import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';
import { execFileSync, spawn } from 'child_process';

/**
 * Lightweight, zero-dependency `.env.local` / `.env` loader.
 * Safely reads `.env.local` and `.env` in `cwd` (default `process.cwd()`) if present,
 * populating `envTarget[key]` only for keys not already set in `envTarget`.
 * Supports UTF-8, UTF-8 BOM, and UTF-16LE BOM (e.g. Windows PowerShell `>`).
 */
export function loadDotEnvIfExists(
  cwd: string = process.cwd(),
  envTarget: Record<string, string | undefined> = process.env
): Record<string, string> {
  const loaded: Record<string, string> = {};
  const seenKeys = new Set<string>();
  for (const fileName of ['.env.local', '.env']) {
    const filePath = path.resolve(cwd, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const rawBuf = fs.readFileSync(filePath);
      const rawContent =
        rawBuf.length >= 2 && rawBuf[0] === 0xff && rawBuf[1] === 0xfe
          ? rawBuf.subarray(2).toString('utf16le')
          : rawBuf.toString('utf-8').replace(/^\uFEFF/, '');
      const lines = rawContent.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        const key = match[1];
        const rawVal = match[2].trim();
        let val = rawVal;

        if (rawVal.startsWith('"') || rawVal.startsWith("'")) {
          const quote = rawVal[0];
          const findClosingQuote = (str: string): number => {
            for (let c = 1; c < str.length; c++) {
              if (quote === '"' && str[c] === '\\') {
                c++;
                continue;
              }
              if (str[c] === quote) {
                return c;
              }
            }
            return -1;
          };

          let closeIdx = findClosingQuote(rawVal);
          let lookaheadIdx = i;
          let candidateVal = rawVal;
          while (closeIdx === -1 && lookaheadIdx + 1 < lines.length) {
            lookaheadIdx++;
            candidateVal += '\n' + lines[lookaheadIdx];
            closeIdx = findClosingQuote(candidateVal);
          }

          const trailingAfterQuote = closeIdx !== -1 ? candidateVal.slice(closeIdx + 1) : '';
          if (closeIdx !== -1 && /^\s*(?:#.*)?$/.test(trailingAfterQuote)) {
            i = lookaheadIdx;
            const inner = candidateVal.slice(1, closeIdx);
            val =
              quote === '"'
                ? inner.replace(/\\(["\\nrt])/g, (_, ch: string) => {
                    if (ch === 'n') return '\n';
                    if (ch === 'r') return '\r';
                    if (ch === 't') return '\t';
                    return ch;
                  })
                : inner;
          } else {
            const commentIdx = rawVal.search(/(?:^|\s+)#/);
            val = (commentIdx !== -1 ? rawVal.slice(0, commentIdx) : rawVal).trim();
          }
        } else {
          const commentIdx = rawVal.search(/(?:^|\s+)#/);
          val = (commentIdx !== -1 ? rawVal.slice(0, commentIdx) : rawVal).trim();
        }

        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        if (envTarget[key] === undefined) {
          envTarget[key] = val;
          loaded[key] = val;
        }
      }
    } catch {
      // Ignore unreadable dotenv file
    }
  }
  return loaded;
}

loadDotEnvIfExists();

export const GEMINI_4_ARGON_MODEL = 'gemini-4-argon' as const;
const INTERACTIONS_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const INTERACTIONS_API_REVISION = '2026-05-20';

/**
 * Gemini 4 Argon Thinking Level (`LOW`, `MEDIUM`, `HIGH`).
 * Note: `MINIMAL` is not supported by Gemini 4 Argon, and legacy sampling parameters
 * (`temperature`, `topP`, `topK`) are deprecated and omitted.
 *
 * - HIGH: Maximizes reasoning depth. Best for Stage 1 in-depth multi-source research.
 * - MEDIUM: Balanced reasoning effort, latency, and token usage (default). Best for Stage 2 structured synthesis/scriptwriting.
 * - LOW: Minimizes latency and token usage. Best for fast tool routing & interactive approval gates.
 */
export type ThinkingLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export function normalizeThinkingLevel(
  level?: string,
  defaultLevel: ThinkingLevel = 'MEDIUM'
): ThinkingLevel {
  if (!level) return defaultLevel;
  const upper = level.trim().toUpperCase();
  if (upper === 'LOW' || upper === 'MEDIUM' || upper === 'HIGH') {
    return upper;
  }
  return defaultLevel;
}

export interface StagePromptContract {
  name: string;
  model: string;
  maxOutputTokens: number;
  thinkingLevel: ThinkingLevel;
  includeThoughts: boolean;
  useGoogleSearch: boolean;
  outputFormat: 'text' | 'json';
  outputJsonSchema?: Record<string, any>;
  template: string;
}

/**
 * Parses `output.schema` or `output.jsonSchema` from stage contract YAML frontmatter.
 * Supports flat scalars (`title: string`), scalar arrays (`bullets: string[]`),
 * nested object arrays (`slides(array):` / `slides[]:` / `slides: array` with indented child fields),
 * nested objects (`metadata:` with indented child fields), or inline JSON Schema (`jsonSchema: {...}`).
 */
function parseFrontmatterOutputSchema(outputBlock: string): Record<string, any> | undefined {
  const inlineJsonMatch = outputBlock.match(/(?:jsonSchema|schema):\s*(\{[\s\S]*\})\s*$/);
  if (inlineJsonMatch) {
    try {
      return JSON.parse(inlineJsonMatch[1]);
    } catch {
      // Fall through to line-by-line YAML schema parsing
    }
  }

  const schemaSectionMatch = outputBlock.match(/schema:\s*[\r\n]+([\s\S]*)$/);
  if (!schemaSectionMatch) return undefined;

  const rawLines = schemaSectionMatch[1].split(/\r?\n/);
  const schemaLines: Array<{ indent: number; text: string }> = [];
  for (const line of rawLines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    schemaLines.push({ indent, text: line.trim() });
  }

  if (schemaLines.length === 0) return undefined;

  function parseBlock(startIndex: number, minIndent: number): {
    properties: Record<string, any>;
    required: string[];
    nextIndex: number;
  } {
    const properties: Record<string, any> = {};
    const required: string[] = [];
    let i = startIndex;

    while (i < schemaLines.length) {
      const current = schemaLines[i];
      if (!current || current.indent < minIndent) break;

      const lineMatch = current.text.match(
        /^([a-zA-Z0-9_]+)(\[\]|\(array\))?(\?)?:\s*(.*)$/i
      );
      if (!lineMatch) {
        i++;
        continue;
      }

      const [, propName, arraySuffix, optionalFlag, rawType] = lineMatch;
      const typeStr = rawType.trim();
      const isOptional = Boolean(optionalFlag);
      const nextLine = schemaLines[i + 1];
      const hasChildren = Boolean(nextLine && nextLine.indent > current.indent);

      const isArrayHeader =
        Boolean(arraySuffix) ||
        /^array$/i.test(typeStr) ||
        /^array<object>$/i.test(typeStr);

      if (hasChildren && nextLine) {
        const childBlock = parseBlock(i + 1, nextLine.indent);
        const objectSchema = {
          type: 'object',
          properties: childBlock.properties,
          required: childBlock.required,
        };
        properties[propName] = isArrayHeader
          ? { type: 'array', items: objectSchema }
          : objectSchema;
        if (!isOptional) required.push(propName);
        i = childBlock.nextIndex;
        continue;
      }

      const scalarArrayMatch =
        typeStr.match(/^(string|integer|number|boolean)\[\]$/i) ||
        typeStr.match(/^array<\s*(string|integer|number|boolean)\s*>$/i);
      if (scalarArrayMatch) {
        properties[propName] = {
          type: 'array',
          items: { type: scalarArrayMatch[1].toLowerCase() },
        };
        if (!isOptional) required.push(propName);
        i++;
        continue;
      }

      const scalarMatch = typeStr.match(/^(string|integer|number|boolean)$/i);
      if (scalarMatch) {
        const scalarType = scalarMatch[1].toLowerCase();
        properties[propName] = arraySuffix
          ? { type: 'array', items: { type: scalarType } }
          : { type: scalarType };
        if (!isOptional) required.push(propName);
      }

      i++;
    }

    return { properties, required, nextIndex: i };
  }

  const root = parseBlock(0, schemaLines[0]?.indent ?? 2);
  if (Object.keys(root.properties).length === 0) return undefined;

  return {
    type: 'object',
    properties: root.properties,
    required: root.required,
  };
}

/**
 * Parses a stage contract Markdown file from `./prompts/<name>.md` (YAML frontmatter + Handlebars template)
 * without requiring any external framework dependencies.
 */
export function loadStagePromptContract(
  promptName: string,
  promptDir: string = './prompts'
): StagePromptContract {
  const filePath = path.resolve(promptDir, `${promptName}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Stage contract not found at: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return {
      name: promptName,
      model: GEMINI_4_ARGON_MODEL,
      maxOutputTokens: 32768,
      thinkingLevel: 'MEDIUM',
      includeThoughts: true,
      useGoogleSearch: false,
      outputFormat: 'text',
      template: raw.trim(),
    };
  }

  const frontmatter = match[1];
  const template = match[2].trim();

  const maxTokensMatch = frontmatter.match(/maxOutputTokens:\s*(\d+)/);
  const maxOutputTokens = maxTokensMatch ? parseInt(maxTokensMatch[1], 10) : 32768;

  const thinkingMatch = frontmatter.match(/thinkingLevel:\s*(LOW|MEDIUM|HIGH)/i);
  const thinkingLevel = normalizeThinkingLevel(thinkingMatch?.[1], 'MEDIUM');

  const includeThoughtsMatch = frontmatter.match(/includeThoughts:\s*(true|false)/i);
  const includeThoughts = includeThoughtsMatch
    ? includeThoughtsMatch[1].toLowerCase() === 'true'
    : true;

  const useGoogleSearch = /googleSearch|google_search/i.test(frontmatter);

  const formatMatch = frontmatter.match(/output:\s*[\r\n]+\s*format:\s*(json|text)/i);
  const outputFormat: 'text' | 'json' =
    formatMatch?.[1]?.toLowerCase() === 'json' ? 'json' : 'text';

  let outputJsonSchema: Record<string, any> | undefined;
  if (outputFormat === 'json') {
    const outputBlockMatch = frontmatter.match(/output:\s*[\r\n]+([\s\S]*)$/);
    if (outputBlockMatch) {
      outputJsonSchema = parseFrontmatterOutputSchema(outputBlockMatch[1]);
    }
  }

  return {
    name: promptName,
    model: GEMINI_4_ARGON_MODEL,
    maxOutputTokens,
    thinkingLevel,
    includeThoughts,
    useGoogleSearch,
    outputFormat,
    outputJsonSchema,
    template,
  };
}

/**
 * Renders Handlebars-style `{{#if key}}...{{/if}}` and `{{key}}` placeholders in a stage prompt template.
 */
export function renderPromptTemplate(
  template: string,
  variables: Record<string, string | undefined>
): string {
  let rendered = template.replace(
    /\{\{#if\s+([a-zA-Z0-9_]+)\}\}\r?\n?([\s\S]*?)\{\{\/if\}\}\r?\n?/g,
    (_full, varName: string, inner: string) => {
      const val = variables[varName];
      if (val && val.trim() !== '') {
        return inner.replace(
          new RegExp(`\\{\\{\\s*${varName}\\s*\\}\\}`, 'g'),
          () => val
        );
      }
      return '';
    }
  );

  rendered = rendered.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, varName: string) => {
    return variables[varName] ?? '';
  });

  return rendered.trim();
}

export interface InteractionUsageTelemetry {
  inputTokens: number;
  thoughtsTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface Gemini4ArgonInteractionResult {
  id?: string;
  status?: string;
  text: string;
  thoughts: string[];
  searchQueries: string[];
  steps: any[];
  usage: InteractionUsageTelemetry;
}

export interface Gemini4ArgonRequestOptions {
  promptText?: string;
  steps?: any[];
  thinkingLevel: ThinkingLevel;
  maxOutputTokens: number;
  includeThoughts?: boolean;
  useGoogleSearch?: boolean;
  tools?: any[];
  outputFormat?: 'text' | 'json';
  outputJsonSchema?: Record<string, any>;
  store?: boolean;
  previousInteractionId?: string;
  onThought?: (thoughtStep: string, allThoughts: string[]) => void;
  onSearchQuery?: (queries: string[], allQueries: string[]) => void;
  onTextDelta?: (deltaText: string, accumulatedText: string) => void;
}

function getApiKey(): string {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY && !process.env.GOOGLE_GENAI_API_KEY) {
    loadDotEnvIfExists();
  }
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
  if (!key) {
    throw new Error(
      'Missing GEMINI_API_KEY environment variable. Add GEMINI_API_KEY="your-key" to .env.local.'
    );
  }
  return key;
}

function isRetryableError(err: any): boolean {
  const status = err?.statusCode || err?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('rate limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('deadline_exceeded') ||
    msg.includes('aborted') ||
    msg.includes('error reading from the stream')
  );
}

/**
 * Direct SSE streaming client for Gemini 4 Argon (`gemini-4-argon`) via the Google AI Interactions API
 * (`/v1beta/interactions`). Zero external framework bloat.
 */
export async function streamGemini4ArgonInteraction(
  options: Gemini4ArgonRequestOptions
): Promise<Gemini4ArgonInteractionResult> {
  const apiKey = getApiKey();
  const tools: any[] = [];
  if (options.useGoogleSearch) {
    tools.push({ type: 'google_search' });
  }
  if (Array.isArray(options.tools)) {
    tools.push(...options.tools);
  }

  const inputSteps =
    options.steps && options.steps.length > 0
      ? options.steps
      : [
          {
            type: 'user_input',
            content: [{ type: 'text', text: options.promptText || '' }],
          },
        ];

  const requestBody: Record<string, any> = {
    model: GEMINI_4_ARGON_MODEL,
    tools: tools.length > 0 ? tools : undefined,
    generation_config: {
      max_output_tokens: options.maxOutputTokens,
      thinking_level: options.thinkingLevel.toLowerCase(),
      thinking_summaries: options.includeThoughts === false ? 'none' : 'auto',
    },
    stream: true,
    store: Boolean(options.store),
    input: inputSteps,
  };

  if (options.previousInteractionId) {
    requestBody.previous_interaction_id = options.previousInteractionId;
  }

  if (options.outputFormat === 'json') {
    requestBody.response_format = {
      type: 'text',
      mime_type: 'application/json',
      ...(options.outputJsonSchema ? { schema: options.outputJsonSchema } : {}),
    };
  }

  const response = await fetch(INTERACTIONS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Revision': INTERACTIONS_API_REVISION,
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text();
    const error: any = new Error(
      `Gemini 4 Argon Interactions API Error [${response.status} ${response.statusText}]: ${errText}`
    );
    error.statusCode = response.status;
    throw error;
  }

  if (!response.body) {
    throw new Error('Gemini 4 Argon Interactions API returned an empty response body.');
  }

  const interaction: Record<string, any> = { steps: [] };
  const thoughts: string[] = [];
  const searchQueries: string[] = [];
  let accumulatedText = '';
  const partialArgumentsMap = new Map<number, string>();

  const decoderStream = response.body.pipeThrough(new TextDecoderStream('utf-8'));
  const reader = decoderStream.getReader();
  let buffer = '';

  const processEvent = (event: any) => {
    if (!event || typeof event !== 'object') return;

    if (event.event_type === 'error') {
      const err: any = new Error(
        `Interactions API stream error [${event.error?.code || 'UNKNOWN'}]: ${event.error?.message || JSON.stringify(event)}`
      );
      err.status = event.error?.code;
      throw err;
    }

    if (
      event.event_type === 'interaction.created' ||
      event.event_type === 'interaction.completed' ||
      event.event_type === 'interaction.complete'
    ) {
      const { steps, ...rest } = event.interaction || {};
      Object.assign(interaction, rest);
      if (Array.isArray(steps) && steps.length > 0) {
        if (!Array.isArray(interaction.steps)) {
          interaction.steps = [];
        }
        const mergedExisting = new Set<any>();
        for (let i = 0; i < steps.length; i++) {
          const completedStep = steps[i];
          if (!completedStep || typeof completedStep !== 'object') continue;

          let targetStep: any = null;
          const atIdx = interaction.steps[i];
          if (
            atIdx &&
            typeof atIdx === 'object' &&
            !mergedExisting.has(atIdx) &&
            (!atIdx.type || !completedStep.type || atIdx.type === completedStep.type) &&
            (!completedStep.id || !atIdx.id || atIdx.id === completedStep.id) &&
            (!completedStep.call_id || !atIdx.call_id || atIdx.call_id === completedStep.call_id)
          ) {
            targetStep = atIdx;
          } else {
            targetStep = interaction.steps.find(
              (s: any) =>
                s &&
                typeof s === 'object' &&
                !mergedExisting.has(s) &&
                s.type === completedStep.type &&
                (!completedStep.id || !s.id || s.id === completedStep.id) &&
                (!completedStep.call_id || !s.call_id || s.call_id === completedStep.call_id)
            );
          }

          if (!targetStep) {
            if (!interaction.steps[i]) {
              interaction.steps[i] = completedStep;
            } else {
              interaction.steps.push(completedStep);
            }
            mergedExisting.add(completedStep);
            targetStep = completedStep;
          } else {
            mergedExisting.add(targetStep);
            for (const [k, v] of Object.entries(completedStep)) {
              if (v === undefined || v === null) continue;
              if (
                k === 'content' &&
                Array.isArray(v) &&
                Array.isArray(targetStep.content) &&
                targetStep.content.length > 0
              ) {
                for (const cPart of v) {
                  if (!cPart || typeof cPart !== 'object') continue;
                  if (cPart.type === 'text') {
                    let existingTextPart = [...targetStep.content]
                      .reverse()
                      .find((p: any) => p && p.type === 'text');
                    if (!existingTextPart) {
                      existingTextPart = { type: 'text', text: cPart.text || '' };
                      targetStep.content.push(existingTextPart);
                    } else if (
                      typeof cPart.text === 'string' &&
                      cPart.text.length > (existingTextPart.text || '').length
                    ) {
                      existingTextPart.text = cPart.text;
                    }
                    if (Array.isArray(cPart.annotations) && cPart.annotations.length > 0) {
                      const existingAnns: any[] = Array.isArray(existingTextPart.annotations)
                        ? existingTextPart.annotations
                        : [];
                      const seenAnnKeys = new Set(
                        existingAnns.map(
                          (a: any) =>
                            `${a?.start_index ?? ''}:${a?.end_index ?? ''}:${a?.url ?? ''}`
                        )
                      );
                      for (const ann of cPart.annotations) {
                        const key = `${ann?.start_index ?? ''}:${ann?.end_index ?? ''}:${ann?.url ?? ''}`;
                        if (!seenAnnKeys.has(key)) {
                          seenAnnKeys.add(key);
                          existingAnns.push(ann);
                        }
                      }
                      existingTextPart.annotations = existingAnns;
                    }
                  } else {
                    const alreadyPresent = targetStep.content.some(
                      (p: any) =>
                        p &&
                        p.type === cPart.type &&
                        ((cPart.id && p.id === cPart.id) ||
                          (cPart.name && p.name === cPart.name) ||
                          JSON.stringify(p) === JSON.stringify(cPart))
                    );
                    if (!alreadyPresent) {
                      targetStep.content.push(cPart);
                    }
                  }
                }
              } else if (Array.isArray(v)) {
                if (v.length > 0 || !Array.isArray(targetStep[k])) {
                  targetStep[k] = v;
                }
              } else {
                targetStep[k] = v;
              }
            }
          }

          if (
            completedStep.type === 'google_search_call' &&
            Array.isArray(completedStep.arguments?.queries)
          ) {
            const newQueries = completedStep.arguments.queries.filter(
              (q: any) => typeof q === 'string' && q.trim() && !searchQueries.includes(q)
            );
            if (newQueries.length > 0) {
              searchQueries.push(...newQueries);
              options.onSearchQuery?.(newQueries, searchQueries);
            }
          }

          if (completedStep.type === 'thought' && Array.isArray(completedStep.summary)) {
            for (const sPart of completedStep.summary) {
              const thoughtText = String(
                typeof sPart === 'string' ? sPart : sPart?.text || ''
              ).trim();
              if (thoughtText && !thoughts.includes(thoughtText)) {
                thoughts.push(thoughtText);
                options.onThought?.(thoughtText, thoughts);
              }
            }
          }
        }
      }
      return;
    }

    if (event.event_type === 'interaction.status_update') {
      interaction.status = event.status;
      return;
    }

    if (event.event_type === 'step.start') {
      if (!interaction.steps) interaction.steps = [];
      interaction.steps[event.index] = event.step;
      return;
    }

    if (event.event_type === 'step.delta') {
      if (!interaction.steps) interaction.steps = [];
      const step = interaction.steps[event.index];
      const delta = event.delta;
      if (!delta) return;

      if (delta.type === 'thought_summary' && delta.content?.text) {
        const thoughtText = String(delta.content.text).trim();
        if (thoughtText) {
          thoughts.push(thoughtText);
          options.onThought?.(thoughtText, thoughts);
        }
      }

      if (delta.type === 'google_search_call' && Array.isArray(delta.arguments?.queries)) {
        const queries = delta.arguments.queries.filter((q: any) => typeof q === 'string' && q.trim());
        if (queries.length > 0) {
          searchQueries.push(...queries);
          options.onSearchQuery?.(queries, searchQueries);
        }
      }

      if (step) {
        if (step.type === 'model_output' || step.type === 'user_input' || step.type === 'thought') {
          if (step.type === 'thought' && !step.summary) step.summary = [];
          if (step.type !== 'thought' && !step.content) step.content = [];
          const arr = step.type === 'thought' ? step.summary : step.content;

          if (delta.type === 'text' && typeof delta.text === 'string') {
            const last = arr[arr.length - 1];
            if (last?.type === 'text') {
              last.text = (last.text ?? '') + delta.text;
            } else {
              arr.push({ type: 'text', text: delta.text });
            }
            if (step.type === 'model_output') {
              accumulatedText += delta.text;
              options.onTextDelta?.(delta.text, accumulatedText);
            }
          } else if (delta.type === 'text_annotation_delta' && Array.isArray(delta.annotations)) {
            let target = [...arr].reverse().find((c: any) => c.type === 'text');
            if (!target) {
              target = { type: 'text', text: '' };
              arr.push(target);
            }
            target.annotations = [...(target.annotations ?? []), ...delta.annotations];
          } else if (delta.type === 'thought_summary' && delta.content) {
            arr.push(delta.content);
          } else if (delta.type === 'thought_signature' && step.type === 'thought') {
            step.signature = delta.signature;
          } else if (delta.type === 'function_call') {
            arr.push({
              type: 'function_call',
              name: delta.name,
              id: delta.id,
              arguments: delta.arguments,
            });
          }
        } else if (step.type === 'function_call' && delta.type === 'arguments_delta') {
          const existing = partialArgumentsMap.get(event.index) || '';
          partialArgumentsMap.set(event.index, existing + (delta.arguments || ''));
        } else if (delta.type === step.type) {
          const { type: _type, ...fields } = delta;
          for (const [k, v] of Object.entries(fields)) {
            if (v !== undefined) {
              step[k] = v;
            }
          }
        }
      }
      return;
    }

    if (event.event_type === 'step.stop') {
      if (partialArgumentsMap.has(event.index)) {
        const step = interaction.steps?.[event.index];
        if (step && step.type === 'function_call') {
          try {
            const argStr = partialArgumentsMap.get(event.index);
            if (argStr) {
              step.arguments = JSON.parse(argStr);
            }
          } catch {
            // Ignore malformed partial JSON
          }
        }
        partialArgumentsMap.delete(event.index);
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;

      while (true) {
        const match = buffer.match(/\r\n\r\n|\n\n|\r\r/);
        if (!match || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);

        const lines = block.split(/\r\n|\r|\n/);
        let dataText = '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            dataText += line.slice(6);
          } else if (line.startsWith('data:')) {
            dataText += line.slice(5);
          }
        }
        if (!dataText || dataText === '[DONE]') continue;
        const parsed = JSON.parse(dataText);
        processEvent(parsed);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (interaction.status === 'failed') {
    const details = (interaction.errors ?? [])
      .map((e: any) => `${e.code ? `[${e.code}] ` : ''}${e.message || ''}`.trim())
      .filter(Boolean)
      .join('; ');
    const err: any = new Error(`Gemini 4 Argon interaction failed: ${details || 'Unknown error'}`);
    err.status = interaction.errors?.[0]?.code;
    throw err;
  }

  if (interaction.status === 'in_progress') {
    const err: any = new Error(
      `Gemini 4 Argon SSE stream closed prematurely while status was still 'in_progress' (${accumulatedText.length} chars received before stream drop)`
    );
    err.status = 503;
    throw err;
  }

  // Fallback text extraction from completed steps if not already accumulated via deltas
  if (!accumulatedText && Array.isArray(interaction.steps)) {
    for (const step of interaction.steps) {
      if (step?.type === 'model_output' && Array.isArray(step.content)) {
        for (const part of step.content) {
          if (part?.type === 'text' && typeof part.text === 'string') {
            accumulatedText += part.text;
          }
        }
      }
    }
  }

  const rawUsage = interaction.usage || {};
  const usage: InteractionUsageTelemetry = {
    inputTokens: rawUsage.total_input_tokens ?? 0,
    thoughtsTokens: rawUsage.total_thought_tokens ?? 0,
    outputTokens: rawUsage.total_output_tokens ?? 0,
    totalTokens: rawUsage.total_tokens ?? 0,
  };

  return {
    id: interaction.id,
    status: interaction.status,
    text: accumulatedText,
    thoughts,
    searchQueries,
    steps: interaction.steps || [],
    usage,
  };
}

/**
 * Executes a Gemini 4 Argon interaction with automatic retry and optional thinking-level fallback
 * (e.g., Stage 1 retries `HIGH` once and falls back to `MEDIUM` if overloaded).
 */
async function executeWithRetryAndFallback(
  options: Gemini4ArgonRequestOptions,
  maxRetries: number = 1,
  fallbackThinkingLevel?: ThinkingLevel
): Promise<{ result: Gemini4ArgonInteractionResult; usedThinkingLevel: ThinkingLevel }> {
  let attempt = 0;
  while (true) {
    try {
      const result = await streamGemini4ArgonInteraction(options);
      return { result, usedThinkingLevel: options.thinkingLevel };
    } catch (err: any) {
      if (attempt < maxRetries && isRetryableError(err)) {
        attempt++;
        console.warn(
          `[Retry ${attempt}/${maxRetries}] Transient error on ${GEMINI_4_ARGON_MODEL} (thinkingLevel: ${options.thinkingLevel}): ${err.message}. Retrying...`
        );
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      if (
        fallbackThinkingLevel &&
        fallbackThinkingLevel !== options.thinkingLevel &&
        isRetryableError(err)
      ) {
        console.warn(
          `[Fallback] Switching ${GEMINI_4_ARGON_MODEL} from thinkingLevel ${options.thinkingLevel} -> ${fallbackThinkingLevel} after error: ${err.message}`
        );
        const fallbackResult = await streamGemini4ArgonInteraction({
          ...options,
          thinkingLevel: fallbackThinkingLevel,
        });
        return { result: fallbackResult, usedThinkingLevel: fallbackThinkingLevel };
      }
      throw err;
    }
  }
}

export function parseValidIsoTimestamp(val: any): string | undefined {
  if (val === undefined || val === null || typeof val === 'boolean') return undefined;
  const s = String(val).trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(`${s}T00:00:00Z`);
    if (Number.isNaN(ms)) return undefined;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const isoCandidate = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(s)
    ? `${s.replace(' ', 'T')}Z`
    : s;
  const ms = Date.parse(isoCandidate);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseHttpLastModified(headerVal?: string | null): string | undefined {
  if (!headerVal || typeof headerVal !== 'string') return undefined;
  return parseValidIsoTimestamp(headerVal);
}

function normalizeIsoTimestamp(val: any): string {
  const s = String(val ?? '').trim();
  if (!s) return '';
  return parseValidIsoTimestamp(s) || s;
}

/**
 * Decodes HTML named entities (including Nordic/Latin-1 entities such as &oslash;, &aelig;, &aring;,
 * &Oslash;, &AElig;, &Aring;, &ouml;, &auml;, &uuml;, &eacute;, &sect;, &laquo;, &raquo;, &ndash;, &mdash;, &nbsp;)
 * as well as decimal (`&#248;`) and hexadecimal (`&#x00F8;`) numeric character references.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/&oslash;/g, 'ø')
    .replace(/&Oslash;|&OSLASH;/g, 'Ø')
    .replace(/&aelig;/g, 'æ')
    .replace(/&AElig;|&AELIG;/g, 'Æ')
    .replace(/&aring;/g, 'å')
    .replace(/&Aring;|&ARING;/g, 'Å')
    .replace(/&ouml;/g, 'ö')
    .replace(/&Ouml;|&OUML;/g, 'Ö')
    .replace(/&auml;/g, 'ä')
    .replace(/&Auml;|&AUML;/g, 'Ä')
    .replace(/&uuml;/g, 'ü')
    .replace(/&Uuml;|&UUML;/g, 'Ü')
    .replace(/&eacute;/g, 'é')
    .replace(/&Eacute;|&EACUTE;/g, 'É')
    .replace(/&egrave;/g, 'è')
    .replace(/&Egrave;|&EGRAVE;/g, 'È')
    .replace(/&szlig;/g, 'ß')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&sect;/gi, '§')
    .replace(/&laquo;/gi, '«')
    .replace(/&raquo;/gi, '»')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&lsquo;|&rsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&bull;/gi, '•')
    .replace(/&hellip;/gi, '…')
    .replace(/&deg;/gi, '°')
    .replace(/&plusmn;/gi, '±')
    .replace(/&times;/gi, '×')
    .replace(/&divide;/gi, '÷')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return m;
      }
    })
    .replace(/&#(\d+);/g, (m, code) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch {
        return m;
      }
    })
    .replace(/&amp;/gi, '&');
}

function parseSaneDocTimestamp(val: any): string | undefined {
  const iso = parseValidIsoTimestamp(val);
  if (!iso) return undefined;
  const yr = Number(iso.slice(0, 4));
  const maxYr = new Date().getUTCFullYear() + 2;
  if (!Number.isFinite(yr) || yr < 1970 || yr > maxYr) return undefined;
  return iso;
}

/**
 * Extracts standard W3C / OpenGraph / Dublin Core / Schema.org document modification
 * (or fallback publication) timestamps from an HTML `<head>` / JSON-LD snippet.
 * Zero domain/keyword heuristics — purely protocol-level metadata (`OKF v0.2` §5.1 `last_modified`).
 */
export function extractHtmlModifiedFromSnippet(htmlSnippet: string): string | undefined {
  if (!htmlSnippet || typeof htmlSnippet !== 'string') return undefined;

  const findMetaContent = (keys: Set<string>): string | undefined => {
    const metaTagRe = /<meta\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = metaTagRe.exec(htmlSnippet)) !== null) {
      const tag = m[0];
      const attrMatch = tag.match(/\b(?:property|name|http-equiv|itemprop)\s*=\s*["']([^"']+)["']/i);
      const contentMatch = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i);
      if (attrMatch && contentMatch) {
        const key = attrMatch[1].trim().toLowerCase();
        if (keys.has(key)) {
          const parsed = parseSaneDocTimestamp(decodeHtmlEntities(contentMatch[1]));
          if (parsed) return parsed;
        }
      }
    }
    return undefined;
  };

  const findTimeItemprop = (propLower: string): string | undefined => {
    const timeTagRe = /<time\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = timeTagRe.exec(htmlSnippet)) !== null) {
      const tag = m[0];
      const propMatch = tag.match(/\bitemprop\s*=\s*["']([^"']+)["']/i);
      const dtMatch = tag.match(/\bdatetime\s*=\s*["']([^"']+)["']/i);
      if (propMatch && dtMatch && propMatch[1].trim().toLowerCase() === propLower) {
        const parsed = parseSaneDocTimestamp(decodeHtmlEntities(dtMatch[1]));
        if (parsed) return parsed;
      }
    }
    return undefined;
  };

  const findJsonLdDate = (field: 'dateModified' | 'datePublished'): string | undefined => {
    const re = new RegExp(`"${field}"\\s*:\\s*"([^"]{8,64})"`, 'i');
    const m = htmlSnippet.match(re);
    return m && m[1] ? parseSaneDocTimestamp(decodeHtmlEntities(m[1])) : undefined;
  };

  const modKeys = new Set([
    'article:modified_time',
    'og:updated_time',
    'dcterms.modified',
    'dc.date.modified',
    'last-modified',
    'datemodified',
  ]);
  const explicitMod =
    findMetaContent(modKeys) || findTimeItemprop('datemodified') || findJsonLdDate('dateModified');
  if (explicitMod) return explicitMod;

  const pubKeys = new Set([
    'article:published_time',
    'dcterms.issued',
    'dcterms.created',
    'dc.date',
    'datepublished',
  ]);
  return (
    findMetaContent(pubKeys) || findTimeItemprop('datepublished') || findJsonLdDate('datePublished')
  );
}

/**
 * Parses an ISO 32000-1 §7.9.4 PDF date string (`D:YYYYMMDDHHmmSSOHH'mm'`, including Quartz `Z00'00'`
 * and octal `\\047` escapes) or ISO 8601 timestamp into canonical UTC ISO 8601 (`YYYY-MM-DDTHH:MM:SSZ`).
 */
export function parsePdfDateToIso(raw: string): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/\\047/g, "'").trim();
  if (!cleaned) return undefined;
  const body = cleaned.replace(/^D:\s*/i, '');
  const m = body.match(
    /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:\.\d+)?\s*(Z(?:00'?00'?)?|[+-]\d{2}(?:'\d{2}'?|:\d{2}|\d{2})?)?$/i
  );
  if (m) {
    const yyyy = m[1];
    const mm = m[2] || '01';
    const dd = m[3] || '01';
    const hh = m[4] || '00';
    const min = m[5] || '00';
    const ss = m[6] || '00';
    const mmNum = Number(mm);
    const ddNum = Number(dd);
    const hhNum = Number(hh);
    const minNum = Number(min);
    const ssNum = Number(ss);
    if (
      mmNum >= 1 &&
      mmNum <= 12 &&
      ddNum >= 1 &&
      ddNum <= 31 &&
      hhNum >= 0 &&
      hhNum <= 23 &&
      minNum >= 0 &&
      minNum <= 59 &&
      ssNum >= 0 &&
      ssNum <= 60
    ) {
      const tzRaw = (m[7] || 'Z').trim();
      let tz = 'Z';
      if (tzRaw && !/^Z/i.test(tzRaw)) {
        const tzMatch = tzRaw.match(/^([+-])(\d{2})(?:[':]?(\d{2})'?)?$/);
        if (!tzMatch) return undefined;
        tz = `${tzMatch[1]}${tzMatch[2]}:${tzMatch[3] || '00'}`;
      }
      return parseSaneDocTimestamp(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}${tz}`);
    }
  }
  return parseSaneDocTimestamp(cleaned);
}

/**
 * Extracts ISO 32000 `/Info` (`/ModDate`, fallback `/CreationDate`, both inline `(D:...)` and
 * indirect `<obj> <gen> R` objects) or Adobe XMP (`xmp:ModifyDate`, fallback `xmp:CreateDate`)
 * timestamps from a `'latin1'`-decoded PDF byte slice.
 */
export function extractPdfModifiedFromLatin1(pdfLatin1: string): string | undefined {
  if (!pdfLatin1 || typeof pdfLatin1 !== 'string') return undefined;

  const extractByPdfInfoKey = (key: 'ModDate' | 'CreationDate'): string | undefined => {
    let lastValid: string | undefined;
    const directRe = new RegExp(`\\/${key}\\s*\\(\\s*([^)\\r\\n]{4,64})\\)`, 'g');
    let dm: RegExpExecArray | null;
    while ((dm = directRe.exec(pdfLatin1)) !== null) {
      const parsed = parsePdfDateToIso(dm[1]);
      if (parsed) lastValid = parsed;
    }
    if (lastValid) return lastValid;

    const refRe = new RegExp(`\\/${key}\\s+(\\d+)\\s+(\\d+)\\s+R\\b`, 'g');
    let rm: RegExpExecArray | null;
    const refs: Array<[string, string]> = [];
    while ((rm = refRe.exec(pdfLatin1)) !== null) {
      refs.push([rm[1], rm[2]]);
    }
    for (let i = refs.length - 1; i >= 0; i--) {
      const [objNum, genNum] = refs[i];
      const objRe = new RegExp(
        `(?:^|[^0-9])${objNum}\\s+${genNum}\\s+obj\\s*\\(\\s*([^)\\r\\n]{4,64})\\)`,
        'g'
      );
      let om: RegExpExecArray | null;
      let objParsed: string | undefined;
      while ((om = objRe.exec(pdfLatin1)) !== null) {
        const p = parsePdfDateToIso(om[1]);
        if (p) objParsed = p;
      }
      if (objParsed) return objParsed;
    }
    return undefined;
  };

  const extractByXmpKey = (tag: 'ModifyDate' | 'CreateDate'): string | undefined => {
    let lastValid: string | undefined;
    const elRe = new RegExp(`<(?:xmp|xap):${tag}[^>]*>\\s*([^<]{8,64}?)\\s*<\\/(?:xmp|xap):${tag}>`, 'gi');
    let em: RegExpExecArray | null;
    while ((em = elRe.exec(pdfLatin1)) !== null) {
      const p = parsePdfDateToIso(em[1]);
      if (p) lastValid = p;
    }
    if (lastValid) return lastValid;

    const attrRe = new RegExp(`\\b(?:xmp|xap):${tag}\\s*=\\s*["']([^"']{8,64})["']`, 'gi');
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(pdfLatin1)) !== null) {
      const p = parsePdfDateToIso(am[1]);
      if (p) lastValid = p;
    }
    return lastValid;
  };

  return (
    extractByPdfInfoKey('ModDate') ||
    extractByXmpKey('ModifyDate') ||
    extractByPdfInfoKey('CreationDate') ||
    extractByXmpKey('CreateDate')
  );
}

// Helper function to extract the destination URL (and opportunistic Last-Modified / document metadata) from Vertex AI Search grounding 302 redirects.
// Uses `redirect: 'manual'` first so we read Google's `Location` header directly in ~100ms without
function extractHtmlTitleFromSnippet(htmlSnippet: string): string | undefined {
  if (!htmlSnippet || typeof htmlSnippet !== 'string') return undefined;
  const decodeEntities = (raw: string): string =>
    decodeHtmlEntities(raw)
      .replace(/\s+/g, ' ')
      .replace(/\s*(?:\||—|–|-)\s*(?:YouTube|Reddit|Quora|Instagram|Facebook|X|Twitter|LinkedIn|Medium)\s*$/i, '')
      .trim();

  const isInvalidOrBotTitle = (t: string): boolean =>
    t.length < 4 ||
    /^(?:just a moment|access denied|attention required|403 forbidden|404 not found|redirecting|error|page not found|verify you are human|security check)/i.test(
      t
    ) ||
    isBareDomainTitle(t);

  const clampLen = (t: string): string =>
    t.length > 180 ? `${t.slice(0, 177).trimEnd()}…` : t;

  const ogMatch =
    htmlSnippet.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    htmlSnippet.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (ogMatch && ogMatch[1]) {
    const cleaned = decodeEntities(ogMatch[1]);
    if (!isInvalidOrBotTitle(cleaned)) {
      return clampLen(cleaned);
    }
  }
  const titleMatch = htmlSnippet.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    const cleaned = decodeEntities(titleMatch[1]);
    if (!isInvalidOrBotTitle(cleaned)) {
      return clampLen(cleaned);
    }
  }
  return undefined;
}

// failing or timing out when a third-party destination server is unreachable.
async function resolveRedirect(
  url: string
): Promise<{ url: string; lastModified?: string; pageTitle?: string }> {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  const isNonErrorStatus = (res: any): boolean =>
    res?.status === undefined || (typeof res.status === 'number' && res.status >= 200 && res.status < 400);

  const inspectResponseMetadata = async (
    res: any,
    targetUrl: string,
    alreadyHasHttpLastModified: boolean
  ): Promise<{ pageTitle?: string; docModified?: string }> => {
    if (!isNonErrorStatus(res)) return {};
    const contentType = String(res?.headers?.get?.('content-type') || '').toLowerCase();
    const isDeclaredHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
    const isDeclaredPdf = contentType.includes('application/pdf');
    if (contentType && !isDeclaredHtml && !isDeclaredPdf && !contentType.includes('octet-stream')) {
      return {};
    }

    try {
      if (typeof res?.body?.getReader === 'function') {
        const reader = res.body.getReader();
        const headChunks: Uint8Array[] = [];
        let headBytes = 0;
        const headLimit = isDeclaredPdf ? 16384 : 32768;
        while (headBytes < headLimit) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          headChunks.push(value);
          headBytes += value.byteLength;
          if (!isDeclaredPdf) {
            const partialStr = Buffer.concat(headChunks).toString('utf8');
            if (
              /<\/head>/i.test(partialStr) ||
              (alreadyHasHttpLastModified && /<\/title>/i.test(partialStr)) ||
              partialStr.startsWith('%PDF-')
            ) {
              break;
            }
          }
        }
        if (headChunks.length === 0) {
          await reader.cancel().catch(() => {});
          return {};
        }

        const headBuf = Buffer.concat(headChunks);
        const headLatin1 = headBuf.toString('latin1');
        const isPdf = isDeclaredPdf || headLatin1.startsWith('%PDF-');

        if (!isPdf) {
          await reader.cancel().catch(() => {});
          const headUtf8 = headBuf.toString('utf8');
          const pageTitle = extractHtmlTitleFromSnippet(headUtf8);
          const docModified = alreadyHasHttpLastModified
            ? undefined
            : extractHtmlModifiedFromSnippet(headUtf8);
          return {
            ...(pageTitle ? { pageTitle } : {}),
            ...(docModified ? { docModified } : {}),
          };
        }

        // PDF response (`application/pdf` or `%PDF-` magic header)
        if (alreadyHasHttpLastModified) {
          await reader.cancel().catch(() => {});
          return {};
        }
        const headPdfMod = extractPdfModifiedFromLatin1(headLatin1);
        if (headPdfMod) {
          await reader.cancel().catch(() => {});
          return { docModified: headPdfMod };
        }

        // ISO 32000 `/Info` (`/ModDate`, `/CreationDate`) typically resides near `xref` at the PDF trailer.
        if (res?.status === 206 && /^https?:\/\//i.test(targetUrl)) {
          await reader.cancel().catch(() => {});
          const crHeader = String(res?.headers?.get?.('content-range') || '');
          const totalMatch = crHeader.match(/\/(\d+)\s*$/);
          const totalSize = totalMatch ? Number(totalMatch[1]) : 0;
          if (totalSize > headBytes) {
            try {
              const tailStart = Math.max(0, totalSize - 32768);
              const tailRes = await globalThis.fetch(targetUrl, {
                method: 'GET',
                redirect: 'follow',
                signal: AbortSignal.timeout(1800),
                headers: {
                  ...headers,
                  Range: `bytes=${tailStart}-${totalSize - 1}`,
                },
              });
              if (isNonErrorStatus(tailRes) && typeof tailRes?.arrayBuffer === 'function') {
                const tailAb = await tailRes.arrayBuffer();
                const tailMod = extractPdfModifiedFromLatin1(
                  Buffer.from(tailAb).subarray(-40960).toString('latin1')
                );
                if (tailMod) return { docModified: tailMod };
              } else {
                await tailRes?.body?.cancel().catch(() => {});
              }
            } catch {
              // Ignore opportunistic PDF tail range timeout
            }
          }
          return {};
        }

        // Server ignored `Range` and returned `200 OK` (e.g., Varnish CDN): drain open stream up to 4 MB
        // while retaining only a rolling 40 KB tail window in memory.
        const clRaw = Number(res?.headers?.get?.('content-length') || 0);
        const maxDrainBytes = 4 * 1024 * 1024;
        if (!clRaw || clRaw <= maxDrainBytes) {
          let totalRead = headBytes;
          let tailBuf: Buffer = headBuf.length > 40960 ? headBuf.subarray(headBuf.length - 40960) : headBuf;
          let reachedEof = false;
          while (totalRead <= maxDrainBytes) {
            const { done, value } = await reader.read();
            if (done || !value) {
              reachedEof = true;
              break;
            }
            totalRead += value.byteLength;
            const combined = Buffer.concat([tailBuf, value]);
            tailBuf = combined.length > 40960 ? combined.subarray(combined.length - 40960) : combined;
          }
          await reader.cancel().catch(() => {});
          if (reachedEof || tailBuf.length > 0) {
            const tailMod = extractPdfModifiedFromLatin1(tailBuf.toString('latin1'));
            if (tailMod) return { docModified: tailMod };
          }
        } else {
          await reader.cancel().catch(() => {});
        }
        return {};
      } else if (typeof res?.text === 'function' && !res?.body) {
        const txt = String((await res.text()) || '');
        if (isDeclaredPdf || txt.startsWith('%PDF-')) {
          const docModified = alreadyHasHttpLastModified
            ? undefined
            : extractPdfModifiedFromLatin1(txt.slice(0, 32768)) ||
              extractPdfModifiedFromLatin1(txt.slice(-40960));
          return docModified ? { docModified } : {};
        }
        const snippet = txt.slice(0, 32768);
        const pageTitle = extractHtmlTitleFromSnippet(snippet);
        const docModified = alreadyHasHttpLastModified
          ? undefined
          : extractHtmlModifiedFromSnippet(snippet);
        return {
          ...(pageTitle ? { pageTitle } : {}),
          ...(docModified ? { docModified } : {}),
        };
      }
    } catch {
      // Ignore stream read errors when opportunistically extracting <title> / document timestamps
    }
    return {};
  };

  try {
    const manualRes = await globalThis.fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers,
    });
    let lastModified = isNonErrorStatus(manualRes)
      ? parseHttpLastModified(manualRes.headers?.get?.('last-modified'))
      : undefined;
    const location = manualRes.headers?.get?.('location');
    if (location && /^https?:\/\//i.test(location)) {
      await manualRes.body?.cancel().catch(() => {});
      let pageTitle: string | undefined;
      let finalLocation = location;
      if (!isLowSignalGroundingUrl(location)) {
        try {
          const destRes = await globalThis.fetch(location, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(2500),
            headers: {
              ...headers,
              Range: 'bytes=0-16383',
            },
          });
          if (destRes?.url && /^https?:\/\//i.test(destRes.url)) {
            finalLocation = destRes.url;
          }
          if (!lastModified && isNonErrorStatus(destRes)) {
            lastModified = parseHttpLastModified(destRes?.headers?.get?.('last-modified'));
          }
          const destMeta = await inspectResponseMetadata(
            destRes,
            finalLocation,
            Boolean(lastModified)
          );
          pageTitle = destMeta.pageTitle;
          if (!lastModified && destMeta.docModified) {
            lastModified = destMeta.docModified;
          }
          await destRes?.body?.cancel().catch(() => {});
        } catch {
          // Ignore unreachable third-party servers or timeout during opportunistic title/header check
        }
      }
      return { url: finalLocation, lastModified, ...(pageTitle ? { pageTitle } : {}) };
    }
    const directMeta = await inspectResponseMetadata(
      manualRes,
      manualRes.url || url,
      Boolean(lastModified)
    );
    if (!lastModified && directMeta.docModified) {
      lastModified = directMeta.docModified;
    }
    await manualRes.body?.cancel().catch(() => {});
    const isDirect2xx =
      typeof manualRes.status === 'number' && manualRes.status >= 200 && manualRes.status < 300;
    if (isDirect2xx || lastModified || directMeta.pageTitle) {
      return {
        url: manualRes.url || url,
        lastModified,
        ...(directMeta.pageTitle ? { pageTitle: directMeta.pageTitle } : {}),
      };
    }
  } catch {
    // Fall through to follow mode if manual hop check fails
  }

  try {
    const followRes = await globalThis.fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
      headers,
    });
    let lastModified = isNonErrorStatus(followRes)
      ? parseHttpLastModified(followRes.headers?.get?.('last-modified'))
      : undefined;
    const followMeta = await inspectResponseMetadata(
      followRes,
      followRes.url || url,
      Boolean(lastModified)
    );
    if (!lastModified && followMeta.docModified) {
      lastModified = followMeta.docModified;
    }
    await followRes.body?.cancel().catch(() => {});
    return {
      url: followRes.url || url,
      lastModified,
      ...(followMeta.pageTitle ? { pageTitle: followMeta.pageTitle } : {}),
    };
  } catch {
    return { url };
  }
}

export type TrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';

export interface OKFActorEvent {
  by: string;
  at?: string;
}

export interface OKFSource {
  id?: string;
  resource: string;
  url?: string;
  title?: string;
  retrieved_at?: string;
  last_modified?: string;
  author?: string;
  usage_count?: number;
  usage_window?: { from: string; to: string };
}

export interface OKFFrontmatter {
  okf_version?: string;
  type?: string;
  resource?: string;
  title?: string;
  description?: string;
  tags?: string[];
  status?: 'draft' | 'stable' | 'deprecated' | string;
  runtime?: string;
  parameters?: Array<{ name: string; type: string; required?: boolean }>;
  computation?: string;
  executor?: { resource: string; receipt?: string[] };
  attester?: { resource: string };
  generated?: OKFActorEvent;
  verified?: OKFActorEvent | OKFActorEvent[];
  stale_after?: string;
  sources?: OKFSource[];
  usage_window?: { from: string; to: string };
  [key: string]: any;
}

export interface OKFDocument {
  frontmatter: OKFFrontmatter;
  body: string;
}

export const RESERVED_OKF_FILENAMES = new Set(['index.md', 'log.md']);

const PREFERRED_OKF_KEY_ORDER = [
  'okf_version',
  'type',
  'resource',
  'title',
  'description',
  'tags',
  'status',
  'runtime',
  'parameters',
  'computation',
  'executor',
  'attester',
  'generated',
  'verified',
  'stale_after',
  'sources',
  'usage_window',
];

const PREFERRED_OKF_SOURCE_KEY_ORDER = [
  'id',
  'resource',
  'title',
  'retrieved_at',
  'last_modified',
  'author',
  'usage_count',
  'usage_window',
];

function stripYamlComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && raw[i - 1] !== '\\') {
      inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(raw[i - 1])) {
        return raw.slice(0, i).trimEnd();
      }
    }
  }
  return raw.trim();
}

function splitYamlFlowItems(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let depthBracket = 0;
  let depthBrace = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle && inner[i - 1] !== '\\') {
      inDouble = !inDouble;
      current += ch;
    } else if (!inSingle && !inDouble) {
      if (ch === '[') {
        depthBracket++;
        current += ch;
      } else if (ch === ']') {
        depthBracket = Math.max(0, depthBracket - 1);
        current += ch;
      } else if (ch === '{') {
        depthBrace++;
        current += ch;
      } else if (ch === '}') {
        depthBrace = Math.max(0, depthBrace - 1);
        current += ch;
      } else if (ch === ',' && depthBracket === 0 && depthBrace === 0) {
        if (current.trim() !== '') items.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') items.push(current.trim());
  return items;
}

function parseYamlScalar(rawInput: string): any {
  const s = stripYamlComment(rawInput);
  if (s === '') return '';
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(s)) {
    return parseInt(s, 10);
  }
  if (/^-?\d+\.\d+$/.test(s)) {
    return parseFloat(s);
  }
  // Keep ISO 8601 timestamps and strings as literal strings (OKF v0.2 YAML 1.2 convention)
  return s;
}

function findUnquotedColon(pair: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < pair.length; i++) {
    const ch = pair[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && pair[i - 1] !== '\\') {
      inDouble = !inDouble;
    } else if (ch === ':' && !inSingle && !inDouble) {
      if (i + 1 >= pair.length || /\s/.test(pair[i + 1])) {
        return i;
      }
    }
  }
  return pair.indexOf(':');
}

function parseYamlFlowValue(rawInput: string): any {
  const s = stripYamlComment(rawInput);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitYamlFlowItems(inner).map((item) => parseYamlFlowValue(item));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const obj: Record<string, any> = {};
    if (!inner) return obj;
    for (const pair of splitYamlFlowItems(inner)) {
      const colonIdx = findUnquotedColon(pair);
      if (colonIdx === -1) continue;
      const k = parseYamlScalar(pair.slice(0, colonIdx).trim());
      const v = parseYamlFlowValue(pair.slice(colonIdx + 1).trim());
      obj[String(k)] = v;
    }
    return obj;
  }
  return parseYamlScalar(s);
}

function matchYamlKeyValue(text: string): { key: string; rest: string } | null {
  const m = text.match(/^([A-Za-z0-9_.\-]+|"[^"]+"|'[^']+'):(?:\s+(.*)|\s*)$/);
  if (!m) return null;
  const rawKey = m[1];
  const key = String(parseYamlScalar(rawKey));
  const rest = (m[2] ?? '').trim();
  return { key, rest };
}

/**
 * Zero-dependency OKF v0.2 YAML frontmatter + Markdown body parser.
 * Supports block mappings, block sequences, flow sequences/mappings, YAML 1.2 block scalars (`|` and `>`),
 * plain multi-line scalars, and leaves ISO 8601 timestamps as exact strings per SPEC.md §5.
 */
export function parseOkfDocument(text: string): OKFDocument {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { frontmatter: {}, body: text };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error('Unterminated YAML frontmatter block in OKF document');
  }

  const rawFmLines = lines.slice(1, endIdx);
  const parsedLines: Array<{
    indent: number;
    text: string;
    rawLine: string;
    isBlankOrComment: boolean;
  }> = [];

  for (const line of rawFmLines) {
    const rawIndent = line.match(/^\s*/)?.[0].length ?? 0;
    const cleaned = stripYamlComment(line);
    const trimmed = cleaned.trim();
    parsedLines.push({
      indent: rawIndent,
      text: trimmed,
      rawLine: line,
      isBlankOrComment: trimmed === '',
    });
  }

  function nextSignificantIndex(fromIdx: number): number {
    let idx = fromIdx;
    while (idx < parsedLines.length && parsedLines[idx].isBlankOrComment) {
      idx++;
    }
    return idx;
  }

  function parseBlockScalar(
    startIndex: number,
    parentIndent: number,
    style: '|' | '>',
    chomp: '-' | '+' | ''
  ): { value: string; nextIndex: number } {
    const contentLines: Array<{ isBlank: boolean; raw: string; indent: number }> = [];
    let i = startIndex;
    let blockIndent = -1;

    while (i < parsedLines.length) {
      const entry = parsedLines[i];
      const isTrulyEmpty = entry.rawLine.trim() === '';
      if (isTrulyEmpty) {
        contentLines.push({ isBlank: true, raw: '', indent: 0 });
        i++;
        continue;
      }
      if (entry.indent <= parentIndent) {
        break;
      }
      if (blockIndent === -1) {
        blockIndent = entry.indent;
      }
      const sliced =
        entry.rawLine.length >= blockIndent
          ? entry.rawLine.slice(blockIndent)
          : entry.rawLine.trimStart();
      contentLines.push({ isBlank: false, raw: sliced, indent: entry.indent });
      i++;
    }

    // Trim trailing blank lines unless chomp === '+'
    while (
      chomp !== '+' &&
      contentLines.length > 0 &&
      contentLines[contentLines.length - 1].isBlank
    ) {
      contentLines.pop();
    }

    if (contentLines.length === 0) {
      return { value: '', nextIndex: i };
    }

    let result = '';
    if (style === '|') {
      result = contentLines.map((l) => (l.isBlank ? '' : l.raw)).join('\n');
    } else {
      // Folded style (`>`): single newlines between normal lines fold into spaces; blank lines become paragraph breaks
      const paragraphs: string[] = [];
      let currentPara: string[] = [];
      for (const l of contentLines) {
        if (l.isBlank) {
          if (currentPara.length > 0) {
            paragraphs.push(currentPara.join(' '));
            currentPara = [];
          }
          paragraphs.push('');
        } else {
          currentPara.push(l.raw.trimEnd());
        }
      }
      if (currentPara.length > 0) {
        paragraphs.push(currentPara.join(' '));
      }
      result = paragraphs.join('\n').replace(/\n{2,}/g, '\n\n');
    }

    if (chomp === '+') {
      result = `${result}\n`;
    }
    return { value: result, nextIndex: i };
  }

  function parseKeyValueChild(
    kvRest: string,
    currentLineIdx: number,
    parentIndent: number
  ): { value: any; nextIndex: number } {
    const blockScalarMatch = kvRest.match(/^([|>])([+\-])?$/);
    if (blockScalarMatch) {
      return parseBlockScalar(
        currentLineIdx + 1,
        parentIndent,
        blockScalarMatch[1] as '|' | '>',
        (blockScalarMatch[2] || '') as '-' | '+' | ''
      );
    }

    if (kvRest !== '') {
      return { value: parseYamlFlowValue(kvRest), nextIndex: currentLineIdx + 1 };
    }

    const nextIdx = nextSignificantIndex(currentLineIdx + 1);
    if (nextIdx < parsedLines.length && parsedLines[nextIdx].indent > parentIndent) {
      return parseYamlNode(nextIdx, parsedLines[nextIdx].indent);
    }
    return { value: '', nextIndex: nextIdx };
  }

  function parseYamlNode(
    startIndex: number,
    minIndent: number
  ): { value: any; nextIndex: number } {
    const firstIdx = nextSignificantIndex(startIndex);
    if (firstIdx >= parsedLines.length) {
      return { value: {}, nextIndex: firstIdx };
    }
    const first = parsedLines[firstIdx];
    if (first.indent < minIndent) {
      return { value: {}, nextIndex: firstIdx };
    }

    // Sequence block (`- ...`)
    if (first.text === '-' || first.text.startsWith('- ')) {
      const arr: any[] = [];
      const seqIndent = first.indent;
      let i = firstIdx;

      while (i < parsedLines.length) {
        i = nextSignificantIndex(i);
        if (i >= parsedLines.length) break;
        const cur = parsedLines[i];
        if (cur.indent < seqIndent) break;
        if (cur.indent > seqIndent) {
          i++;
          continue;
        }
        if (cur.text !== '-' && !cur.text.startsWith('- ')) break;

        const itemRest = cur.text.slice(1).trim();
        if (!itemRest) {
          const nextIdx = nextSignificantIndex(i + 1);
          if (nextIdx < parsedLines.length && parsedLines[nextIdx].indent > seqIndent) {
            const child = parseYamlNode(nextIdx, parsedLines[nextIdx].indent);
            arr.push(child.value);
            i = child.nextIndex;
          } else {
            arr.push(null);
            i = nextIdx;
          }
          continue;
        }

        const itemBlockMatch = itemRest.match(/^([|>])([+\-])?$/);
        if (itemBlockMatch) {
          const child = parseBlockScalar(
            i + 1,
            seqIndent,
            itemBlockMatch[1] as '|' | '>',
            (itemBlockMatch[2] || '') as '-' | '+' | ''
          );
          arr.push(child.value);
          i = child.nextIndex;
          continue;
        }

        if (itemRest.startsWith('{') || itemRest.startsWith('[')) {
          arr.push(parseYamlFlowValue(itemRest));
          i++;
          continue;
        }

        const kv = matchYamlKeyValue(itemRest);
        if (kv) {
          const itemObj: Record<string, any> = {};
          const itemPropIndent = seqIndent + 2;
          const firstProp = parseKeyValueChild(kv.rest, i, seqIndent);
          itemObj[kv.key] = firstProp.value;
          i = firstProp.nextIndex;

          while (i < parsedLines.length) {
            i = nextSignificantIndex(i);
            if (i >= parsedLines.length) break;
            const propLine = parsedLines[i];
            if (propLine.indent <= seqIndent) break;
            if (
              propLine.indent === seqIndent &&
              (propLine.text === '-' || propLine.text.startsWith('- '))
            ) {
              break;
            }
            const propKv = matchYamlKeyValue(propLine.text);
            if (!propKv) {
              i++;
              continue;
            }
            const propRes = parseKeyValueChild(
              propKv.rest,
              i,
              Math.max(propLine.indent, itemPropIndent - 1)
            );
            itemObj[propKv.key] = propRes.value;
            i = propRes.nextIndex;
          }
          arr.push(itemObj);
          continue;
        }

        arr.push(parseYamlFlowValue(itemRest));
        i++;
      }

      return { value: arr, nextIndex: i };
    }

    // Plain multi-line continuation scalar (indented lines that are neither `-` nor `key: value`)
    if (!matchYamlKeyValue(first.text)) {
      const scalarParts: string[] = [];
      const scalarIndent = first.indent;
      let i = firstIdx;
      while (i < parsedLines.length) {
        i = nextSignificantIndex(i);
        if (i >= parsedLines.length) break;
        const cur = parsedLines[i];
        if (cur.indent < scalarIndent) break;
        if (
          cur.text === '-' ||
          cur.text.startsWith('- ') ||
          Boolean(matchYamlKeyValue(cur.text))
        ) {
          break;
        }
        scalarParts.push(cur.text);
        i++;
      }
      return { value: parseYamlScalar(scalarParts.join(' ')), nextIndex: i };
    }

    // Mapping block (`key: ...`)
    const obj: Record<string, any> = {};
    const mapIndent = first.indent;
    let i = firstIdx;

    while (i < parsedLines.length) {
      i = nextSignificantIndex(i);
      if (i >= parsedLines.length) break;
      const cur = parsedLines[i];
      if (cur.indent < mapIndent) break;
      if (cur.text === '-' || cur.text.startsWith('- ')) break;
      const kv = matchYamlKeyValue(cur.text);
      if (!kv) {
        i++;
        continue;
      }

      const childRes = parseKeyValueChild(kv.rest, i, cur.indent);
      obj[kv.key] = childRes.value;
      i = childRes.nextIndex;
    }

    return { value: obj, nextIndex: i };
  }

  const firstSigIdx = nextSignificantIndex(0);
  const rootParsed =
    firstSigIdx < parsedLines.length
      ? parseYamlNode(firstSigIdx, parsedLines[firstSigIdx].indent).value
      : {};
  if (!rootParsed || typeof rootParsed !== 'object' || Array.isArray(rootParsed)) {
    throw new Error('OKF frontmatter must be a YAML mapping');
  }

  let body = lines.slice(endIdx + 1).join('\n');
  if (body.startsWith('\n')) {
    body = body.slice(1);
  }

  return {
    frontmatter: rootParsed as OKFFrontmatter,
    body,
  };
}

function formatYamlScalar(val: any, inFlowContext: boolean = false): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  const s = String(val);
  if (s === '') return '""';
  const needsQuotes =
    /[:#\[\]{}&*!|>'"%@`\-?]/.test(s[0]) ||
    s.endsWith(':') ||
    /:\s/.test(s) ||
    /\s#/.test(s) ||
    /[\r\n\t]/.test(s) ||
    /^\s|\s$/.test(s) ||
    (inFlowContext && /[,[\]{}]/.test(s)) ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(s);
  if (needsQuotes) {
    return `"${s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')}"`;
  }
  return s;
}

function serializeYamlKeyValue(key: string, val: any, indent: string = ''): string[] {
  if (val === undefined) return [];
  if (val === null || typeof val === 'boolean' || typeof val === 'number' || typeof val === 'string') {
    if (key === 'okf_version') {
      return [`${indent}${key}: "${String(val).replace(/"/g, '')}"`];
    }
    const normalizedScalar =
      typeof val === 'string' &&
      (key === 'retrieved_at' || key === 'last_modified' || key === 'stale_after' || key === 'at')
        ? normalizeIsoTimestamp(val)
        : val;
    return [`${indent}${key}: ${formatYamlScalar(normalizedScalar)}`];
  }

  if (Array.isArray(val)) {
    if (val.length === 0) {
      return [`${indent}${key}: []`];
    }
    const allScalars = val.every(
      (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
    );
    if (allScalars) {
      return [`${indent}${key}: [${val.map((v) => formatYamlScalar(v, true)).join(', ')}]`];
    }
    const lines = [`${indent}${key}:`];
    for (const item of val) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const rawKeys = Object.keys(item).filter((k) => item[k] !== undefined);
        const keys =
          key === 'sources'
            ? [
                ...PREFERRED_OKF_SOURCE_KEY_ORDER.filter((k) => rawKeys.includes(k)),
                ...rawKeys.filter((k) => !PREFERRED_OKF_SOURCE_KEY_ORDER.includes(k)),
              ]
            : rawKeys;
        // Compact inline mapping for { by, at } or { name, type, required }
        if (
          keys.length <= 3 &&
          keys.every(
            (k) =>
              ['by', 'at', 'name', 'type', 'required', 'from', 'to'].includes(k) &&
              (item[k] === null ||
                typeof item[k] === 'string' ||
                typeof item[k] === 'number' ||
                typeof item[k] === 'boolean')
          )
        ) {
          const pairs = keys
            .map((k) => {
              const rawItemVal = item[k];
              const normItemVal =
                typeof rawItemVal === 'string' && (k === 'at' || k === 'from' || k === 'to')
                  ? normalizeIsoTimestamp(rawItemVal)
                  : rawItemVal;
              return `${k}: ${formatYamlScalar(normItemVal, true)}`;
            })
            .join(', ');
          lines.push(`${indent}  - { ${pairs} }`);
        } else {
          keys.forEach((k, idx) => {
            const prefix = idx === 0 ? `${indent}  - ` : `${indent}    `;
            const rawV = item[k];
            const v =
              typeof rawV === 'string' &&
              (k === 'retrieved_at' || k === 'last_modified' || k === 'stale_after' || k === 'at')
                ? normalizeIsoTimestamp(rawV)
                : rawV;
            if (Array.isArray(v)) {
              const vScalars = v.every(
                (sub) =>
                  typeof sub === 'string' || typeof sub === 'number' || typeof sub === 'boolean'
              );
              if (v.length === 0) {
                lines.push(`${prefix}${k}: []`);
              } else if (vScalars) {
                lines.push(
                  `${prefix}${k}: [${v.map((sub) => formatYamlScalar(sub, true)).join(', ')}]`
                );
              } else {
                const subLines = serializeYamlKeyValue(k, v, `${indent}    `);
                if (idx === 0 && subLines.length > 0) {
                  lines.push(`${indent}  - ${subLines[0].trimStart()}`);
                  lines.push(...subLines.slice(1));
                } else {
                  lines.push(...subLines);
                }
              }
            } else if (v && typeof v === 'object') {
              const subEntries = Object.entries(v).filter(([, sv]) => sv !== undefined);
              const allSubScalars = subEntries.every(
                ([, sv]) =>
                  sv === null ||
                  typeof sv === 'string' ||
                  typeof sv === 'number' ||
                  typeof sv === 'boolean'
              );
              if (subEntries.length === 0) {
                lines.push(`${prefix}${k}: {}`);
              } else if (allSubScalars && subEntries.length <= 4) {
                const subPairs = subEntries
                  .map(([sk, sv]) => {
                    const normSv =
                      typeof sv === 'string' && (sk === 'at' || sk === 'from' || sk === 'to')
                        ? normalizeIsoTimestamp(sv)
                        : sv;
                    return `${sk}: ${formatYamlScalar(normSv, true)}`;
                  })
                  .join(', ');
                lines.push(`${prefix}${k}: { ${subPairs} }`);
              } else {
                const subLines = serializeYamlKeyValue(k, v, `${indent}    `);
                if (idx === 0 && subLines.length > 0) {
                  lines.push(`${indent}  - ${subLines[0].trimStart()}`);
                  lines.push(...subLines.slice(1));
                } else {
                  lines.push(...subLines);
                }
              }
            } else {
              lines.push(`${prefix}${k}: ${formatYamlScalar(v)}`);
            }
          });
        }
      } else {
        lines.push(`${indent}  - ${formatYamlScalar(item)}`);
      }
    }
    return lines;
  }

  if (typeof val === 'object') {
    const entries = Object.entries(val).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return [`${indent}${key}: {}`];
    const isCompactActorOrWindow = entries.every(
      ([k, v]) =>
        ['by', 'at', 'from', 'to'].includes(k) &&
        (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    );
    if (isCompactActorOrWindow) {
      const pairs = entries
        .map(([k, v]) => {
          const normV =
            typeof v === 'string' && (k === 'at' || k === 'from' || k === 'to')
              ? normalizeIsoTimestamp(v)
              : v;
          return `${k}: ${formatYamlScalar(normV, true)}`;
        })
        .join(', ');
      return [`${indent}${key}: { ${pairs} }`];
    }
    const lines = [`${indent}${key}:`];
    for (const [subKey, subVal] of entries) {
      lines.push(...serializeYamlKeyValue(subKey, subVal, `${indent}  `));
    }
    return lines;
  }

  return [`${indent}${key}: ${formatYamlScalar(val)}`];
}

/**
 * Serializes an OKFDocument into UTF-8 Markdown with ordered YAML frontmatter (`SPEC.md` §4).
 */
export function serializeOkfDocument(doc: OKFDocument): string {
  const fm = doc.frontmatter || {};
  const orderedKeys: string[] = [];
  for (const key of PREFERRED_OKF_KEY_ORDER) {
    if (key in fm && fm[key] !== undefined) {
      orderedKeys.push(key);
    }
  }
  for (const key of Object.keys(fm)) {
    if (!orderedKeys.includes(key) && fm[key] !== undefined) {
      orderedKeys.push(key);
    }
  }

  const fmLines: string[] = [];
  for (const key of orderedKeys) {
    fmLines.push(...serializeYamlKeyValue(key, fm[key]));
  }

  const trimmedBody = (doc.body || '').replace(/^\r?\n+/, '');
  const finalBody = trimmedBody.endsWith('\n') ? trimmedBody : `${trimmedBody}\n`;
  if (fmLines.length === 0) {
    return finalBody;
  }
  return `---\n${fmLines.join('\n')}\n---\n\n${finalBody}`;
}

/**
 * Validates OKF v0.2 conformance (`SPEC.md` §11: `type` is required).
 */
export function validateOkfDocument(doc: OKFDocument): void {
  const typeVal = doc.frontmatter?.type;
  if (!typeVal || typeof typeVal !== 'string' || !typeVal.trim()) {
    throw new Error('Missing required OKF v0.2 frontmatter key: type');
  }
}

/**
 * Normalizes `verified` frontmatter into an array of `{ by, at }` objects (`SPEC.md` §5.2 & §11).
 * A bare `{ by, at }` mapping is treated as a single-element list.
 */
export function normalizeVerified(frontmatter: Record<string, any>): OKFActorEvent[] {
  const verified = frontmatter?.verified;
  if (!verified) return [];
  if (Array.isArray(verified)) {
    return verified.filter((v) => v && typeof v === 'object' && typeof v.by === 'string');
  }
  if (typeof verified === 'object' && typeof verified.by === 'string') {
    return [verified as OKFActorEvent];
  }
  return [];
}

/**
 * Derives an OKF v0.2 trust tier from `verified` (`SPEC.md` §5.3):
 * - No `verified` key => `'unverified'`
 * - `verified` by non-`human:` actors only => `'machine-confirmed'`
 * - `verified` by any `human:<id>` actor => `'human-reviewed'`
 */
export function getOkfTrustTier(frontmatter: Record<string, any>): TrustTier {
  const events = normalizeVerified(frontmatter);
  if (events.length === 0) return 'unverified';
  for (const event of events) {
    const by = String(event?.by || '');
    if (by.startsWith('human:')) {
      return 'human-reviewed';
    }
  }
  return 'machine-confirmed';
}

export const trust_tier = getOkfTrustTier;

/**
 * Evaluates whether an OKF v0.2 concept is stale (`now >= stale_after` per `SPEC.md` §5.5).
 * Requires an ISO 8601 datetime with `T` and an explicit timezone offset (`Z` or `[+-]HH:MM`),
 * or a date-only `YYYY-MM-DD` string normalized to `YYYY-MM-DDT00:00:00Z`.
 */
export function isOkfStale(frontmatter: Record<string, any>, now?: Date): boolean {
  const rawInput = String(frontmatter?.stale_after || '').trim();
  if (!rawInput) return false;
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(rawInput) ? `${rawInput}T00:00:00Z` : rawInput;
  if (!raw.includes('T')) return false;
  if (!/(Z|[+\-]\d{2}:?\d{2})$/i.test(raw)) return false;
  const staleAfterMs = Date.parse(raw);
  if (Number.isNaN(staleAfterMs)) return false;
  const nowMs = (now ?? new Date()).getTime();
  return nowMs >= staleAfterMs;
}

export const is_stale = isOkfStale;

export function transliterateNordicAscii(str: string): string {
  return String(str || '')
    .replace(/æ/g, 'ae')
    .replace(/Æ/g, 'Ae')
    .replace(/ø/g, 'o')
    .replace(/Ø/g, 'O')
    .replace(/å/g, 'a')
    .replace(/Å/g, 'A')
    .replace(/ä/g, 'a')
    .replace(/Ä/g, 'A')
    .replace(/ö/g, 'o')
    .replace(/Ö/g, 'O')
    .replace(/ü/g, 'u')
    .replace(/Ü/g, 'U')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function truncateSlugAtWordBoundary(
  rawSlug: string,
  maxLen: number,
  minSnapPos = 12
): string {
  const clean = String(rawSlug || '').replace(/^-+|-+$/g, '');
  if (clean.length <= maxLen) {
    return clean;
  }
  const sliced = clean.slice(0, maxLen);
  if (clean[maxLen] === '-') {
    return sliced.replace(/-+$/g, '');
  }
  const lastDash = sliced.lastIndexOf('-');
  if (lastDash >= minSnapPos) {
    return sliced.slice(0, lastDash).replace(/-+$/g, '');
  }
  return sliced.replace(/-+$/g, '');
}

function generateSourceSlugId(
  titleOrUrl: string,
  resourceUrl: string,
  usedIds: Set<string>
): string {
  let base = transliterateNordicAscii(titleOrUrl)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base || base.length < 2) {
    try {
      base = new URL(resourceUrl).hostname
        .replace(/^www\./, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    } catch {
      base = 'source';
    }
  }
  const words = base.split('-').filter(Boolean).slice(0, 4);
  base = truncateSlugAtWordBoundary(words.join('-'), 32) || 'source';

  let candidate = base;
  let counter = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter++;
  }
  usedIds.add(candidate);
  return candidate;
}

function isVertexRedirectUrl(url?: string): boolean {
  return typeof url === 'string' && url.includes('vertexaisearch.cloud.google.com/grounding-api-redirect/');
}

/**
 * Normalizes a source URL for canonical cross-concept / cross-run deduplication:
 * - Lowercases protocol and hostname
 * - Strips leading `www.`
 * - Strips URL fragment (`#hash`)
 * - Strips trailing `/` on non-root pathnames
 */
export function normalizeCanonicalSourceUrl(rawUrl?: string): string {
  const s = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(s) || isVertexRedirectUrl(s)) return '';
  try {
    const u = new URL(s);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.hash = '';
    for (const k of Array.from(u.searchParams.keys())) {
      if (/^(?:utm_|fbclid$|gclid$)/i.test(k)) {
        u.searchParams.delete(k);
      }
    }
    if (u.pathname.length > 1) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.toString();
  } catch {
    return s;
  }
}

function normalizeSourceMatchKey(input?: string): string {
  return transliterateNordicAscii(String(input || ''))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*\(alternativ indeks\)\s*$/i, '')
    .replace(/^\*\*|\*\*$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const SOURCE_MATCH_STOPWORDS = new Set([
  'http',
  'https',
  'www',
  'com',
  'org',
  'net',
  'html',
  'htm',
  'pdf',
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'med',
  'som',
  'til',
  'fra',
  'over',
  'under',
  'ved',
  'hos',
  'alle',
]);

function extractSourceMatchTokens(input?: string): string[] {
  return normalizeSourceMatchKey(input)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !SOURCE_MATCH_STOPWORDS.has(t));
}

function collectExistingBundleSources(bundleRoot: string): OKFSource[] {
  const resolvedRoot = path.resolve(bundleRoot);
  if (!fs.existsSync(resolvedRoot)) return [];
  const out: OKFSource[] = [];
  const scanDir = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        !RESERVED_OKF_FILENAMES.has(entry.name)
      ) {
        try {
          const doc = parseOkfDocument(fs.readFileSync(full, 'utf-8'));
          if (Array.isArray(doc.frontmatter?.sources)) {
            for (const s of doc.frontmatter.sources) {
              const rawRes = s && typeof s === 'object' ? String(s.resource || (s as any).url || '').trim() : '';
              if (
                rawRes &&
                /^https?:\/\//i.test(rawRes) &&
                !isVertexRedirectUrl(rawRes)
              ) {
                out.push({
                  id: s.id ? String(s.id) : undefined,
                  resource: rawRes,
                  title: s.title ? decodeHtmlEntities(String(s.title)) : undefined,
                  retrieved_at: parseValidIsoTimestamp(s.retrieved_at),
                  last_modified: parseValidIsoTimestamp(s.last_modified),
                });
              }
            }
          }
        } catch {
          // Ignore unreadable concept files
        }
      }
    }
  };
  scanDir(resolvedRoot);
  return out;
}

export interface CleanGroundingOptions {
  topic?: string;
  model?: string;
  generatedBy?: string;
  generatedAt?: string;
  staleAfter?: string;
  staleAfterDays?: number;
  type?: string;
  status?: 'draft' | 'stable' | 'deprecated';
  tags?: string[];
  workspaceRoot?: string;
  bundleRoot?: string;
}

const LOW_SIGNAL_GROUNDING_DOMAINS = new Set([
  'quora.com',
  'reddit.com',
  'old.reddit.com',
  'instagram.com',
  'facebook.com',
  'tiktok.com',
  'pinterest.com',
  'x.com',
  'twitter.com',
  'threads.net',
  'edubirdie.com',
  'gradesfixer.com',
  'bartleby.com',
  'studymode.com',
  'ukessays.com',
  'studocu.com',
  'coursehero.com',
  'chegg.com',
  'scribd.com',
  'issuu.com',
  'bandladder.com',
  'vocal.media',
]);

export function isLowSignalGroundingUrl(url?: string): boolean {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return false;
  try {
    const host = new URL(clean).hostname.toLowerCase().replace(/^www\./, '');
    if (LOW_SIGNAL_GROUNDING_DOMAINS.has(host)) return true;
    for (const domain of LOW_SIGNAL_GROUNDING_DOMAINS) {
      if (host.endsWith(`.${domain}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isAutoLowSignalSourceEntry(s: OKFSource): boolean {
  const srcUrl = s ? String(s.resource || s.url || '').trim() : '';
  if (!s || !isLowSignalGroundingUrl(srcUrl)) return false;
  const id = String(s.id || '').trim();
  const title = String(s.title || '').trim();
  if (
    /^(?:src|quora|reddit|old-reddit|instagram|facebook|tiktok|pinterest|x|twitter|threads|edubirdie|gradesfixer|bartleby|studymode|ukessays|studocu|coursehero|chegg|scribd|issuu|bandladder|vocal)(?:-(?:com|org|net|media))?(?:-\d+)?$/i.test(
      id
    )
  ) {
    return true;
  }
  if (!title || isBareDomainTitle(title) || isAutoDomainSlugTitle(title)) {
    return true;
  }
  return false;
}

export function stripFootnotesPreservingWordBoundaries(text: string): string {
  return String(text || '').replace(
    /(?:\[\^[^\r\n\]]+\][ \t]*)+/g,
    (match: string, offset: number, str: string) => {
      const beforeChar = offset > 0 ? str[offset - 1] : '';
      const afterIdx = offset + match.length;
      const afterChar = afterIdx < str.length ? str[afterIdx] : '';
      if (
        beforeChar &&
        afterChar &&
        /[\p{L}\p{N}]/u.test(beforeChar) &&
        /[\p{L}\p{N}]/u.test(afterChar)
      ) {
        return ' ';
      }
      if (/[ \t]$/.test(match) && beforeChar && !/\s/.test(beforeChar) && afterChar && !/\s/.test(afterChar)) {
        return ' ';
      }
      return '';
    }
  );
}

function removeSpecificFootnotePreservingBoundary(text: string, fnId: string): string {
  const escaped = fnId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\[\\^${escaped}\\]`, 'g');
  return text.replace(re, (match: string, offset: number, str: string) => {
    const beforeChar = offset > 0 ? str[offset - 1] : '';
    const afterIdx = offset + match.length;
    const afterChar = afterIdx < str.length ? str[afterIdx] : '';
    if (
      beforeChar &&
      afterChar &&
      /[\p{L}\p{N}]/u.test(beforeChar) &&
      /[\p{L}\p{N}]/u.test(afterChar)
    ) {
      return ' ';
    }
    return '';
  });
}

function isBareDomainTitle(title?: string): boolean {
  const t = String(title || '').trim();
  if (!t) return true;
  if (/^(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}\/?$/i.test(t)) {
    return true;
  }
  if (
    /^(?:id\d+|\w*servlet|legosh(?:[_ ][a-z]{2})?|downloads?|files?|assets|media|documents?|docs|articles?|pages?|view|pdf|pmc|fulltext|abs|paperinformation|index|default)$/i.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\s+[—–-]\s+(?:id\d+|\w*servlet|legosh(?:[_ ][a-z]{2})?|downloads?|files?|assets|media|documents?|docs|articles?|pages?|view|pdf|pmc|fulltext|abs|paperinformation)$/i.test(
      t
    )
  ) {
    return true;
  }
  const autoSlugMatch = t.match(/^[a-z0-9.-]+\.[a-z]{2,}\s+[—–-]\s+(.+)$/i);
  if (autoSlugMatch) {
    const slugPart = autoSlugMatch[1].trim();
    if (
      slugPart.length <= 1 ||
      /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)\s+\d/i.test(slugPart) ||
      /^[^\p{L}]+[\p{Ll}]/u.test(slugPart) ||
      /^\d{4}\.\d{4,5}(?:v\d+)?$/i.test(slugPart) ||
      /^(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[_-\s]+/i.test(
        slugPart
      ) ||
      /^(?:id\d+|\w*servlet|legosh(?:[_ ][a-z]{2})?|downloads?|files?|assets|media|documents?|docs|articles?|pages?|view|pdf|pmc|fulltext|abs|paperinformation)$/i.test(
        slugPart
      ) ||
      (!/[\s_-]/.test(slugPart) &&
        slugPart.length >= 6 &&
        slugPart.length <= 16 &&
        /[A-Z]/.test(slugPart) &&
        /[a-z]/.test(slugPart) &&
        (/\d/.test(slugPart) || /[a-z][A-Z]/.test(slugPart)))
    ) {
      return true;
    }
  }
  return false;
}

export function enrichBareDomainSourceTitle(
  rawTitle: string | undefined,
  resourceUrl: string
): string {
  const cleanTitle = decodeHtmlEntities(String(rawTitle || '')).trim();
  const cleanUrl = String(resourceUrl || '').trim();
  if (!isBareDomainTitle(cleanTitle) && cleanTitle !== cleanUrl) {
    if (
      /^[\p{L}\p{N}]{1,15}$/u.test(cleanTitle) &&
      /\p{L}/u.test(cleanTitle) &&
      /^https?:\/\//i.test(cleanUrl) &&
      !isVertexRedirectUrl(cleanUrl)
    ) {
      try {
        const host = new URL(cleanUrl).hostname.replace(/^www\./i, '');
        const domain = /^assets\.website-files\.com$/i.test(host) ? 'website-files.com' : host;
        const domainParts = domain.toLowerCase().split('.').slice(0, -1);
        const domainStem =
          domainParts.length >= 2 && /^(?:co|gov|org|ac|edu|net)$/.test(domainParts[domainParts.length - 1])
            ? domainParts[domainParts.length - 2]
            : domainParts.length > 0
              ? domainParts[domainParts.length - 1]
              : '';
        const lowerTitle = cleanTitle.toLowerCase();
        const matchesDomainStem =
          Boolean(domainStem) &&
          (lowerTitle === domainStem || (domainStem.length >= 4 && lowerTitle.includes(domainStem)));
        if (
          domain &&
          !lowerTitle.includes(domain.toLowerCase()) &&
          !matchesDomainStem
        ) {
          return `${domain} — ${cleanTitle}`;
        }
      } catch {
        // Fall through and return cleanTitle
      }
    }
    return cleanTitle;
  }
  if (!/^https?:\/\//i.test(cleanUrl) || isVertexRedirectUrl(cleanUrl)) {
    return cleanTitle || cleanUrl;
  }
  try {
    const parsed = new URL(cleanUrl);
    const domainPrefixMatch = cleanTitle.match(/^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/i);
    const rawHost = domainPrefixMatch
      ? domainPrefixMatch[1].replace(/^www\./i, '')
      : parsed.hostname.replace(/^www\./i, '');
    const domain = /^assets\.website-files\.com$/i.test(rawHost)
      ? 'website-files.com'
      : rawHost;

    if (/^(?:export\.)?arxiv\.org$/i.test(domain)) {
      const arxivMatch = parsed.pathname.match(/(\d{4}\.\d{4,5}(?:v\d+)?)/i);
      if (arxivMatch) {
        return `arxiv.org — arXiv:${arxivMatch[1].replace(/V(\d+)$/, 'v$1')}`;
      }
    }

    const rawSegments = parsed.pathname
      .split('/')
      .map((s) => {
        try {
          return decodeURIComponent(s).trim();
        } catch {
          return s.trim();
        }
      })
      .filter(
        (s) =>
          s.length > 0 &&
          s !== '-' &&
          !/^(?:index|default)\.(?:html?|aspx?|php)$/i.test(s)
      );

    const isOracleApexPath =
      /\/f$/i.test(parsed.pathname) && parsed.searchParams.has('p');

    const isOpaqueOrBucket = (seg: string): boolean => {
      if (isOracleApexPath) {
        return true;
      }
      const noExt = seg.replace(/\.(?:pdf|html?|aspx?|php|md|docx?)$/i, '');
      if (
        /^(?:_f|p\d+|no|nb|nn|en|wiki|globalassets|contentassets|wp-content|uploads|dyn|pls|ords|apex|legosh(?:_[a-z]{2})?|downloads?|files?|assets|media|documents?|docs|articles?|pages?|view|pdf|pmc|fulltext|abs|reel|p|tv)$/i.test(
          noExt
        )
      ) {
        return true;
      }
      if (/^id\d+$/i.test(noExt) || /servlet$/i.test(noExt)) {
        return true;
      }
      if (/^[a-z]$/i.test(noExt) || /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i.test(noExt)) {
        return true;
      }
      if (
        (/^i\d{6,}$/i.test(noExt) ||
          (/^[0-9a-f]{8,}(?:-[0-9a-f]{4,})*$/i.test(noExt) && /[a-f]/i.test(noExt))) &&
        /\d/.test(noExt)
      ) {
        return true;
      }
      if (
        !/[\s_-]/.test(noExt) &&
        noExt.length >= 6 &&
        noExt.length <= 16 &&
        /[A-Z]/.test(noExt) &&
        /[a-z]/.test(noExt) &&
        (/\d/.test(noExt) || /[a-z][A-Z]/.test(noExt))
      ) {
        return true;
      }
      return false;
    };

    const stripExt = (seg: string): string =>
      seg.replace(/\.(?:pdf|html?|aspx?|php|md|docx?)$/i, '');

    const filteredSegments = rawSegments.filter((s) => !isOpaqueOrBucket(s));
    const meaningful: string[] = [];
    for (const seg of filteredSegments) {
      if (
        meaningful.length > 0 &&
        stripExt(meaningful[meaningful.length - 1]).toLowerCase() === stripExt(seg).toLowerCase()
      ) {
        continue;
      }
      meaningful.push(seg);
    }

    if (meaningful.length === 0) {
      return domain || cleanTitle;
    }

    if (
      meaningful.length >= 2 &&
      stripExt(meaningful[meaningful.length - 1]) === '1' &&
      /\d/.test(meaningful[meaningful.length - 2])
    ) {
      meaningful.pop();
    }

    const lastSeg = stripExt(meaningful[meaningful.length - 1]);
    const prevSeg = meaningful.length >= 2 ? stripExt(meaningful[meaningful.length - 2]) : '';

    let chosenSlug = lastSeg;
    if (/^paperinformation$/i.test(lastSeg)) {
      const paperId = parsed.searchParams.get('paperid') || parsed.searchParams.get('id');
      chosenSlug = paperId ? `Paper ${paperId}` : 'Journal Paper';
    } else if (prevSeg && /^[0-9-]+$/.test(lastSeg)) {
      let alphaIdx = -1;
      for (let k = meaningful.length - 2; k >= 0; k--) {
        if (/[\p{L}]/u.test(stripExt(meaningful[k]))) {
          alphaIdx = k;
          break;
        }
      }
      if (alphaIdx >= 0) {
        const alphaPrev = stripExt(meaningful[alphaIdx]);
        const numericTail = meaningful.slice(alphaIdx + 1).map(stripExt);
        if (numericTail.length >= 2 && /^(?:19|20)\d{2}$/.test(numericTail[0])) {
          chosenSlug = `${alphaPrev} ${numericTail.join('-')}`;
        } else {
          chosenSlug = `${alphaPrev} ${lastSeg}`;
        }
      } else {
        chosenSlug = `${prevSeg} ${lastSeg}`;
      }
    }

    // Strip leading Webflow/CDN 24-hex ObjectId or UUID prefixes from filename slugs
    chosenSlug = chosenSlug.replace(
      /^(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[_-\s]+/i,
      ''
    );

    let humanized = chosenSlug
      .replace(/[+_]+/g, ' ')
      .replace(/(?<!\d)-|-(?!\d)|--+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!humanized || !/[\p{L}]/u.test(humanized)) {
      return domain || cleanTitle;
    }
    humanized = humanized.replace(
      /^(\d+[a-z]\.\s+|[^\p{L}]*)([\p{L}])/u,
      (_m, prefix: string, ch: string) => `${prefix}${ch.toUpperCase()}`
    );
    if (humanized.length > 160) {
      const cut = humanized.slice(0, 158);
      const lastSpace = cut.lastIndexOf(' ');
      humanized = `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
    }
    return `${domain} — ${humanized}`;
  } catch {
    return cleanTitle || cleanUrl;
  }
}

const SOURCE_MATCH_STOP_WORDS = new Set([
  'og',
  'i',
  'til',
  'om',
  'for',
  'av',
  'pa',
  'med',
  'ved',
  'som',
  'en',
  'et',
  'de',
  'den',
  'det',
  'the',
  'and',
  'of',
  'to',
  'in',
  'no',
  'org',
  'com',
  'www',
  'https',
  'http',
  'html',
  'pdf',
]);

function normalizeTextForSourceMatch(raw: string): string {
  return transliterateNordicAscii(String(raw || ''))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function tokenizeForSourceMatch(raw: string): string[] {
  const norm = normalizeTextForSourceMatch(raw);
  const tokens = norm
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !SOURCE_MATCH_STOP_WORDS.has(t));
  const out = new Set<string>(tokens);
  if (out.has('faq')) {
    out.add('ofte');
    out.add('stilte');
    out.add('sporsmal');
  }
  if (out.has('ofte') && out.has('sporsmal')) {
    out.add('faq');
  }
  return Array.from(out);
}

function matchOrphanFootnoteToSource(
  orphanId: string,
  orphanDefLabel: string | undefined,
  sources: OKFSource[]
): OKFSource | null {
  if (!orphanId || !Array.isArray(sources) || sources.length === 0) return null;
  const idTokens = tokenizeForSourceMatch(orphanId);
  const labelTokens =
    orphanDefLabel && orphanDefLabel.trim() !== orphanId.trim()
      ? tokenizeForSourceMatch(orphanDefLabel)
      : [];
  const allOrphanTokens = Array.from(new Set([...idTokens, ...labelTokens]));
  if (allOrphanTokens.length === 0) return null;

  const stripParenthetical = (s?: string): string =>
    normalizeTextForSourceMatch(String(s || '').replace(/\([^)]*\)/g, ''))
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const orphanCleanTitle =
    orphanDefLabel && orphanDefLabel.trim() !== orphanId.trim()
      ? stripParenthetical(orphanDefLabel)
      : '';

  let bestSrc: OKFSource | null = null;
  let bestScore = 0;
  let bestTotalMatch = 0;

  for (const src of sources) {
    if (!src || !src.id) continue;
    const srcIdTokens = new Set(tokenizeForSourceMatch(src.id));
    const srcTitleTokens = new Set(tokenizeForSourceMatch(src.title || ''));
    const srcUrlTokens = new Set(tokenizeForSourceMatch(src.resource || ''));
    const allSrcTokens = new Set([...srcIdTokens, ...srcTitleTokens, ...srcUrlTokens]);

    let score = 0;
    let idMatchCount = 0;
    let totalMatchCount = 0;

    for (const t of idTokens) {
      if (srcIdTokens.has(t)) {
        idMatchCount++;
        totalMatchCount++;
        score += t.length >= 8 ? 30 : 20;
      } else if (srcUrlTokens.has(t) || srcTitleTokens.has(t)) {
        idMatchCount++;
        totalMatchCount++;
        score += t.length >= 8 ? 25 : 15;
      }
    }

    for (const t of labelTokens) {
      if (idTokens.includes(t)) continue;
      if (allSrcTokens.has(t)) {
        totalMatchCount++;
        score += t.length >= 8 ? 12 : 8;
      }
    }

    if (orphanCleanTitle.length >= 15) {
      const srcCleanTitle = stripParenthetical(src.title);
      if (
        srcCleanTitle.length >= 15 &&
        (srcCleanTitle === orphanCleanTitle ||
          srcCleanTitle.includes(orphanCleanTitle) ||
          orphanCleanTitle.includes(srcCleanTitle))
      ) {
        score += 50;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestSrc = src;
      bestTotalMatch = totalMatchCount;
    }
  }

  if (bestSrc && bestTotalMatch >= 2 && bestScore >= 25) {
    return bestSrc;
  }
  return null;
}

function isAutoDomainSlugTitle(title?: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}\s+[—–-]\s+/i.test(String(title || '').trim());
}

export function shouldUpgradeSourceTitle(
  existingTitle: string | undefined,
  candidateTitle: string | undefined,
  resourceUrl?: string
): boolean {
  const cand = String(candidateTitle || '').trim();
  if (!cand || isBareDomainTitle(cand)) return false;
  if (resourceUrl && cand === resourceUrl.trim()) return false;
  const cur = String(existingTitle || '').trim();
  if (!cur || (resourceUrl && cur === resourceUrl.trim()) || isBareDomainTitle(cur)) {
    return true;
  }
  const isShortSingleWordCand = /^[\p{L}\p{N}]{1,15}$/u.test(cand);
  if (isAutoDomainSlugTitle(cur) && !isAutoDomainSlugTitle(cand) && !isShortSingleWordCand) {
    return true;
  }
  if (cur.length < 18 && !isAutoDomainSlugTitle(cand) && cand.length >= cur.length + 10) {
    return true;
  }
  const curWordCount = cur.split(/\s+/).filter(Boolean).length;
  if (
    cur.length < 32 &&
    curWordCount < 4 &&
    !isAutoDomainSlugTitle(cand) &&
    cand.length >= cur.length * 2 &&
    cand.length >= 45
  ) {
    return true;
  }
  return false;
}

export function stripTrailingEmptyCitationSection(prose: string): string {
  return prose
    .replace(/\r?\n+---\s*$/g, '')
    .replace(
      /(?:\r?\n+---)?\r?\n+#{1,4}\s+(?:\*\*|__)?(?:\d+(?:\.\d+)*\.?\s+)?(?:Sources?(?:\s*(?:&|and|\/)\s*(?:Citations?|Footnotes?|References?))?|References?(?:\s*(?:&|and|\/)\s*(?:Footnotes?|Citations?|Sources?))?|Citations?(?:\s*(?:&|and|\/)\s*(?:Footnotes?|References?))?|Footnotes?(?:\s*(?:&|and|\/)\s*(?:References?|Sources?))?|Grounded\s+Search\s+References|Kildehenvisninger(?:\s*(?:og|&|\/)\s*(?:referanser|fotnoter))?|Kilder(?:\s*(?:og|&|\/)\s*(?:referanser|fotnoter|kildehenvisninger))?|Kildeliste(?:\s*(?:og|&|\/)\s*fotnoter)?|Referanser(?:\s*(?:og|&|\/)\s*(?:fotnoter|kilder))?|Referanseliste(?:\s*(?:og|&|\/)\s*fotnoter)?|Fotnoter(?:\s*(?:og|&|\/)\s*(?:kilder|referanser))?):?(?:\*\*|__)?(?:\r?\n+---)?\s*$/i,
      ''
    )
    .replace(/\r?\n+---\s*$/g, '')
    .trim();
}

/**
 * Self-heals an OKF v0.2 document in-place by:
 * 1. Enriching any bare-domain or CMS-polluted (`Id87138`, `ResourceServlet`, `Downloads`) source titles in `doc.frontmatter.sources`.
 * 2. Deduplicating `doc.frontmatter.sources` that share an identical `resource` URL and rewriting alias `[^id]` citations.
 * 3. Filtering auto-injected low-signal social/forum/essay-mill grounding sources (`quora.com`, `reddit.com`, `instagram.com`, `edubirdie.com`, `vocal.media`) when authoritative sources exist.
 * 4. Resolving any orphan `[^id]` citations in `doc.body` against `doc.frontmatter.sources` (or stripping ungrounded orphans without concatenating adjacent words).
 * 5. Synchronizing the bottom `[^id]: Title` footnote definitions so `citedFootnoteIds.size === doc.frontmatter.sources.length`.
 */
export function healOrphanOkfFootnotes(doc: OKFDocument): boolean {
  if (!doc || !doc.frontmatter) return false;
  const rawSources = Array.isArray(doc.frontmatter.sources) ? doc.frontmatter.sources : [];
  if (rawSources.length === 0 && !doc.body) return false;

  let modified = false;

  // 1. Enrich bare-domain titles & deduplicate frontmatter sources by canonical resource URL
  const aliasMap = new Map<string, string>();
  const canonicalByUrl = new Map<string, OKFSource>();
  const dedupedSources: OKFSource[] = [];

  for (const s of rawSources) {
    if (!s || typeof s !== 'object') continue;
    if (!s.resource && typeof s.url === 'string') {
      s.resource = s.url.trim();
      delete s.url;
      modified = true;
    }
    const rawCandidateTitle = s.title ? decodeHtmlEntities(String(s.title)).trim() : s.title;
    if (rawCandidateTitle && rawCandidateTitle !== s.title) {
      s.title = rawCandidateTitle;
      modified = true;
    }
    const enrichedTitle = s.resource
      ? enrichBareDomainSourceTitle(s.title, String(s.resource))
      : s.title;
    if (enrichedTitle && enrichedTitle !== s.title) {
      s.title = enrichedTitle;
      modified = true;
    }
    const resKey = normalizeCanonicalSourceUrl(s.resource) || String(s.resource || '').trim();
    if (resKey && canonicalByUrl.has(resKey)) {
      const existing = canonicalByUrl.get(resKey)!;
      if (s.id && existing.id && s.id !== existing.id) {
        aliasMap.set(s.id, existing.id);
      }
      const candidateForUpgrade =
        rawCandidateTitle && !isBareDomainTitle(rawCandidateTitle) ? rawCandidateTitle : s.title;
      if (shouldUpgradeSourceTitle(existing.title, candidateForUpgrade, String(s.resource || resKey))) {
        existing.title = enrichBareDomainSourceTitle(candidateForUpgrade, String(s.resource || resKey));
      }
      modified = true;
    } else {
      if (resKey) canonicalByUrl.set(resKey, s);
      dedupedSources.push(s);
    }
  }

  // Filter auto-generated low-signal grounding sources when authoritative sources are present
  const authoritativeSources = dedupedSources.filter((s) => !isAutoLowSignalSourceEntry(s));
  const filteredLowSignalIds = new Set<string>();
  if (authoritativeSources.length >= 1 && authoritativeSources.length < dedupedSources.length) {
    for (const s of dedupedSources) {
      if (isAutoLowSignalSourceEntry(s) && s.id) {
        filteredLowSignalIds.add(s.id);
      }
    }
    dedupedSources.length = 0;
    dedupedSources.push(...authoritativeSources);
    modified = true;
  }

  // 2. Separate body prose from bottom `[^id]: label` definitions
  const rawBody = String(doc.body || '');
  const existingDefs = new Map<string, string>();
  const proseLines: string[] = [];
  for (const line of rawBody.split(/\r?\n/)) {
    const m = line.trim().match(/^\[\^([A-Za-z0-9_\-]+)\]:\s*(.+)$/);
    if (m) {
      existingDefs.set(m[1], decodeHtmlEntities(m[2].trim()));
    } else {
      proseLines.push(line);
    }
  }

  let proseText = proseLines.join('\n');

  // Expand comma/semicolon-separated multi-footnote brackets (`[^id1, ^id2]` or `[^id1,[^id1] 4]`) into separate `[^id1] [^id2]` tags
  proseText = proseText.replace(
    /\[\^([A-Za-z0-9_\-]+)\s*,\s*\[\^([A-Za-z0-9_\-]+)\]\s*([0-9A-Za-z_\-]+)\]/g,
    (_m, id1: string, id2: string, tail: string) => {
      const reconstructed = /^\d+$/.test(tail) ? `${id2.replace(/\d+$/, '')}${tail}` : `${id2}${tail}`;
      return `[^${id1}] [^${reconstructed}]`;
    }
  );
  proseText = proseText.replace(
    /\[\^([A-Za-z0-9_\-]+(?:\s*[,;]\s*(?:\[\^|\^)?[A-Za-z0-9_\-]+\]?)+)\]/g,
    (_m, inner: string) =>
      inner
        .split(/\s*[,;]\s*/)
        .map((part) => part.replace(/^\[?\^?/, '').replace(/\]$/, '').trim())
        .filter(Boolean)
        .map((id) => `[^${id}]`)
        .join(' ')
  );

  // Snap footnotes out of slash-joined words (`overtredelser[^id]/avvik` -> `overtredelser/avvik[^id]`)
  proseText = proseText.replace(
    /([\p{L}\p{N}_\-]+)(\[\^[A-Za-z0-9_\-]+\](?:[ \t]*\[\^[A-Za-z0-9_\-]+\])*)((?:\/[\p{L}\p{N}_\-]+)+)/gu,
    '$1$3$2'
  );

  // Strip redundant carets before `[^id]` (`^[^id]` -> `[^id]`) and convert bare `.^id` typos to `.[^id]` before rewriting aliases
  proseText = proseText.replace(/\^+(\[\^[A-Za-z0-9_\-]+\])/g, '$1');
  proseText = proseText.replace(/\.\^([a-z0-9]+(?:-[a-z0-9]+)+)/gi, '.[^$1]');

  // Rewrite duplicate-URL source aliases
  for (const [aliasId, canonicalId] of aliasMap.entries()) {
    if (proseText.includes(`[^${aliasId}]`)) {
      proseText = proseText.replaceAll(`[^${aliasId}]`, `[^${canonicalId}]`);
      modified = true;
    }
  }

  // 3. Resolve or strip orphan `[^id]` citations in proseText
  const validSourceById = new Map<string, OKFSource>();
  for (const s of dedupedSources) {
    if (s.id) validSourceById.set(s.id, s);
  }

  const inlineFnIds = Array.from(
    new Set(Array.from(proseText.matchAll(/\[\^([A-Za-z0-9_\-]+)\]/g)).map((m) => m[1]))
  );
  for (const fnId of inlineFnIds) {
    if (!validSourceById.has(fnId)) {
      const matched = filteredLowSignalIds.has(fnId)
        ? null
        : matchOrphanFootnoteToSource(fnId, existingDefs.get(fnId), dedupedSources);
      if (matched && matched.id) {
        proseText = proseText.replaceAll(`[^${fnId}]`, `[^${matched.id}]`);
      } else {
        proseText = removeSpecificFootnotePreservingBoundary(proseText, fnId);
        proseText = proseText.replace(
          /(?<=[\p{L}\p{N})*_`”"»'])[ \t]+(\[\^[A-Za-z0-9_\-]+\])/gu,
          '$1'
        );
        proseText = proseText.replace(
          /(?<=[\p{L}\p{N})*_`\]”"»'])[ \t]+([.,;!?]|:(?!-))/gu,
          '$1'
        );
        proseText = proseText.replace(/(?<=\S)[ \t]{2,}/g, ' ');
        proseText = proseText.replace(/[ \t]+$/gm, '');
      }
      modified = true;
    }
  }

  // Snap any stray space between bold/word/quote and inline footnote (`**word** [^id]` -> `**word**[^id]`) or before clause punctuation (`[^id] :` -> `[^id]:`)
  const beforeSpaceSnap = proseText;
  proseText = proseText.replace(
    /(?<=[\p{L}\p{N})*_`”"»'])[ \t]+(\[\^[A-Za-z0-9_\-]+\])/gu,
    '$1'
  );
  proseText = proseText.replace(
    /(?<=[\p{L}\p{N})*_`\]”"»'])[ \t]+([.,;!?]|:(?!-))/gu,
    '$1'
  );
  if (proseText !== beforeSpaceSnap) {
    modified = true;
  }

  // Normalize trailing sentence & clause punctuation (`word.[^id]` -> `word[^id].`, `word:[^id]` -> `word[^id]:`, and `[^a].[^b]` -> `[^a] [^b].`) before collapsing duplicates
  let prevProseText = '';
  while (prevProseText !== proseText) {
    prevProseText = proseText;
    proseText = proseText.replace(
      /((?:\[\^[A-Za-z0-9_\-]+\][ \t]*)+)([.?!:;]+)((?:[ \t]*\[\^[A-Za-z0-9_\-]+\])+)/g,
      (fullMatch, leftFns: string, punctCluster: string, rightFns: string, offset: number, str: string) => {
        if (
          punctCluster === ':' &&
          /^\[\^[A-Za-z0-9_\-]+\]$/.test(leftFns.trim()) &&
          /(?:^|\r?\n)[\t ]*$/.test(str.slice(0, offset))
        ) {
          return fullMatch;
        }
        const finalPunct = punctCluster[punctCluster.length - 1];
        return `${leftFns.trimEnd()} ${rightFns.trimStart()}${finalPunct}`;
      }
    );
  }
  proseText = proseText.replace(
    /([^\s.?!:;])([.?!:;])((?:[ \t]*\[\^[A-Za-z0-9_\-]+\])+)([.?!:;]+)?/g,
    (
      fullMatch,
      before: string,
      punct: string,
      fns: string,
      trailingPunct: string | undefined,
      offset: number,
      str: string
    ) => {
      if (
        punct === ':' &&
        before === ']' &&
        /(?:^|\r?\n)[\t ]*\[\^[A-Za-z0-9_\-]+\]$/.test(str.slice(0, offset + 1))
      ) {
        return fullMatch;
      }
      const finalPunct = trailingPunct ? trailingPunct[trailingPunct.length - 1] : punct;
      return `${before}${fns.trimStart()}${finalPunct}`;
    }
  );

  // Collapse adjacent duplicate footnote citations (`[^a] [^a]` or `[^a][^a]` -> `[^a]`)
  proseText = proseText.replace(/(?:\[\^[A-Za-z0-9_\-]+\][ \t]*){2,}/g, (cluster) => {
    const trailingSpace = /[ \t]+$/.exec(cluster)?.[0] || '';
    const seenFn = new Set<string>();
    const uniqueRefs: string[] = [];
    for (const m of cluster.matchAll(/\[\^([A-Za-z0-9_\-]+)\]/g)) {
      if (!seenFn.has(m[1])) {
        seenFn.add(m[1]);
        uniqueRefs.push(`[^${m[1]}]`);
      }
    }
    return uniqueRefs.join(' ') + trailingSpace;
  });

  // Ensure a space follows any inline footnote citation that is immediately followed by a word character (`word[^id]Next` -> `word[^id] Next`)
  proseText = proseText.replace(/(\[\^[A-Za-z0-9_\-]+\])(?=[\p{L}\p{N}])/gu, '$1 ');

  // 4. Filter uncited frontmatter sources & rebuild synchronized bottom footnote definitions
  const finalCitedIds = Array.from(
    new Set(Array.from(proseText.matchAll(/\[\^([A-Za-z0-9_\-]+)\]/g)).map((m) => m[1]))
  );
  const finalCitedSet = new Set(finalCitedIds);

  const finalSources =
    finalCitedSet.size > 0
      ? dedupedSources.filter((s) => s.id && finalCitedSet.has(s.id))
      : dedupedSources;
  if (finalSources.length !== rawSources.length) {
    modified = true;
  }
  doc.frontmatter.sources = finalSources;

  const footnoteLines: string[] = [];
  for (const fnId of finalCitedIds) {
    const src = validSourceById.get(fnId);
    const label = decodeHtmlEntities(src?.title || existingDefs.get(fnId) || src?.resource || fnId);
    footnoteLines.push(`[^${fnId}]: ${label}`);
  }

  const trimmedProse = stripTrailingEmptyCitationSection(proseText);
  const nextBody =
    footnoteLines.length > 0
      ? `${trimmedProse}\n\n${footnoteLines.join('\n')}\n`
      : trimmedProse
        ? `${trimmedProse}\n`
        : '';

  if (nextBody !== rawBody) {
    doc.body = nextBody;
    modified = true;
  }

  return modified;
}

export interface SourceDomainProvenance {
  hostname: string;
  isDirectFileAsset: boolean;
  claimedPublisher?: string;
  domainMismatch: boolean;
}

/**
 * Domain-neutral provenance check comparing a source's resolved URL hostname against any
 * explicit publisher attribution in its title (`– Publisher` / `| Publisher`).
 * Recognizes direct domain token overlap, parenthetical/initialism acronyms (`DSB` <-> `dsb.no`,
 * `SEC` <-> `sec.gov`), compound-word abbreviations (`Utdanningsdirektoratet` <-> `udir.no`),
 * and official government/intergovernmental umbrella portals (`.gov`, `regjeringen.no`, `europa.eu`),
 * while flagging third-party mirrors/uploads (`secure.styret.com`, `dyrebo.barnehage.no`, `scribd.com`)
 * whose titles masquerade as another authority.
 */
export function inspectSourceDomainProvenance(source: {
  id?: string;
  title?: string;
  resource?: string;
  url?: string;
}): SourceDomainProvenance {
  const rawUrl = String(source?.resource || source?.url || '').trim();
  if (!rawUrl || isVertexRedirectUrl(rawUrl)) {
    return { hostname: '', isDirectFileAsset: false, domainMismatch: false };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { hostname: '', isDirectFileAsset: false, domainMismatch: false };
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!hostname) {
    return { hostname: '', isDirectFileAsset: false, domainMismatch: false };
  }

  const isDirectFileAsset =
    /\.(?:pdf|docx?|xlsx?|pptx?)(?:$|[?#])/i.test(parsed.pathname) ||
    /\/(?:s3assets[^/]*|getfile(?:\.aspx)?|wp-content\/uploads|uploads|attachments)\b/i.test(
      parsed.pathname
    ) ||
    /(?:amazonaws\.com|cloudfront\.net|blob\.core\.windows\.net|storage\.googleapis\.com)$/i.test(
      hostname
    );

  const rawTitle = decodeHtmlEntities(String(source?.title || '').trim());
  if (!rawTitle) {
    return { hostname, isDirectFileAsset, domainMismatch: false };
  }

  const viaAnnotMatch = rawTitle.match(/\s*\(via\s+([a-z0-9.-]+\.[a-z]{2,})\)\s*$/i);
  const titleWithoutVia = viaAnnotMatch
    ? rawTitle.slice(0, rawTitle.length - viaAnnotMatch[0].length).trim()
    : rawTitle;

  const sepMatch = titleWithoutVia.match(/\s+(?:([|])|[–—]|-\s)\s*([^–—|]{2,60})\s*$/);
  if (!sepMatch) {
    return { hostname, isDirectFileAsset, domainMismatch: false };
  }
  const prefixHostCandidate = titleWithoutVia
    .slice(0, sepMatch.index ?? 0)
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
  if (
    prefixHostCandidate &&
    (prefixHostCandidate === hostname || hostname.endsWith(`.${prefixHostCandidate}`))
  ) {
    return { hostname, isDirectFileAsset, domainMismatch: false };
  }
  const isPipeSep = sepMatch[1] === '|';
  const candidatePub = sepMatch[2].trim();
  const pubWords = candidatePub.split(/\s+/).filter(Boolean);
  if (pubWords.length === 0 || pubWords.length > 6) {
    return { hostname, isDirectFileAsset, domainMismatch: false };
  }
  // Ignore lowercase phrases (unless domain-like), section/chapter/date markers, or generic subtitle words
  if (
    (/^[a-zæøåäö]/.test(candidatePub) && !/\.[a-z]{2,}$/i.test(candidatePub)) ||
    /^(?:§+|kap(?:ittel|\.)?\s*\d|del\s+\d|part\s+\d|ch(?:apter|\.)\s*\d|sec(?:tion\b|\.\s*\d|\s+\d)|mod(?:ul|ule|\.)\s*\d|steg\s+\d|step\s+\d|fase\s+\d|phase\s+\d|tabell\b|table\b|figur\b|figure\b|vedlegg\b|appendix\b|rev(?:ision\b|\.\s*\d|\s+\d)|v\d|\d{4}\b|q[1-4]\b)/i.test(
      candidatePub
    ) ||
    /^\d+[\d\s.,:\-–/]*$/.test(candidatePub)
  ) {
    return { hostname, isDirectFileAsset, domainMismatch: false };
  }

  const normAscii = (s: string) =>
    transliterateNordicAscii(s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

  const pubSlug = normAscii(candidatePub)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const srcIdLower = String(source?.id || '').toLowerCase();
  const idEncodesPub = Boolean(
    pubSlug &&
      pubSlug.length >= 3 &&
      (srcIdLower.endsWith(`-${pubSlug}`) || srcIdLower.startsWith(`${pubSlug}-`))
  );

  const hasParenAcronym = /\([A-ZÆØÅ0-9]{2,10}\)\s*$/.test(candidatePub);
  if (
    !isPipeSep &&
    !hasParenAcronym &&
    !idEncodesPub &&
    (pubWords.length > 4 ||
      /\b(?:oversikt|overview|innledning|introduction|sammendrag|summary|veiledning|veileder|guide|guidelines|sjekkliste|checklist|kontrollrutiner|gjennomforing|gjennomføring|analyse|analysis|vurdering|assessment|krav|requirements|praksis|tiltak|actions|rapport|report|utgave|edition|hovedpunkter|key\s+points)\b/i.test(
        candidatePub
      ))
  ) {
    return { hostname, isDirectFileAsset, domainMismatch: false };
  }

  // Official shared government / intergovernmental umbrella portals legitimately host ministries & agencies
  if (
    /\.(?:gov|gov\.[a-z]{2}|mil|int)$/i.test(hostname) ||
    /(?:^|\.)(?:regjeringen\.no|stortinget\.no|europa\.eu|canada\.ca|gov\.uk|usa\.gov|who\.int|un\.org|oecd\.org|worldbank\.org)$/i.test(
      hostname
    )
  ) {
    return { hostname, isDirectFileAsset, claimedPublisher: candidatePub, domainMismatch: false };
  }

  const hostIgnore = new Set([
    'www',
    'www2',
    'wwwex',
    'web',
    'secure',
    'portal',
    'app',
    'api',
    'docs',
    'cdn',
    'static',
    'files',
    'media',
    'no',
    'com',
    'org',
    'net',
    'edu',
    'gov',
    'int',
    'eu',
    'uk',
    'de',
    'se',
    'dk',
    'fi',
    'is',
    'nl',
    'fr',
    'es',
    'it',
    'ch',
    'at',
    'be',
    'ca',
    'au',
    'nz',
    'us',
    'io',
    'ai',
    'co',
  ]);
  const hostTokens = hostname
    .split('.')
    .map((p) => p.replace(/[^a-z0-9]/g, ''))
    .filter((p) => p.length >= 2 && !hostIgnore.has(p));

  if (hostTokens.length === 0) {
    return { hostname, isDirectFileAsset, claimedPublisher: candidatePub, domainMismatch: false };
  }

  const pubStop = new Set([
    'for',
    'og',
    'and',
    'of',
    'the',
    'in',
    'on',
    'til',
    'av',
    'om',
    'i',
    'de',
    'la',
    'du',
    'des',
    'und',
    'fur',
    'van',
    'het',
    'us',
    'uk',
  ]);
  const rawPubTokens = normAscii(candidatePub.replace(/\([^)]*\)/g, ' '))
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !pubStop.has(t));
  const pubJoined = rawPubTokens.join('');

  const acronyms = new Set<string>();
  for (const pm of candidatePub.matchAll(/\(([A-Za-zÆØÅæøå0-9]{2,12})\)/g)) {
    acronyms.add(normAscii(pm[1]).replace(/[^a-z0-9]/g, ''));
  }
  for (const um of candidatePub.matchAll(/\b([A-ZÆØÅ]{2,10})\b/g)) {
    acronyms.add(normAscii(um[1]).replace(/[^a-z0-9]/g, ''));
  }
  if (rawPubTokens.length >= 2) {
    acronyms.add(rawPubTokens.map((t) => t[0]).join(''));
  }

  const matchesHost = hostTokens.some((hp) => {
    if (acronyms.has(hp)) return true;
    for (const ac of acronyms) {
      if (ac.length >= 3 && (hp.includes(ac) || ac.includes(hp))) return true;
    }
    for (const pt of rawPubTokens) {
      if (pt === hp) return true;
      if (pt.length >= 4 && hp.includes(pt)) return true;
      if (hp.length >= 4 && pt.includes(hp)) return true;
    }
    // Compound-word abbreviation (e.g., "udir" <-> "utdanningsdirektoratet", "digdir" <-> "digitaliseringsdirektoratet")
    if (hp.length >= 4 && pubJoined.startsWith(hp[0]) && pubJoined.includes(hp.slice(1))) {
      return true;
    }
    for (let splitAt = 2; splitAt <= Math.min(4, hp.length - 3); splitAt++) {
      if (
        pubJoined.startsWith(hp.slice(0, splitAt)) &&
        pubJoined.indexOf(hp.slice(splitAt), splitAt) !== -1
      ) {
        return true;
      }
    }
    // Multi-token syllabic / compound initialism (e.g., "dibk" <-> ["direktoratet", "byggkvalitet"], "nkom", "bufdir")
    if (rawPubTokens.length >= 2 && hp.length >= 3 && hp.length <= 8) {
      const matchSyllabicTokens = (tokIdx: number, hpIdx: number): boolean => {
        if (tokIdx === rawPubTokens.length) return hpIdx === hp.length;
        if (hpIdx >= hp.length) return false;
        const tok = rawPubTokens[tokIdx];
        if (tok[0] !== hp[hpIdx]) return false;
        const maxPrefix = Math.min(4, tok.length, hp.length - hpIdx);
        for (let len = 1; len <= maxPrefix; len++) {
          if (tok.slice(0, len) === hp.slice(hpIdx, hpIdx + len)) {
            if (matchSyllabicTokens(tokIdx + 1, hpIdx + len)) return true;
          }
        }
        if (tok.length >= 8) {
          const maxStem = Math.min(4, hp.length - hpIdx - 1);
          for (let remLen = 1; remLen <= maxStem; remLen++) {
            const sub = hp.slice(hpIdx + 1, hpIdx + 1 + remLen);
            const minOffset = remLen === 1 ? 3 : 2;
            if (tok.indexOf(sub, minOffset) !== -1) {
              if (matchSyllabicTokens(tokIdx + 1, hpIdx + 1 + remLen)) return true;
            }
          }
        }
        return false;
      };
      if (matchSyllabicTokens(0, 0)) return true;
    }
    return false;
  });

  return {
    hostname,
    isDirectFileAsset,
    claimedPublisher: candidatePub,
    domainMismatch: !matchesHost || Boolean(viaAnnotMatch),
  };
}

export interface CurateOkfSourcesOptions {
  rejectSourceIds?: string[];
  replaceSourceMap?: Record<string, string>;
  addSources?: Array<{
    url: string;
    title?: string;
    id?: string;
    retrievedAt?: string;
    retrieved_at?: string;
    lastModified?: string;
    last_modified?: string;
  }>;
}

/**
 * Deterministically curates an OKF v0.2 Markdown document by:
 * 1. Re-anchoring inline citations from rejected sources to existing or newly added sources (`replaceSourceMap`),
 *    so `[^old-id]` becomes `[^new-id]` across the entire document at zero LLM token cost.
 * 2. Rejecting specified source IDs (`rejectSourceIds`), detecting any prose lines or sentences/table cells
 *    whose only remaining citation was an un-replaced rejected source (`orphanClaimLines`), removing the rejected
 *    sources from `frontmatter.sources`, and stripping `[^rejected-id]` inline tags and bottom definitions
 *    while preserving word boundaries and sentence punctuation.
 * 3. Adding human-supplied sources (`addSources`), deduplicating by canonical URL, generating
 *    clean Nordic-transliterated slug IDs, enriching titles, and weaving `[^id]` inline + bottom
 *    definitions so 3-way OKF v0.2 footnote parity (`frontmatter.sources == inline [^id] == bottom definitions`)
 *    is guaranteed.
 */
export function curateOkfSources(
  rawMarkdown: string,
  options: CurateOkfSourcesOptions
): {
  markdown: string;
  rejectedIds: string[];
  replacedMap: Record<string, string>;
  addedSources: OKFSource[];
  orphanClaimLines: string[];
} {
  const doc = parseOkfDocument(rawMarkdown);
  if (!doc.frontmatter) {
    doc.frontmatter = { type: 'Research Concept', status: 'draft' };
  }
  const initialSources: OKFSource[] = Array.isArray(doc.frontmatter.sources)
    ? doc.frontmatter.sources.map((s) => ({ ...s }))
    : [];

  const cleanFnId = (val: string) =>
    String(val || '')
      .trim()
      .replace(/^\[\^/, '')
      .replace(/\]$/, '')
      .trim();

  const rawReplaceEntries: Array<[string, string]> = [];
  if (options?.replaceSourceMap && typeof options.replaceSourceMap === 'object') {
    for (const [rawOld, rawTarget] of Object.entries(options.replaceSourceMap)) {
      const oldId = cleanFnId(rawOld);
      const targetSpec = String(rawTarget || '')
        .trim()
        .replace(/^\[\^/, '')
        .replace(/\]$/, '')
        .trim();
      if (oldId && targetSpec && oldId !== targetSpec) {
        rawReplaceEntries.push([oldId, targetSpec]);
      }
    }
  }

  const normalizedRejectIds = Array.from(
    new Set([
      ...(options?.rejectSourceIds || []).map(cleanFnId).filter(Boolean),
      ...rawReplaceEntries.map(([oldId]) => oldId),
    ])
  );
  const rejectSet = new Set(normalizedRejectIds);

  const rawBody = String(doc.body || '');
  const existingDefs = new Map<string, string>();
  const proseLines: string[] = [];
  for (const rawLine of rawBody.split(/\r?\n/)) {
    const defMatch = rawLine.trim().match(/^\[\^([A-Za-z0-9_\-]+)\]:\s*(.+)$/);
    if (defMatch) {
      if (!rejectSet.has(defMatch[1])) {
        existingDefs.set(defMatch[1], decodeHtmlEntities(defMatch[2].trim()));
      }
    } else {
      // Pre-normalize malformed `^[^id]` or `.^id` so rejected inline markers are caught cleanly
      const cleanedLine = rawLine
        .replace(/\^\[\^([A-Za-z0-9_\-]+)\]/g, '[^$1]')
        .replace(/([a-zA-ZæøåÆØÅ0-9.)”"»])\^([a-z][a-z0-9_\-]{2,})(?=[\s.,;!?)\]]|$)/g, '$1[^$2]');
      proseLines.push(cleanedLine);
    }
  }

  // Track actually rejected IDs (present in initial frontmatter.sources or initial inline body)
  const existingSourceIds = new Set(
    initialSources.map((s) => String(s?.id || '').trim()).filter(Boolean)
  );
  const initialInlineBodyIds = new Set(
    Array.from(proseLines.join('\n').matchAll(/\[\^([A-Za-z0-9_\-]+)\]/g)).map((m) => m[1])
  );
  const rejectedIds = normalizedRejectIds.filter(
    (id) => existingSourceIds.has(id) || initialInlineBodyIds.has(id)
  );

  // Filter out rejected sources from frontmatter.sources
  const remainingSources: OKFSource[] = initialSources.filter(
    (s) => s && !rejectSet.has(String(s.id || '').trim())
  );

  const parseInlineReplaceUrlSpec = (
    specRaw: string
  ): { url: string; title?: string; id?: string } | undefined => {
    let rest = String(specRaw || '').trim();
    let customId: string | undefined;
    const idPrefix = rest.match(/^id=([A-Za-z0-9_\-]+)\|([\s\S]+)$/i);
    if (idPrefix) {
      customId = idPrefix[1].trim();
      rest = idPrefix[2].trim();
    }
    if (!/^https?:\/\//i.test(rest)) return undefined;
    const pipeIdx = rest.indexOf('|');
    const url = (pipeIdx !== -1 ? rest.slice(0, pipeIdx) : rest).trim();
    const title = pipeIdx !== -1 ? rest.slice(pipeIdx + 1).trim() : '';
    if (!url) return undefined;
    return {
      url,
      ...(title ? { title } : {}),
      ...(customId ? { id: customId } : {}),
    };
  };

  // Register human-added sources (plus any standalone `https://...` targets in `replaceSourceMap`)
  // BEFORE resolving `replaceSourceMap` so `--replace-source oldId=https://...` works standalone without `--add-source`
  const addedSources: OKFSource[] = [];
  const existingMatchIdsToWeave: string[] = [];
  const baseAddList = Array.isArray(options?.addSources) ? options.addSources : [];
  const existingByCanonUrl = new Map<string, OKFSource>();
  for (const s of remainingSources) {
    const cUrl = normalizeCanonicalSourceUrl(String(s.resource || s.url || ''));
    if (cUrl) existingByCanonUrl.set(cUrl, s);
  }

  const effectiveAddList = [...baseAddList];
  const queuedCanonUrls = new Set<string>(
    effectiveAddList
      .map((item) => {
        const u = String(item?.url || '').trim();
        return u ? normalizeCanonicalSourceUrl(u) || u : '';
      })
      .filter(Boolean)
  );
  for (const [, targetSpec] of rawReplaceEntries) {
    const parsedUrlTarget = parseInlineReplaceUrlSpec(targetSpec);
    if (!parsedUrlTarget) continue;
    const canonTarget = normalizeCanonicalSourceUrl(parsedUrlTarget.url) || parsedUrlTarget.url;
    if (!existingByCanonUrl.has(canonTarget) && !queuedCanonUrls.has(canonTarget)) {
      effectiveAddList.push(parsedUrlTarget);
      queuedCanonUrls.add(canonTarget);
    }
  }

  if (effectiveAddList.length > 0) {
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const usedIds = new Set<string>([
      ...remainingSources.map((s) => String(s?.id || '').trim()).filter(Boolean),
      ...normalizedRejectIds,
    ]);
    for (const m of proseLines.join('\n').matchAll(/\[\^([A-Za-z0-9_\-]+)\]/g)) {
      usedIds.add(m[1]);
    }

    for (const item of effectiveAddList) {
      const rawUrl = String(item?.url || '').trim();
      if (!rawUrl) continue;
      const rawLastMod = item.lastModified || item.last_modified;
      const rawRetAt = item.retrievedAt || item.retrieved_at;
      const canonUrl = normalizeCanonicalSourceUrl(rawUrl) || rawUrl;
      const existingMatch = existingByCanonUrl.get(canonUrl);
      if (existingMatch && existingMatch.id) {
        if (item.title && shouldUpgradeSourceTitle(existingMatch.title, item.title, rawUrl)) {
          existingMatch.title = enrichBareDomainSourceTitle(item.title, rawUrl);
          existingDefs.set(existingMatch.id, existingMatch.title);
        }
        if (rawLastMod && !existingMatch.last_modified) {
          const validLm = parseValidIsoTimestamp(rawLastMod);
          if (validLm) existingMatch.last_modified = validLm;
        }
        existingMatchIdsToWeave.push(existingMatch.id);
        continue;
      }

      const rawCustomId = item.id
        ? transliterateNordicAscii(String(item.id))
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '')
        : '';
      let slugId = '';
      if (rawCustomId && !usedIds.has(rawCustomId)) {
        slugId = rawCustomId;
        usedIds.add(slugId);
      } else {
        slugId = generateSourceSlugId(item.title || rawUrl, rawUrl, usedIds);
      }

      const enrichedTitle = enrichBareDomainSourceTitle(item.title || rawUrl, rawUrl);
      const retrievedAt = parseValidIsoTimestamp(rawRetAt) || nowIso;
      const lastModified = parseValidIsoTimestamp(rawLastMod);
      const newSrc: OKFSource = {
        id: slugId,
        resource: rawUrl,
        title: enrichedTitle,
        retrieved_at: retrievedAt,
        ...(lastModified ? { last_modified: lastModified } : {}),
      };
      remainingSources.push(newSrc);
      addedSources.push(newSrc);
      existingByCanonUrl.set(canonUrl, newSrc);
      existingDefs.set(slugId, enrichedTitle);
    }
  }

  // Apply `replaceSourceMap` re-anchoring (`[^oldId]` -> `[^newId]`) before orphan-claim detection
  const replacedMap: Record<string, string> = {};
  if (rawReplaceEntries.length > 0) {
    const activeById = new Map<string, OKFSource>();
    for (const s of remainingSources) {
      if (s && s.id) activeById.set(String(s.id).trim(), s);
    }
    for (const [oldId, targetSpec] of rawReplaceEntries) {
      let resolvedTarget: OKFSource | undefined = activeById.get(targetSpec);
      if (!resolvedTarget) {
        const parsedUrlTarget = parseInlineReplaceUrlSpec(targetSpec);
        if (parsedUrlTarget) {
          const canonTarget =
            normalizeCanonicalSourceUrl(parsedUrlTarget.url) || parsedUrlTarget.url;
          resolvedTarget =
            existingByCanonUrl.get(canonTarget) ||
            (parsedUrlTarget.id ? activeById.get(parsedUrlTarget.id) : undefined);
        }
      }
      if (resolvedTarget && resolvedTarget.id && resolvedTarget.id !== oldId) {
        const newId = resolvedTarget.id;
        replacedMap[oldId] = newId;
        const escapedOld = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedNew = newId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const oldFnRe = new RegExp(`\\[\\^${escapedOld}\\]`, 'g');
        const dupNewRe = new RegExp(`(\\[\\^${escapedNew}\\])(?:\\s*\\[\\^${escapedNew}\\])+`, 'g');
        for (let idx = 0; idx < proseLines.length; idx++) {
          if (proseLines[idx].includes(`[^${oldId}]`)) {
            proseLines[idx] = proseLines[idx]
              .replace(oldFnRe, `[^${newId}]`)
              .replace(dupNewRe, '$1');
          }
        }
      }
    }
  }

  // Detect prose lines (or individual sentences / table cells on multi-citation lines) that cite an un-replaced
  // rejected source and have no other non-rejected citation backing that claim.
  const orphanClaimLines: string[] = [];
  if (rejectSet.size > 0) {
    for (const line of proseLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const citedOnLine = Array.from(trimmed.matchAll(/\[\^([A-Za-z0-9_\-]+)\]/g)).map((m) => m[1]);
      if (citedOnLine.length === 0) continue;
      const citesRejected = citedOnLine.some((id) => rejectSet.has(id));
      const citesNonRejected = citedOnLine.some((id) => !rejectSet.has(id));
      if (citesRejected && !citesNonRejected) {
        orphanClaimLines.push(trimmed);
      } else if (citesRejected && citesNonRejected) {
        const subSegments =
          trimmed.startsWith('|') && trimmed.endsWith('|')
            ? trimmed
                .split('|')
                .map((s) => s.trim())
                .filter(Boolean)
            : trimmed
                .split(/(?<=[.?!](?:\s*\[\^[A-Za-z0-9_\-]+\])*)\s+/)
                .map((s) => s.trim())
                .filter(Boolean);
        if (subSegments.length > 1) {
          for (const seg of subSegments) {
            const segCited = Array.from(seg.matchAll(/\[\^([A-Za-z0-9_\-]+)\]/g)).map((m) => m[1]);
            if (segCited.length === 0) continue;
            const segRej = segCited.some((id) => rejectSet.has(id));
            const segKeep = segCited.some((id) => !rejectSet.has(id));
            if (segRej && !segKeep) {
              orphanClaimLines.push(seg);
            }
          }
        }
      }
    }
  }

  // Strip any remaining rejected [^id] citations from prose while preserving word boundaries, table cells, and punctuation
  let proseText = proseLines.join('\n');
  for (const rejId of normalizedRejectIds) {
    proseText = removeSpecificFootnotePreservingBoundary(proseText, rejId);
    proseText = proseText.replace(
      /(?<=[\p{L}\p{N})*_`”"»'])[ \t]+(\[\^[A-Za-z0-9_\-]+\])/gu,
      '$1'
    );
    proseText = proseText.replace(
      /(?<=[\p{L}\p{N})*_`\]”"»'])[ \t]+([.,;!?]|:(?!-))/gu,
      '$1'
    );
    proseText = proseText.replace(/(?<=\S)[ \t]{2,}/g, ' ');
    proseText = proseText.replace(/[ \t]+$/gm, '');
  }

  // Ensure any newly added sources that weren't already cited inline (e.g. via `replaceSourceMap`) are weaved for 3-way parity
  if (addedSources.length > 0 || existingMatchIdsToWeave.length > 0) {
    const ensureInlineCitationWeaved = (fnId: string) => {
      const escaped = fnId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\[\\^${escaped}\\]`).test(proseText)) {
        return;
      }
      const lines = proseText.split(/\r?\n/);
      let firstProseIdx = -1;
      let firstListIdx = -1;
      const candidateIndices: number[] = [];
      let inFence = false;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith('```')) {
          inFence = !inFence;
          continue;
        }
        if (inFence || !t) continue;
        if (/^#{1,4}\s+(?:Relaterte\s+konsepter|Related\s+(?:Bundle\s+)?Concepts?)\b/i.test(t)) {
          break;
        }
        if (
          t.startsWith('#') ||
          /^---+\s*$/.test(t) ||
          t.startsWith('|') ||
          t.startsWith('>') ||
          /^\[\^[A-Za-z0-9_\-]+\]:/.test(t) ||
          /^(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/.test(t)
        ) {
          continue;
        }
        candidateIndices.push(i);
        if (/^(?:[-*+]|\d+[.)])\s+/.test(t)) {
          if (firstListIdx < 0) firstListIdx = i;
        } else if (firstProseIdx < 0) {
          firstProseIdx = i;
        }
      }

      let targetIdx = -1;
      const srcMeta = remainingSources.find((s) => s && s.id === fnId);
      if (srcMeta && candidateIndices.length > 1) {
        const cleanQueryBasis = `${String(srcMeta.title || '').replace(/\s*\(via\s+[^)]+\)\s*$/i, '')} ${fnId.replace(/-/g, ' ')}`;
        const rawWords = cleanQueryBasis.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [];
        const rawSections = (cleanQueryBasis.match(/§+\s*\d+(?:-\d+)?/g) || []).map((sec) =>
          sec.replace(/\s+/g, '').toLowerCase()
        );
        const uniqueWords = Array.from(new Set(rawWords));
        const uniqueSections = Array.from(new Set(rawSections));
        if (uniqueWords.length > 0 || uniqueSections.length > 0) {
          const lineEntries = candidateIndices.map((lineIdx) => {
            const stripped = lines[lineIdx]
              .replace(/\[\^[A-Za-z0-9_\-]+\]/g, ' ')
              .toLowerCase();
            const wordSet = new Set(stripped.match(/[\p{L}\p{N}]{4,}/gu) || []);
            const compactSec = stripped.replace(/\s+/g, '');
            return { lineIdx, stripped, wordSet, compactSec };
          });
          const nCand = lineEntries.length;
          const scores = new Array<number>(nCand).fill(0);
          for (const qt of uniqueWords) {
            let df = 0;
            for (const entry of lineEntries) {
              if (entry.wordSet.has(qt) || (qt.length >= 6 && entry.stripped.includes(qt))) {
                df++;
              }
            }
            if (df === 0 || (nCand >= 4 && df > nCand * 0.6)) continue;
            const idf = Math.log((nCand + 1) / (df + 0.5));
            for (let k = 0; k < nCand; k++) {
              if (lineEntries[k].wordSet.has(qt)) {
                scores[k] += 1.5 * idf;
              } else if (qt.length >= 6 && lineEntries[k].stripped.includes(qt)) {
                scores[k] += 0.75 * idf;
              }
            }
          }
          for (const sec of uniqueSections) {
            let df = 0;
            for (const entry of lineEntries) {
              if (entry.compactSec.includes(sec)) df++;
            }
            if (df === 0) continue;
            const idf = Math.log((nCand + 1) / (df + 0.5));
            for (let k = 0; k < nCand; k++) {
              if (lineEntries[k].compactSec.includes(sec)) {
                scores[k] += 3.0 * idf;
              }
            }
          }
          let bestScore = 0;
          let bestLineIdx = -1;
          for (let k = 0; k < nCand; k++) {
            if (scores[k] > bestScore) {
              bestScore = scores[k];
              bestLineIdx = lineEntries[k].lineIdx;
            }
          }
          if (bestScore >= 1.0 && bestLineIdx >= 0) {
            targetIdx = bestLineIdx;
          }
        }
      }

      if (targetIdx < 0) {
        targetIdx = firstProseIdx >= 0 ? firstProseIdx : firstListIdx;
      }
      if (targetIdx >= 0) {
        lines[targetIdx] = lines[targetIdx].replace(
          /([.?!])?(\s*)$/,
          (_m, punct: string | undefined, ws: string) => `[^${fnId}]${punct || ''}${ws || ''}`
        );
        proseText = lines.join('\n');
      } else {
        proseText = proseText.trim()
          ? `${proseText.trim()}\n\nKilde[^${fnId}].`
          : `Kilde[^${fnId}].`;
      }
    };

    for (const idToWeave of existingMatchIdsToWeave) {
      ensureInlineCitationWeaved(idToWeave);
    }
    for (const addedSrc of addedSources) {
      if (addedSrc.id) ensureInlineCitationWeaved(addedSrc.id);
    }
  }

  // Rebuild body with bottom definitions and run healOrphanOkfFootnotes for 100% 3-way parity
  const defLines: string[] = [];
  for (const s of remainingSources) {
    if (!s || !s.id) continue;
    const label = decodeHtmlEntities(s.title || existingDefs.get(s.id) || s.resource || s.id);
    defLines.push(`[^${s.id}]: ${label}`);
  }
  doc.frontmatter.sources = remainingSources;
  doc.body =
    defLines.length > 0 ? `${proseText.trimEnd()}\n\n${defLines.join('\n')}\n` : `${proseText.trimEnd()}\n`;

  healOrphanOkfFootnotes(doc);

  return {
    markdown: serializeOkfDocument(doc),
    rejectedIds,
    replacedMap,
    addedSources,
    orphanClaimLines,
  };
}



/**
 * Parses markdown text and Interactions API grounding steps, resolves Vertex redirect URLs,
 * weaves inline `url_citation` annotations at their UTF-8 byte offsets as OKF v0.2 `[^id]` footnotes,
 * lifts all external sources into YAML frontmatter (`sources: [{ id, resource, title, retrieved_at }]`),
 * and formats a complete OKF v0.2 Concept Document (`SPEC.md` §4 & §5).
 */
export async function cleanGroundingLinks(
  text: string,
  steps?: any[],
  options?: CleanGroundingOptions
): Promise<string> {
  const nowIso =
    parseValidIsoTimestamp(options?.generatedAt) ||
    new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const redirectRegex =
    /https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[a-zA-Z0-9_\-\+=%]+/g;
  const textMatches = text.match(redirectRegex) || [];

  const groundedSources: Array<{ title?: string; url: string }> = [];
  const inlineAnnotations: Array<{
    start_index?: number;
    end_index: number;
    title?: string;
    url: string;
  }> = [];

  if (Array.isArray(steps)) {
    const isModelTextStep = (s: any): boolean => {
      if (s?.type === 'model_output' && Array.isArray(s.content)) {
        return s.content.some((cp: any) => typeof cp?.text === 'string' && cp.text.trim().length > 0);
      }
      if (s?.type === 'text' && typeof s.text === 'string' && s.text.trim().length > 0) {
        return true;
      }
      return false;
    };

    let finalModelOutputIdx = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (isModelTextStep(steps[i])) {
        finalModelOutputIdx = i;
        break;
      }
    }
    if (finalModelOutputIdx === -1) {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (
          (steps[i]?.type === 'model_output' && Array.isArray(steps[i].content)) ||
          (steps[i]?.type === 'text' && Array.isArray(steps[i].annotations))
        ) {
          finalModelOutputIdx = i;
          break;
        }
      }
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step?.type === 'google_search_result' && Array.isArray(step.result)) {
        for (const resItem of step.result) {
          if (resItem?.url && typeof resItem.url === 'string') {
            groundedSources.push({ title: resItem.title, url: resItem.url });
          }
        }
      }

      const contentParts =
        step?.type === 'model_output' && Array.isArray(step.content)
          ? step.content
          : step?.type === 'text' && Array.isArray(step.annotations)
            ? [step]
            : null;

      if (contentParts) {
        const isFinalStep =
          finalModelOutputIdx !== -1 ? i === finalModelOutputIdx : i === steps.length - 1;
        for (const contentPart of contentParts) {
          if (Array.isArray(contentPart?.annotations)) {
            for (const ann of contentPart.annotations) {
              if (ann?.url && typeof ann.url === 'string') {
                if (isFinalStep) {
                  groundedSources.push({ title: ann.title, url: ann.url });
                  if (typeof ann.end_index === 'number' && ann.end_index > 0) {
                    inlineAnnotations.push({
                      start_index: ann.start_index,
                      end_index: ann.end_index,
                      title: ann.title,
                      url: ann.url,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  const allRedirectUrls = Array.from(
    new Set([
      ...textMatches,
      ...groundedSources
        .map((s) => s.url)
        .filter((u) => isVertexRedirectUrl(u)),
    ])
  );

  const urlMap = new Map<string, string>();
  const lastModifiedMap = new Map<string, string>();
  const pageTitleMap = new Map<string, string>();
  const freshlyGroundedUrls = new Set<string>();
  for (const gs of groundedSources) {
    if (gs.url) freshlyGroundedUrls.add(gs.url.trim());
  }
  for (const ann of inlineAnnotations) {
    if (ann.url) freshlyGroundedUrls.add(ann.url.trim());
  }
  for (const rUrl of allRedirectUrls) {
    if (rUrl) freshlyGroundedUrls.add(rUrl.trim());
  }

  if (allRedirectUrls.length > 0) {
    console.log(
      `Found ${allRedirectUrls.length} Vertex grounding redirects. Resolving to raw URLs...`
    );
    const resolutions = await Promise.all(
      allRedirectUrls.map(async (url) => {
        const resolved = await resolveRedirect(url);
        return { original: url, resolved };
      })
    );
    for (const { original, resolved } of resolutions) {
      const finalUrl = (resolved?.url || original).trim();
      urlMap.set(original, finalUrl);
      if (!isVertexRedirectUrl(finalUrl)) {
        freshlyGroundedUrls.add(finalUrl);
      }
      if (resolved?.lastModified) {
        lastModifiedMap.set(original, resolved.lastModified);
        lastModifiedMap.set(finalUrl, resolved.lastModified);
      }
      if (resolved?.pageTitle) {
        pageTitleMap.set(original, resolved.pageTitle);
        pageTitleMap.set(finalUrl, resolved.pageTitle);
      }
    }
  }

  // Build candidate pool from groundedSources + existing workspace/bundle/ concepts to heal any
  // frontmatter/body redirect URLs whose base64 token was corrupted or truncated by the LLM
  const extractRedirectToken = (url?: string): string => {
    if (!url) return '';
    const marker = 'vertexaisearch.cloud.google.com/grounding-api-redirect/';
    const idx = url.indexOf(marker);
    return idx !== -1 ? url.slice(idx + marker.length).trim() : '';
  };

  interface HealingCandidate {
    id: string;
    slug: string;
    title: string;
    normTitle: string;
    resource: string;
    tokens: Set<string>;
    searchableText: string;
    originalRedirect?: string;
    redirectToken: string;
  }
  const healingCandidates: HealingCandidate[] = [];
  const seenCandidateKeys = new Set<string>();

  const addHealingCandidate = (
    resourceUrl: string,
    rawTitle?: string,
    rawId?: string,
    originalRedirect?: string
  ) => {
    const cleanUrl = (resourceUrl || '').trim();
    if (!/^https?:\/\//i.test(cleanUrl) || isVertexRedirectUrl(cleanUrl)) return;
    const key = `${(rawId || '').toLowerCase()}::${(rawTitle || '').toLowerCase()}::${cleanUrl}`;
    if (seenCandidateKeys.has(key)) return;
    seenCandidateKeys.add(key);

    let urlTokensText = '';
    try {
      const parsed = new URL(cleanUrl);
      urlTokensText = `${parsed.hostname.replace(/^www\./, '')} ${parsed.pathname}`;
    } catch {
      urlTokensText = cleanUrl;
    }
    const slug = generateSourceSlugId(rawTitle || rawId || '', cleanUrl, new Set());
    const normTitle = normalizeSourceMatchKey(rawTitle);
    const allTokens = extractSourceMatchTokens(`${rawId || ''} ${rawTitle || ''} ${urlTokensText}`);
    healingCandidates.push({
      id: (rawId || '').trim().toLowerCase(),
      slug: slug.toLowerCase(),
      title: (rawTitle || '').trim(),
      normTitle,
      resource: cleanUrl,
      tokens: new Set(allTokens),
      searchableText: `${normalizeSourceMatchKey(rawId)} ${normTitle} ${normalizeSourceMatchKey(urlTokensText)}`.trim(),
      originalRedirect,
      redirectToken: extractRedirectToken(originalRedirect),
    });
  };

  for (const gs of groundedSources) {
    const resolved = (urlMap.get(gs.url) || gs.url).trim();
    if (!isVertexRedirectUrl(resolved)) {
      addHealingCandidate(
        resolved,
        gs.title,
        undefined,
        isVertexRedirectUrl(gs.url) ? gs.url : undefined
      );
    }
  }

  for (const [origRedirect, resolvedUrl] of urlMap.entries()) {
    if (resolvedUrl && resolvedUrl !== origRedirect && !isVertexRedirectUrl(resolvedUrl)) {
      addHealingCandidate(resolvedUrl, undefined, undefined, origRedirect);
    }
  }

  const bundleRootDir =
    options?.bundleRoot || path.join(options?.workspaceRoot || './workspace', 'bundle');
  const existingBundleSourceByCanonicalUrl = new Map<string, OKFSource>();
  for (const bs of collectExistingBundleSources(bundleRootDir)) {
    addHealingCandidate(bs.resource, bs.title, bs.id);
    const canonUrl = normalizeCanonicalSourceUrl(bs.resource);
    if (canonUrl) {
      const prev = existingBundleSourceByCanonicalUrl.get(canonUrl);
      if (!prev) {
        existingBundleSourceByCanonicalUrl.set(canonUrl, { ...bs });
      } else {
        if (!prev.id && bs.id) prev.id = bs.id;
        if (shouldUpgradeSourceTitle(prev.title, bs.title, bs.resource)) {
          prev.title = bs.title;
        }
      }
    }
    if (bs.last_modified && !lastModifiedMap.has(bs.resource)) {
      lastModifiedMap.set(bs.resource, bs.last_modified);
    }
  }

  const healRedirectUrl = (rawUrl: string, rawTitle?: string, preferredId?: string): string => {
    const mapped = (urlMap.get(rawUrl) || rawUrl).trim();
    if (!isVertexRedirectUrl(mapped)) return mapped;
    if (healingCandidates.length === 0) return mapped;

    const slugId = String(preferredId || '').trim().toLowerCase();
    const normId = normalizeSourceMatchKey(preferredId);
    const normTitle = normalizeSourceMatchKey(rawTitle);
    const titleSlug = rawTitle
      ? generateSourceSlugId(rawTitle, 'https://example.com', new Set()).toLowerCase()
      : '';
    const queryTokens = extractSourceMatchTokens(`${preferredId || ''} ${rawTitle || ''}`);
    const rawRedirectToken = extractRedirectToken(mapped);

    let bestCandidate: HealingCandidate | null = null;
    let bestScore = 0;

    for (const c of healingCandidates) {
      let score = 0;

      // 1. Exact or substring ID / slug match
      if (slugId && (c.id === slugId || c.slug === slugId)) {
        score += 100;
      } else if (
        titleSlug &&
        titleSlug !== 'source' &&
        (c.slug === titleSlug || c.id === titleSlug)
      ) {
        score += 90;
      } else if (slugId.length >= 5) {
        if (
          (c.id.length >= 5 && (c.id.includes(slugId) || slugId.includes(c.id))) ||
          (c.slug.length >= 5 && (c.slug.includes(slugId) || slugId.includes(c.slug)))
        ) {
          score += 45;
        }
      }

      // 2. Normalized title match (weighted by title specificity so generic 1-word site titles like 'Lovdata' don't trump specific compound matches)
      if (normTitle && c.normTitle) {
        if (c.normTitle === normTitle) {
          const wordCount = normTitle.split(/\s+/).length;
          score += wordCount >= 2 || normTitle.length >= 12 ? 85 : 25;
        } else if (
          normTitle.length >= 5 &&
          c.normTitle.length >= 5 &&
          (c.normTitle.includes(normTitle) || normTitle.includes(c.normTitle))
        ) {
          const overlapLen = Math.min(normTitle.length, c.normTitle.length);
          const overlapWords = Math.min(
            normTitle.split(/\s+/).length,
            c.normTitle.split(/\s+/).length
          );
          score += overlapWords >= 2 || overlapLen >= 12 ? Math.min(55, overlapLen * 2) : 6;
        }
      }

      if (
        normId.length >= 5 &&
        c.normTitle.length >= 5 &&
        (c.normTitle.includes(normId) || normId.includes(c.normTitle))
      ) {
        const overlapLen = Math.min(normId.length, c.normTitle.length);
        score += overlapLen >= 8 ? Math.min(40, overlapLen * 2) : 8;
      }

      // 3. Token overlap scoring across id, title, and URL domain/path (supporting compound words)
      for (const qt of queryTokens) {
        if (c.tokens.has(qt)) {
          score += qt.length >= 10 ? 18 : qt.length >= 6 ? 10 : 5;
        } else if (qt.length >= 5) {
          let matchedCompound = false;
          for (const ct of c.tokens) {
            if (ct.length >= 4 && (qt.includes(ct) || ct.includes(qt))) {
              score += Math.min(qt.length, ct.length) >= 8 ? 14 : 8;
              matchedCompound = true;
              break;
            }
          }
          if (!matchedCompound && c.searchableText.includes(qt)) {
            score += 4;
          }
        } else if (qt.length >= 4 && c.searchableText.includes(qt)) {
          score += 3;
        }
      }

      // 4. Base64 redirect token prefix similarity (when LLM truncated or slightly corrupted the redirect token)
      if (rawRedirectToken.length >= 16 && c.redirectToken.length >= 16) {
        let prefixLen = 0;
        const maxLen = Math.min(rawRedirectToken.length, c.redirectToken.length);
        while (prefixLen < maxLen && rawRedirectToken[prefixLen] === c.redirectToken[prefixLen]) {
          prefixLen++;
        }
        if (prefixLen >= 18) {
          score += Math.min(60, prefixLen);
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = c;
      }
    }

    if (bestCandidate && bestScore >= 6) {
      return bestCandidate.resource;
    }

    // 5. Fallback if there is only a single unique resolved grounded URL
    const uniqueUrls = Array.from(new Set(healingCandidates.map((c) => c.resource)));
    if (uniqueUrls.length === 1) {
      return uniqueUrls[0];
    }

    return mapped;
  };

  // Pre-register any existing frontmatter sources so their IDs are preserved during byte-offset weaving
  const usedIds = new Set<string>();
  const sourcesByUrl = new Map<string, OKFSource>();
  const sourcesById = new Map<string, OKFSource>();
  const sourceIdAliases = new Map<string, string>();
  const orderedSources: OKFSource[] = [];
  const authorExplicitUrls = new Set<string>();

  const registerSource = (
    rawUrl: string,
    rawTitle?: string,
    preferredId?: string,
    extra?: Partial<OKFSource>,
    freshlyGrounded: boolean = false
  ): OKFSource => {
    const initialResolved = (urlMap.get(rawUrl) || rawUrl).trim();
    const resolvedUrl = isVertexRedirectUrl(initialResolved)
      ? healRedirectUrl(initialResolved, rawTitle, preferredId)
      : initialResolved;
    if (!isVertexRedirectUrl(resolvedUrl)) {
      if (resolvedUrl !== rawUrl) {
        urlMap.set(rawUrl, resolvedUrl);
      }
      addHealingCandidate(
        resolvedUrl,
        rawTitle,
        preferredId,
        isVertexRedirectUrl(rawUrl) ? rawUrl : undefined
      );
    }

    const canonResolvedUrl = normalizeCanonicalSourceUrl(resolvedUrl);
    const matchingBundleSrc = canonResolvedUrl
      ? existingBundleSourceByCanonicalUrl.get(canonResolvedUrl)
      : undefined;

    const effectiveRawTitle =
      rawTitle && !isBareDomainTitle(rawTitle)
        ? rawTitle
        : pageTitleMap.get(resolvedUrl) || pageTitleMap.get(rawUrl) || rawTitle;

    let cleanTitle = decodeHtmlEntities(effectiveRawTitle || '')
      .replace(/\s*\(Alternativ indeks\)\s*$/i, '')
      .replace(/^\*\*|\*\*$/g, '')
      .trim();

    if (
      matchingBundleSrc?.title &&
      (!cleanTitle ||
        isBareDomainTitle(cleanTitle) ||
        isAutoDomainSlugTitle(cleanTitle) ||
        shouldUpgradeSourceTitle(cleanTitle, matchingBundleSrc.title, resolvedUrl))
    ) {
      cleanTitle = decodeHtmlEntities(matchingBundleSrc.title).trim();
    }

    const detectedLastModified =
      lastModifiedMap.get(resolvedUrl) ||
      lastModifiedMap.get(rawUrl) ||
      parseValidIsoTimestamp(extra?.last_modified);
    const extraRetrievedAt = parseValidIsoTimestamp(extra?.retrieved_at);
    const wasHealedFromRedirect = isVertexRedirectUrl(rawUrl) && !isVertexRedirectUrl(resolvedUrl);
    const isFresh =
      freshlyGrounded ||
      wasHealedFromRedirect ||
      freshlyGroundedUrls.has(rawUrl.trim()) ||
      freshlyGroundedUrls.has(resolvedUrl);

    if (preferredId && sourcesById.has(preferredId)) {
      const existingById = sourcesById.get(preferredId)!;
      if (
        isVertexRedirectUrl(existingById.resource) &&
        resolvedUrl &&
        !isVertexRedirectUrl(resolvedUrl)
      ) {
        sourcesByUrl.delete(existingById.resource);
        existingById.resource = resolvedUrl;
        sourcesByUrl.set(resolvedUrl, existingById);
        if (canonResolvedUrl) sourcesByUrl.set(canonResolvedUrl, existingById);
        existingById.retrieved_at = nowIso;
      }
      if (shouldUpgradeSourceTitle(existingById.title, cleanTitle, existingById.resource)) {
        existingById.title = enrichBareDomainSourceTitle(cleanTitle, existingById.resource);
      } else if (isBareDomainTitle(existingById.title)) {
        existingById.title = enrichBareDomainSourceTitle(existingById.title, existingById.resource);
      }
      if (isFresh) {
        existingById.retrieved_at = nowIso;
      } else if (extraRetrievedAt && !existingById.retrieved_at) {
        existingById.retrieved_at = extraRetrievedAt;
      } else if (!existingById.retrieved_at) {
        existingById.retrieved_at = nowIso;
      }
      if (detectedLastModified && !existingById.last_modified) {
        existingById.last_modified = detectedLastModified;
      }
      return existingById;
    }

    const existingUrlMatch =
      sourcesByUrl.get(resolvedUrl) || (canonResolvedUrl ? sourcesByUrl.get(canonResolvedUrl) : undefined);
    if (existingUrlMatch) {
      const existing = existingUrlMatch;
      const prefId = preferredId?.trim();
      if (prefId && existing.id && prefId !== existing.id) {
        sourceIdAliases.set(prefId, existing.id);
        sourcesById.set(prefId, existing);
        usedIds.add(prefId);
      }
      if (shouldUpgradeSourceTitle(existing.title, cleanTitle, existing.resource)) {
        existing.title = enrichBareDomainSourceTitle(cleanTitle, existing.resource);
      } else if (isBareDomainTitle(existing.title)) {
        existing.title = enrichBareDomainSourceTitle(existing.title, existing.resource);
      }
      if (isFresh) {
        existing.retrieved_at = nowIso;
      } else if (extraRetrievedAt && !existing.retrieved_at) {
        existing.retrieved_at = extraRetrievedAt;
      } else if (!existing.retrieved_at) {
        existing.retrieved_at = nowIso;
      }
      if (detectedLastModified && !existing.last_modified) {
        existing.last_modified = detectedLastModified;
      }
      return existing;
    }

    // If this newly resolved URL heals an already-registered unhealed frontmatter source, update it in place
    if (!preferredId && !isVertexRedirectUrl(resolvedUrl)) {
      for (const existing of orderedSources) {
        if (isVertexRedirectUrl(existing.resource)) {
          const healed = healRedirectUrl(existing.resource, existing.title, existing.id);
          if (healed === resolvedUrl) {
            sourcesByUrl.delete(existing.resource);
            existing.resource = resolvedUrl;
            sourcesByUrl.set(resolvedUrl, existing);
            if (canonResolvedUrl) sourcesByUrl.set(canonResolvedUrl, existing);
            if (shouldUpgradeSourceTitle(existing.title, cleanTitle, resolvedUrl)) {
              existing.title = enrichBareDomainSourceTitle(cleanTitle, resolvedUrl);
            } else if (isBareDomainTitle(existing.title)) {
              existing.title = enrichBareDomainSourceTitle(existing.title, resolvedUrl);
            }
            existing.retrieved_at = nowIso;
            if (detectedLastModified && !existing.last_modified) {
              existing.last_modified = detectedLastModified;
            }
            return existing;
          }
        }
      }
    }

    let fallbackLabel = cleanTitle;
    if (!fallbackLabel) {
      try {
        fallbackLabel = new URL(resolvedUrl).hostname.replace(/^www\./, '');
      } catch {
        fallbackLabel = 'source';
      }
    }

    const prefId = preferredId?.trim() || '';
    const bundleCanonicalId = matchingBundleSrc?.id?.trim() || '';
    let id = '';
    if (bundleCanonicalId && !usedIds.has(bundleCanonicalId)) {
      id = bundleCanonicalId;
      usedIds.add(id);
      if (prefId && prefId !== id) {
        sourceIdAliases.set(prefId, id);
        usedIds.add(prefId);
      }
    } else if (prefId) {
      id = prefId;
      usedIds.add(id);
    } else {
      id = generateSourceSlugId(fallbackLabel, resolvedUrl, usedIds);
    }

    const validExtraLm = parseValidIsoTimestamp(extra?.last_modified);
    const finalLm = detectedLastModified || validExtraLm;
    const enrichedTitle = enrichBareDomainSourceTitle(cleanTitle || fallbackLabel, resolvedUrl);
    const entry: OKFSource = {
      id,
      resource: resolvedUrl,
      title: enrichedTitle,
      ...extra,
      retrieved_at: isFresh ? nowIso : extraRetrievedAt || nowIso,
      ...(finalLm ? { last_modified: finalLm } : {}),
    };
    if (!finalLm && 'last_modified' in entry) {
      delete entry.last_modified;
    }
    sourcesByUrl.set(resolvedUrl, entry);
    if (canonResolvedUrl) sourcesByUrl.set(canonResolvedUrl, entry);
    sourcesById.set(id, entry);
    if (prefId && prefId !== id) {
      sourcesById.set(prefId, entry);
    }
    orderedSources.push(entry);
    return entry;
  };

  // Check if raw text already begins with YAML frontmatter so we don't weave inline footnotes inside frontmatter
  let frontmatterEndByteOffset = 0;
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (fmMatch) {
    frontmatterEndByteOffset = Buffer.byteLength(fmMatch[0], 'utf8');
    try {
      const initialDoc = parseOkfDocument(text);
      const initialSources = initialDoc.frontmatter?.sources;
      if (Array.isArray(initialSources)) {
        for (const s of initialSources) {
          const rawRes = s && typeof s === 'object' ? String(s.resource || (s as any).url || '').trim() : '';
          if (rawRes) {
            const { id, resource, url, title, ...rest } = s as any;
            authorExplicitUrls.add(rawRes);
            const entry = registerSource(rawRes, title ? String(title) : undefined, id ? String(id) : undefined, rest);
            if (entry?.resource) authorExplicitUrls.add(entry.resource);
          }
        }
      }
    } catch {
      // Ignore partial frontmatter errors before full cleanup
    }
  }

  // 1. Weave inline url_citation annotations into the UTF-8 buffer as OKF v0.2 [^id] footnotes before byte offsets change
  let workingText = text;
  if (inlineAnnotations.length > 0) {
    const buf = Buffer.from(workingText, 'utf8');
    const snapSafeEndIndex = (rawIdx: number): number | null => {
      let idx = rawIdx;
      // Never split a multi-byte UTF-8 character sequence (continuation bytes 10xxxxxx)
      while (idx < buf.length && (buf[idx] & 0b11000000) === 0b10000000) {
        idx++;
      }
      if (idx > buf.length || idx <= frontmatterEndByteOffset) return null;

      // Inspect surrounding text on the current line
      let lineStart = idx;
      while (lineStart > frontmatterEndByteOffset && buf[lineStart - 1] !== 0x0a) {
        lineStart--;
      }
      let lineEnd = idx;
      while (lineEnd < buf.length && buf[lineEnd] !== 0x0a && buf[lineEnd] !== 0x0d) {
        lineEnd++;
      }
      const lineStr = buf.subarray(lineStart, lineEnd).toString('utf8');
      // Never weave byte-offset footnotes inside Markdown headings (`## ...`) or Markdown table rows (`| ... |`)
      if (/^\s*#{1,6}\s/.test(lineStr) || /^\s*\|/.test(lineStr)) {
        return null;
      }

      let beforeStr = buf.subarray(lineStart, idx).toString('utf8');
      let afterStr = buf.subarray(idx, lineEnd).toString('utf8');

      // Advance to the end of the current word/token (including slash-joined word pairs like `overtredelser/avvik`)
      const wordMatch = afterStr.match(/^[\p{L}\p{N}_\-]+(?:\/[\p{L}\p{N}_\-]+)*/u);
      if (wordMatch) {
        idx += Buffer.byteLength(wordMatch[0], 'utf8');
        beforeStr = buf.subarray(lineStart, idx).toString('utf8');
        afterStr = buf.subarray(idx, lineEnd).toString('utf8');
      }
      if (/[\p{L}\p{N}_\-]$/u.test(beforeStr)) {
        const slashTailMatch = afterStr.match(/^(?:\/[\p{L}\p{N}_\-]+)+/u);
        if (slashTailMatch) {
          idx += Buffer.byteLength(slashTailMatch[0], 'utf8');
          beforeStr = buf.subarray(lineStart, idx).toString('utf8');
          afterStr = buf.subarray(idx, lineEnd).toString('utf8');
        }
      }

      // If immediately after `§` or inside a short section/parenthetical token like `§ 11-2` / `(RK 1)` / `(*FOB § 4*)`,
      // advance past any trailing section number (`§ 4`, `11-2`, `1`) without consuming subsequent prose words
      if (/(?:§|\([*_`]*[\p{L}\p{N}_\-]{1,15})\s*$/u.test(beforeStr)) {
        const secNumMatch = afterStr.match(/^(?:\s*(?:§\s*)?\d[\p{L}\p{N}_\-]*)+/u);
        if (secNumMatch) {
          idx += Buffer.byteLength(secNumMatch[0], 'utf8');
          afterStr = buf.subarray(idx, lineEnd).toString('utf8');
        }
      }

      // Advance past any immediately following closing emphasis or bracket characters (`*`, `_`, `` ` ``, `)`, `]`)
      const closingMatch = afterStr.match(/^[*_`)\]]+/);
      if (closingMatch) {
        idx += Buffer.byteLength(closingMatch[0], 'utf8');
        beforeStr = buf.subarray(lineStart, idx).toString('utf8');
        afterStr = buf.subarray(idx, lineEnd).toString('utf8');
      }

      // If `idx` landed inside an unclosed footnote bracket (`[^id1, ^id2]`), advance to its closing `]`
      if (/\[\^[^\]]*$/.test(beforeStr)) {
        const bracketRest = afterStr.match(/^[^\]]*\]/);
        if (bracketRest) {
          idx += Buffer.byteLength(bracketRest[0], 'utf8');
        }
      }

      return idx;
    };

    const byEndIndex = new Map<number, OKFSource[]>();
    for (const ann of inlineAnnotations) {
      if (ann.end_index > buf.length || ann.end_index <= frontmatterEndByteOffset) continue;
      const resolvedAnnUrl = (urlMap.get(ann.url) || ann.url).trim();
      if (
        isLowSignalGroundingUrl(resolvedAnnUrl) &&
        !authorExplicitUrls.has(resolvedAnnUrl) &&
        !authorExplicitUrls.has(ann.url.trim())
      ) {
        continue;
      }
      const safeIdx = snapSafeEndIndex(ann.end_index);
      if (safeIdx === null) continue;
      const srcEntry = registerSource(ann.url, ann.title, undefined, undefined, true);
      if (!byEndIndex.has(safeIdx)) {
        byEndIndex.set(safeIdx, []);
      }
      const group = byEndIndex.get(safeIdx)!;
      if (!group.some((item) => item.id === srcEntry.id)) {
        group.push(srcEntry);
      }
    }

    const sortedEnds = Array.from(byEndIndex.keys()).sort((a, b) => b - a);
    const chunks: Buffer[] = [];
    let cursor = buf.length;

    for (const endIdx of sortedEnds) {
      const sourcesAtSpan = byEndIndex.get(endIdx)!;
      const precedingSlice = buf.subarray(Math.max(0, endIdx - 64), endIdx).toString('utf8');
      const followingSlice = buf
        .subarray(endIdx, Math.min(buf.length, endIdx + 64))
        .toString('utf8');
      const neededFootnotes = sourcesAtSpan
        .filter((s) => {
          const escapedId = String(s.id || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const alreadyFollowsWithCaretOrPunct = new RegExp(
            `^[\\s.?!:;]*\\^*\\[\\^${escapedId}\\]`
          ).test(followingSlice);
          return (
            !precedingSlice.endsWith(`[^${s.id}]`) &&
            !followingSlice.startsWith(`[^${s.id}]`) &&
            !followingSlice.startsWith(`.^${s.id}`) &&
            !followingSlice.startsWith(`?^${s.id}`) &&
            !alreadyFollowsWithCaretOrPunct
          );
        })
        .map((s) => `[^${s.id}]`)
        .join('');
      chunks.unshift(buf.subarray(endIdx, cursor));
      if (neededFootnotes) {
        chunks.unshift(Buffer.from(neededFootnotes, 'utf8'));
      }
      cursor = endIdx;
    }
    chunks.unshift(buf.subarray(0, cursor));
    workingText = Buffer.concat(chunks).toString('utf8');
  }

  // 2. Replace any remaining raw redirect URLs in the text
  for (const [original, resolved] of urlMap.entries()) {
    if (resolved && resolved !== original) {
      console.log(`Resolved: ${original.substring(0, 60)}... -> ${resolved}`);
      workingText = workingText.replaceAll(original, resolved);
    }
  }

  // Strip outer ```markdown or ```yaml wrapper if the model accidentally fenced the entire document
  workingText = workingText
    .replace(/^```(?:markdown|md|yaml)\r?\n([\s\S]*?)\r?\n```\s*$/i, '$1')
    .trim();

  // 3. Parse existing frontmatter + body (if present)
  let parsedDoc: OKFDocument;
  try {
    parsedDoc = parseOkfDocument(workingText);
  } catch {
    parsedDoc = { frontmatter: {}, body: workingText };
  }

  if (Array.isArray(parsedDoc.frontmatter.sources)) {
    for (const s of parsedDoc.frontmatter.sources) {
      const rawRes = s && typeof s === 'object' ? String(s.resource || (s as any).url || '').trim() : '';
      if (rawRes) {
        const { id, resource, url, title, ...rest } = s as any;
        registerSource(rawRes, title ? String(title) : undefined, id ? String(id) : undefined, rest);
      }
    }
  }

  let bodyText = parsedDoc.body;

  // 4. Extract legacy "* **Title**: https://..." or "- [Title](https://...)" citation lines and convert to OKF sources
  const bareSourceLineRegex = /^(\s*[\*\-]\s+)\*\*(.+?)\*\*:\s+(https?:\/\/\S+)\s*$/;
  const bulletLinkSourceLineRegex = /^(\s*[\*\-]\s+)\[\*\*?(.+?)\*\*?\]\((https?:\/\/[^\s)]+)\)\s*$/;
  const footnoteDefLineRegex = /^\[\^([A-Za-z0-9_\-]+)\]:\s*(.+)$/;
  const existingFootnoteDefs = new Map<string, string>();

  const rawBodyLines = bodyText.split(/\r?\n/);
  const cleanedBodyLines: string[] = [];
  let inLegacyCitationsSection = false;

  for (const line of rawBodyLines) {
    if (/^#{1,3}\s+(Sources\s*&\s*Citations|Citations|Grounded\s+Search\s+References)\s*$/i.test(line.trim())) {
      inLegacyCitationsSection = true;
      continue;
    }
    if (inLegacyCitationsSection && /^#{1,3}\s+/.test(line.trim())) {
      inLegacyCitationsSection = false;
    }

    const fnMatch = line.trim().match(footnoteDefLineRegex);
    if (fnMatch) {
      const [, fnId, fnRest] = fnMatch;
      const urlInFn = fnRest.match(/(https?:\/\/[^\s)]+)/);
      if (urlInFn) {
        const titlePart = fnRest
          .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/, '$1')
          .replace(urlInFn[1], '')
          .replace(/^[\s:\-–—]+|[\s:\-–—]+$/g, '')
          .trim();
        const src = registerSource(urlInFn[1], titlePart || fnId, fnId);
        existingFootnoteDefs.set(src.id!, src.title || src.resource);
      } else {
        existingFootnoteDefs.set(fnId, decodeHtmlEntities(fnRest.trim()));
      }
      continue;
    }

    const bareMatch = line.match(bareSourceLineRegex);
    if (bareMatch) {
      const [, , rawTitle, url] = bareMatch;
      const src = registerSource(url, rawTitle);
      existingFootnoteDefs.set(src.id!, src.title || src.resource);
      continue;
    }

    if (inLegacyCitationsSection) {
      const bulletMatch = line.match(bulletLinkSourceLineRegex);
      if (bulletMatch) {
        const src = registerSource(bulletMatch[3], bulletMatch[2]);
        existingFootnoteDefs.set(src.id!, src.title || src.resource);
        continue;
      }
      const plainUrlBullet = line.match(/^\s*[\*\-]\s+(https?:\/\/\S+)\s*$/);
      if (plainUrlBullet) {
        const src = registerSource(plainUrlBullet[1]);
        existingFootnoteDefs.set(src.id!, src.title || src.resource);
        continue;
      }
      if (!line.trim()) continue;
    }

    cleanedBodyLines.push(line);
  }

  bodyText = cleanedBodyLines.join('\n');

  // 5. Convert inline external markdown links in prose (`([Title](https://...))` or `[Title](https://...)`)
  // into OKF v0.2 `[^id]` footnote references while leaving Markdown images (`![Alt](https://...)`)
  // and internal bundle links (`/foo.md`, `./bar.md`) intact.
  bodyText = bodyText.replace(
    /\s*\(\s*(?<!\!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\s*\)/g,
    (_full, label: string, url: string) => {
      const src = registerSource(url, label);
      return `[^${src.id}]`;
    }
  );

  bodyText = bodyText.replace(
    /(?<!\!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_full, label: string, url: string) => {
      const cleanLabel = label.replace(/^\*\*|\*\*$/g, '').trim();
      const src = registerSource(url, cleanLabel);
      // If the link text was just a domain/URL citation marker, emit footnote directly; otherwise keep anchor text + footnote
      if (/^https?:\/\//i.test(cleanLabel) || cleanLabel.toLowerCase() === 'source' || cleanLabel.toLowerCase() === 'link') {
        return `[^${src.id}]`;
      }
      return `${label}[^${src.id}]`;
    }
  );

  // Deduplicate adjacent identical footnote markers like `[^id][^id]`
  bodyText = bodyText.replace(/(\[\^[A-Za-z0-9_\-]+\])\1+/g, '$1');

  // Normalize stray BPE space immediately after list-item opening bold marker (e.g. `2. ** label**:` -> `2. **label**:`) outside code fences
  bodyText = bodyText
    .split(/(^```[\s\S]*?^```)/gm)
    .map((segment, idx) =>
      idx % 2 === 1
        ? segment
        : segment.replace(
            /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)\*\*[ \t]+([^\s*\r\n][^*\r\n]*?\*\*)/gm,
            '$1**$2'
          )
    )
    .join('');

  // 6. Register any remaining groundedSources from the Interactions API steps
  for (const src of groundedSources) {
    const candidateResolved = (urlMap.get(src.url) || src.url).trim();
    if (
      isLowSignalGroundingUrl(candidateResolved) &&
      !authorExplicitUrls.has(candidateResolved) &&
      !authorExplicitUrls.has(src.url.trim())
    ) {
      continue;
    }
    if (!isVertexRedirectUrl(candidateResolved) || orderedSources.length === 0) {
      registerSource(src.url, src.title, undefined, undefined, true);
    }
  }

  // Final healing and deduplication pass on orderedSources in case body links introduced new candidate URLs
  for (let i = 0; i < orderedSources.length; i++) {
    const entry = orderedSources[i];
    if (isVertexRedirectUrl(entry.resource)) {
      const healed = healRedirectUrl(entry.resource, entry.title, entry.id);
      if (healed && !isVertexRedirectUrl(healed)) {
        sourcesByUrl.delete(entry.resource);
        entry.resource = healed;
        entry.retrieved_at = nowIso;
        const healedLm = lastModifiedMap.get(healed);
        if (healedLm && !entry.last_modified) {
          entry.last_modified = healedLm;
        }
      }
    }
  }

  const dedupedSources: OKFSource[] = [];
  const canonicalByResource = new Map<string, OKFSource>();
  for (const entry of orderedSources) {
    const canonEntryUrl = normalizeCanonicalSourceUrl(entry.resource);
    const matchingBundleSrc = canonEntryUrl
      ? existingBundleSourceByCanonicalUrl.get(canonEntryUrl)
      : undefined;
    if (
      matchingBundleSrc?.title &&
      (!entry.title ||
        isBareDomainTitle(entry.title) ||
        isAutoDomainSlugTitle(entry.title) ||
        shouldUpgradeSourceTitle(entry.title, matchingBundleSrc.title, entry.resource))
    ) {
      entry.title = decodeHtmlEntities(matchingBundleSrc.title).trim();
    }
    if (
      matchingBundleSrc?.id &&
      entry.id &&
      entry.id !== matchingBundleSrc.id &&
      !usedIds.has(matchingBundleSrc.id)
    ) {
      const oldId = entry.id;
      entry.id = matchingBundleSrc.id;
      usedIds.add(entry.id);
      sourceIdAliases.set(oldId, entry.id);
      sourcesById.set(entry.id, entry);
      sourcesById.set(oldId, entry);
    }
    const rawEntryTitle = entry.title;
    entry.title = enrichBareDomainSourceTitle(entry.title, entry.resource);
    const resourceKey = canonEntryUrl || entry.resource;
    const existingCanonical = canonicalByResource.get(resourceKey);
    if (existingCanonical && existingCanonical !== entry) {
      const candidateForUpgrade =
        rawEntryTitle && !isBareDomainTitle(rawEntryTitle) ? rawEntryTitle : entry.title;
      if (shouldUpgradeSourceTitle(existingCanonical.title, candidateForUpgrade, entry.resource)) {
        existingCanonical.title = enrichBareDomainSourceTitle(candidateForUpgrade, entry.resource);
      }
      if (entry.retrieved_at === nowIso || !existingCanonical.retrieved_at) {
        existingCanonical.retrieved_at = entry.retrieved_at || nowIso;
      }
      if (entry.last_modified && !existingCanonical.last_modified) {
        existingCanonical.last_modified = entry.last_modified;
      }
      if (entry.id && existingCanonical.id && entry.id !== existingCanonical.id) {
        sourceIdAliases.set(entry.id, existingCanonical.id);
        bodyText = bodyText.replaceAll(`[^${entry.id}]`, `[^${existingCanonical.id}]`);
        sourcesById.set(entry.id, existingCanonical);
      }
    } else {
      canonicalByResource.set(resourceKey, entry);
      sourcesByUrl.set(entry.resource, entry);
      if (canonEntryUrl) sourcesByUrl.set(canonEntryUrl, entry);
      dedupedSources.push(entry);
    }
  }
  orderedSources.length = 0;
  orderedSources.push(...dedupedSources);

  // Domain-neutral provenance check: annotate masquerading publisher titles on third-party mirrors (`(via <hostname>)`)
  for (const entry of orderedSources) {
    const prov = inspectSourceDomainProvenance(entry);
    if (prov.domainMismatch && prov.hostname && prov.claimedPublisher) {
      const viaSuffix = `(via ${prov.hostname})`;
      if (entry.title && !entry.title.toLowerCase().includes(prov.hostname.toLowerCase())) {
        entry.title = `${entry.title} ${viaSuffix}`;
        if (entry.id) {
          existingFootnoteDefs.set(entry.id, entry.title);
        }
      }
      console.log(
        `[OKF Source Provenance Notice] Source [^${entry.id}] claims "${prov.claimedPublisher}" in title, but resolved to "${prov.hostname}" (${entry.resource}).`
      );
    }
  }

  // Expand comma/semicolon-separated multi-footnote brackets (`[^id1, ^id2]` or `[^id1,[^id1] 4]`) into separate `[^id1] [^id2]` tags before bare-caret and alias rewriting
  bodyText = bodyText.replace(
    /\[\^([A-Za-z0-9_\-]+)\s*,\s*\[\^([A-Za-z0-9_\-]+)\]\s*([0-9A-Za-z_\-]+)\]/g,
    (_m, id1: string, id2: string, tail: string) => {
      const reconstructed = /^\d+$/.test(tail) ? `${id2.replace(/\d+$/, '')}${tail}` : `${id2}${tail}`;
      return `[^${id1}] [^${reconstructed}]`;
    }
  );
  bodyText = bodyText.replace(
    /\[\^([A-Za-z0-9_\-]+(?:\s*[,;]\s*(?:\[\^|\^)?[A-Za-z0-9_\-]+\]?)+)\]/g,
    (_m, inner: string) =>
      inner
        .split(/\s*[,;]\s*/)
        .map((part) => part.replace(/^\[?\^?/, '').replace(/\]$/, '').trim())
        .filter(Boolean)
        .map((id) => `[^${id}]`)
        .join(' ')
  );

  // Strip redundant carets before `[^id]` (`^[^id]` -> `[^id]`) and convert bare `.^id` typos (`/\.\^([a-z0-9]+(?:-[a-z0-9]+)+)/g`) to `.[^$1]` before alias rewriting
  bodyText = bodyText.replace(/\^+(\[\^[A-Za-z0-9_\-]+\])/g, '$1');
  bodyText = bodyText.replace(/\.\^([a-z0-9]+(?:-[a-z0-9]+)+)/gi, '.[^$1]');
  bodyText = bodyText.replace(
    /([.?!:;]?)(?<!\[)\^([A-Za-z0-9_\-]+)(?!\])/g,
    (fullMatch, punct: string, rawId: string) => {
      const mapped = sourcesById.get(rawId);
      if (!mapped) return fullMatch;
      const canonicalId = mapped.id || rawId;
      return `[^${canonicalId}]${punct || ''}`;
    }
  );

  // Rewrite all duplicate-URL source aliases recorded in registerSource() or deduplication
  for (const [aliasId, rawCanonicalId] of sourceIdAliases.entries()) {
    let canonicalId = rawCanonicalId;
    const seen = new Set<string>([aliasId]);
    while (sourceIdAliases.has(canonicalId) && !seen.has(canonicalId)) {
      seen.add(canonicalId);
      canonicalId = sourceIdAliases.get(canonicalId)!;
    }
    bodyText = bodyText.replaceAll(`[^${aliasId}]`, `[^${canonicalId}]`);
    existingFootnoteDefs.delete(aliasId);
    const canonicalEntry = sourcesById.get(canonicalId);
    if (canonicalEntry) {
      sourcesById.set(aliasId, canonicalEntry);
    }
  }

  // Resolve or strip any orphan `[^id]` citations in bodyText that do not exist in orderedSources
  const canonicalSourceById = new Map<string, OKFSource>();
  for (const s of orderedSources) {
    if (s.id) canonicalSourceById.set(s.id, s);
  }
  const rawCitedFnIds = Array.from(
    new Set(Array.from(bodyText.matchAll(/\[\^([A-Za-z0-9_\-]+)\]/g)).map((m) => m[1]))
  );
  for (const fnId of rawCitedFnIds) {
    if (!canonicalSourceById.has(fnId)) {
      const matched = matchOrphanFootnoteToSource(
        fnId,
        existingFootnoteDefs.get(fnId),
        orderedSources
      );
      if (matched && matched.id) {
        bodyText = bodyText.replaceAll(`[^${fnId}]`, `[^${matched.id}]`);
      } else {
        bodyText = removeSpecificFootnotePreservingBoundary(bodyText, fnId);
      }
      existingFootnoteDefs.delete(fnId);
    }
  }

  // Normalize trailing sentence & clause punctuation (`word.[^id]` -> `word[^id].`, `word:[^id]` -> `word[^id]:`, and `[^a].[^b]` -> `[^a] [^b].`)
  let prevBodyText = '';
  while (prevBodyText !== bodyText) {
    prevBodyText = bodyText;
    bodyText = bodyText.replace(
      /((?:\[\^[A-Za-z0-9_\-]+\][ \t]*)+)([.?!:;]+)((?:[ \t]*\[\^[A-Za-z0-9_\-]+\])+)/g,
      (fullMatch, leftFns: string, punctCluster: string, rightFns: string, offset: number, str: string) => {
        if (
          punctCluster === ':' &&
          /^\[\^[A-Za-z0-9_\-]+\]$/.test(leftFns.trim()) &&
          /(?:^|\r?\n)[\t ]*$/.test(str.slice(0, offset))
        ) {
          return fullMatch;
        }
        const finalPunct = punctCluster[punctCluster.length - 1];
        return `${leftFns.trimEnd()} ${rightFns.trimStart()}${finalPunct}`;
      }
    );
  }
  bodyText = bodyText.replace(
    /([^\s.?!:;])([.?!:;])((?:[ \t]*\[\^[A-Za-z0-9_\-]+\])+)([.?!:;]+)?/g,
    (
      fullMatch,
      before: string,
      punct: string,
      fns: string,
      trailingPunct: string | undefined,
      offset: number,
      str: string
    ) => {
      if (
        punct === ':' &&
        before === ']' &&
        /(?:^|\r?\n)[\t ]*\[\^[A-Za-z0-9_\-]+\]$/.test(str.slice(0, offset + 1))
      ) {
        return fullMatch;
      }
      const finalPunct = trailingPunct ? trailingPunct[trailingPunct.length - 1] : punct;
      return `${before}${fns.trimStart()}${finalPunct}`;
    }
  );
  bodyText = bodyText.replace(
    /([\p{L}\p{N}_\-]+)(\[\^[A-Za-z0-9_\-]+\](?:[ \t]*\[\^[A-Za-z0-9_\-]+\])*)((?:\/[\p{L}\p{N}_\-]+)+)/gu,
    '$1$3$2'
  );
  bodyText = bodyText.replace(/(?:\[\^[A-Za-z0-9_\-]+\][ \t]*){2,}/g, (cluster) => {
    const trailingSpace = /[ \t]+$/.exec(cluster)?.[0] || '';
    const seenFn = new Set<string>();
    const uniqueRefs: string[] = [];
    for (const m of cluster.matchAll(/\[\^([A-Za-z0-9_\-]+)\]/g)) {
      if (!seenFn.has(m[1])) {
        seenFn.add(m[1]);
        uniqueRefs.push(`[^${m[1]}]`);
      }
    }
    return uniqueRefs.join(' ') + trailingSpace;
  });
  bodyText = bodyText.replace(
    /[ \t]+(\[\^[A-Za-z0-9_\-]+\])/g,
    (_m, fn: string, offset: number, str: string) =>
      /\][ \t]*$/.test(str.slice(0, offset)) ? ` ${fn}` : fn
  );
  bodyText = bodyText.replace(/[ \t]+([.,;!?])/g, '$1');
  bodyText = bodyText.replace(/(\[\^[A-Za-z0-9_\-]+\])(?=[\p{L}\p{N}])/gu, '$1 ');

  // 7. Append OKF v0.2 footnote definitions (`[^id]: Title`) at the bottom of the body (SPEC.md §5.1)
  // Only emit definitions for footnote IDs actually cited (`[^id]`) in the body (`citedFootnoteIds`).
  const citedFootnoteIds = Array.from(
    new Set(Array.from(bodyText.matchAll(/\[\^([A-Za-z0-9_\-]+)\]/g)).map((m) => m[1]))
  );
  const citedFootnoteIdSet = new Set(citedFootnoteIds);

  const footnoteLines: string[] = [];
  for (const fnId of citedFootnoteIds) {
    const src = canonicalSourceById.get(fnId) || sourcesById.get(fnId);
    const label = src?.title || existingFootnoteDefs.get(fnId) || src?.resource || fnId;
    footnoteLines.push(`[^${fnId}]: ${label}`);
  }

  bodyText = stripTrailingEmptyCitationSection(bodyText);
  if (footnoteLines.length > 0) {
    bodyText = `${bodyText}\n\n${footnoteLines.join('\n')}\n`;
  } else {
    bodyText = `${bodyText}\n`;
  }

  // 8. Build complete OKF v0.2 Frontmatter (SPEC.md §4.1 & §5)
  const fm: OKFFrontmatter = { ...parsedDoc.frontmatter };
  if (!fm.type || !String(fm.type).trim()) {
    fm.type = options?.type || 'Research Concept';
  }

  if (!fm.title || !String(fm.title).trim()) {
    const headingMatch = bodyText.match(/^#\s+(.+)$/m);
    fm.title =
      headingMatch?.[1]?.replace(/[*_`]/g, '').trim() ||
      options?.topic ||
      'Grounded Research Concept';
  }

  if (!fm.description || !String(fm.description).trim()) {
    const firstPara = bodyText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(
        (l) =>
          l.length > 25 &&
          !l.startsWith('#') &&
          !l.startsWith('[^') &&
          !l.startsWith('|') &&
          !l.startsWith('```')
      );
    const cleanSummary = firstPara
      ? firstPara
          .replace(/\[\^[A-Za-z0-9_\-]+\]/g, '')
          .replace(/^[\*\-\d.]+\s+/, '')
          .replace(/\*\*/g, '')
          .split(/(?<=[.!?])\s+/)[0]
          .slice(0, 200)
          .trim()
      : `Grounded research synthesis on ${fm.title}.`;
    fm.description = cleanSummary || `Grounded research synthesis on ${fm.title}.`;
  }

  if (!Array.isArray(fm.tags) || fm.tags.length === 0) {
    if (options?.tags && options.tags.length > 0) {
      fm.tags = options.tags;
    } else {
      const topicWords = transliterateNordicAscii(
        String(options?.topic || fm.title || 'research')
      )
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !['the', 'and', 'for', 'with', 'from', 'that', 'this'].includes(w))
        .slice(0, 5);
      fm.tags = topicWords.length > 0 ? Array.from(new Set(topicWords)) : ['research', 'icm'];
    }
  }

  if (!fm.status) {
    fm.status = options?.status || 'draft';
  }

  const existingGen =
    fm.generated && typeof fm.generated === 'object' ? fm.generated : ({} as OKFActorEvent);
  const rawGenAt = String(existingGen.at || nowIso).trim();
  const finalGenAt = parseValidIsoTimestamp(rawGenAt) || nowIso;
  fm.generated = {
    by:
      existingGen.by ||
      options?.generatedBy ||
      `icm-stage1/${options?.model || GEMINI_4_ARGON_MODEL}`,
    at: finalGenAt,
  };

  if (!fm.stale_after) {
    if (options?.staleAfter) {
      fm.stale_after = options.staleAfter;
    } else {
      const days = options?.staleAfterDays ?? 30;
      const baseMs = Date.parse(fm.generated.at || nowIso) || Date.now();
      const staleDate = new Date(baseMs + days * 24 * 60 * 60 * 1000);
      fm.stale_after = staleDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
  }
  if (typeof fm.stale_after === 'string') {
    fm.stale_after = normalizeIsoTimestamp(fm.stale_after);
  }

  const finalSources =
    citedFootnoteIdSet.size > 0
      ? orderedSources.filter((s) => s.id && citedFootnoteIdSet.has(s.id))
      : orderedSources;

  for (const s of finalSources) {
    s.retrieved_at = parseValidIsoTimestamp(s.retrieved_at) || finalGenAt;
    const validLm = parseValidIsoTimestamp(s.last_modified);
    if (validLm) {
      s.last_modified = validLm;
    } else {
      delete s.last_modified;
    }
  }
  fm.sources = finalSources;

  return serializeOkfDocument({
    frontmatter: fm,
    body: bodyText,
  });
}

function isCodeFenceDelimiter(line: string): string | null {
  const m = line.match(/^\s*(`{3,}|~{3,})/);
  return m ? m[1][0] : null;
}

function matchTopLevelMarkdownHeading(line: string): string | null {
  // Only match unindented (0-3 spaces) `# Heading` lines outside code blocks
  const m = line.match(/^ {0,3}#\s+(.+)$/);
  return m ? `# ${m[1].trim()}` : null;
}

function extractTopLevelHeadings(body: string): string[] {
  const headings: string[] = [];
  let inFenceChar: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const fenceChar = isCodeFenceDelimiter(line);
    if (fenceChar) {
      if (!inFenceChar) {
        inFenceChar = fenceChar;
      } else if (inFenceChar === fenceChar) {
        inFenceChar = null;
      }
      continue;
    }
    if (inFenceChar) continue;
    const h = matchTopLevelMarkdownHeading(line);
    if (h) {
      headings.push(h);
    }
  }
  return headings;
}

function extractSchemaFieldNames(body: string): string[] {
  const fields = new Set<string>();
  let inSchema = false;
  let inFenceChar: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const fenceChar = isCodeFenceDelimiter(line);
    if (fenceChar) {
      if (!inFenceChar) {
        inFenceChar = fenceChar;
      } else if (inFenceChar === fenceChar) {
        inFenceChar = null;
      }
      continue;
    }
    if (inFenceChar) continue;
    const h = matchTopLevelMarkdownHeading(line);
    if (h) {
      inSchema = h.toLowerCase() === '# schema';
      continue;
    }
    const trimmed = line.trim();
    if (inSchema && trimmed) {
      for (const m of trimmed.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)`/g)) {
        fields.add(m[1]);
      }
    }
  }
  return Array.from(fields);
}

function mergeMarkdownSectionsAndSchema(existingBody: string, incomingBody: string): string {
  if (!existingBody.trim()) return incomingBody;
  if (!incomingBody.trim()) return existingBody;

  const parseSections = (text: string) => {
    const sections = new Map<string, string[]>();
    const order: string[] = [];
    const footnotes = new Map<string, string>();
    let currentHeading = '__preamble__';
    let inFenceChar: string | null = null;
    sections.set(currentHeading, []);
    order.push(currentHeading);

    for (const line of text.split(/\r?\n/)) {
      const fenceChar = isCodeFenceDelimiter(line);
      if (fenceChar) {
        if (!inFenceChar) {
          inFenceChar = fenceChar;
        } else if (inFenceChar === fenceChar) {
          inFenceChar = null;
        }
        sections.get(currentHeading)!.push(line);
        continue;
      }
      if (!inFenceChar) {
        const fnMatch = line.trim().match(/^\[\^([A-Za-z0-9_\-]+)\]:\s*(.+)$/);
        if (fnMatch) {
          footnotes.set(fnMatch[1], line.trim());
          continue;
        }
        const hm = matchTopLevelMarkdownHeading(line);
        if (hm) {
          currentHeading = hm;
          if (!sections.has(currentHeading)) {
            sections.set(currentHeading, []);
            order.push(currentHeading);
          }
          continue;
        }
      }
      sections.get(currentHeading)!.push(line);
    }
    return { sections, order, footnotes };
  };

  const oldParsed = parseSections(existingBody);
  const newParsed = parseSections(incomingBody);

  const combinedOrder = [...newParsed.order];
  for (const h of oldParsed.order) {
    if (!combinedOrder.includes(h)) {
      combinedOrder.push(h);
    }
  }

  const outBlocks: string[] = [];
  for (const heading of combinedOrder) {
    const oldLines = oldParsed.sections.get(heading) || [];
    const newLines = newParsed.sections.get(heading) || [];

    let bodyLines: string[];
    if (heading.toLowerCase() === '# schema' && oldLines.length > 0 && newLines.length > 0) {
      // Non-shrinking union of # Schema field lines
      const mergedSchemaLines = [...oldLines.filter((l) => l.trim() !== '')];
      const existingFields = new Set(extractSchemaFieldNames(`# Schema\n${oldLines.join('\n')}`));
      for (const l of newLines) {
        if (!l.trim()) continue;
        const fieldMatches = Array.from(l.matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)`/g)).map((m) => m[1]);
        if (fieldMatches.length === 0 || fieldMatches.some((f) => !existingFields.has(f))) {
          mergedSchemaLines.push(l);
          fieldMatches.forEach((f) => existingFields.add(f));
        }
      }
      bodyLines = mergedSchemaLines;
    } else if (newLines.some((l) => l.trim() !== '')) {
      bodyLines = newLines;
    } else {
      bodyLines = oldLines;
    }

    const content = bodyLines.join('\n').trim();
    if (heading === '__preamble__') {
      if (content) outBlocks.push(content);
    } else {
      outBlocks.push(content ? `${heading}\n\n${content}` : heading);
    }
  }

  const mergedProse = outBlocks.join('\n\n');
  const citedInMerged = Array.from(
    new Set(Array.from(mergedProse.matchAll(/\[\^([A-Za-z0-9_\-]+)\]/g)).map((m) => m[1]))
  );
  const allFootnotes: string[] = [];
  for (const fnId of citedInMerged) {
    const fnLine = newParsed.footnotes.get(fnId) || oldParsed.footnotes.get(fnId);
    if (fnLine) {
      allFootnotes.push(fnLine);
    }
  }
  if (allFootnotes.length > 0) {
    outBlocks.push(allFootnotes.join('\n'));
  }

  return `${outBlocks.join('\n\n').trim()}\n`;
}

/**
 * Merges an existing OKF concept document with an updated document, preserving all prior
 * `sources`, `tags`, `verified` sign-offs, `# Schema` fields, and `# Section` headings when augmenting.
 */
export function mergeConceptDocuments(
  existing: OKFDocument,
  incoming: OKFDocument
): OKFDocument {
  const mergedFm: OKFFrontmatter = {
    ...existing.frontmatter,
    ...incoming.frontmatter,
  };

  // Do not downgrade `stable` status to `draft` during non-shrinking augmentation
  if (existing.frontmatter?.status === 'stable' && incoming.frontmatter?.status === 'draft') {
    mergedFm.status = 'stable';
  }

  const existingGenAt =
    existing.frontmatter?.generated && typeof existing.frontmatter.generated === 'object'
      ? parseValidIsoTimestamp(existing.frontmatter.generated.at)
      : undefined;
  const incomingGenAt =
    incoming.frontmatter?.generated && typeof incoming.frontmatter.generated === 'object'
      ? parseValidIsoTimestamp(incoming.frontmatter.generated.at)
      : undefined;
  const fallbackGenAt = incomingGenAt || existingGenAt;

  // Preserve non-shrinking union of sources (`resource` | `url` | `path` | `id`),
  // while healing existing unresolvable Vertex redirect URLs when a matching source provides a resolved URL
  const existingSources = Array.isArray(existing.frontmatter?.sources)
    ? existing.frontmatter.sources
    : [];
  const incomingSources = Array.isArray(incoming.frontmatter?.sources)
    ? incoming.frontmatter.sources
    : [];
  const mergedSources: OKFSource[] = [];
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  const getSourceLocator = (s: any): string =>
    String(s?.resource || s?.url || s?.path || s?.id || '').trim();

  const updateMergedSourceMetadata = (
    target: OKFSource,
    incomingSrc: OKFSource,
    wasHealed: boolean = false
  ) => {
    const cleanIncomingTitle = typeof incomingSrc.title === 'string' ? incomingSrc.title.trim() : '';
    if (
      cleanIncomingTitle &&
      (!target.title ||
        !target.title.trim() ||
        target.title.trim() === String(target.resource || '').trim())
    ) {
      target.title = cleanIncomingTitle;
    }
    const incRetrievedAt = parseValidIsoTimestamp(incomingSrc.retrieved_at);
    const targetRetrievedAt = parseValidIsoTimestamp(target.retrieved_at);
    if (incRetrievedAt) {
      if (!targetRetrievedAt) {
        target.retrieved_at = incRetrievedAt;
      } else {
        const targetMs = Date.parse(targetRetrievedAt);
        const incMs = Date.parse(incRetrievedAt);
        if (!Number.isNaN(incMs) && (Number.isNaN(targetMs) || incMs >= targetMs)) {
          target.retrieved_at = incRetrievedAt;
        } else {
          target.retrieved_at = targetRetrievedAt;
        }
      }
    } else if (wasHealed && (incomingGenAt || fallbackGenAt)) {
      target.retrieved_at = incomingGenAt || fallbackGenAt;
    } else if (targetRetrievedAt) {
      target.retrieved_at = targetRetrievedAt;
    } else if (existingGenAt || fallbackGenAt) {
      target.retrieved_at = existingGenAt || fallbackGenAt;
    } else if ('retrieved_at' in target) {
      delete target.retrieved_at;
    }

    const incLastModified = parseValidIsoTimestamp(incomingSrc.last_modified);
    const targetLastModified = parseValidIsoTimestamp(target.last_modified);
    if (incLastModified) {
      if (!targetLastModified) {
        target.last_modified = incLastModified;
      } else {
        const targetLmMs = Date.parse(targetLastModified);
        const incLmMs = Date.parse(incLastModified);
        if (!Number.isNaN(incLmMs) && (Number.isNaN(targetLmMs) || incLmMs >= targetLmMs)) {
          target.last_modified = incLastModified;
        } else {
          target.last_modified = targetLastModified;
        }
      }
    } else if (targetLastModified) {
      target.last_modified = targetLastModified;
    } else if ('last_modified' in target) {
      delete target.last_modified;
    }

    if (incomingSrc.author && !target.author) {
      target.author = incomingSrc.author;
    }
    if (incomingSrc.usage_count !== undefined) {
      target.usage_count = incomingSrc.usage_count;
    }
    if (incomingSrc.usage_window && !target.usage_window) {
      target.usage_window = incomingSrc.usage_window;
    }
  };

  const taggedSources: Array<{ src: OKFSource; isIncoming: boolean }> = [
    ...existingSources.map((src) => ({ src, isIncoming: false })),
    ...incomingSources.map((src) => ({ src, isIncoming: true })),
  ];

  for (const { src, isIncoming } of taggedSources) {
    if (!src || typeof src !== 'object') continue;
    const locator = getSourceLocator(src);
    if (!locator) continue;
    if (seenKeys.has(locator)) {
      const target = mergedSources.find((s) => getSourceLocator(s) === locator);
      if (target) {
        updateMergedSourceMetadata(target, src, false);
      }
      continue;
    }

    const srcId = String(src.id || '').trim();
    const srcNormTitle = normalizeSourceMatchKey(src.title);
    const matchingExisting = mergedSources.find(
      (s) =>
        (srcId && s.id === srcId) ||
        (srcNormTitle &&
          srcNormTitle.length >= 6 &&
          normalizeSourceMatchKey(s.title) === srcNormTitle)
    );
    if (matchingExisting) {
      const existingLocator = String(
        (matchingExisting as any).resource ||
          (matchingExisting as any).url ||
          (matchingExisting as any).path ||
          ''
      ).trim();
      if (isVertexRedirectUrl(existingLocator) && !isVertexRedirectUrl(locator)) {
        seenKeys.delete(existingLocator);
        matchingExisting.resource = locator;
        seenKeys.add(locator);
        if (
          src.title &&
          (!matchingExisting.title || matchingExisting.title === existingLocator)
        ) {
          matchingExisting.title = src.title.trim();
        }
        updateMergedSourceMetadata(matchingExisting, src, true);
        continue;
      }
      if (!isVertexRedirectUrl(existingLocator) && isVertexRedirectUrl(locator)) {
        updateMergedSourceMetadata(matchingExisting, src, false);
        continue;
      }
    }

    seenKeys.add(locator);
    let id = src.id || 'source';
    let counter = 2;
    while (seenIds.has(id)) {
      id = `${src.id || 'source'}-${counter++}`;
    }
    seenIds.add(id);

    const normalizedRetrievedAt =
      parseValidIsoTimestamp(src.retrieved_at) ||
      (isIncoming ? incomingGenAt || fallbackGenAt : existingGenAt || fallbackGenAt);
    const normalizedLastModified = parseValidIsoTimestamp(src.last_modified);

    const mergedEntry: OKFSource = {
      ...src,
      ...(typeof src.resource === 'string' ? { resource: src.resource.trim() } : {}),
      ...(typeof src.title === 'string' ? { title: src.title.trim() } : {}),
      id,
      ...(normalizedRetrievedAt ? { retrieved_at: normalizedRetrievedAt } : {}),
      ...(normalizedLastModified ? { last_modified: normalizedLastModified } : {}),
    };
    if (!normalizedRetrievedAt && 'retrieved_at' in mergedEntry) {
      delete mergedEntry.retrieved_at;
    }
    if (!normalizedLastModified && 'last_modified' in mergedEntry) {
      delete mergedEntry.last_modified;
    }
    mergedSources.push(mergedEntry);
  }
  mergedFm.sources = mergedSources;

  if (typeof mergedFm.stale_after === 'string') {
    mergedFm.stale_after = normalizeIsoTimestamp(mergedFm.stale_after);
  }
  if (
    mergedFm.generated &&
    typeof mergedFm.generated === 'object' &&
    typeof mergedFm.generated.at === 'string'
  ) {
    mergedFm.generated = {
      ...mergedFm.generated,
      at: normalizeIsoTimestamp(mergedFm.generated.at),
    };
  }

  // Preserve union of tags
  const existingTags = Array.isArray(existing.frontmatter?.tags) ? existing.frontmatter.tags : [];
  const incomingTags = Array.isArray(incoming.frontmatter?.tags) ? incoming.frontmatter.tags : [];
  if (existingTags.length > 0 || incomingTags.length > 0) {
    mergedFm.tags = Array.from(new Set([...existingTags, ...incomingTags].map(String)));
  }

  // Preserve existing human/machine `verified` records alongside any new verification events
  const existingVerified = normalizeVerified(existing.frontmatter || {});
  const incomingVerified = normalizeVerified(incoming.frontmatter || {});
  if (existingVerified.length > 0 || incomingVerified.length > 0) {
    const combinedVerified: OKFActorEvent[] = [];
    for (const v of [...existingVerified, ...incomingVerified]) {
      const existingActorIdx = combinedVerified.findIndex((c) => c.by === v.by);
      if (existingActorIdx >= 0) {
        combinedVerified[existingActorIdx] = v;
      } else {
        combinedVerified.push(v);
      }
    }
    mergedFm.verified = combinedVerified;
  }

  return {
    frontmatter: mergedFm,
    body: mergeMarkdownSectionsAndSchema(existing.body, incoming.body),
  };
}

/**
 * Writes an OKF v0.2 concept document to `bundleRoot/<conceptId>.md` with universal
 * Augmentation Guards enforced across ALL concept types (fixing OKF reference_agent Trap 2).
 */
export function writeBundleConcept(
  bundleRoot: string,
  conceptId: string,
  docInput: OKFDocument | string,
  options?: {
    mergeExisting?: boolean;
    allowDestructiveOverwrite?: boolean;
    actor?: string;
  }
): { path: string; conceptId: string; bytes: number; action: 'Creation' | 'Update' } {
  const cleanCid = conceptId
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.md$/i, '');
  const baseName = path.posix.basename(`${cleanCid}.md`);
  if (RESERVED_OKF_FILENAMES.has(baseName)) {
    throw new Error(
      `Cannot write concept to "${baseName}": index.md and log.md are reserved OKF filenames (SPEC.md §3.1).`
    );
  }

  const doc: OKFDocument =
    typeof docInput === 'string' ? parseOkfDocument(docInput) : docInput;
  validateOkfDocument(doc);

  const resolvedBundleRoot = path.resolve(bundleRoot);
  const targetPath = path.resolve(resolvedBundleRoot, `${cleanCid}.md`);
  const existed = fs.existsSync(targetPath);
  let docToWrite: OKFDocument = {
    frontmatter: { ...doc.frontmatter },
    body: doc.body,
  };

  if (existed) {
    const existingRaw = fs.readFileSync(targetPath, 'utf-8');
    const existingDoc = parseOkfDocument(existingRaw);

    if (!options?.allowDestructiveOverwrite) {
      if (options?.mergeExisting) {
        docToWrite = mergeConceptDocuments(existingDoc, docToWrite);
      } else {
        // Universal Augmentation Guard 1: Non-shrinking `sources` across all concept types
        const oldSources = Array.isArray(existingDoc.frontmatter?.sources)
          ? existingDoc.frontmatter.sources
          : existingDoc.frontmatter?.sources
            ? [existingDoc.frontmatter.sources]
            : [];
        const newSources = Array.isArray(docToWrite.frontmatter?.sources)
          ? docToWrite.frontmatter.sources
          : docToWrite.frontmatter?.sources
            ? [docToWrite.frontmatter.sources]
            : [];
        const newSourceIds = new Set(
          newSources.map((s: any) => String(s?.id || s?.resource || s?.url || s?.path || '')).filter(Boolean)
        );
        const missingSourceIds = oldSources
          .map((s: any) => String(s?.id || s?.resource || s?.url || s?.path || ''))
          .filter((id: string) => id && !newSourceIds.has(id));
        if (newSources.length < oldSources.length || missingSourceIds.length > 0) {
          throw new Error(
            `OKF Augmentation Guard [${cleanCid}]: Update removes existing source IDs (${missingSourceIds.join(', ') || `${oldSources.length} -> ${newSources.length}`}). Merge new sources into the existing list.`
          );
        }

        // Universal Augmentation Guard 2: Preserve `# Schema` fields and top-level `#` headings across all concept types
        const oldHeadings = extractTopLevelHeadings(existingDoc.body);
        const newHeadings = new Set(extractTopLevelHeadings(docToWrite.body));
        const missingHeadings = oldHeadings.filter((h) => !newHeadings.has(h));
        if (missingHeadings.length > 0) {
          throw new Error(
            `OKF Augmentation Guard [${cleanCid}]: Update drops existing section heading "${missingHeadings[0]}" (${missingHeadings.join(', ')}).`
          );
        }

        const oldSchemaFields = extractSchemaFieldNames(existingDoc.body);
        const newSchemaFields = new Set(extractSchemaFieldNames(docToWrite.body));
        const missingSchemaFields = oldSchemaFields.filter((f) => !newSchemaFields.has(f));
        if (missingSchemaFields.length > 0) {
          throw new Error(
            `OKF Augmentation Guard [${cleanCid}]: Update drops existing # Schema field(s): ${missingSchemaFields.join(', ')}.`
          );
        }

        // Universal Augmentation Guard 3: Prevent silent erasure of human `verified` sign-offs
        const oldVerified = normalizeVerified(existingDoc.frontmatter);
        const newVerified = normalizeVerified(docToWrite.frontmatter);
        const hadHumanVerify = oldVerified.some((v) => String(v.by || '').startsWith('human:'));
        const hasHumanVerify = newVerified.some((v) => String(v.by || '').startsWith('human:'));
        if (hadHumanVerify && !hasHumanVerify) {
          throw new Error(
            `OKF Augmentation Guard [${cleanCid}]: Update drops existing human verification sign-off without preserving 'verified' history.`
          );
        }
      }
    }
  }

  if (!docToWrite.frontmatter.generated || typeof docToWrite.frontmatter.generated !== 'object') {
    docToWrite.frontmatter.generated = {
      by: options?.actor || `icm/${GEMINI_4_ARGON_MODEL}`,
      at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  }

  if (Array.isArray(docToWrite.frontmatter.sources)) {
    const genAtFallback =
      parseValidIsoTimestamp(docToWrite.frontmatter.generated?.at) ||
      new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    docToWrite.frontmatter.sources = docToWrite.frontmatter.sources.map((s) => {
      if (!s || typeof s !== 'object') return s;
      const validRetrieved = parseValidIsoTimestamp(s.retrieved_at) || genAtFallback;
      const validLm = parseValidIsoTimestamp(s.last_modified);
      const nextSrc: OKFSource = {
        ...s,
        retrieved_at: validRetrieved,
        ...(validLm ? { last_modified: validLm } : {}),
      };
      if (!validLm && 'last_modified' in nextSrc) {
        delete nextSrc.last_modified;
      }
      return nextSrc;
    });
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const serialized = serializeOkfDocument(docToWrite);
  fs.writeFileSync(targetPath, serialized, 'utf-8');

  return {
    path: path.relative(resolvedBundleRoot, targetPath).replace(/\\/g, '/'),
    conceptId: cleanCid,
    bytes: Buffer.byteLength(serialized, 'utf-8'),
    action: existed ? 'Update' : 'Creation',
  };
}

/**
 * 100% deterministic `index.md` generator for an OKF v0.2 bundle (`SPEC.md` §8 & §12).
 * Zero hidden LLM calls (fixes OKF reference_agent Trap 3) and excludes both `index.md` and `log.md`.
 */
export function regenerateBundleIndexes(bundleRoot: string): string[] {
  const resolvedRoot = path.resolve(bundleRoot);
  if (!fs.existsSync(resolvedRoot)) return [];

  const dirsToIndex = new Set<string>([resolvedRoot]);
  function scanDirs(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDirs(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        !RESERVED_OKF_FILENAMES.has(entry.name)
      ) {
        let cur = path.dirname(fullPath);
        while (cur.startsWith(resolvedRoot)) {
          dirsToIndex.add(cur);
          if (cur === resolvedRoot) break;
          cur = path.dirname(cur);
        }
      }
    }
  }
  scanDirs(resolvedRoot);

  // Sort directories deepest first so subdirectory descriptions roll up deterministically
  const sortedDirs = Array.from(dirsToIndex).sort((a, b) => {
    const depthA = path.relative(resolvedRoot, a).split(path.sep).filter(Boolean).length;
    const depthB = path.relative(resolvedRoot, b).split(path.sep).filter(Boolean).length;
    return depthB - depthA || a.localeCompare(b);
  });

  const dirDescriptions = new Map<string, string>();
  const writtenPaths: string[] = [];

  for (const directory of sortedDirs) {
    const entries: Array<{ type: string; title: string; link: string; desc: string }> = [];
    const children = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      if (RESERVED_OKF_FILENAMES.has(child.name)) continue;
      const fullChild = path.join(directory, child.name);
      if (child.isFile() && child.name.endsWith('.md')) {
        try {
          const doc = parseOkfDocument(fs.readFileSync(fullChild, 'utf-8'));
          const fm = doc.frontmatter || {};
          const title = String(fm.title || path.basename(child.name, '.md'));
          const desc = String(fm.description || '');
          const typ = String(fm.type || 'Other');
          entries.push({ type: typ, title, link: child.name, desc });
        } catch {
          // Skip malformed files
        }
      } else if (child.isDirectory() && dirsToIndex.has(fullChild)) {
        const subDesc = dirDescriptions.get(fullChild) || `Concepts in ${child.name}`;
        entries.push({
          type: 'Subdirectories',
          title: child.name,
          link: `${child.name}/index.md`,
          desc: subDesc,
        });
      }
    }

    const isRoot = directory === resolvedRoot;
    const indexPath = path.join(directory, 'index.md');

    if (entries.length === 0) {
      if (isRoot) {
        const emptyIndex = [
          '---',
          'okf_version: "0.2"',
          '---',
          '',
          '# Knowledge Bundle Index',
          '',
          '_No concepts indexed yet. Run Stage 1 (`npm run cli:stage1 -- "<topic>"`) to populate `workspace/bundle/`._',
          '',
        ].join('\n');
        fs.writeFileSync(indexPath, emptyIndex, 'utf-8');
        writtenPaths.push(indexPath);
      }
      continue;
    }

    const grouped = new Map<string, Array<{ title: string; link: string; desc: string }>>();
    for (const e of entries) {
      const groupKey = e.type || 'Other';
      if (!grouped.has(groupKey)) grouped.set(groupKey, []);
      grouped.get(groupKey)!.push({ title: e.title, link: e.link, desc: e.desc });
    }

    const sections: string[] = [];
    for (const typ of Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b))) {
      const groupItems = grouped
        .get(typ)!
        .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
      const sectionLines = [`# ${typ}`, ''];
      for (const item of groupItems) {
        const suffix = item.desc ? ` - ${item.desc}` : '';
        sectionLines.push(`* [${item.title}](${item.link})${suffix}`);
      }
      sections.push(sectionLines.join('\n'));
    }

    // SPEC.md §8 & §12: Bundle-root index.md carries okf_version: "0.2"; subdirectory index.md has no frontmatter
    const indexContent = isRoot
      ? `---\nokf_version: "0.2"\n---\n\n${sections.join('\n\n')}\n`
      : `${sections.join('\n\n')}\n`;

    fs.writeFileSync(indexPath, indexContent, 'utf-8');
    writtenPaths.push(indexPath);

    if (!isRoot) {
      if (entries.length === 1 && entries[0].desc) {
        dirDescriptions.set(directory, entries[0].desc);
      } else {
        const sampleTitles = entries
          .slice(0, 3)
          .map((e) => e.title)
          .join(', ');
        dirDescriptions.set(
          directory,
          `${entries.length} concept(s) including ${sampleTitles}${entries.length > 3 ? '...' : ''}`
        );
      }
    }
  }

  return writtenPaths;
}

/**
 * Appends a date-grouped entry (`## YYYY-MM-DD`, newest first) to `bundleRoot/log.md` (`SPEC.md` §9).
 */
export function appendBundleLog(
  bundleRoot: string,
  action: 'Creation' | 'Update' | 'Verification' | 'Deprecation' | 'Initialization',
  conceptId: string,
  title: string,
  detail?: string
): string {
  const resolvedRoot = path.resolve(bundleRoot);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  const logPath = path.join(resolvedRoot, 'log.md');
  const today = new Date().toISOString().slice(0, 10);
  const cleanCid = conceptId.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '');
  const suffix = detail ? ` (${detail})` : '';
  const entryBullet = `* **${action}**: [${title}](/${cleanCid}.md)${suffix}`;

  let existing = '';
  if (fs.existsSync(logPath)) {
    existing = fs.readFileSync(logPath, 'utf-8');
  }

  if (!existing.trim()) {
    const content = `# Directory Update Log\n\n## ${today}\n${entryBullet}\n`;
    fs.writeFileSync(logPath, content, 'utf-8');
    return logPath;
  }

  const lines = existing.split(/\r?\n/);
  const todayHeadingIdx = lines.findIndex((l) => l.trim() === `## ${today}`);
  if (todayHeadingIdx !== -1) {
    const sameActionPrefix = `* **${action}**: [`;
    const sameConceptLink = `](/${cleanCid}.md)`;
    let nextSectionIdx = lines.findIndex(
      (l, idx) => idx > todayHeadingIdx && /^##\s+\d{4}-\d{2}-\d{2}/.test(l.trim())
    );
    if (nextSectionIdx === -1) nextSectionIdx = lines.length;
    for (let idx = nextSectionIdx - 1; idx > todayHeadingIdx; idx--) {
      const lineTrim = lines[idx].trim();
      if (
        lineTrim === entryBullet ||
        (lineTrim.startsWith(sameActionPrefix) && lineTrim.includes(sameConceptLink))
      ) {
        lines.splice(idx, 1);
      }
    }
    lines.splice(todayHeadingIdx + 1, 0, entryBullet);
    fs.writeFileSync(logPath, lines.join('\n').trimEnd() + '\n', 'utf-8');
    return logPath;
  }

  const firstDateHeadingIdx = lines.findIndex((l) => /^##\s+\d{4}-\d{2}-\d{2}/.test(l.trim()));
  if (firstDateHeadingIdx !== -1) {
    lines.splice(firstDateHeadingIdx, 0, `## ${today}`, entryBullet, '');
    fs.writeFileSync(logPath, lines.join('\n').trimEnd() + '\n', 'utf-8');
    return logPath;
  }

  const appended = `${existing.trimEnd()}\n\n## ${today}\n${entryBullet}\n`;
  fs.writeFileSync(logPath, appended, 'utf-8');
  return logPath;
}

function isLikelyNorwegianOkfDoc(doc: OKFDocument): boolean {
  const sample = `${doc.frontmatter?.title || ''} ${doc.frontmatter?.description || ''} ${doc.body || ''}`;
  if (/[æøåÆØÅ]/.test(sample)) return true;
  if (/\b(?:og|i|for|med|til|av|på|skal|må|krav|forskrift|barnehage|brannvern|sjekkliste|internkontroll)\b/i.test(sample)) {
    return true;
  }
  return false;
}

function insertRelatedConceptLinkIntoDoc(
  doc: OKFDocument,
  targetConceptId: string,
  targetTitle: string
): boolean {
  const cleanTargetId = targetConceptId.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '');
  const targetSlug = path.posix.basename(cleanTargetId);
  const rawBody = String(doc.body || '');

  // Check if the body already links to this concept via root-relative or relative Markdown link
  const escapedId = cleanTargetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedSlug = targetSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingLinkRe = new RegExp(
    `\\]\\((?:\\/${escapedId}(?:\\.md)?|(?:\\.\\/|\\.\\.\\/[A-Za-z0-9_\\-\\/]+\\/)?${escapedSlug}\\.md)(?:[#?][^)]*)?\\)`,
    'i'
  );
  if (existingLinkRe.test(rawBody)) {
    return false;
  }

  const lines = rawBody.split(/\r?\n/);
  const proseLines: string[] = [];
  const footnoteLines: string[] = [];
  for (const line of lines) {
    if (/^\[\^[A-Za-z0-9_\-]+\]:\s*.+$/.test(line.trim())) {
      footnoteLines.push(line.trim());
    } else {
      proseLines.push(line);
    }
  }

  const bulletLine = `- [${targetTitle || targetSlug}](/${cleanTargetId}.md)`;
  const relatedHeadingRe =
    /^#{2,3}\s+(?:Relaterte\s+konsepter(?:\s+i\s+kunnskapsbasen)?|Related\s+(?:Bundle\s+)?Concepts?)\s*$/i;
  const headingIdx = proseLines.findIndex((l) => relatedHeadingRe.test(l.trim()));

  if (headingIdx !== -1) {
    let insertIdx = headingIdx + 1;
    while (insertIdx < proseLines.length && proseLines[insertIdx].trim() === '') {
      insertIdx++;
    }
    while (
      insertIdx < proseLines.length &&
      /^\s*[-*]\s+/.test(proseLines[insertIdx])
    ) {
      insertIdx++;
    }
    proseLines.splice(insertIdx, 0, bulletLine);
  } else {
    while (proseLines.length > 0 && proseLines[proseLines.length - 1].trim() === '') {
      proseLines.pop();
    }
    const heading = isLikelyNorwegianOkfDoc(doc)
      ? '## Relaterte konsepter i kunnskapsbasen'
      : '## Related Bundle Concepts';
    if (proseLines.length > 0) {
      proseLines.push('', heading, '', bulletLine);
    } else {
      proseLines.push(heading, '', bulletLine);
    }
  }

  const cleanProse = proseLines.join('\n').trimEnd();
  doc.body =
    footnoteLines.length > 0
      ? `${cleanProse}\n\n${footnoteLines.join('\n')}\n`
      : `${cleanProse}\n`;
  return true;
}

/**
 * Ensures bidirectional Markdown links (`## Related Bundle Concepts` / `## Relaterte konsepter i kunnskapsbasen`)
 * across related concepts in `workspace/bundle/` AND synchronizes those links back into each corresponding
 * run's `workspace/runs/<runId>/stages/01_research/output/research_summary.md` (before `[^id]:` footnote definitions).
 */
export function injectBidirectionalBundleLinks(
  workspaceOrBundleRoot: string,
  currentConceptId?: string,
  _currentTitleOrDoc?: string | OKFDocument,
  explicitWorkspaceRoot?: string
): string[] {
  const resolvedInput = path.resolve(workspaceOrBundleRoot);
  const isBundleDir =
    path.basename(resolvedInput).toLowerCase() === 'bundle' ||
    (!fs.existsSync(path.join(resolvedInput, 'bundle')) &&
      fs.existsSync(path.join(resolvedInput, 'research')));
  const bundleRoot = isBundleDir ? resolvedInput : path.join(resolvedInput, 'bundle');
  const workspaceRoot = explicitWorkspaceRoot
    ? path.resolve(explicitWorkspaceRoot)
    : isBundleDir
      ? path.dirname(resolvedInput)
      : resolvedInput;

  if (!fs.existsSync(bundleRoot)) return [];

  interface BundleConceptRecord {
    id: string;
    slug: string;
    dir: string;
    filePath: string;
    doc: OKFDocument;
    title: string;
    modified: boolean;
  }

  const conceptsById = new Map<string, BundleConceptRecord>();
  const scanBundleConcepts = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanBundleConcepts(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        !RESERVED_OKF_FILENAMES.has(entry.name)
      ) {
        try {
          const doc = parseOkfDocument(fs.readFileSync(fullPath, 'utf-8'));
          const relId = path
            .relative(bundleRoot, fullPath)
            .replace(/\\/g, '/')
            .replace(/\.md$/i, '');
          const slug = path.posix.basename(relId);
          const dirName = path.posix.dirname(relId);
          const title = String(doc.frontmatter?.title || slug).trim();
          conceptsById.set(relId, {
            id: relId,
            slug,
            dir: dirName,
            filePath: fullPath,
            doc,
            title,
            modified: false,
          });
        } catch {
          // Ignore unreadable concept file
        }
      }
    }
  };
  scanBundleConcepts(bundleRoot);

  if (conceptsById.size < 2) return [];

  const resolveLinkTargetId = (fromConceptId: string, rawHref: string): string | null => {
    const cleanHref = String(rawHref || '').trim().split('#')[0].split('?')[0];
    if (!cleanHref || /^[a-z]+:\/\//i.test(cleanHref) || cleanHref.startsWith('mailto:')) {
      return null;
    }
    let candidate = '';
    if (cleanHref.startsWith('/')) {
      candidate = cleanHref.replace(/^\/+/, '').replace(/\.md$/i, '');
    } else if (cleanHref.endsWith('.md')) {
      const baseDir = path.posix.dirname(fromConceptId);
      candidate = path.posix
        .normalize(baseDir === '.' ? cleanHref : `${baseDir}/${cleanHref}`)
        .replace(/\.md$/i, '');
    } else {
      return null;
    }
    if (!candidate || candidate.startsWith('..')) return null;
    const baseName = path.posix.basename(candidate);
    if (RESERVED_OKF_FILENAMES.has(`${baseName}.md`)) return null;
    if (conceptsById.has(candidate)) return candidate;
    // Also match by slug if stored under research/<slug>
    for (const [cid, rec] of conceptsById.entries()) {
      if (rec.slug === baseName) return cid;
    }
    return null;
  };

  const extractLinkedConceptIds = (rec: BundleConceptRecord): Set<string> => {
    const out = new Set<string>();
    const mdLinkRegex = /(?<!\!)\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    for (const m of String(rec.doc.body || '').matchAll(mdLinkRegex)) {
      const targetId = resolveLinkTargetId(rec.id, m[1]);
      if (targetId && targetId !== rec.id) {
        out.add(targetId);
      }
    }
    return out;
  };

  // 1. Collect all directed concept pairs that should be bidirectionally linked
  const normalizedCurrentId = currentConceptId
    ? currentConceptId.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '')
    : undefined;

  const linkPairs = new Set<string>();
  const addBidirectionalPair = (idA: string, idB: string) => {
    if (!idA || !idB || idA === idB) return;
    if (!conceptsById.has(idA) || !conceptsById.has(idB)) return;
    linkPairs.add(`${idA}:::${idB}`);
    linkPairs.add(`${idB}:::${idA}`);
  };

  for (const rec of conceptsById.values()) {
    for (const targetId of extractLinkedConceptIds(rec)) {
      addBidirectionalPair(rec.id, targetId);
    }
  }

  // If a currentConceptId was promoted (or if sibling concepts in the same directory exist), link siblings bidirectionally
  if (normalizedCurrentId && conceptsById.has(normalizedCurrentId)) {
    const curRec = conceptsById.get(normalizedCurrentId)!;
    for (const other of conceptsById.values()) {
      if (other.id !== curRec.id && other.dir === curRec.dir) {
        addBidirectionalPair(curRec.id, other.id);
      }
    }
  } else if (linkPairs.size === 0) {
    const allRecs = Array.from(conceptsById.values());
    for (let i = 0; i < allRecs.length; i++) {
      for (let j = i + 1; j < allRecs.length; j++) {
        if (allRecs[i].dir === allRecs[j].dir) {
          addBidirectionalPair(allRecs[i].id, allRecs[j].id);
        }
      }
    }
  }

  const updatedPaths: string[] = [];

  for (const pair of linkPairs) {
    const [sourceId, targetId] = pair.split(':::');
    const sourceRec = conceptsById.get(sourceId);
    const targetRec = conceptsById.get(targetId);
    if (!sourceRec || !targetRec) continue;
    if (insertRelatedConceptLinkIntoDoc(sourceRec.doc, targetRec.id, targetRec.title)) {
      sourceRec.modified = true;
    }
  }

  for (const rec of conceptsById.values()) {
    if (rec.modified) {
      fs.writeFileSync(rec.filePath, serializeOkfDocument(rec.doc), 'utf-8');
      updatedPaths.push(rec.filePath);
    }
  }

  // 2. Synchronize every concept's outbound bundle links into any matching run's stages/01_research/output/research_summary.md
  const runsRoot = path.join(workspaceRoot, 'runs');
  if (fs.existsSync(runsRoot)) {
    let runDirs: fs.Dirent[] = [];
    try {
      runDirs = fs.readdirSync(runsRoot, { withFileTypes: true });
    } catch {
      runDirs = [];
    }

    const toCanonicalSlug = (raw: string): string => {
      const s = transliterateNordicAscii(String(raw || ''))
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/-\d{10,}$/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      return truncateSlugAtWordBoundary(s, 48);
    };

    for (const runEntry of runDirs) {
      if (!runEntry.isDirectory() || runEntry.name === '_dry_run') continue;
      const runDir = path.join(runsRoot, runEntry.name);
      const researchSummaryPath = path.join(
        runDir,
        'stages/01_research/output/research_summary.md'
      );
      if (!fs.existsSync(researchSummaryPath)) continue;

      try {
        const runDoc = parseOkfDocument(fs.readFileSync(researchSummaryPath, 'utf-8'));
        let matchedConcept: BundleConceptRecord | undefined;

        const metaPath = path.join(runDir, 'meta.json');
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            const metaCid = String(meta?.okf?.bundleConceptId || '')
              .trim()
              .replace(/\\/g, '/')
              .replace(/^\/+/, '')
              .replace(/\.md$/i, '');
            if (metaCid && conceptsById.has(metaCid)) {
              matchedConcept = conceptsById.get(metaCid);
            }
          } catch {
            // Ignore unreadable meta.json
          }
        }

        if (!matchedConcept) {
          const runTitle = String(runDoc.frontmatter?.title || '').trim();
          const runSlug = toCanonicalSlug(runTitle || runEntry.name);
          for (const rec of conceptsById.values()) {
            if (
              (runTitle && rec.title.toLowerCase() === runTitle.toLowerCase()) ||
              (runSlug && rec.slug === runSlug)
            ) {
              matchedConcept = rec;
              break;
            }
          }
        }

        if (!matchedConcept) continue;

        const outboundTargets = extractLinkedConceptIds(matchedConcept);
        let runModified = false;
        for (const targetId of outboundTargets) {
          const targetRec = conceptsById.get(targetId);
          if (!targetRec) continue;
          if (insertRelatedConceptLinkIntoDoc(runDoc, targetRec.id, targetRec.title)) {
            runModified = true;
          }
        }

        if (runModified) {
          fs.writeFileSync(researchSummaryPath, serializeOkfDocument(runDoc), 'utf-8');
          updatedPaths.push(researchSummaryPath);
        }
      } catch {
        // Ignore unreadable run research_summary.md
      }
    }
  }

  return updatedPaths;
}

/**
 * Promotes/synchronizes a Stage 1 `research_summary.md` artifact into `workspace/bundle/research/<slug>.md`,
 * injects reciprocal cross-concept links (in both `workspace/bundle/` and `workspace/runs/`),
 * regenerates deterministic `index.md` files, and logs the update in `workspace/bundle/log.md`.
 */
export function syncRunToBundle(
  workspacePath: string,
  runId: string,
  options?: {
    conceptSlug?: string;
    actionOverride?: 'Creation' | 'Update' | 'Verification';
    allowDestructiveOverwrite?: boolean;
  }
): { conceptId: string; bundleFilePath: string } | null {
  const resolvedWorkspace = path.resolve(workspacePath);
  const runDir = path.join(resolvedWorkspace, 'runs', runId);
  const researchPath = path.join(runDir, 'stages/01_research/output/research_summary.md');
  if (!fs.existsSync(researchPath)) return null;

  const bundleRoot = path.join(resolvedWorkspace, 'bundle');
  const doc = parseOkfDocument(fs.readFileSync(researchPath, 'utf-8'));
  if (!doc.frontmatter.type) {
    doc.frontmatter.type = 'Research Concept';
  }

  const docHealed = healOrphanOkfFootnotes(doc);
  if (docHealed) {
    fs.writeFileSync(researchPath, serializeOkfDocument(doc), 'utf-8');
  }

  const rawTitleSlug = transliterateNordicAscii(String(doc.frontmatter.title || runId))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/-\d{10,}$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const canonicalTitleSlug = truncateSlugAtWordBoundary(rawTitleSlug, 48) || 'research-concept';

  let slug = options?.conceptSlug || '';
  const metaPath = path.join(runDir, 'meta.json');
  if (!slug && fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const existingCid = String(meta?.okf?.bundleConceptId || '').trim();
      if (existingCid.startsWith('research/')) {
        const existingSlug = existingCid.slice('research/'.length);
        if (rawTitleSlug.startsWith(existingSlug) && existingSlug !== canonicalTitleSlug) {
          const oldBundleFile = path.join(bundleRoot, 'research', `${existingSlug}.md`);
          const newBundleFile = path.join(bundleRoot, 'research', `${canonicalTitleSlug}.md`);
          if (fs.existsSync(oldBundleFile)) {
            if (!fs.existsSync(newBundleFile)) {
              fs.renameSync(oldBundleFile, newBundleFile);
            } else {
              fs.unlinkSync(oldBundleFile);
            }
          }
          meta.okf.bundleConceptId = `research/${canonicalTitleSlug}`;
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
          const logPath = path.join(bundleRoot, 'log.md');
          if (fs.existsSync(logPath)) {
            const logTxt = fs.readFileSync(logPath, 'utf-8');
            const updatedLog = logTxt.replaceAll(
              `/research/${existingSlug}.md`,
              `/research/${canonicalTitleSlug}.md`
            );
            if (updatedLog !== logTxt) {
              fs.writeFileSync(logPath, updatedLog, 'utf-8');
            }
          }
          slug = canonicalTitleSlug;
        } else {
          slug = existingSlug;
        }
      }
    } catch {
      // Ignore unreadable meta.json
    }
  }
  if (!slug) {
    slug = canonicalTitleSlug;
  }

  const conceptId = `research/${slug}`;
  const bundleFilePath = path.join(bundleRoot, `${conceptId}.md`);
  const writeResult = writeBundleConcept(bundleRoot, conceptId, doc, {
    mergeExisting: !options?.allowDestructiveOverwrite,
    allowDestructiveOverwrite: options?.allowDestructiveOverwrite,
  });
  injectBidirectionalBundleLinks(bundleRoot, conceptId, doc, resolvedWorkspace);
  regenerateBundleIndexes(bundleRoot);

  const writtenDoc = fs.existsSync(bundleFilePath)
    ? parseOkfDocument(fs.readFileSync(bundleFilePath, 'utf-8'))
    : doc;
  const tier = getOkfTrustTier(writtenDoc.frontmatter);
  const status = String(writtenDoc.frontmatter.status || 'draft');
  const action = options?.actionOverride || writeResult.action;
  appendBundleLog(
    bundleRoot,
    action,
    conceptId,
    String(writtenDoc.frontmatter.title || slug),
    `run: ${runId}, status: ${status}, trust_tier: ${tier}`
  );

  return {
    conceptId,
    bundleFilePath,
  };
}

// Helper to load ICM Layer 0 (GEMINI.md), Layer 1 (CONTEXT.md), and Layer 3 (_config/voice_guide.md + bundle/index.md) from disk
export function loadWorkspaceLayers(workspacePath: string) {
  const geminiGuidePath = path.join(workspacePath, 'GEMINI.md');
  const contextGuidePath = path.join(workspacePath, 'CONTEXT.md');
  const toneGuidePath = path.join(workspacePath, '_config/voice_guide.md');
  const bundleRoot = path.join(workspacePath, 'bundle');

  let bundleContext = '';
  if (fs.existsSync(bundleRoot) && fs.statSync(bundleRoot).isDirectory()) {
    const freshSummaries: string[] = [];
    const staleConceptRelPaths: string[] = [];
    const deprecatedConceptRelPaths: string[] = [];

    const scanBundleConcepts = (dir: string) => {
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanBundleConcepts(full);
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.md') &&
          !RESERVED_OKF_FILENAMES.has(entry.name)
        ) {
          try {
            const doc = parseOkfDocument(fs.readFileSync(full, 'utf-8'));
            const relFile = path.relative(bundleRoot, full).replace(/\\/g, '/');
            const relCid = relFile.replace(/\.md$/i, '');
            const status = String(doc.frontmatter.status || 'stable').toLowerCase();
            if (status === 'deprecated') {
              deprecatedConceptRelPaths.push(`\`${relFile}\``);
            } else if (isOkfStale(doc.frontmatter)) {
              staleConceptRelPaths.push(`\`${relFile}\``);
            } else {
              const tier = getOkfTrustTier(doc.frontmatter);
              freshSummaries.push(
                `- [/${relCid}.md] **${doc.frontmatter.title || relCid}** (${doc.frontmatter.type || 'Concept'}, trust_tier: ${tier}): ${doc.frontmatter.description || ''}`
              );
            }
          } catch {
            // Ignore unreadable concept files
          }
        }
      }
    };

    scanBundleConcepts(bundleRoot);
    if (
      freshSummaries.length > 0 ||
      staleConceptRelPaths.length > 0 ||
      deprecatedConceptRelPaths.length > 0
    ) {
      const lines: string[] = [
        'Progressive Disclosure Index (`workspace/bundle/index.md`) — Fresh Active Concepts (`now < stale_after`):',
        ...freshSummaries.slice(0, 25),
      ];
      if (staleConceptRelPaths.length > 0) {
        lines.push(
          `Skipped stale concepts (${staleConceptRelPaths.length}): ${staleConceptRelPaths.join(', ')}`
        );
      }
      if (deprecatedConceptRelPaths.length > 0) {
        lines.push(
          `Skipped deprecated concepts (${deprecatedConceptRelPaths.length}): ${deprecatedConceptRelPaths.join(', ')}`
        );
      }
      bundleContext = lines.join('\n');
    }
  }

  return {
    globalIdentity: fs.existsSync(geminiGuidePath)
      ? fs.readFileSync(geminiGuidePath, 'utf-8')
      : '',
    workspaceContext: fs.existsSync(contextGuidePath)
      ? fs.readFileSync(contextGuidePath, 'utf-8')
      : '',
    toneGuide: fs.existsSync(toneGuidePath)
      ? fs.readFileSync(toneGuidePath, 'utf-8')
      : 'Maintain a professional and clear tone.',
    bundleContext,
  };
}

function writeStageAssembledInput(
  stageDir: string,
  metadata: {
    stage: string;
    model: string;
    thinkingLevel: ThinkingLevel;
    maxOutputTokens: number;
    useGoogleSearch: boolean;
    outputFormat: string;
  },
  assembledPrompt: string
) {
  const inputFile = path.join(stageDir, 'input/prompt_assembled.md');
  fs.mkdirSync(path.dirname(inputFile), { recursive: true });
  const header = [
    '---',
    `stage: ${metadata.stage}`,
    `model: ${metadata.model}`,
    `thinkingLevel: ${metadata.thinkingLevel}`,
    `maxOutputTokens: ${metadata.maxOutputTokens}`,
    `googleSearch: ${metadata.useGoogleSearch}`,
    `outputFormat: ${metadata.outputFormat}`,
    `assembledAt: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(inputFile, `${header}${assembledPrompt}\n`, 'utf-8');
  return inputFile;
}

function printDryRunPreview(
  stage: string,
  assembledInputPath: string,
  assembledPrompt: string,
  options: {
    thinkingLevel: ThinkingLevel;
    maxOutputTokens: number;
    includeThoughts: boolean;
    useGoogleSearch: boolean;
    outputFormat: 'text' | 'json';
    outputJsonSchema?: Record<string, any>;
  }
) {
  const approxTokens = Math.ceil(assembledPrompt.length / 4);
  const previewBody: Record<string, any> = {
    model: GEMINI_4_ARGON_MODEL,
    ...(options.useGoogleSearch ? { tools: [{ type: 'google_search' }] } : {}),
    generation_config: {
      max_output_tokens: options.maxOutputTokens,
      thinking_level: options.thinkingLevel.toLowerCase(),
      thinking_summaries: options.includeThoughts ? 'auto' : 'none',
    },
    ...(options.outputFormat === 'json'
      ? {
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            ...(options.outputJsonSchema ? { schema: options.outputJsonSchema } : {}),
          },
        }
      : {}),
    stream: true,
    store: false,
    input: `[1 user_input step (${assembledPrompt.length} chars, ~${approxTokens} tokens) -> ${assembledInputPath}]`,
  };

  console.log(`[DRY-RUN] Stage: ${stage}`);
  console.log(
    `[DRY-RUN] Assembled 5-Layer ICM Input written to: ${assembledInputPath} (${assembledPrompt.length} chars, ~${approxTokens} est. input tokens)`
  );
  console.log(`[DRY-RUN] Would send: POST ${INTERACTIONS_API_URL}`);
  console.log(`[DRY-RUN] Headers:`);
  console.log(`    Content-Type: application/json`);
  console.log(`    Api-Revision: ${INTERACTIONS_API_REVISION}`);
  console.log(`    x-goog-api-key: <REDACTED>`);
  console.log(`[DRY-RUN] Body:\n${JSON.stringify(previewBody, null, 2)}`);
  console.log(`[DRY-RUN] Network call skipped. Zero tokens spent.`);
}

function writeStageThinkingTrace(
  stageDir: string,
  metadata: {
    stage: string;
    thinkingLevel: ThinkingLevel;
    durationMs: number;
    usage: InteractionUsageTelemetry;
    thoughts: string[];
    searchQueries?: string[];
  }
) {
  const traceFile = path.join(stageDir, 'output/thinking_trace.md');
  fs.mkdirSync(path.dirname(traceFile), { recursive: true });

  const lines: string[] = [
    `# ${metadata.stage} — Gemini 4 Argon Thinking & Telemetry Trace`,
    '',
    `- **Model:** \`${GEMINI_4_ARGON_MODEL}\``,
    `- **Thinking Level:** \`${metadata.thinkingLevel}\``,
    `- **Duration:** ${(metadata.durationMs / 1000).toFixed(1)}s`,
    `- **Input Tokens:** ${metadata.usage.inputTokens}`,
    `- **Thinking Tokens:** ${metadata.usage.thoughtsTokens}`,
    `- **Output Tokens:** ${metadata.usage.outputTokens}`,
    `- **Total Tokens:** ${metadata.usage.totalTokens}`,
    '',
  ];

  if (metadata.searchQueries && metadata.searchQueries.length > 0) {
    lines.push('## Executed Google Search Queries');
    for (const q of metadata.searchQueries) {
      lines.push(`- \`${q}\``);
    }
    lines.push('');
  }

  lines.push(`## Reasoning Steps (${metadata.thoughts.length})`);
  lines.push('');
  if (metadata.thoughts.length === 0) {
    lines.push('_No reasoning summary steps emitted._');
  } else {
    metadata.thoughts.forEach((step, idx) => {
      lines.push(`### Step ${idx + 1}`);
      lines.push(step);
      lines.push('');
    });
  }

  fs.writeFileSync(traceFile, lines.join('\n'), 'utf-8');
}

// 1. Standalone Stage 1 Research Runner (Stops at the Human-in-the-Loop Intermission Gate)
export async function runStage1Flow(input: {
  workspaceRoot: string;
  runId: string;
  topic: string;
  thinkingLevel?: ThinkingLevel | string;
  dryRun?: boolean;
}): Promise<{
  success: boolean;
  runId: string;
  outputPath: string;
  bundleConceptId?: string;
  dryRun?: boolean;
}> {
  const workspacePath = path.resolve(input.workspaceRoot);
  const runDir = path.join(workspacePath, 'runs', input.runId);
  const { globalIdentity, workspaceContext, bundleContext } = loadWorkspaceLayers(workspacePath);

  const contract = loadStagePromptContract('01_research');
  const stage1ThinkingLevel = normalizeThinkingLevel(input.thinkingLevel, contract.thinkingLevel);
  const stage1FallbackThinkingLevel: ThinkingLevel =
    stage1ThinkingLevel === 'HIGH' ? 'MEDIUM' : 'LOW';

  console.log(
    `--- Executing Stage 1: Research [model: ${GEMINI_4_ARGON_MODEL}, thinkingLevel: ${stage1ThinkingLevel}${input.dryRun ? ', DRY-RUN' : ''}] ---`
  );

  const stage1Dir = path.join(runDir, 'stages/01_research');
  const researchFileTarget = path.join(stage1Dir, 'output/research_summary.md');
  const researchStreamTarget = path.join(stage1Dir, 'output/research_stream.md');
  fs.mkdirSync(path.dirname(researchFileTarget), { recursive: true });

  // Assemble Layer 0 + Layer 1 + Layer 2 + Layer 3 (OKF Bundle Index) prompt and persist to stages/01_research/input/prompt_assembled.md
  const assembledPrompt = renderPromptTemplate(contract.template, {
    topic: input.topic,
    globalIdentity,
    workspaceContext,
    bundleContext,
  });

  const assembledInputPath = writeStageAssembledInput(
    stage1Dir,
    {
      stage: '01_research',
      model: GEMINI_4_ARGON_MODEL,
      thinkingLevel: stage1ThinkingLevel,
      maxOutputTokens: contract.maxOutputTokens,
      useGoogleSearch: contract.useGoogleSearch,
      outputFormat: contract.outputFormat,
    },
    assembledPrompt
  );

  if (input.dryRun) {
    const metaPath = path.join(runDir, 'meta.json');
    try {
      const meta: Record<string, any> = fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        : {
            runId: input.runId,
            topic: input.topic,
            model: GEMINI_4_ARGON_MODEL,
            researchThinkingLevel: stage1ThinkingLevel,
            createdAt: new Date().toISOString(),
          };
      meta.status = 'stage1_dry_run';
      meta.dryRun = true;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch {
      // Ignore metadata update errors
    }
    printDryRunPreview('01_research', assembledInputPath, assembledPrompt, {
      thinkingLevel: stage1ThinkingLevel,
      maxOutputTokens: contract.maxOutputTokens,
      includeThoughts: contract.includeThoughts,
      useGoogleSearch: contract.useGoogleSearch,
      outputFormat: contract.outputFormat,
    });
    return {
      success: true,
      runId: input.runId,
      outputPath: assembledInputPath,
      dryRun: true,
    };
  }

  const startTimeMs = Date.now();
  let latestStreamedText = '';

  const updateLiveStreamFile = (allThoughts: string[], bodyText: string) => {
    const latestThought =
      allThoughts.length > 0
        ? `> **Gemini 4 Argon Thinking (${allThoughts.length} steps):**\n> ${allThoughts[allThoughts.length - 1].replace(/\n/g, '\n> ')}\n\n---\n\n`
        : `> **Gemini 4 Argon is researching and verifying sources via Google Search...**\n\n---\n\n`;
    const liveBody = bodyText || '_Synthesizing findings from grounded search results..._';
    try {
      fs.writeFileSync(researchStreamTarget, `${latestThought}${liveBody}`, 'utf-8');
    } catch {
      // Ignore transient file write errors during live stream preview
    }
  };

  const { result: stage1Response, usedThinkingLevel } = await executeWithRetryAndFallback(
    {
      promptText: assembledPrompt,
      thinkingLevel: stage1ThinkingLevel,
      maxOutputTokens: contract.maxOutputTokens,
      includeThoughts: contract.includeThoughts,
      useGoogleSearch: contract.useGoogleSearch,
      outputFormat: contract.outputFormat,
      onThought: (thoughtStep, allThoughts) => {
        const previewSnippet = thoughtStep.replace(/\s+/g, ' ').slice(0, 120);
        console.log(`[Stage 1 Thought]: ${previewSnippet}...`);
        updateLiveStreamFile(allThoughts, latestStreamedText);
      },
      onSearchQuery: (queries) => {
        console.log(`[Stage 1 Google Search]: ${queries.join(' | ')}`);
      },
      onTextDelta: (_delta, accumulatedText) => {
        latestStreamedText = accumulatedText;
      },
    },
    1,
    stage1FallbackThinkingLevel
  );

  if (!stage1Response.text || stage1Response.text.trim() === '') {
    throw new Error(
      'Research summary output was empty. This is typically caused by safety/privacy filters blocking search queries about private individuals, or Google Grounding returning no results.'
    );
  }

  const cleanedText = await cleanGroundingLinks(stage1Response.text, stage1Response.steps, {
    topic: input.topic,
    model: GEMINI_4_ARGON_MODEL,
    workspaceRoot: workspacePath,
  });
  fs.writeFileSync(researchFileTarget, cleanedText, 'utf-8');
  if (fs.existsSync(researchStreamTarget)) {
    try {
      fs.unlinkSync(researchStreamTarget);
    } catch {
      // Ignore cleanup errors
    }
  }

  const stage1Doc = parseOkfDocument(cleanedText);
  const syncedBundle = syncRunToBundle(workspacePath, input.runId);

  const durationMs = Date.now() - startTimeMs;
  const usage = stage1Response.usage;

  // Persist Gemini 4 Argon's reasoning chain & search queries to stages/01_research/output/thinking_trace.md
  writeStageThinkingTrace(stage1Dir, {
    stage: '01_research',
    thinkingLevel: usedThinkingLevel,
    durationMs,
    usage,
    thoughts: stage1Response.thoughts,
    searchQueries: stage1Response.searchQueries,
  });

  console.log(
    `[Stage 1 Telemetry]: input=${usage.inputTokens}, thoughts=${usage.thoughtsTokens}, output=${usage.outputTokens}, total=${usage.totalTokens} tokens (${(durationMs / 1000).toFixed(1)}s)`
  );
  console.log(`Stage 1 complete. Output written to: ${researchFileTarget}`);
  if (syncedBundle) {
    console.log(
      `[OKF Bundle Sync]: Synced concept '${syncedBundle.conceptId}' -> ${syncedBundle.bundleFilePath}`
    );
  }

  const metaPath = path.join(runDir, 'meta.json');
  try {
    const meta: Record<string, any> = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      : {
          runId: input.runId,
          topic: input.topic,
          model: GEMINI_4_ARGON_MODEL,
          researchThinkingLevel: usedThinkingLevel,
          createdAt: new Date().toISOString(),
          status: 'stage1_completed',
        };
    if (
      !meta.status ||
      meta.status === 'running' ||
      meta.status === 'stage1_running' ||
      meta.status === 'stage1_dry_run'
    ) {
      meta.status = 'stage1_completed';
    }
    const trustTier = getOkfTrustTier(stage1Doc.frontmatter);
    const stale = isOkfStale(stage1Doc.frontmatter);
    const sourcesCount = Array.isArray(stage1Doc.frontmatter.sources)
      ? stage1Doc.frontmatter.sources.length
      : 0;
    meta.stage1Telemetry = {
      thinkingLevel: usedThinkingLevel,
      thoughtSteps: stage1Response.thoughts.length,
      searchQueries: stage1Response.searchQueries,
      inputTokens: usage.inputTokens,
      thoughtsTokens: usage.thoughtsTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      durationMs,
      trust_tier: trustTier,
      is_stale: stale,
      sourcesCount,
    };
    meta.okf = {
      type: stage1Doc.frontmatter.type || 'Research Concept',
      title: stage1Doc.frontmatter.title || input.topic,
      status: stage1Doc.frontmatter.status || 'draft',
      trust_tier: trustTier,
      is_stale: stale,
      stale_after: stage1Doc.frontmatter.stale_after,
      generated: stage1Doc.frontmatter.generated,
      verified: normalizeVerified(stage1Doc.frontmatter),
      sourcesCount,
      bundleConceptId: syncedBundle?.conceptId,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  } catch {
    // Ignore metadata update errors
  }

  try {
    const bundleDir = path.join(workspacePath, 'bundle');
    if (fs.existsSync(bundleDir)) {
      const vizRes = generateBundleVisualization(bundleDir);
      console.log(`[OKF Graph Viz]: ${vizRes.outputPath}`);
    }
    const a2uiRes = generateA2uiSurface(input.runId, { workspaceRoot: workspacePath });
    console.log(
      `[Stage 1 Intermission A2UI Review]: ${a2uiRes.htmlOutputPath}${a2uiRes.bundleHtmlPath ? ` (bundle mirror: ${a2uiRes.bundleHtmlPath})` : ''}`
    );
  } catch (err: any) {
    console.warn(`[Stage 1 A2UI Review Warning]: ${err?.message || String(err)}`);
  }

  return {
    success: true,
    runId: input.runId,
    outputPath: researchFileTarget,
    bundleConceptId: syncedBundle?.conceptId,
  };
}

function normalizeVerifierActor(actor?: string): string {
  const raw = (actor || '').trim();
  if (!raw) {
    const user = process.env.USER || process.env.USERNAME || 'reviewer';
    return `human:${user}`;
  }
  if (raw.startsWith('human:') || raw.startsWith('process:') || raw.includes('/')) {
    return raw;
  }
  return `human:${raw}`;
}

/**
 * Stamps OKF v0.2 `verified: [{ by, at }]` and `status: stable` onto a Stage 1 `research_summary.md`
 * (by `<runId>`) or a bundle concept `.md` file, optionally curating sources (`rejectSourceIds`, `addSources`),
 * updates `meta.json`, syncs to `workspace/bundle/`, and refreshes `viz.html` & `a2ui.html`.
 */
export function verifyOkfConcept(
  runIdOrPath: string,
  options?: {
    workspaceRoot?: string;
    by?: string;
    at?: string;
    rejectSourceIds?: string[];
    replaceSourceMap?: Record<string, string>;
    addSources?: CurateOkfSourcesOptions['addSources'];
  }
): {
  filePath: string;
  runId?: string;
  bundleConceptId?: string;
  status: string;
  trust_tier: TrustTier;
  is_stale: boolean;
  verified: OKFActorEvent[];
  rejectedIds: string[];
  replacedMap: Record<string, string>;
  addedSources: OKFSource[];
  orphanClaimLines: string[];
} {
  const workspacePath = path.resolve(options?.workspaceRoot || './workspace');
  const actor = normalizeVerifierActor(options?.by);
  const atIso = options?.at || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const candidateRunDir = path.join(workspacePath, 'runs', runIdOrPath);
  const candidateRunResearch = path.join(
    candidateRunDir,
    'stages/01_research/output/research_summary.md'
  );

  let targetFilePath = '';
  let detectedRunId: string | undefined;

  if (fs.existsSync(candidateRunResearch)) {
    targetFilePath = candidateRunResearch;
    detectedRunId = runIdOrPath;
  } else if (fs.existsSync(path.resolve(runIdOrPath))) {
    targetFilePath = path.resolve(runIdOrPath);
  } else {
    const runsRoot = path.join(workspacePath, 'runs');
    if (fs.existsSync(runsRoot)) {
      const matchingRun = fs
        .readdirSync(runsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== '_dry_run')
        .map((d) => d.name)
        .find((name) => name.endsWith(`-${runIdOrPath}`) || name.includes(runIdOrPath));
      if (matchingRun) {
        const matchedResearch = path.join(
          runsRoot,
          matchingRun,
          'stages/01_research/output/research_summary.md'
        );
        if (fs.existsSync(matchedResearch)) {
          targetFilePath = matchedResearch;
          detectedRunId = matchingRun;
        }
      }
    }
    if (!targetFilePath) {
      const bundleCandidate = path.join(
        workspacePath,
        'bundle',
        runIdOrPath.endsWith('.md') ? runIdOrPath : `${runIdOrPath}.md`
      );
      if (fs.existsSync(bundleCandidate)) {
        targetFilePath = bundleCandidate;
      } else {
        throw new Error(
          `Could not find Stage 1 research artifact or OKF concept for "${runIdOrPath}".`
        );
      }
    }
  }

  let raw = fs.readFileSync(targetFilePath, 'utf-8');
  let rejectedIds: string[] = [];
  let replacedMap: Record<string, string> = {};
  let addedSources: OKFSource[] = [];
  let orphanClaimLines: string[] = [];
  const hasReplaceMap =
    Boolean(options?.replaceSourceMap) &&
    Object.keys(options?.replaceSourceMap || {}).length > 0;

  if (
    (options?.rejectSourceIds && options.rejectSourceIds.length > 0) ||
    hasReplaceMap ||
    (options?.addSources && options.addSources.length > 0)
  ) {
    const curated = curateOkfSources(raw, {
      rejectSourceIds: options?.rejectSourceIds,
      replaceSourceMap: options?.replaceSourceMap,
      addSources: options?.addSources,
    });
    raw = curated.markdown;
    rejectedIds = curated.rejectedIds;
    replacedMap = curated.replacedMap;
    addedSources = curated.addedSources;
    orphanClaimLines = curated.orphanClaimLines;
    if (options?.rejectSourceIds && options.rejectSourceIds.length > 0) {
      for (const reqId of options.rejectSourceIds) {
        const cleanId = String(reqId || '')
          .trim()
          .replace(/^\[\^/, '')
          .replace(/\]$/, '')
          .trim();
        if (cleanId && !rejectedIds.includes(cleanId)) {
          rejectedIds.push(cleanId);
        }
      }
    }
  }

  const doc = parseOkfDocument(raw);
  if (!doc.frontmatter.type) {
    doc.frontmatter.type = 'Research Concept';
  }
  if (
    typeof doc.frontmatter.stale_after === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(doc.frontmatter.stale_after.trim())
  ) {
    doc.frontmatter.stale_after = `${doc.frontmatter.stale_after.trim()}T00:00:00Z`;
  }
  if (
    doc.frontmatter.generated &&
    typeof doc.frontmatter.generated === 'object' &&
    typeof doc.frontmatter.generated.at === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(doc.frontmatter.generated.at.trim())
  ) {
    doc.frontmatter.generated = {
      ...doc.frontmatter.generated,
      at: `${doc.frontmatter.generated.at.trim()}T00:00:00Z`,
    };
  }

  const defaultPlaceholders = new Set(['human:styrer', 'human:reviewer']);
  let existingVerified = normalizeVerified(doc.frontmatter);
  if (!defaultPlaceholders.has(actor)) {
    existingVerified = existingVerified.filter((v) => !defaultPlaceholders.has(v.by));
  }
  const existingActorIdx = existingVerified.findIndex((v) => v.by === actor);
  if (existingActorIdx >= 0) {
    existingVerified[existingActorIdx] = { by: actor, at: atIso };
  } else {
    existingVerified.push({ by: actor, at: atIso });
  }
  doc.frontmatter.verified = existingVerified;
  doc.frontmatter.status = 'stable';

  const serialized = serializeOkfDocument(doc);
  fs.writeFileSync(targetFilePath, serialized, 'utf-8');

  const trustTier = getOkfTrustTier(doc.frontmatter);
  const stale = isOkfStale(doc.frontmatter);
  let bundleConceptId: string | undefined;

  if (detectedRunId) {
    const synced = syncRunToBundle(workspacePath, detectedRunId, {
      actionOverride: 'Verification',
      allowDestructiveOverwrite: true,
    });
    bundleConceptId = synced?.conceptId;

    const resolvedRunDir = path.join(workspacePath, 'runs', detectedRunId);
    const metaPath = path.join(resolvedRunDir, 'meta.json');
    try {
      const meta: Record<string, any> = fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        : {
            runId: detectedRunId,
            topic: doc.frontmatter.title || detectedRunId,
            model: GEMINI_4_ARGON_MODEL,
            createdAt: new Date().toISOString(),
            status: 'stage1_verified',
          };
      const sourcesCount = Array.isArray(doc.frontmatter.sources)
        ? doc.frontmatter.sources.length
        : 0;
      if (
        !meta.status ||
        meta.status === 'running' ||
        meta.status === 'stage1_running' ||
        meta.status === 'stage1_completed'
      ) {
        meta.status = 'stage1_verified';
      }
      meta.okf = {
        ...(meta.okf || {}),
        type: doc.frontmatter.type,
        title: doc.frontmatter.title,
        status: doc.frontmatter.status,
        trust_tier: trustTier,
        is_stale: stale,
        stale_after: doc.frontmatter.stale_after,
        generated: doc.frontmatter.generated,
        verified: existingVerified,
        sourcesCount,
        bundleConceptId: bundleConceptId || meta.okf?.bundleConceptId,
      };
      if (meta.stage1Telemetry) {
        meta.stage1Telemetry.trust_tier = trustTier;
        meta.stage1Telemetry.is_stale = stale;
        meta.stage1Telemetry.sourcesCount = sourcesCount;
      }
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch {
      // Ignore meta update errors
    }

    try {
      const bundleDir = path.join(workspacePath, 'bundle');
      if (fs.existsSync(bundleDir)) {
        generateBundleVisualization(bundleDir);
      }
      generateA2uiSurface(detectedRunId, { workspaceRoot: workspacePath });
    } catch {
      // Ignore visualization/A2UI refresh errors during verification
    }
  } else {
    const bundleRoot = path.join(workspacePath, 'bundle');
    if (targetFilePath.startsWith(bundleRoot)) {
      const relCid = path
        .relative(bundleRoot, targetFilePath)
        .replace(/\\/g, '/')
        .replace(/\.md$/i, '');
      bundleConceptId = relCid;
      regenerateBundleIndexes(bundleRoot);
      appendBundleLog(
        bundleRoot,
        'Verification',
        relCid,
        String(doc.frontmatter.title || relCid),
        `verified by ${actor}, trust_tier: ${trustTier}`
      );
      try {
        generateBundleVisualization(bundleRoot);
      } catch {
        // Ignore visualization errors
      }
    }
  }

  const replacedSummary = Object.entries(replacedMap)
    .map(([k, v]) => `${k}->${v}`)
    .join(', ');
  console.log(
    `[OKF Verification Gate]: Verified ${targetFilePath} (by: ${actor}, status: stable, trust_tier: ${trustTier}, is_stale: ${stale}${rejectedIds.length > 0 ? `, rejected: [${rejectedIds.join(', ')}]` : ''}${replacedSummary ? `, replaced: [${replacedSummary}]` : ''}${addedSources.length > 0 ? `, added: [${addedSources.map((s) => s.id).join(', ')}]` : ''})`
  );
  if (orphanClaimLines.length > 0) {
    console.warn(
      `[OKF Source Curation Notice]: ${orphanClaimLines.length} claim line(s) were backed solely by rejected source(s): ${JSON.stringify(orphanClaimLines)}`
    );
  }

  return {
    filePath: targetFilePath,
    runId: detectedRunId,
    bundleConceptId,
    status: String(doc.frontmatter.status),
    trust_tier: trustTier,
    is_stale: stale,
    verified: existingVerified,
    rejectedIds,
    replacedMap,
    addedSources,
    orphanClaimLines,
  };
}

/**
 * Strips raw URLs (`https://...`), Markdown links (`[label](url)` and internal `[label](/concept.md)`),
 * `verified-source:...` tokens, and OKF footnote tags (`[^id]`) from spoken script text so voiceover
 * deliverables (`script_draft.json`) never suffer URL or markup leakage.
 */
export function sanitizeSpokenScript(text: string): string {
  if (!text) return '';
  return text
    .replace(/\s*\(\s*(?<!\!)\[([^\]]+)\]\((?:https?:\/\/|verified-source:)[^\s)]+\)\s*\)/g, '')
    .replace(
      /(?<!\!)\[([^\]]+)\]\((?:https?:\/\/|verified-source:|\/|\.\.?\/|[^)\s]+\.md)[^\s)]*\)/g,
      '$1'
    )
    .replace(/\[\^[A-Za-z0-9_\-]+\]:\s*.*$/gm, '')
    .replace(/\s*\(\s*(?:\[\^[A-Za-z0-9_\-]+\][\s,;]*)+\)/g, '')
    .replace(/\[\^[A-Za-z0-9_\-]+\]/g, '')
    .replace(/\s*\(\s*(?:https?:\/\/|verified-source:)[^\s)]+\s*\)/g, '')
    .replace(/(?:https?:\/\/|verified-source:)\S+/g, '')
    .replace(/\s*\(\s*[,;:\s]*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Recursively applies `sanitizeSpokenScript()` across all string values in a parsed Stage 2 JSON
 * payload (including nested objects and arrays like `modules[].spokenNarration`).
 */
export function sanitizeSpokenJson<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeSpokenScript(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSpokenJson(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeSpokenJson(v);
    }
    return out as T;
  }
  return value;
}

function formatResearchForStage2Prompt(doc: OKFDocument, rawText: string): string {
  if (!doc.frontmatter || Object.keys(doc.frontmatter).length === 0) {
    return rawText;
  }
  const sanitizedFm: OKFFrontmatter = {
    ...doc.frontmatter,
  };
  if (Array.isArray(sanitizedFm.sources)) {
    sanitizedFm.sources = sanitizedFm.sources.map((s) => ({
      id: s.id,
      resource: s.title ? `verified-source:${s.id || 'ref'}` : s.resource,
      title: s.title || s.id || 'Verified Source',
      ...(s.retrieved_at ? { retrieved_at: s.retrieved_at } : {}),
      ...(s.last_modified ? { last_modified: s.last_modified } : {}),
      ...(s.author ? { author: s.author } : {}),
      ...(s.usage_count !== undefined ? { usage_count: s.usage_count } : {}),
      ...(s.usage_window ? { usage_window: s.usage_window } : {}),
    }));
  }
  return serializeOkfDocument({
    frontmatter: sanitizedFm,
    body: doc.body,
  });
}

// 2. Standalone Stage 2 Scriptwriting Runner (Reads Verified Stage 1 Artifact from Disk)
export async function runStage2Flow(input: {
  workspaceRoot: string;
  runId: string;
  thinkingLevel?: ThinkingLevel | string;
  dryRun?: boolean;
}): Promise<{
  success: boolean;
  outputPath: string;
  trust_tier: TrustTier;
  is_stale: boolean;
  dryRun?: boolean;
}> {
  const workspacePath = path.resolve(input.workspaceRoot);
  const runDir = path.join(workspacePath, 'runs', input.runId);
  const researchFileTarget = path.join(runDir, 'stages/01_research/output/research_summary.md');
  const stage2Dir = path.join(runDir, 'stages/02_script');
  const scriptOutputTarget = path.join(stage2Dir, 'output/script_draft.json');

  const contract = loadStagePromptContract('02_script');
  const stage2ThinkingLevel = normalizeThinkingLevel(input.thinkingLevel, contract.thinkingLevel);
  const { globalIdentity, workspaceContext, toneGuide } = loadWorkspaceLayers(workspacePath);

  if (!fs.existsSync(researchFileTarget)) {
    throw new Error(`Research summary not found for run ${input.runId}`);
  }

  fs.mkdirSync(path.dirname(scriptOutputTarget), { recursive: true });

  const startTimeMs = Date.now();
  const activeResearchData = fs.readFileSync(researchFileTarget, 'utf-8');
  const researchDoc = parseOkfDocument(activeResearchData);
  const trustTier = getOkfTrustTier(researchDoc.frontmatter);
  const stale = isOkfStale(researchDoc.frontmatter);
  const docStatus = String(researchDoc.frontmatter.status || 'stable');
  const sourcesCount = Array.isArray(researchDoc.frontmatter.sources)
    ? researchDoc.frontmatter.sources.length
    : 0;

  console.log(
    `--- Executing Stage 2: Scriptwriting for Run: ${input.runId} [model: ${GEMINI_4_ARGON_MODEL}, thinkingLevel: ${stage2ThinkingLevel}${input.dryRun ? ', DRY-RUN' : ''}] ---`
  );
  console.log(
    `[Stage 2 OKF Gate]: status=${docStatus}, trust_tier=${trustTier}, is_stale=${stale}, sources=${sourcesCount}`
  );
  if (stale) {
    console.warn(
      `[Stage 2 OKF Warning]: Source concept is STALE (stale_after: ${researchDoc.frontmatter.stale_after}). Consider refreshing Stage 1.`
    );
  } else if (trustTier === 'unverified') {
    console.log(
      `[Stage 2 OKF Advisory]: Consuming unverified Stage 1 artifact (run 'npm run cli:verify -- ${input.runId}' to stamp human-reviewed sign-off).`
    );
  }

  const stage2ResearchInput = formatResearchForStage2Prompt(researchDoc, activeResearchData);

  // Assemble Layer 0 + Layer 1 + Layer 2 + Layer 3 + Layer 4 prompt and persist to stages/02_script/input/prompt_assembled.md
  const assembledPrompt = renderPromptTemplate(contract.template, {
    researchFile: stage2ResearchInput,
    toneRules: toneGuide,
    globalIdentity,
    workspaceContext,
  });

  const assembledInputPath = writeStageAssembledInput(
    stage2Dir,
    {
      stage: '02_script',
      model: GEMINI_4_ARGON_MODEL,
      thinkingLevel: stage2ThinkingLevel,
      maxOutputTokens: contract.maxOutputTokens,
      useGoogleSearch: contract.useGoogleSearch,
      outputFormat: contract.outputFormat,
    },
    assembledPrompt
  );

  const updateMetaWithStage2Okf = (telemetryExtra?: Record<string, any>) => {
    const metaPath = path.join(runDir, 'meta.json');
    try {
      const meta: Record<string, any> = fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        : {
            runId: input.runId,
            topic: researchDoc.frontmatter.title || input.runId,
            model: GEMINI_4_ARGON_MODEL,
            scriptThinkingLevel: stage2ThinkingLevel,
            createdAt: new Date().toISOString(),
            status: input.dryRun ? 'stage2_dry_run' : 'completed',
          };
      if (
        !input.dryRun &&
        telemetryExtra &&
        (!meta.status ||
          meta.status === 'running' ||
          meta.status === 'stage1_completed' ||
          meta.status === 'stage1_verified' ||
          meta.status === 'stage2_running' ||
          meta.status === 'stage2_dry_run')
      ) {
        meta.status = 'completed';
      }
      meta.okf = {
        ...(meta.okf || {}),
        type: researchDoc.frontmatter.type || 'Research Concept',
        title: researchDoc.frontmatter.title || meta.topic,
        status: docStatus,
        trust_tier: trustTier,
        is_stale: stale,
        stale_after: researchDoc.frontmatter.stale_after,
        generated: researchDoc.frontmatter.generated,
        verified: normalizeVerified(researchDoc.frontmatter),
        sourcesCount,
      };
      meta.stage2Telemetry = {
        ...(meta.stage2Telemetry || {}),
        trust_tier: trustTier,
        is_stale: stale,
        sourceStatus: docStatus,
        sourcesCount,
        ...(telemetryExtra || {}),
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch {
      // Ignore metadata update errors
    }
  };

  if (input.dryRun) {
    updateMetaWithStage2Okf();
    printDryRunPreview('02_script', assembledInputPath, assembledPrompt, {
      thinkingLevel: stage2ThinkingLevel,
      maxOutputTokens: contract.maxOutputTokens,
      includeThoughts: contract.includeThoughts,
      useGoogleSearch: contract.useGoogleSearch,
      outputFormat: contract.outputFormat,
      outputJsonSchema: contract.outputJsonSchema,
    });
    return {
      success: true,
      outputPath: assembledInputPath,
      trust_tier: trustTier,
      is_stale: stale,
      dryRun: true,
    };
  }

  const { result: stage2Response, usedThinkingLevel } = await executeWithRetryAndFallback(
    {
      promptText: assembledPrompt,
      thinkingLevel: stage2ThinkingLevel,
      maxOutputTokens: contract.maxOutputTokens,
      includeThoughts: contract.includeThoughts,
      useGoogleSearch: contract.useGoogleSearch,
      outputFormat: contract.outputFormat,
      outputJsonSchema: contract.outputJsonSchema,
      onThought: (thoughtStep) => {
        const previewSnippet = thoughtStep.replace(/\s+/g, ' ').slice(0, 120);
        console.log(`[Stage 2 Thought]: ${previewSnippet}...`);
      },
    },
    2
  );

  if (contract.outputFormat === 'json') {
    const parsedJson = sanitizeSpokenJson(JSON.parse(stage2Response.text));
    fs.writeFileSync(scriptOutputTarget, JSON.stringify(parsedJson, null, 2), 'utf-8');
  } else {
    fs.writeFileSync(scriptOutputTarget, sanitizeSpokenScript(stage2Response.text), 'utf-8');
  }

  const durationMs = Date.now() - startTimeMs;
  const usage = stage2Response.usage;

  // Persist Gemini 4 Argon's Stage 2 reasoning chain to stages/02_script/output/thinking_trace.md
  writeStageThinkingTrace(stage2Dir, {
    stage: '02_script',
    thinkingLevel: usedThinkingLevel,
    durationMs,
    usage,
    thoughts: stage2Response.thoughts,
  });

  console.log(
    `[Stage 2 Telemetry]: input=${usage.inputTokens}, thoughts=${usage.thoughtsTokens}, output=${usage.outputTokens}, total=${usage.totalTokens} tokens (${(durationMs / 1000).toFixed(1)}s)`
  );
  console.log(`Stage 2 complete. Output written to: ${scriptOutputTarget}`);

  updateMetaWithStage2Okf({
    thinkingLevel: usedThinkingLevel,
    thoughtSteps: stage2Response.thoughts.length,
    inputTokens: usage.inputTokens,
    thoughtsTokens: usage.thoughtsTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    durationMs,
  });

  try {
    const a2uiRes = generateA2uiSurface(input.runId, { workspaceRoot: workspacePath });
    console.log(
      `[Stage 2 A2UI Studio]: ${a2uiRes.htmlOutputPath}${a2uiRes.bundleHtmlPath ? ` (bundle mirror: ${a2uiRes.bundleHtmlPath})` : ''}`
    );
  } catch (err: any) {
    console.warn(`[Stage 2 A2UI Warning]: ${err?.message || String(err)}`);
  }

  return {
    success: true,
    outputPath: scriptOutputTarget,
    trust_tier: trustTier,
    is_stale: stale,
  };
}

// 3. Central Orchestration Runner (Layer 1 Task Router: Stage 1 -> Stage 2)
export async function icmOrchestratorFlow(input: {
  workspaceRoot: string;
  runId: string;
  topic: string;
  researchThinkingLevel?: ThinkingLevel | string;
  scriptThinkingLevel?: ThinkingLevel | string;
}): Promise<{
  status: string;
  outputPath: string;
}> {
  await runStage1Flow({
    workspaceRoot: input.workspaceRoot,
    runId: input.runId,
    topic: input.topic,
    thinkingLevel: input.researchThinkingLevel,
  });

  // --- INTERMISSION: HUMAN-IN-THE-LOOP FILESYSTEM GATE ---
  // Between Stage 1 and Stage 2, the reviewer can inspect/edit `research_summary.md`,
  // stamp human sign-off via `npm run cli:verify -- <runId>`,
  // and re-run Stage 2 standalone at any time via `runStage2Flow` (`npm run cli:stage2 -- <runId>`).

  const stage2Result = await runStage2Flow({
    workspaceRoot: input.workspaceRoot,
    runId: input.runId,
    thinkingLevel: input.scriptThinkingLevel,
  });

  return {
    status: 'Pipeline executed successfully',
    outputPath: stage2Result.outputPath,
  };
}

const OKF_TYPE_PALETTE: Record<string, string> = {
  'Research Concept': '#2563eb',
  'BigQuery Dataset': '#8b5cf6',
  'BigQuery Table': '#3b82f6',
  Reference: '#10b981',
  Metric: '#0d9488',
  Playbook: '#d97706',
  'Attested Computation': '#7c3aed',
};
const OKF_FALLBACK_TYPE_COLORS: readonly string[] = [
  '#0284c7',
  '#e11d48',
  '#059669',
  '#ea580c',
  '#4f46e5',
  '#0891b2',
  '#c026d3',
  '#65a30d',
  '#dc2626',
  '#9333ea',
  '#ca8a04',
  '#0f766e',
];
const DEFAULT_OKF_NODE_COLOR = '#64748b';

export function getOkfTypeColor(type?: string): string {
  const cleanType = String(type || '').trim();
  if (!cleanType || cleanType.toLowerCase() === 'unknown') {
    return DEFAULT_OKF_NODE_COLOR;
  }
  if (OKF_TYPE_PALETTE[cleanType]) {
    return OKF_TYPE_PALETTE[cleanType];
  }
  let hash = 2166136261;
  for (let i = 0; i < cleanType.length; i++) {
    hash ^= cleanType.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return OKF_FALLBACK_TYPE_COLORS[(hash >>> 0) % OKF_FALLBACK_TYPE_COLORS.length];
}

export interface OKFConceptNode {
  id: string;
  type: string;
  title: string;
  description: string;
  resource: string;
  tags: string[];
  body: string;
  status: string;
  generated: OKFActorEvent | Record<string, any>;
  verified: OKFActorEvent[];
  stale_after: string;
  sources: OKFSource[];
  trust_tier: TrustTier;
  stale: boolean;
  links_to: string[];
}

function resolveBundleLinkTarget(
  rawTarget: string,
  docDir: string,
  bundleRootResolved: string
): string | null {
  const cleaned = rawTarget.trim().replace(/#[A-Za-z0-9_\-]*$/, '');
  if (!cleaned || cleaned.includes('://') || cleaned.startsWith('mailto:') || cleaned.startsWith('#')) {
    return null;
  }

  let resolvedAbs: string;
  if (cleaned.startsWith('/')) {
    // SPEC.md §6.1: Bundle-root-relative path (fixes OKF reference_agent Trap 1)
    resolvedAbs = path.resolve(bundleRootResolved, cleaned.slice(1));
  } else if (cleaned.startsWith('./') || cleaned.startsWith('../')) {
    // SPEC.md §6.1: Explicit file-relative path (`./` or `../`)
    resolvedAbs = path.resolve(docDir, cleaned);
  } else {
    // Bare path (e.g. `sibling.md` or `references/skills/run-on-bq.md` per SPEC.md §6.3 & §10.2):
    // Prefer file-relative if it exists in docDir; fall back to bundle-root-relative if it exists at bundleRoot or starts with `references/`.
    const docRelCandidate = path.resolve(docDir, cleaned);
    const rootRelCandidate = path.resolve(bundleRootResolved, cleaned);
    if (
      fs.existsSync(docRelCandidate) ||
      fs.existsSync(`${docRelCandidate}.md`)
    ) {
      resolvedAbs = docRelCandidate;
    } else if (
      fs.existsSync(rootRelCandidate) ||
      fs.existsSync(`${rootRelCandidate}.md`) ||
      cleaned.startsWith('references/')
    ) {
      resolvedAbs = rootRelCandidate;
    } else {
      resolvedAbs = docRelCandidate;
    }
  }

  const relToBundle = path.relative(bundleRootResolved, resolvedAbs).replace(/\\/g, '/');
  if (!relToBundle || relToBundle.startsWith('..') || path.isAbsolute(relToBundle)) {
    return null;
  }

  const withoutExt = relToBundle.replace(/\.md$/i, '');
  const baseName = path.posix.basename(`${withoutExt}.md`);
  if (RESERVED_OKF_FILENAMES.has(baseName)) {
    return null;
  }
  return withoutExt;
}

/**
 * Extracts all internal concept links from both Markdown body links (`[...](/foo.md)` and `[...](../bar.md)`)
 * and path-valued frontmatter fields (`resource`, `sources[].resource`, `computation`, `executor.resource`, `attester.resource`).
 */
export function extractConceptLinks(
  body: string,
  frontmatter: OKFFrontmatter,
  docDir: string,
  bundleRoot: string
): string[] {
  const bundleRootResolved = path.resolve(bundleRoot);
  const out: string[] = [];
  const seen = new Set<string>();

  const addCandidate = (raw: string) => {
    const resolved = resolveBundleLinkTarget(raw, docDir, bundleRootResolved);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  };

  const mdLinkRegex = /\]\(([^)\s]+\.md(?:#[A-Za-z0-9_\-]*)?)\)/gi;
  for (const m of body.matchAll(mdLinkRegex)) {
    addCandidate(m[1]);
  }

  const codePathRegex = /`(\/[A-Za-z0-9_\-\/]+\.md)`/gi;
  for (const m of body.matchAll(codePathRegex)) {
    addCandidate(m[1]);
  }

  const pathCandidates: string[] = [];
  if (typeof frontmatter?.resource === 'string') pathCandidates.push(frontmatter.resource);
  if (typeof frontmatter?.computation === 'string') pathCandidates.push(frontmatter.computation);
  if (typeof frontmatter?.executor?.resource === 'string') {
    pathCandidates.push(frontmatter.executor.resource);
  }
  if (typeof frontmatter?.attester?.resource === 'string') {
    pathCandidates.push(frontmatter.attester.resource);
  }
  if (Array.isArray(frontmatter?.sources)) {
    for (const s of frontmatter.sources) {
      if (s && typeof s.resource === 'string') {
        pathCandidates.push(s.resource);
      }
    }
  }

  for (const candidate of pathCandidates) {
    if (candidate.endsWith('.md') || candidate.startsWith('/') || candidate.startsWith('.')) {
      addCandidate(candidate);
    }
  }

  return out;
}

/**
 * Walks an OKF v0.2 bundle directory and returns all parsed Concept nodes (excluding both `index.md` and `log.md`).
 */
export function walkBundleConcepts(bundleRoot: string): OKFConceptNode[] {
  const resolvedRoot = path.resolve(bundleRoot);
  if (!fs.existsSync(resolvedRoot)) return [];

  const mdFiles: string[] = [];
  const collectMd = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectMd(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        !RESERVED_OKF_FILENAMES.has(entry.name)
      ) {
        mdFiles.push(full);
      }
    }
  };
  collectMd(resolvedRoot);
  mdFiles.sort((a, b) => a.localeCompare(b));

  const concepts: OKFConceptNode[] = [];
  for (const mdPath of mdFiles) {
    const conceptId = path
      .relative(resolvedRoot, mdPath)
      .replace(/\\/g, '/')
      .replace(/\.md$/i, '');
    let doc: OKFDocument;
    try {
      doc = parseOkfDocument(fs.readFileSync(mdPath, 'utf-8'));
    } catch {
      continue;
    }

    if (healOrphanOkfFootnotes(doc)) {
      try {
        fs.writeFileSync(mdPath, serializeOkfDocument(doc), 'utf-8');
      } catch {
        // Ignore read-only bundle paths
      }
    }

    const fm = doc.frontmatter || {};
    const rawTags = fm.tags || [];
    const tags = Array.isArray(rawTags) ? rawTags.map(String) : [String(rawTags)];
    const generated = fm.generated && typeof fm.generated === 'object' ? fm.generated : {};
    const genAtFallback = parseValidIsoTimestamp((generated as any)?.at);
    const rawSources = fm.sources;
    const rawSourcesList: OKFSource[] = Array.isArray(rawSources)
      ? rawSources.filter((s) => s && typeof s === 'object')
      : rawSources && typeof rawSources === 'object'
        ? [rawSources as OKFSource]
        : [];
    const normalizedBody = doc.body || '';
    const sources: OKFSource[] = rawSourcesList.map((s) => {
      const validRetrieved = parseValidIsoTimestamp(s.retrieved_at) || genAtFallback;
      const validLm = parseValidIsoTimestamp(s.last_modified);
      const enrichedTitle = s.resource
        ? enrichBareDomainSourceTitle(s.title, String(s.resource))
        : s.title;
      const nextSrc: OKFSource = {
        ...s,
        ...(enrichedTitle ? { title: enrichedTitle } : {}),
        ...(validRetrieved ? { retrieved_at: validRetrieved } : {}),
        ...(validLm ? { last_modified: validLm } : {}),
      };
      if (!validRetrieved && 'retrieved_at' in nextSrc) {
        delete nextSrc.retrieved_at;
      }
      if (!validLm && 'last_modified' in nextSrc) {
        delete nextSrc.last_modified;
      }
      return nextSrc;
    });

    concepts.push({
      id: conceptId,
      type: String(fm.type || 'Unknown'),
      title: String(fm.title || conceptId),
      description: String(fm.description || ''),
      resource: String(fm.resource || ''),
      tags,
      body: normalizedBody,
      status: String(fm.status || 'stable'),
      generated,
      verified: normalizeVerified(fm),
      stale_after: String(fm.stale_after || ''),
      sources,
      trust_tier: getOkfTrustTier(fm),
      stale: isOkfStale(fm),
      links_to: extractConceptLinks(doc.body || '', fm, path.dirname(mdPath), resolvedRoot),
    });
  }

  return concepts;
}

const OKF_VIZ_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
  color: #0f172a;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
  height: 100vh;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #fff;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.title strong { font-size: 16px; margin-right: 8px; }
.muted { color: #64748b; font-size: 12px; }
.controls { display: flex; gap: 8px; }
.controls input, .controls select, .controls button {
  font-size: 13px;
  padding: 5px 8px;
  border: 1px solid #cbd5e1;
  border-radius: 4px;
  background: #fff;
  color: #0f172a;
}
.controls input::placeholder { color: #64748b; opacity: 1; }
.controls input { width: 220px; }
.controls button { cursor: pointer; background: #f1f5f9; }
.controls button:hover { background: #e2e8f0; }
main { display: flex; flex: 1; min-height: 0; }
#graph {
  flex: 1 1 60%;
  background: #fff;
  border-right: 1px solid #e2e8f0;
  min-width: 0;
  position: relative;
}
#detail {
  flex: 0 0 40%;
  overflow-y: auto;
  padding: 18px 22px;
  background: #fff;
}
#detail-empty { text-align: center; margin-top: 40px; }
.detail-header { margin-bottom: 12px; }
.detail-header h1 { font-size: 18px; margin: 4px 0 2px; font-weight: 600; }
.type-chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  background: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
dl.frontmatter {
  display: grid;
  grid-template-columns: 90px 1fr;
  row-gap: 4px;
  column-gap: 12px;
  margin: 8px 0 12px;
  font-size: 13px;
}
dl.frontmatter dt { color: #64748b; font-weight: 500; }
dl.frontmatter dd { margin: 0; }
dl.frontmatter a { color: #2563eb; word-break: break-all; }
.tag {
  display: inline-block;
  padding: 1px 6px;
  margin: 0 4px 2px 0;
  border-radius: 4px;
  background: #f1f5f9;
  color: #475569;
  font-size: 11px;
}
.badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid transparent;
}
.badge.status-stable { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
.badge.status-draft { background: #fefce8; color: #a16207; border-color: #fde68a; }
.badge.status-deprecated { background: #f1f5f9; color: #64748b; border-color: #cbd5e1; text-decoration: line-through; }
.badge.trust-unverified { background: #f1f5f9; color: #64748b; border-color: #cbd5e1; }
.badge.trust-machine-confirmed { background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; }
.badge.trust-human-reviewed { background: #f5f3ff; color: #6d28d9; border-color: #ddd6fe; }
.badge.stale { background: #fef2f2; color: #b91c1c; border-color: #fecaca; }
.badge.fresh { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
.sources-list { padding-left: 18px; margin: 0; }
.sources-list li { margin: 2px 0; }
.src-badge {
  display: inline-block;
  margin-left: 4px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  vertical-align: middle;
  border: 1px solid transparent;
}
.src-badge.retrieved { background: #f1f5f9; color: #475569; border-color: #e2e8f0; }
.src-badge.modified { background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; }
hr { border: none; border-top: 1px solid #e2e8f0; margin: 14px 0; }
#detail-body { font-size: 13px; line-height: 1.55; }
#detail-body h1 { font-size: 16px; margin: 18px 0 6px; padding-bottom: 4px; border-bottom: 1px solid #e2e8f0; }
#detail-body h2 { font-size: 14px; margin: 14px 0 4px; }
#detail-body h3 { font-size: 13px; margin: 12px 0 4px; }
#detail-body p { margin: 6px 0; }
#detail-body code {
  background: #f1f5f9;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
}
#detail-body pre {
  background: #0f172a;
  color: #e2e8f0;
  padding: 10px 12px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
}
#detail-body pre code { background: transparent; color: inherit; padding: 0; }
#detail-body ul, #detail-body ol { padding-left: 22px; margin: 6px 0; }
#detail-body li { margin: 2px 0; }
#detail-body table { border-collapse: collapse; margin: 8px 0; }
#detail-body th, #detail-body td { border: 1px solid #e2e8f0; padding: 4px 8px; font-size: 12px; }
#detail-body a.internal { color: #2563eb; cursor: pointer; font-weight: 500; }
#detail-body a.external { color: #2563eb; }
#detail-body sup.fn-ref { font-size: 10px; margin-left: 2px; }
#detail-body sup.fn-ref a { color: #2563eb; text-decoration: none; font-weight: 600; }
#detail-body section.footnotes { margin-top: 16px; padding-top: 8px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #475569; }
#detail-body section.footnotes ul { padding-left: 18px; margin: 4px 0; }
#detail-backlinks { margin-top: 18px; }
#detail-backlinks h2 { font-size: 13px; color: #64748b; margin-bottom: 6px; }
#detail-backlinks ul { padding-left: 18px; }
#detail-backlinks a { color: #2563eb; cursor: pointer; }
`.trim();

/**
 * Auto-detects whether an ICM run/bundle is primarily Norwegian ('no') or English ('en').
 */
export function detectIcmLanguage(text: string): 'no' | 'en' {
  const sample = String(text || '');
  const noCharCount = (sample.match(/[æøåÆØÅ]/g) || []).length;
  const noStopMatches =
    sample.match(
      /\b(ikke|eller|brann\w*|styret|virksomhet\w*|forskrift\w*|sjekkliste\w*|kurset|kursdeltaker\w*|deltaker\w*|opplæring\w*|ansvar\w*|tiltak\w*|arbeidsgiver\w*|krav(?:ene|et)?|kontroll(?:en|er)?|lovpålagt\w*|vurdering\w*|gjennomfør\w*)\b/gi
    ) || [];
  const noShortMatches =
    sample.match(/\b(og|det|som|med|til|fra|lov|skal|må|kan|ved|av|på|en|et)\b/g) || [];
  const enStopMatches =
    sample.match(
      /\b(the|and|with|from|that|this|are|was|were|have|has|had|will|would|should|could|which|their|there|about|into|between|without|within|through|during|before|after|under|above|below|while|where|when|what|these|those)\b/gi
    ) || [];
  const noScore = noCharCount * 2 + noStopMatches.length * 3 + noShortMatches.length;
  const enScore = enStopMatches.length * 2;
  if (noScore === 0) return 'en';
  if (enScore === 0) {
    if (noCharCount >= 1 || noStopMatches.length >= 1 || noShortMatches.length >= 2) return 'no';
    return 'en';
  }
  return noScore >= enScore ? 'no' : 'en';
}

/**
 * Auto-detects whether Stage 2 represents a training/course pipeline ('course')
 * or an analytical/investment/decision/memo pipeline ('analysis').
 */
export function detectIcmDomainMode(
  rawStage2: Record<string, unknown> | null | undefined,
  quizCount: number,
  textSample?: string
): 'course' | 'analysis' {
  if (rawStage2 && typeof rawStage2 === 'object') {
    if (
      Array.isArray(rawStage2.pillars) ||
      Array.isArray(rawStage2.analysisPillars) ||
      Array.isArray(rawStage2.stressTests) ||
      typeof rawStage2.investmentThesis === 'string' ||
      typeof rawStage2.memoBody === 'string' ||
      typeof rawStage2.reportTitle === 'string' ||
      typeof rawStage2.memoTitle === 'string' ||
      typeof rawStage2.verdict === 'string'
    ) {
      return 'analysis';
    }
  }
  const combinedSample = `${JSON.stringify(rawStage2 || {})} ${textSample || ''}`;
  const hasAnalysisSignals =
    /\b(investment\s+committee|equity\s+research|valuation\s+pillar|sum-of-the-parts|sotp|dcf\b|ev\/ebitda|buy\/hold\/sell|due\s+diligence|pre-ipo|institutional\s+equity|capital\s+allocation)\b/i.test(
      combinedSample
    );
  const hasCourseSignals =
    /\b(kurs\b|opplæring|leksjon|kursdeltaker|training\s+course|certification\s+course)\b/i.test(
      combinedSample
    );
  if (hasAnalysisSignals && !hasCourseSignals) {
    return 'analysis';
  }
  if (quizCount === 0 && !hasCourseSignals) {
    return 'analysis';
  }
  return 'course';
}

const OKF_VIZ_JS = `
(function () {
  function detectTextLang(text) {
    const sample = String(text || "");
    const noCharCount = (sample.match(/[æøåÆØÅ]/g) || []).length;
    const noStopMatches =
      sample.match(
        /\\b(ikke|eller|brann\\w*|styret|virksomhet\\w*|forskrift\\w*|sjekkliste\\w*|kurset|kursdeltaker\\w*|deltaker\\w*|opplæring\\w*|ansvar\\w*|tiltak\\w*|arbeidsgiver\\w*|krav(?:ene|et)?|kontroll(?:en|er)?|lovpålagt\\w*|vurdering\\w*|gjennomfør\\w*)\\b/gi
      ) || [];
    const noShortMatches =
      sample.match(/\\b(og|det|som|med|til|fra|lov|skal|må|kan|ved|av|på|en|et)\\b/g) || [];
    const enStopMatches =
      sample.match(
        /\\b(the|and|with|from|that|this|are|was|were|have|has|had|will|would|should|could|which|their|there|about|into|between|without|within|through|during|before|after|under|above|below|while|where|when|what|these|those)\\b/gi
      ) || [];
    const noScore = noCharCount * 2 + noStopMatches.length * 3 + noShortMatches.length;
    const enScore = enStopMatches.length * 2;
    if (noScore === 0) return "en";
    if (enScore === 0) {
      if (noCharCount >= 1 || noStopMatches.length >= 1 || noShortMatches.length >= 2) return "no";
      return "en";
    }
    return noScore >= enScore ? "no" : "en";
  }

  function isInlineLatexMath(inner) {
    if (!inner || typeof inner !== "string") return false;
    if (/^\\s|\\s$/.test(inner)) return false;
    if (/[\\r\\n|]/.test(inner)) return false;
    if (inner.indexOf("[^") !== -1) return false;
    if (/\\*\\*|__/.test(inner)) return false;
    if (/(?:^|[^\\\\])~$/.test(inner)) return false;
    if (/^[A-Z]{1,5}\\/[A-Z]{1,5}$/.test(inner)) return true;
    if (/^[a-zA-Z]$/.test(inner)) return true;
    if (/^\\d+\\.\\d{3,}$/.test(inner)) return true;
    if (/^[a-zA-Z](?:_[a-zA-Z0-9]+)?\\s*(?:=|<|>|<=|>=|≈|~|±)\\s*[+-]?\\d+(?:[.,]\\d+)?%?$/.test(inner)) return true;
    if (/^\\d[\\d,.]*(?:\\s*(?:[BMKTbmkt](?![\\^_])\\b|billion|million|trillion|thousand|bn\\b|mn\\b|\\/(?![a-zA-Z0-9_()]*[\\^_\\\\])|\\s+(?:per|to|and|or|in|at|for|from|of|vs)\\b|-|–|—|\\)|\\s*$))/i.test(inner)) {
      return false;
    }
    if (!/(?:\\\\[a-zA-Z !,;:%$&_#]|[A-Za-z0-9)\\]}][\\^_](?:\\{[^{}\\r\\n]+\\}|[A-Za-z0-9+\\-°]))/.test(inner)) {
      return false;
    }
    if (/^\\d/.test(inner)) {
      if (
        !/^\\d+(?:[.,]\\d+)*(?:\\s*[+\\-*/]?\\s*(?:\\\\|[\\^_])|\\s+[a-zA-Z]{1,4}[\\^_]|\\s*[*/]\\s*[a-zA-Z0-9()]+\\s*[\\^_])/.test(
          inner
        ) &&
        !/^0\\.\\d{3,}$/.test(inner)
      ) {
        return false;
      }
    }
    return true;
  }

  function replaceInlineLatexSpans(str, replacer) {
    const s = String(str || "");
    let out = "";
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\\\" && i + 1 < s.length && s[i + 1] === "$") {
        out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch !== "$") {
        out += ch;
        i++;
        continue;
      }
      if (i + 1 < s.length && s[i + 1] === "$") {
        let j = i + 2;
        while (j + 1 < s.length) {
          if (s[j] === "\\\\" && j + 1 < s.length) {
            j += 2;
            continue;
          }
          if (s[j] === "$" && s[j + 1] === "$") {
            break;
          }
          if (s[j] === "|" || (s[j] === "\\n" && /^\\r?\\n\\s*\\r?\\n/.test(s.slice(j)))) {
            break;
          }
          j++;
        }
        if (j + 1 < s.length && s[j] === "$" && s[j + 1] === "$") {
          const innerDisp = s.slice(i + 2, j).replace(/\\s+/g, " ").trim();
          if (isInlineLatexMath(innerDisp)) {
            out += replacer(s.slice(i, j + 2), innerDisp);
            i = j + 2;
            continue;
          }
        }
      }
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "\\\\" && j + 1 < s.length) {
          j += 2;
          continue;
        }
        if (s[j] === "$" || s[j] === "\\n" || s[j] === "\\r" || s[j] === "|") {
          break;
        }
        j++;
      }
      if (j < s.length && s[j] === "$") {
        const inner = s.slice(i + 1, j);
        if (isInlineLatexMath(inner)) {
          out += replacer(s.slice(i, j + 1), inner);
          i = j + 1;
          continue;
        }
      }
      out += "$";
      i++;
    }
    return out;
  }

  if (typeof window !== "undefined" && window.__ICM_TEST_HOOKS__) {
    window.__ICM_TEST_HOOKS__.renderMarkdownWithOkfFootnotes = renderMarkdownWithOkfFootnotes;
    window.__ICM_TEST_HOOKS__.parseBuiltInVizMarkdown = parseBuiltInVizMarkdown;
    window.__ICM_TEST_HOOKS__.isInlineLatexMath = isInlineLatexMath;
    window.__ICM_TEST_HOOKS__.replaceInlineLatexSpans = replaceInlineLatexSpans;
    window.__ICM_TEST_HOOKS__.detectTextLang = detectTextLang;
    window.__ICM_TEST_HOOKS__.resolveInternalConceptId = resolveInternalConceptId;
    return;
  }
  const bundle = window.BUNDLE;
  const bundleName = window.BUNDLE_NAME;
  const isNo =
    (bundle && bundle.lang === "no") ||
    ((!bundle || bundle.lang !== "en") &&
      detectTextLang(Object.values((bundle && bundle.bodies) || {}).join(" ")) === "no");
  document.title = bundleName + " — OKF v0.2 Viewer";
  document.getElementById("bundle-name").textContent = bundleName;

  const typeSelect = document.getElementById("filter-type");
  for (const t of bundle.types) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    typeSelect.appendChild(opt);
  }

  const backlinks = {};
  for (const edge of bundle.edges) {
    const { source, target } = edge.data;
    (backlinks[target] ||= []).push(source);
  }

  var nodeIndex = {};
  for (const n of bundle.nodes) nodeIndex[n.data.id] = n.data;

  const noopCollection = {
    unselect: () => {},
    removeClass: () => {},
    forEach: () => {},
    select: () => {},
  };
  const cy =
    typeof cytoscape === "function"
      ? cytoscape({
          container: document.getElementById("graph"),
          elements: [...bundle.nodes, ...bundle.edges],
          style: [
            {
              selector: "node",
              style: {
                "background-color": "data(color)",
                "label": "data(label)",
                "color": "#0f172a",
                "font-size": 11,
                "text-valign": "bottom",
                "text-margin-y": 4,
                "text-wrap": "wrap",
                "text-max-width": 120,
                "width": "data(size)",
                "height": "data(size)",
                "border-width": 1,
                "border-color": "#0f172a",
              },
            },
            {
              selector: "node[?stale]",
              style: {
                "border-width": 2,
                "border-color": "#b91c1c",
                "border-style": "dashed",
              },
            },
            {
              selector: 'node[status = "deprecated"]',
              style: { "opacity": 0.55 },
            },
            {
              selector: "node:selected",
              style: {
                "border-width": 3,
                "border-color": "#f59e0b",
              },
            },
            {
              selector: "edge",
              style: {
                "width": 1.5,
                "line-color": "#cbd5e1",
                "target-arrow-color": "#cbd5e1",
                "target-arrow-shape": "triangle",
                "curve-style": "bezier",
                "arrow-scale": 0.9,
              },
            },
            {
              selector: "edge:selected",
              style: {
                "line-color": "#f59e0b",
                "target-arrow-color": "#f59e0b",
                "width": 2.5,
              },
            },
            {
              selector: ".dim",
              style: { "opacity": 0.15 },
            },
          ],
          layout: { name: "cose", animate: false, padding: 30 },
          wheelSensitivity: 0.2,
        })
      : createSvgGraphFallback(document.getElementById("graph"), bundle.nodes || [], bundle.edges || []);

  cy.on("tap", "node", (evt) => showDetail(evt.target.id()));
  cy.on("tap", (evt) => {
    if (evt.target === cy) clearSelection();
  });

  document.getElementById("layout").addEventListener("change", (e) => {
    cy.layout({ name: e.target.value, animate: false, padding: 30 }).run();
  });

  document.getElementById("reset").addEventListener("click", () => {
    cy.fit(null, 30);
    clearSelection();
  });

  document.getElementById("search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) {
      cy.elements().removeClass("dim");
      return;
    }
    cy.nodes().forEach((n) => {
      const d = n.data();
      const hay =
        (d.label || "").toLowerCase() + " " +
        d.id.toLowerCase() + " " +
        (d.tags || []).join(" ").toLowerCase();
      n.toggleClass("dim", !hay.includes(q));
    });
    cy.edges().forEach((edge) => {
      const src = edge.source();
      const tgt = edge.target();
      edge.toggleClass("dim", src.hasClass("dim") || tgt.hasClass("dim"));
    });
  });

  document.getElementById("filter-type").addEventListener("change", (e) => {
    const t = e.target.value;
    if (!t) {
      cy.elements().removeClass("dim");
      return;
    }
    cy.nodes().forEach((n) => {
      n.toggleClass("dim", n.data("type") !== t);
    });
    cy.edges().forEach((edge) => {
      edge.toggleClass("dim", edge.source().hasClass("dim") || edge.target().hasClass("dim"));
    });
  });

  function clearSelection() {
    cy.elements().unselect();
    document.getElementById("detail-empty").hidden = false;
    document.getElementById("detail-content").hidden = true;
  }

  function resolveInternalConceptId(href, currentConceptId) {
    if (!href || /^[a-z]+:\\/\\//i.test(href) || href.startsWith("mailto:") || href.startsWith("#")) {
      return null;
    }
    const cleanHref = href.split("#")[0].trim();
    if (!cleanHref.endsWith(".md")) return null;
    if (cleanHref.startsWith("/")) {
      return cleanHref.slice(1, -3);
    }
    const curParts = currentConceptId.split("/");
    curParts.pop();
    const relParts = cleanHref.slice(0, -3).split("/");
    for (const seg of relParts) {
      if (!seg || seg === ".") continue;
      if (seg === "..") {
        curParts.pop();
      } else {
        curParts.push(seg);
      }
    }
    const relResolved = curParts.join("/");
    if (typeof nodeIndex !== "undefined" && nodeIndex && nodeIndex[relResolved]) return relResolved;
    const rootCandidate = cleanHref.slice(0, -3);
    if (
      !cleanHref.startsWith("./") &&
      !cleanHref.startsWith("../") &&
      typeof nodeIndex !== "undefined" &&
      nodeIndex &&
      nodeIndex[rootCandidate]
    ) {
      return rootCandidate;
    }
    return relResolved;
  }

  function formatSourceDateShort(isoStr) {
    if (!isoStr) return "";
    const s = String(isoStr).trim();
    const m = s.match(/^(\\d{4}-\\d{2}-\\d{2})/);
    return m ? m[1] : s;
  }

  function escapeHtmlAttr(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderSourceBadgesHtml(src) {
    if (!src) return "";
    let out = "";
    if (src.retrieved_at) {
      const shortDate = formatSourceDateShort(src.retrieved_at);
      out +=
        ' <span class="src-badge retrieved" title="Retrieved at ' +
        escapeHtmlAttr(src.retrieved_at) +
        '">retrieved ' +
        escapeHtmlAttr(shortDate) +
        "</span>";
    }
    if (src.last_modified) {
      const shortMod = formatSourceDateShort(src.last_modified);
      out +=
        ' <span class="src-badge modified" title="Last-Modified ' +
        escapeHtmlAttr(src.last_modified) +
        '">last_modified ' +
        escapeHtmlAttr(shortMod) +
        "</span>";
    }
    return out;
  }

  function appendSourceBadges(container, src) {
    if (!src) return;
    if (src.retrieved_at) {
      const b = document.createElement("span");
      b.className = "src-badge retrieved";
      b.title = "Retrieved at " + src.retrieved_at;
      b.textContent = "retrieved " + formatSourceDateShort(src.retrieved_at);
      container.appendChild(document.createTextNode(" "));
      container.appendChild(b);
    }
    if (src.last_modified) {
      const b = document.createElement("span");
      b.className = "src-badge modified";
      b.title = "Last-Modified " + src.last_modified;
      b.textContent = "last_modified " + formatSourceDateShort(src.last_modified);
      container.appendChild(document.createTextNode(" "));
      container.appendChild(b);
    }
  }

  function parseBuiltInVizMarkdown(rawMd) {
    const stash = [];
    function putStash(htmlFrag) {
      const idx = stash.length;
      stash.push(htmlFrag);
      return "\\x00STASH_" + idx + "\\x00";
    }
    let text = String(rawMd || "").replace(/\\r\\n/g, "\\n");
    text = text.replace(
      /<sup class="fn-ref[^"]*"><a [^>]+>\\[[^\\]]+\\]<\\/a><\\/sup>|<(?:sub|sup|code)>[^<]*<\\/(?:sub|sup|code)>|<a href="[^"]+"><code>[^<]+<\\/code><\\/a>/g,
      function (m) { return putStash(m); }
    );
    const fenceStash = [];
    text = text.replace(/^\\x60\\x60\\x60[^\\n]*\\n([\\s\\S]*?)^\\x60\\x60\\x60\\s*$/gm, function (_m, codeBody) {
      const idx = fenceStash.length;
      fenceStash.push("<pre><code>" + escapeHtmlAttr(codeBody.replace(/\\n$/, "")) + "</code></pre>");
      return "\\x00FENCE_" + idx + "\\x00";
    });
    function formatInline(s) {
      let line = String(s || "");
      line = line.replace(/\\x60(\\/[A-Za-z0-9_\\-\\/]+\\.md)\\x60/g, function (_m, p) {
        return putStash('<a href="' + escapeHtmlAttr(p) + '"><code>' + escapeHtmlAttr(p) + "</code></a>");
      });
      line = line.replace(/\\x60([^\\x60\\n]+)\\x60/g, function (_m, code) {
        return putStash("<code>" + escapeHtmlAttr(code) + "</code>");
      });
      line = line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      line = line.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function (_m, lbl, rawHref) {
        const cleanHref = rawHref.replace(/&amp;/g, "&");
        const isExt = /^https?:\\/\\//i.test(cleanHref);
        const safeHref = /^(?:https?:\\/\\/|mailto:|\\/|\\.\\/|\\.\\.\\/|#|[A-Za-z0-9_\\-\\/]+\\.md)/i.test(cleanHref)
          ? escapeHtmlAttr(cleanHref)
          : "#";
        const extAttrs = isExt ? ' class="external" target="_blank" rel="noopener noreferrer"' : "";
        return putStash("<a" + extAttrs + ' href="' + safeHref + '">' + formatInline(lbl.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")) + "</a>");
      });
      line = line
        .replace(/\\*\\*\\*([^*\\n]+?)\\*\\*\\*/g, "<strong><em>$1</em></strong>")
        .replace(/\\*\\*([^*\\n]+?)\\*\\*/g, "<strong>$1</strong>")
        .replace(/(^|[\\s(])__([^_\\n]+?)__(?=$|[\\s).,;:!?])/g, "$1<strong>$2</strong>")
        .replace(/(^|[^*])\\*([^\\s*][^*\\n]*?)\\*(?!\\*)/g, "$1<em>$2</em>")
        .replace(/(^|[\\s(])_([^\\s_][^_\\n]*?)_(?=$|[\\s).,;:!?])/g, "$1<em>$2</em>")
        .replace(/~~([^~\\n]+?)~~/g, "<del>$1</del>");
      for (let pass = 0; pass < 3; pass++) {
        if (line.indexOf("\\x00STASH_") === -1) break;
        line = line.replace(/\\x00STASH_(\\d+)\\x00/g, function (_m, n) {
          return stash[Number(n)] || "";
        });
      }
      return line;
    }
    const lines = text.split("\\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();
      if (!trimmed) { i++; continue; }
      const fenceM = trimmed.match(/^\\x00FENCE_(\\d+)\\x00$/);
      if (fenceM) { out.push(fenceStash[Number(fenceM[1])] || ""); i++; continue; }
      if (/^(?:---+|\\*\\*\\*+|___+)$/.test(trimmed)) { out.push("<hr>"); i++; continue; }
      const hM = trimmed.match(/^(#{1,6})\\s+(.+?)\\s*#*\\s*$/);
      if (hM) {
        const lvl = hM[1].length;
        out.push("<h" + lvl + ">" + formatInline(hM[2]) + "</h" + lvl + ">");
        i++;
        continue;
      }
      if (
        trimmed.indexOf("|") !== -1 &&
        i + 1 < lines.length &&
        /^\\s*\\|?\\s*:?-{2,}:?(?:\\s*\\|\\s*:?-{2,}:?)+\\s*\\|?\\s*$/.test(lines[i + 1])
      ) {
        const splitCells = function (rowStr) {
          return rowStr.trim().replace(/^\\|/, "").replace(/\\|$/, "").split("|").map(function (c) { return c.trim(); });
        };
        const headers = splitCells(rawLine);
        i += 2;
        let tbl = "<table><thead><tr>" + headers.map(function (h) { return "<th>" + formatInline(h) + "</th>"; }).join("") + "</tr></thead><tbody>";
        while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") !== -1) {
          const cells = splitCells(lines[i]);
          tbl += "<tr>" + headers.map(function (_h, cIdx) { return "<td>" + formatInline(cells[cIdx] || "") + "</td>"; }).join("") + "</tr>";
          i++;
        }
        tbl += "</tbody></table>";
        out.push(tbl);
        continue;
      }
      if (/^>\\s?/.test(trimmed)) {
        const qLines = [];
        while (i < lines.length && /^\\s*>\\s?/.test(lines[i])) {
          qLines.push(lines[i].replace(/^\\s*>\\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + parseBuiltInVizMarkdown(qLines.join("\\n")) + "</blockquote>");
        continue;
      }
      const listM = rawLine.match(/^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$/);
      if (listM) {
        const renderListBlock = function (baseIndent) {
          const firstM = lines[i].match(/^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$/);
          const isOrd = /^\\d/.test(firstM[2]);
          const tag = isOrd ? "ol" : "ul";
          let listHtml = "<" + tag + ">";
          while (i < lines.length) {
            if (!lines[i].trim()) {
              if (i + 1 < lines.length && /^(\\s*)([-*+]|\\d+[.)])\\s+/.test(lines[i + 1])) { i++; continue; }
              break;
            }
            const m = lines[i].match(/^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$/);
            if (!m) break;
            const ind = m[1].length;
            if (ind < baseIndent) break;
            if (ind > baseIndent) {
              listHtml = listHtml.replace(/<\\/li>$/, "") + renderListBlock(ind) + "</li>";
              continue;
            }
            let itemBody = m[3];
            const taskM = itemBody.match(/^\\[([ xX])\\]\\s+(.*)$/);
            let prefix = "";
            if (taskM) {
              prefix = '<input type="checkbox" disabled' + (taskM[1].toLowerCase() === "x" ? " checked" : "") + "> ";
              itemBody = taskM[2];
            }
            i++;
            while (
              i < lines.length &&
              lines[i].trim() &&
              !/^\\s*([-*+]|\\d+[.)])\\s+/.test(lines[i]) &&
              !/^\\s*(?:#{1,6}\\s+|---+|\\*\\*\\*+|>|\\x60\\x60\\x60|\\x00FENCE_)/.test(lines[i])
            ) {
              itemBody += " " + lines[i].trim();
              i++;
            }
            let subHtml = "";
            if (i < lines.length) {
              const nextM = lines[i].match(/^(\\s*)([-*+]|\\d+[.)])\\s+/);
              if (nextM && nextM[1].length > baseIndent) {
                subHtml = renderListBlock(nextM[1].length);
              }
            }
            listHtml += "<li>" + prefix + formatInline(itemBody) + subHtml + "</li>";
          }
          listHtml += "</" + tag + ">";
          return listHtml;
        };
        out.push(renderListBlock(listM[1].length));
        continue;
      }
      const pLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\\s*(?:#{1,6}\\s+|---+|\\*\\*\\*+|___+|>\\s?|[-*+]\\s+|\\d+[.)]\\s+|\\x00FENCE_)/.test(lines[i]) &&
        !(lines[i].indexOf("|") !== -1 && i + 1 < lines.length && /^\\s*\\|?\\s*:?-{2,}:?(?:\\s*\\|\\s*:?-{2,}:?)+\\s*\\|?\\s*$/.test(lines[i + 1]))
      ) {
        pLines.push(lines[i].trim());
        i++;
      }
      if (pLines.length > 0) {
        out.push("<p>" + formatInline(pLines.join(" ")) + "</p>");
      } else {
        i++;
      }
    }
    return out.join("\\n");
  }

  function createSvgGraphFallback(container, nodes, edges) {
    const tapNodeHandlers = [];
    const tapBgHandlers = [];
    const nodeWrappers = {};
    const edgeWrappers = [];
    let selectedId = null;
    const ns = "http://www.w3.org/2000/svg";
    const W = 820;
    const H = 560;
    const svg = container ? document.createElementNS(ns, "svg") : null;
    if (svg && container) {
      container.innerHTML = "";
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      svg.style.width = "100%";
      svg.style.height = "100%";
      svg.style.display = "block";
      svg.style.userSelect = "none";
      const concepts = nodes.filter(function (n) { return n && n.data && n.data.group !== "source"; });
      const sources = nodes.filter(function (n) { return n && n.data && n.data.group === "source"; });
      const posById = {};
      concepts.forEach(function (c, idx) {
        if (concepts.length === 1) {
          posById[c.data.id] = { x: W / 2, y: H / 2 };
        } else {
          const ang = (2 * Math.PI * idx) / concepts.length - Math.PI / 2;
          posById[c.data.id] = { x: W / 2 + 115 * Math.cos(ang), y: H / 2 + 95 * Math.sin(ang) };
        }
      });
      sources.forEach(function (s, idx) {
        const ang = (2 * Math.PI * idx) / Math.max(1, sources.length) - Math.PI / 2;
        posById[s.data.id] = { x: W / 2 + 300 * Math.cos(ang), y: H / 2 + 215 * Math.sin(ang) };
      });
      const edgeGroup = document.createElementNS(ns, "g");
      const nodeGroup = document.createElementNS(ns, "g");
      svg.appendChild(edgeGroup);
      svg.appendChild(nodeGroup);

      nodes.forEach(function (n) {
        if (!n || !n.data) return;
        const d = n.data;
        const p = posById[d.id] || { x: W / 2, y: H / 2 };
        const g = document.createElementNS(ns, "g");
        g.style.cursor = "pointer";
        const r = Math.max(11, Math.min(24, Number(d.size || 24) / 2));
        const circle = document.createElementNS(ns, "circle");
        circle.setAttribute("cx", String(p.x));
        circle.setAttribute("cy", String(p.y));
        circle.setAttribute("r", String(r));
        circle.setAttribute("fill", d.color || "#0284c7");
        circle.setAttribute("stroke", "#0f172a");
        circle.setAttribute("stroke-width", "1.5");
        const label = document.createElementNS(ns, "text");
        label.setAttribute("x", String(p.x));
        label.setAttribute("y", String(p.y + r + 13));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("font-size", "10.5");
        label.setAttribute("fill", "#0f172a");
        const rawLbl = String(d.label || d.id || "");
        label.textContent = rawLbl.length > 26 ? rawLbl.slice(0, 25) + "…" : rawLbl;
        g.appendChild(circle);
        g.appendChild(label);
        nodeGroup.appendChild(g);
        let dimmed = false;
        const wrapper = {
          id: function () { return d.id; },
          data: function (k) { return k ? d[k] : d; },
          hasClass: function (cls) { return cls === "dim" ? dimmed : false; },
          toggleClass: function (cls, state) {
            if (cls === "dim") {
              dimmed = Boolean(state);
              g.style.opacity = dimmed ? "0.15" : "1";
            }
          },
          removeClass: function (cls) {
            if (cls === "dim") { dimmed = false; g.style.opacity = "1"; }
          },
          select: function () {
            selectedId = d.id;
            Object.keys(nodeWrappers).forEach(function (k) {
              const nw = nodeWrappers[k];
              nw._circle.setAttribute("stroke", k === selectedId ? "#f59e0b" : "#0f172a");
              nw._circle.setAttribute("stroke-width", k === selectedId ? "3.5" : "1.5");
            });
          },
          _circle: circle,
        };
        nodeWrappers[d.id] = wrapper;
        g.addEventListener("click", function (ev) {
          ev.stopPropagation();
          tapNodeHandlers.forEach(function (fn) { fn({ target: wrapper }); });
        });
      });

      edges.forEach(function (e) {
        if (!e || !e.data) return;
        const sp = posById[e.data.source];
        const tp = posById[e.data.target];
        if (!sp || !tp) return;
        const line = document.createElementNS(ns, "line");
        line.setAttribute("x1", String(sp.x));
        line.setAttribute("y1", String(sp.y));
        line.setAttribute("x2", String(tp.x));
        line.setAttribute("y2", String(tp.y));
        line.setAttribute("stroke", "#cbd5e1");
        line.setAttribute("stroke-width", "1.5");
        edgeGroup.appendChild(line);
        edgeWrappers.push({
          source: function () { return nodeWrappers[e.data.source] || { hasClass: function () { return false; } }; },
          target: function () { return nodeWrappers[e.data.target] || { hasClass: function () { return false; } }; },
          toggleClass: function (cls, state) {
            if (cls === "dim") line.style.opacity = state ? "0.15" : "1";
          },
          removeClass: function (cls) {
            if (cls === "dim") line.style.opacity = "1";
          },
        });
      });

      svg.addEventListener("click", function () {
        tapBgHandlers.forEach(function (fn) { fn({ target: api }); });
      });
      container.appendChild(svg);
    }
    const api = {
      on: function (evtName, selOrFn, maybeFn) {
        if (evtName === "tap" && selOrFn === "node" && typeof maybeFn === "function") {
          tapNodeHandlers.push(maybeFn);
        } else if (evtName === "tap" && typeof selOrFn === "function") {
          tapBgHandlers.push(selOrFn);
        }
      },
      layout: function () { return { run: function () {} }; },
      fit: function () {},
      elements: function () {
        return {
          unselect: function () {
            selectedId = null;
            Object.keys(nodeWrappers).forEach(function (k) {
              nodeWrappers[k]._circle.setAttribute("stroke", "#0f172a");
              nodeWrappers[k]._circle.setAttribute("stroke-width", "1.5");
            });
          },
          removeClass: function (cls) {
            Object.keys(nodeWrappers).forEach(function (k) { nodeWrappers[k].removeClass(cls); });
            edgeWrappers.forEach(function (ew) { ew.removeClass(cls); });
          },
        };
      },
      nodes: function () {
        return {
          forEach: function (fn) {
            Object.keys(nodeWrappers).forEach(function (k) { fn(nodeWrappers[k]); });
          },
        };
      },
      edges: function () {
        return {
          forEach: function (fn) { edgeWrappers.forEach(fn); },
        };
      },
      getElementById: function (id) {
        return nodeWrappers[id] || noopCollection;
      },
      animate: function () {},
      zoom: function () { return 1; },
    };
    return api;
  }

  function renderMarkdownWithOkfFootnotes(rawBody, sources) {
    const srcById = {};
    for (const s of sources || []) {
      if (s && s.id) srcById[s.id] = s;
    }
    const fnDefs = [];
    const seenFnIds = {};
    const bodyLines = [];
    for (const line of String(rawBody || "").split(/\\r?\\n/)) {
      const m = line.trim().match(/^\\[\\^([A-Za-z0-9_\\-]+)\\]:\\s*(.+)$/);
      if (m) {
        seenFnIds[m[1]] = true;
        fnDefs.push({ id: m[1], label: m[2] });
      } else {
        bodyLines.push(line);
      }
    }
    const joinedBody = bodyLines
      .join("\\n")
      .replace(/^\\s*#\\s+[^\\r\\n]+(?:\\r?\\n+---(?=\\r?\\n|$))?\\r?\\n*/, "")
      .replace(/\\r?\\n+---\\s*$/g, "")
      .replace(/(?:\\r?\\n+---)?\\r?\\n+#{1,4}\\s+(?:\\*\\*|__)?(?:\\d+(?:\\.\\d+)*\\.?\\s+)?(?:Sources?(?:\\s*(?:&|and|\\/)\\s*(?:Citations?|Footnotes?|References?))?|References?(?:\\s*(?:&|and|\\/)\\s*(?:Footnotes?|Citations?|Sources?))?|Citations?(?:\\s*(?:&|and|\\/)\\s*(?:Footnotes?|References?))?|Footnotes?(?:\\s*(?:&|and|\\/)\\s*(?:References?|Sources?))?|Grounded\\s+Search\\s+References|Kildehenvisninger(?:\\s*(?:og|&|\\/)\\s*(?:referanser|fotnoter))?|Kilder(?:\\s*(?:og|&|\\/)\\s*(?:referanser|fotnoter|kildehenvisninger))?|Kildeliste(?:\\s*(?:og|&|\\/)\\s*fotnoter)?|Referanser(?:\\s*(?:og|&|\\/)\\s*(?:fotnoter|kilder))?|Referanseliste(?:\\s*(?:og|&|\\/)\\s*fotnoter)?|Fotnoter(?:\\s*(?:og|&|\\/)\\s*(?:kilder|referanser))?):?(?:\\*\\*|__)?(?:\\r?\\n+---)?\\s*$/i, "")
      .replace(/\\r?\\n+---\\s*$/g, "");
    const inlineMatches = joinedBody.matchAll(/\\[\\^([A-Za-z0-9_\\-]+)\\]/g);
    for (const im of inlineMatches) {
      const cid = im[1];
      if (!seenFnIds[cid] && srcById[cid]) {
        seenFnIds[cid] = true;
        fnDefs.push({
          id: cid,
          label: srcById[cid].title || srcById[cid].resource || cid,
        });
      }
    }
    const supMap = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ" };
    const subMap = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ" };
    const bodyWithMath = replaceInlineLatexSpans(joinedBody, function (_, inner) {
      let cleaned = String(inner)
        .replace(/\\\\(?:left|right)\\s*([()[\\]|.])?/g, "$1")
        .replace(/\\\\mathcal\\{R\\}/g, "ℛ")
        .replace(/\\\\mathcal\\{([A-Za-z0-9]+)\\}/g, "$1")
        .replace(/\\\\(?:[,;:]|\\s+|quad\\b|qquad\\b)/g, " ")
        .replace(/~/g, " ")
        .replace(/\\\\!/g, "")
        .replace(/\\\\sim(?![a-zA-Z])/g, "~")
        .replace(/\\\\leftrightarrow/g, "↔")
        .replace(/\\\\Leftrightarrow|\\\\iff(?![a-zA-Z])/g, "⇔")
        .replace(/\\\\rightarrow|\\\\to(?![a-zA-Z])/g, "→")
        .replace(/\\\\Rightarrow|\\\\implies(?![a-zA-Z])/g, "⇒")
        .replace(/\\\\leftarrow/g, "←")
        .replace(/\\\\Leftarrow/g, "⇐")
        .replace(/\\\\(?:ge|geq)(?![a-zA-Z])/g, "≥")
        .replace(/\\\\(?:le|leq)(?![a-zA-Z])/g, "≤")
        .replace(/\\\\(?:neq|ne)(?![a-zA-Z])/g, "≠")
        .replace(/\\\\approx(?![a-zA-Z])/g, "≈")
        .replace(/\\\\times(?![a-zA-Z])/g, "×")
        .replace(/\\\\div(?![a-zA-Z])/g, "÷")
        .replace(/\\\\pm(?![a-zA-Z])/g, "±")
        .replace(/\\\\cdot(?![a-zA-Z])/g, "·")
        .replace(/\\\\(?:dots|ldots|cdots)(?![a-zA-Z])/g, "…")
        .replace(/\\\\infty(?![a-zA-Z])/g, "∞")
        .replace(/\\\\sum(?![a-zA-Z])/g, "∑")
        .replace(/\\\\prod(?![a-zA-Z])/g, "∏")
        .replace(/\\\\int(?![a-zA-Z])/g, "∫")
        .replace(/\\\\partial(?![a-zA-Z])/g, "∂")
        .replace(/\\\\nabla(?![a-zA-Z])/g, "∇")
        .replace(/\\\\propto(?![a-zA-Z])/g, "∝")
        .replace(/\\\\perp(?![a-zA-Z])/g, "⊥")
        .replace(/\\\\parallel(?![a-zA-Z])/g, "∥")
        .replace(/\\\\Delta\\s+([a-zA-Z])(?![a-zA-Z])/g, "Δ$1")
        .replace(/\\\\Delta(?![a-zA-Z])/g, "Δ")
        .replace(/\\\\delta(?![a-zA-Z])/g, "δ")
        .replace(/\\\\mu(?![a-zA-Z])/g, "μ")
        .replace(/\\\\Omega(?![a-zA-Z])/g, "Ω")
        .replace(/\\\\omega(?![a-zA-Z])/g, "ω")
        .replace(/\\\\alpha(?![a-zA-Z])/g, "α")
        .replace(/\\\\beta(?![a-zA-Z])/g, "β")
        .replace(/\\\\gamma(?![a-zA-Z])/g, "γ")
        .replace(/\\\\lambda(?![a-zA-Z])/g, "λ")
        .replace(/\\\\pi(?![a-zA-Z])/g, "π")
        .replace(/\\\\sigma(?![a-zA-Z])/g, "σ")
        .replace(/\\\\rho(?![a-zA-Z])/g, "ρ")
        .replace(/\\\\theta(?![a-zA-Z])/g, "θ")
        .replace(/\\\\tau(?![a-zA-Z])/g, "τ")
        .replace(/\\\\phi(?![a-zA-Z])|\\\\varphi(?![a-zA-Z])/g, "φ")
        .replace(/\\\\eta(?![a-zA-Z])/g, "η")
        .replace(/\\\\kappa(?![a-zA-Z])/g, "κ")
        .replace(/\\\\epsilon(?![a-zA-Z])|\\\\varepsilon(?![a-zA-Z])/g, "ε")
        .replace(/\\\\(?:ln|exp|log|sin|cos|tan|min|max|lim|sup|inf)(?![a-zA-Z])/g, function (m) {
          return m.slice(1);
        })
        .replace(/\\\\(?:circ|degree)(?![a-z])/g, "°")
        .replace(/\\\\(?:xrightleftharpoons|rightleftharpoons)(?:\\[[^\\]]*\\])?(?:\\{[^{}]*\\})?/g, "⇌")
        .replace(/\\\\(?:xrightarrow|xleftarrow)(?:\\[[^\\]]*\\])?(?:\\{[^{}]*\\})?/g, "→")
        .replace(/\\\\([$&%_#])/g, "$1");
      for (let pass = 0; pass < 3; pass++) {
        cleaned = cleaned
          .replace(/\\\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\\{([^{}]*)\\}/g, "$1")
          .replace(/\\\\sqrt\\{\\s*([^{}]+?)\\s*\\}/g, "√($1)")
          .replace(/\\\\(?:overline|hat|bar|tilde|vec)\\{\\s*([^{}]+?)\\s*\\}/g, "$1")
          .replace(/\\^\\{\\s*(?:°|o)\\s*([CFK])?\\s*\\}|\\^°/g, "°$1")
          .replace(/\\^\\{\\s*([0-9+\\-=()a-pr-z]+)\\s*\\}|\\^([0-9+\\-a-pr-z])(?![a-zA-Z0-9])/g, function (_m, b, s) {
            return String(b || s).replace(/[0-9+\\-=()a-pr-z]/g, function (d) {
              return supMap[d] || d;
            });
          })
          .replace(/_\\{\\s*([+-]?[0-9]+|[+-=()]+)\\s*\\}|_([+-]?[0-9])(?![0-9])/g, function (_m, b, s) {
            return String(b || s).replace(/[0-9+\\-=()]/g, function (d) {
              return subMap[d] || d;
            });
          })
          .replace(/_\\{\\s*([aehijklmnoprstuvx]+)\\s*\\}|_([aehijklmnoprstuvx])(?![a-zA-Z0-9])/g, function (_m, b, s) {
            return String(b || s).replace(/[aehijklmnoprstuvx]/g, function (d) {
              return subMap[d] || d;
            });
          })
          .replace(/_\\{\\s*([^{}]+?)\\s*\\}/g, function (_m, sub) {
            return "<sub>" + escapeHtmlAttr(sub) + "</sub>";
          })
          .replace(/\\^\\{\\s*([^{}]+?)\\s*\\}/g, function (_m, sup) {
            return "<sup>" + escapeHtmlAttr(sup) + "</sup>";
          })
          .replace(/\\\\frac\\{\\s*([^{}]+?)\\s*\\}\\{\\s*([^{}]+?)\\s*\\}/g, "$1/$2");
      }
      cleaned = cleaned
        .replace(/\\\\([{}])/g, "$1")
        .replace(/_([a-zA-Z0-9()])(?![a-zA-Z0-9])/g, "<sub>$1</sub>")
        .replace(/\\^([a-zA-Z0-9()])(?![a-zA-Z0-9])/g, "<sup>$1</sup>")
        .replace(/\\s+/g, " ")
        .trim();
      if (!/[\\\\{}^_]/.test(cleaned)) {
        return cleaned;
      }
      return "<code>" + escapeHtmlAttr(cleaned) + "</code>";
    });
    const bodyWithSup = bodyWithMath.replace(
      /\\[\\^([A-Za-z0-9_\\-]+)\\]/g,
      '<sup class="fn-ref"><a href="#fn-$1" data-fn="$1">[$1]</a></sup>'
    );
    let html =
      typeof marked !== "undefined" && marked && typeof marked.parse === "function"
        ? marked.parse(bodyWithSup, { breaks: false, gfm: true })
        : parseBuiltInVizMarkdown(bodyWithSup);
    if (fnDefs.length > 0) {
      const items = fnDefs
        .map((fn) => {
          const src = srcById[fn.id];
          const url = src && src.resource && /^https?:\\/\\//.test(src.resource) ? src.resource : null;
          const text = url
            ? '<a class="external" target="_blank" rel="noopener" href="' +
              escapeHtmlAttr(url) +
              '">' +
              escapeHtmlAttr(fn.label) +
              "</a>"
            : escapeHtmlAttr(fn.label);
          const badges = renderSourceBadgesHtml(src);
          return '<li id="fn-' + escapeHtmlAttr(fn.id) + '"><code>[' + escapeHtmlAttr(fn.id) + "]</code> " + text + badges + "</li>";
        })
        .join("");
      html += '<section class="footnotes"><ul>' + items + "</ul></section>";
    }
    return html;
  }

  const fallbackPalette = ["#0284c7", "#e11d48", "#059669", "#ea580c", "#4f46e5", "#0891b2", "#c026d3", "#65a30d", "#dc2626", "#9333ea", "#ca8a04", "#0f766e"];
  function getTypeColor(type) {
    const clean = String(type || "").trim();
    if (!clean || clean.toLowerCase() === "unknown") return "#64748b";
    if (bundle.palette && bundle.palette[clean]) return bundle.palette[clean];
    let hash = 2166136261;
    for (let i = 0; i < clean.length; i++) {
      hash ^= clean.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return fallbackPalette[(hash >>> 0) % fallbackPalette.length];
  }

  let lastConceptId = null;

  function showDetail(conceptId) {
    const data = nodeIndex[conceptId];
    if (!data) return;
    const isSourceNode = data.group === "source" || String(conceptId).startsWith("source:");
    if (!isSourceNode) {
      lastConceptId = conceptId;
    }
    cy.elements().unselect();
    const node = cy.getElementById(conceptId);
    if (node) node.select();

    document.getElementById("detail-empty").hidden = true;
    const content = document.getElementById("detail-content");
    content.hidden = false;

    const chip = document.getElementById("detail-type");
    chip.textContent = data.type;
    chip.style.background = data.color || getTypeColor(data.type);

    document.getElementById("detail-title").textContent = data.fullTitle || data.label;
    document.getElementById("detail-id").textContent = conceptId;
    document.getElementById("detail-description").textContent = data.description || "—";

    const resourceEl = document.getElementById("detail-resource");
    resourceEl.innerHTML = "";
    if (data.resource) {
      const a = document.createElement("a");
      a.href = data.resource;
      a.textContent = data.resource;
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "external";
      resourceEl.appendChild(a);
    } else {
      resourceEl.textContent = "—";
    }

    const tagsEl = document.getElementById("detail-tags");
    tagsEl.innerHTML = "";
    if (data.tags && data.tags.length) {
      for (const t of data.tags) {
        const span = document.createElement("span");
        span.className = "tag";
        span.textContent = t;
        tagsEl.appendChild(span);
      }
    } else {
      tagsEl.textContent = "—";
    }

    const badgesEl = document.getElementById("detail-badges");
    badgesEl.innerHTML = "";
    const status = data.status || "stable";
    badgesEl.appendChild(makeBadge(status, "status-" + status));
    const tier = data.trust_tier || "unverified";
    badgesEl.appendChild(makeBadge(tier.replace(/-/g, " "), "trust-" + tier));
    if (data.stale) {
      const label = data.stale_after ? "stale (since " + data.stale_after + ")" : "stale";
      badgesEl.appendChild(makeBadge(label, "stale"));
    } else if (data.stale_after) {
      badgesEl.appendChild(makeBadge("stale after " + data.stale_after, "fresh"));
    }

    document.getElementById("detail-generated").textContent = formatActorEvent(data.generated);

    const verifiedEl = document.getElementById("detail-verified");
    const verified = data.verified || [];
    if (verified.length) {
      verifiedEl.textContent = verified.map(formatActorEvent).join("; ");
    } else {
      verifiedEl.textContent = "—";
    }

    const sourcesEl = document.getElementById("detail-sources");
    sourcesEl.innerHTML = "";
    const sources = data.sources || [];
    if (sources.length) {
      const ul = document.createElement("ul");
      ul.className = "sources-list";
      for (const s of sources) {
        const li = document.createElement("li");
        const label = s.title || s.resource || s.id || "source";
        const idPrefix = s.id ? "[" + s.id + "] " : "";
        if (s.resource && /^https?:\\/\\//.test(s.resource)) {
          const a = document.createElement("a");
          a.href = s.resource;
          a.textContent = idPrefix + label;
          a.target = "_blank";
          a.rel = "noopener";
          a.className = "external";
          li.appendChild(a);
        } else {
          li.textContent = s.resource ? idPrefix + label + " (" + s.resource + ")" : idPrefix + label;
        }
        appendSourceBadges(li, s);
        ul.appendChild(li);
      }
      sourcesEl.appendChild(ul);
    } else {
      sourcesEl.textContent = "—";
    }

    const body = bundle.bodies[conceptId] || "";
    const html = renderMarkdownWithOkfFootnotes(body, sources);
    const bodyEl = document.getElementById("detail-body");
    const backBtnLabel = isNo ? "← Tilbake til konsept" : "← Back to concept";
    if (isSourceNode) {
      bodyEl.innerHTML =
        '<div style="margin-bottom:10px"><button type="button" id="viz-source-back-btn" style="cursor:pointer;padding:4px 10px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;font-size:12px;font-weight:600">' +
        backBtnLabel +
        "</button></div>" +
        html;
      const srcBackBtn = document.getElementById("viz-source-back-btn");
      if (srcBackBtn) {
        const targetConcept =
          lastConceptId ||
          data.parentConceptId ||
          (backlinks[conceptId] && backlinks[conceptId][0]) ||
          (bundle.nodes[0] && bundle.nodes[0].data.id);
        srcBackBtn.addEventListener("click", () => {
          if (targetConcept) showDetail(targetConcept);
        });
      }
    } else {
      bodyEl.innerHTML = html;
    }
    rewriteInternalLinks(bodyEl, conceptId);

    const bl = backlinks[conceptId] || [];
    const blSection = document.getElementById("detail-backlinks");
    const blList = document.getElementById("backlinks-list");
    blList.innerHTML = "";
    if (bl.length) {
      blSection.hidden = false;
      for (const src of bl) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.textContent = nodeIndex[src]?.label || src;
        a.dataset.target = src;
        a.addEventListener("click", () => showDetail(src));
        li.appendChild(a);
        const muted = document.createElement("span");
        muted.className = "muted";
        muted.textContent = " (" + src + ")";
        li.appendChild(muted);
        blList.appendChild(li);
      }
    } else {
      blSection.hidden = true;
    }

    cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.0) }, { duration: 200 });
  }

  function makeBadge(text, cls) {
    const span = document.createElement("span");
    span.className = "badge " + cls;
    span.textContent = text;
    return span;
  }

  function formatActorEvent(event) {
    if (!event || !event.by) return "—";
    return event.at ? event.by + " · " + event.at : String(event.by);
  }

  const selectNode = showDetail;

  function rewriteInternalLinks(root, currentConceptId) {
    const sourceNodeByFnId = bundle.sourceNodeByFnId || {};
    const sourceNodeByAnyFnId = bundle.sourceNodeByAnyFnId || {};
    root.querySelectorAll("a[data-fn]").forEach((a) => {
      const fnId = a.getAttribute("data-fn");
      if (!fnId) return;
      a.addEventListener("click", (e) => {
        const srcNodeId =
          (sourceNodeByFnId[currentConceptId] && sourceNodeByFnId[currentConceptId][fnId]) ||
          sourceNodeByAnyFnId[fnId] ||
          "source:" + fnId;
        if (nodeIndex[srcNodeId]) {
          e.preventDefault();
          showDetail(srcNodeId);
        }
      });
    });
    root.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      const target = resolveInternalConceptId(href, currentConceptId);
      if (target && nodeIndex[target]) {
        a.className = "internal";
        a.setAttribute("href", "javascript:void(0)");
        a.addEventListener("click", (e) => {
          e.preventDefault();
          showDetail(target);
        });
        return;
      }
      if (target) {
        a.className = "internal stub-link";
        a.style.color = "#f59e0b";
        a.setAttribute("data-internal-href", href);
        a.setAttribute("href", "javascript:void(0)");
        const linkLabel = (a.textContent || target).trim();
        const backBtnLabel = isNo ? "← Tilbake til konsept" : "← Back to concept";
        const stubHint = isNo
          ? "Dette OKF-konseptet er kryssreferert fra <code>" +
            escapeHtmlAttr(currentConceptId) +
            '</code>. Kjør <code>npm run cli:stage1 -- "' +
            escapeHtmlAttr(linkLabel) +
            '"</code> for å generere og verifisere dette konseptet i kunnskapsbunten.'
          : "This OKF concept is cross-referenced from <code>" +
            escapeHtmlAttr(currentConceptId) +
            '</code>. Run <code>npm run cli:stage1 -- "' +
            escapeHtmlAttr(linkLabel) +
            '"</code> to generate and verify this concept in the knowledge bundle.';
        a.addEventListener("click", (e) => {
          e.preventDefault();
          const titleEl = document.getElementById("detail-title");
          if (titleEl) titleEl.textContent = linkLabel;
          const idEl = document.getElementById("detail-id");
          if (idEl) idEl.textContent = target;
          const bodyEl = document.getElementById("detail-body");
          if (!bodyEl) return;
          bodyEl.innerHTML =
            '<div style="padding:14px;border:1px solid #fde68a;background:#fefce8;border-radius:8px;margin-bottom:12px">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
            '<span class="badge status-draft">Linked Concept (Stub)</span>' +
            '<button type="button" id="viz-stub-back-btn" style="cursor:pointer;padding:4px 10px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;font-size:12px;font-weight:600">' +
            backBtnLabel +
            "</button>" +
            "</div>" +
            "<h2 style='margin:6px 0'>" +
            escapeHtmlAttr(linkLabel) +
            "</h2>" +
            "<p class='muted' style='margin:4px 0'>Concept ID: <code>/" +
            escapeHtmlAttr(target) +
            ".md</code></p>" +
            "<p style='margin:8px 0 0'>" +
            stubHint +
            "</p>" +
            "</div>";
          const backBtn = document.getElementById("viz-stub-back-btn");
          if (backBtn) {
            backBtn.addEventListener("click", () => selectNode(currentConceptId));
          }
        });
        return;
      }
      a.className = "external";
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    });
  }

  const initial =
    bundle.nodes.find((n) => n.data.group === "concept") ||
    bundle.nodes[0];
  if (initial) showDetail(initial.data.id);
})();
`.trim();

function extractLastUrlPathSlug(rawUrl: string): string {
  try {
    const u = new URL(String(rawUrl || '').trim());
    const segs = u.pathname
      .split('/')
      .map((s) => {
        try {
          return decodeURIComponent(s).trim();
        } catch {
          return s.trim();
        }
      })
      .filter(
        (s) =>
          s.length > 1 &&
          !/^(?:index|default)\.(?:html?|aspx?|php)$/i.test(s) &&
          !/^(?:id\d+|\d+|_f|p\d+|no|nb|nn|en|globalassets|contentassets)$/i.test(s)
      );
    if (segs.length === 0) return '';
    return segs[segs.length - 1].replace(/\.(?:pdf|html?|aspx?|php|md|docx?)$/i, '');
  } catch {
    return '';
  }
}

/**
 * Generates a single-file interactive OKF v0.2 knowledge graph explorer (`viz.html`)
 * powered by Cytoscape.js and Marked, with unified `/` and `../` link resolution and trust badges.
 */
export function generateBundleVisualization(
  bundleRoot: string = './workspace/bundle',
  outPath?: string,
  options?: { bundleName?: string }
): {
  concepts: number;
  nodes: number;
  edges: number;
  bytes: number;
  outputPath: string;
} {
  const resolvedRoot = path.resolve(bundleRoot);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`OKF Bundle directory not found: ${resolvedRoot}`);
  }

  const resolvedOutPath = path.resolve(outPath || path.join(resolvedRoot, 'viz.html'));
  const concepts = walkBundleConcepts(resolvedRoot);
  const conceptIds = new Set(concepts.map((c) => c.id));
  const bundleLang = detectIcmLanguage(
    concepts.map((c) => `${c.title || ''} ${c.description || ''} ${c.body || ''}`).join('\n')
  );

  const nodes: Array<{ data: Record<string, unknown> }> = concepts.map((c) => {
    const color = getOkfTypeColor(c.type);
    return {
      data: {
        id: c.id,
        group: 'concept',
        label: c.title || c.id,
        type: c.type,
        description: c.description,
        resource: c.resource,
        tags: c.tags,
        status: c.status,
        generated: c.generated,
        verified: c.verified,
        stale_after: c.stale_after,
        sources: c.sources,
        trust_tier: c.trust_tier,
        stale: c.stale,
        color,
        size: 30 + Math.min(60, Math.floor(c.body.length / 200)),
      },
    };
  });

  const bodies: Record<string, string> = {};
  for (const c of concepts) {
    bodies[c.id] = c.body;
  }

  const edges: Array<{ data: { id: string; source: string; target: string; label?: string } }> = [];
  const seenEdges = new Set<string>();
  const seenNodeIds = new Set<string>(conceptIds);
  const sourceNodeByUrl = new Map<string, string>();
  const sourceNodeDataById = new Map<string, Record<string, unknown>>();
  const sourceNodeByFnId: Record<string, Record<string, string>> = {};
  const sourceNodeByAnyFnId: Record<string, string> = {};

  for (const c of concepts) {
    sourceNodeByFnId[c.id] = sourceNodeByFnId[c.id] || {};
    for (const target of c.links_to) {
      if (target === c.id || !conceptIds.has(target)) continue;
      const key = `${c.id}__${target}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({
        data: {
          id: key,
          source: c.id,
          target,
        },
      });
    }
    for (const src of c.sources || []) {
      const srcId = src.id || src.title || 'ref';
      const srcUrl = String((src as any).url || (src as any).resource || '').trim();
      const canonicalUrl = normalizeCanonicalSourceUrl(srcUrl);
      const decodedTitle = decodeHtmlEntities(String(src.title || srcUrl || srcId)).trim();
      const fullTitleText = enrichBareDomainSourceTitle(decodedTitle, srcUrl) || decodedTitle;
      const shortTitleText =
        fullTitleText.length > 42 ? `${fullTitleText.slice(0, 42).trimEnd()}…` : fullTitleText;
      const refLine =
        bundleLang === 'no'
          ? `- **Referert i konsept:** [/${c.id}.md](/${c.id}.md) (*${c.title || c.id}*)`
          : `- **Referenced in concept:** [/${c.id}.md](/${c.id}.md) (*${c.title || c.id}*)`;

      let srcNodeId = '';
      if (canonicalUrl && sourceNodeByUrl.has(canonicalUrl)) {
        srcNodeId = sourceNodeByUrl.get(canonicalUrl)!;
        const existingNodeData = sourceNodeDataById.get(srcNodeId);
        if (existingNodeData) {
          const curDesc = String(existingNodeData.description || '');
          if (shouldUpgradeSourceTitle(curDesc, fullTitleText, srcUrl)) {
            const primaryFnId = String(existingNodeData.primaryFnId || srcId);
            existingNodeData.description = fullTitleText;
            existingNodeData.fullTitle = `[^${primaryFnId}] ${fullTitleText}`;
            existingNodeData.label = `[^${primaryFnId}] ${shortTitleText}`;
          }
          const citedBy = Array.isArray(existingNodeData.citedByConcepts)
            ? (existingNodeData.citedByConcepts as string[])
            : [];
          if (!citedBy.includes(c.id)) {
            citedBy.push(c.id);
            existingNodeData.citedByConcepts = citedBy;
          }
        }
        if (bodies[srcNodeId] && !bodies[srcNodeId].includes(refLine)) {
          bodies[srcNodeId] = `${bodies[srcNodeId]}\n${refLine}`;
        }
      } else {
        let candidateNodeId = `source:${srcId}`;
        let suffix = 2;
        while (seenNodeIds.has(candidateNodeId)) {
          candidateNodeId = `source:${srcId}--${suffix}`;
          suffix++;
        }
        srcNodeId = candidateNodeId;
        seenNodeIds.add(srcNodeId);
        if (canonicalUrl) {
          sourceNodeByUrl.set(canonicalUrl, srcNodeId);
        }
        const displayFnId = srcNodeId.replace(/^source:/, '');
        let effectiveFullTitle = fullTitleText;
        let effectiveShortTitle = shortTitleText;
        if (displayFnId !== srcId) {
          const firstNodeData = sourceNodeDataById.get(`source:${srcId}`);
          const firstBaseTitle = String(
            firstNodeData?.baseTitle || firstNodeData?.description || ''
          ).trim();
          if (firstBaseTitle && firstBaseTitle.toLowerCase() === fullTitleText.toLowerCase()) {
            const pathSlug = extractLastUrlPathSlug(srcUrl);
            if (pathSlug) {
              effectiveFullTitle = `${fullTitleText} (${pathSlug})`;
              effectiveShortTitle = `${shortTitleText} (${pathSlug})`;
            }
          }
        }
        const nodeData: Record<string, unknown> = {
          id: srcNodeId,
          group: 'source',
          primaryFnId: displayFnId,
          baseTitle: fullTitleText,
          label: `[^${displayFnId}] ${effectiveShortTitle}`,
          fullTitle: `[^${displayFnId}] ${effectiveFullTitle}`,
          parentConceptId: c.id,
          citedByConcepts: [c.id],
          type: 'Verified Source',
          description: effectiveFullTitle,
          resource: srcUrl,
          tags: ['verified-source'],
          status: 'stable',
          generated: c.generated,
          verified: c.verified,
          sources: [{ ...src, id: displayFnId, title: effectiveFullTitle }],
          trust_tier: c.trust_tier,
          stale: false,
          color: '#10b981',
          size: 24,
        };
        sourceNodeDataById.set(srcNodeId, nodeData);
        nodes.push({ data: nodeData });
        bodies[srcNodeId] = [
          src.retrieved_at
            ? bundleLang === 'no'
              ? `- **Hentet (\`retrieved_at\`):** \`${src.retrieved_at}\``
              : `- **Retrieved (\`retrieved_at\`):** \`${src.retrieved_at}\``
            : '',
          src.last_modified
            ? bundleLang === 'no'
              ? `- **Sist endret (\`last_modified\`):** \`${src.last_modified}\``
              : `- **Last modified (\`last_modified\`):** \`${src.last_modified}\``
            : '',
          refLine,
        ]
          .filter(Boolean)
          .join('\n');
      }

      sourceNodeByFnId[c.id][srcId] = srcNodeId;
      if (!sourceNodeByAnyFnId[srcId]) {
        sourceNodeByAnyFnId[srcId] = srcNodeId;
      }

      const edgeKey = `${c.id}__${srcNodeId}`;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({
          data: {
            id: edgeKey,
            source: c.id,
            target: srcNodeId,
            label: 'cites',
          },
        });
      }
    }
  }

  const types = Array.from(new Set(nodes.map((n) => String(n.data.type || '')))).sort((a, b) =>
    a.localeCompare(b)
  );
  const resolvedPalette: Record<string, string> = {
    ...OKF_TYPE_PALETTE,
    'Verified Source': '#10b981',
  };
  for (const t of types) {
    if (!resolvedPalette[t]) {
      resolvedPalette[t] = getOkfTypeColor(t);
    }
  }

  const graphData = {
    lang: bundleLang,
    nodes,
    edges,
    bodies,
    types,
    palette: resolvedPalette,
    sourceNodeByFnId,
    sourceNodeByAnyFnId,
  };

  const bundleName = options?.bundleName || path.basename(resolvedRoot);

  const html = `<!DOCTYPE html>
<html lang="${bundleLang}">
<head>
<meta charset="utf-8">
<title>OKF Bundle Viewer</title>
<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.28.1/dist/cytoscape.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
<style>
${OKF_VIZ_CSS}
</style>
</head>
<body>
<header>
  <div class="title">
    <strong id="bundle-name"></strong>
    <span class="muted">OKF v0.2 bundle</span>
  </div>
  <div class="controls">
    <input id="search" type="search" placeholder="Search title / id / tag">
    <select id="filter-type">
      <option value="">All types</option>
    </select>
    <select id="layout">
      <option value="cose">cose (force)</option>
      <option value="concentric">concentric</option>
      <option value="breadthfirst">breadth-first</option>
      <option value="circle">circle</option>
      <option value="grid">grid</option>
    </select>
    <button id="reset">Reset view</button>
  </div>
</header>

<main>
  <section id="graph"></section>
  <section id="detail">
    <div id="detail-empty" class="muted">Click a node to see its details.</div>
    <article id="detail-content" hidden>
      <header class="detail-header">
        <span class="type-chip" id="detail-type"></span>
        <h1 id="detail-title"></h1>
        <div class="muted" id="detail-id"></div>
      </header>
      <div class="badges" id="detail-badges"></div>
      <dl class="frontmatter">
        <dt>Description</dt><dd id="detail-description"></dd>
        <dt>Resource</dt><dd id="detail-resource"></dd>
        <dt>Tags</dt><dd id="detail-tags"></dd>
        <dt>Generated</dt><dd id="detail-generated"></dd>
        <dt>Verified</dt><dd id="detail-verified"></dd>
        <dt>Sources</dt><dd id="detail-sources"></dd>
      </dl>
      <hr>
      <div id="detail-body"></div>
      <section id="detail-backlinks" hidden>
        <h2>Cited by</h2>
        <ul id="backlinks-list"></ul>
      </section>
    </article>
  </section>
</main>

<script>
window.BUNDLE_NAME = ${JSON.stringify(bundleName).replace(/<\//g, '<\\/')};
window.BUNDLE = ${JSON.stringify(graphData).replace(/<\//g, '<\\/')};
</script>
<script>
${OKF_VIZ_JS}
</script>
</body>
</html>
`;

  fs.mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
  fs.writeFileSync(resolvedOutPath, html, 'utf-8');

  return {
    concepts: concepts.length,
    nodes: nodes.length,
    edges: edges.length,
    bytes: Buffer.byteLength(html, 'utf-8'),
    outputPath: resolvedOutPath,
  };
}

// ============================================================================
// 3.9 A2UI v0.9.1 Catalog + Surface Compiler & Bi-Directional Studio Renderer
// ============================================================================

export const A2UI_PROTOCOL_VERSION = 'v0.9.1';
export const A2UI_BASIC_CATALOG_ID =
  'https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json';
export const A2UI_ICM_CATALOG_ID =
  'https://a2ui.org/specification/v0_9_1/catalogs/icm-okf-v0.2/catalog.json';

export type A2uiDynamicValue<T = unknown> =
  | T
  | { path: string }
  | { call: string; args?: Record<string, unknown>; returnType?: string };

export type A2uiChildList = string[] | { path: string; componentId: string };

export interface A2uiComponent {
  id: string;
  component: string;
  weight?: number;
  accessibility?: {
    label?: A2uiDynamicValue<string>;
    description?: A2uiDynamicValue<string>;
  };
  [key: string]: unknown;
}

export interface A2uiCreateSurfaceMessage {
  version: typeof A2UI_PROTOCOL_VERSION;
  createSurface: {
    surfaceId: string;
    catalogId: string;
    theme?: {
      primaryColor?: string;
      iconUrl?: string;
      agentDisplayName?: string;
    };
    sendDataModel?: boolean;
  };
}

export interface A2uiUpdateComponentsMessage {
  version: typeof A2UI_PROTOCOL_VERSION;
  updateComponents: {
    surfaceId: string;
    components: A2uiComponent[];
  };
}

export interface A2uiUpdateDataModelMessage {
  version: typeof A2UI_PROTOCOL_VERSION;
  updateDataModel: {
    surfaceId: string;
    path?: string;
    value?: unknown;
  };
}

export interface A2uiDeleteSurfaceMessage {
  version: typeof A2UI_PROTOCOL_VERSION;
  deleteSurface: {
    surfaceId: string;
  };
}

export type A2uiEnvelopeMessage =
  | A2uiCreateSurfaceMessage
  | A2uiUpdateComponentsMessage
  | A2uiUpdateDataModelMessage
  | A2uiDeleteSurfaceMessage;

export interface A2uiChecklistItem {
  id: string;
  label: string;
  checked: boolean;
  category?: string;
}

export interface A2uiChecklistGroup {
  id: string;
  title: string;
  items: A2uiChecklistItem[];
}

export interface A2uiSurfaceGenerationOptions {
  workspaceRoot?: string;
  bundleRoot?: string;
  runId?: string;
  surfaceId?: string;
  outputHtmlPath?: string;
  mirrorBundleHtml?: boolean;
  outputDir?: string;
  artifactDir?: string;
  openBrowser?: boolean;
  enablePingPong?: boolean;
}

export interface A2uiBundleRunEntry {
  runId: string;
  conceptId: string;
  title: string;
  shortLabel: string;
  isStage1Only?: boolean;
  status: string;
  trustTier: string;
  isStale: boolean;
  sourcesCount: number;
  checklistCount: number;
  checklistItemCount: number;
  moduleCount: number;
  caseCount: number;
  quizCount: number;
  tabTitles: Record<string, string>;
  tabs?: Array<{ title: string; child: string }>;
  dataModel: Record<string, any>;
}

export interface A2uiSurfaceGenerationResult {
  runId: string;
  surfaceId: string;
  catalogId: string;
  isStage1Only?: boolean;
  componentCount: number;
  tabCount: number;
  checklistItemCount: number;
  moduleCount: number;
  quizCount: number;
  caseCount: number;
  conceptCount: number;
  surfaceJsonPath: string;
  surfaceJsonlPath: string;
  htmlOutputPath: string;
  bundleHtmlPath?: string;
  bundleVizPath?: string;
  artifactHtmlPath?: string;
  artifactVizPath?: string;
  browserOpened?: boolean;
  messages: A2uiEnvelopeMessage[];
  bundleRuns?: A2uiBundleRunEntry[];
}

/**
 * Opens a generated HTML file (`a2ui.html` or `viz.html`) in the system browser
 * (`Start-Process` / `cmd /c start` on Windows, `open` on macOS, `xdg-open` on Linux).
 * Suppressed automatically during `--test` and `CI=true`.
 */
export function openFileInSystemBrowser(filePath: string): boolean {
  if (!filePath || !fs.existsSync(filePath)) return false;
  if (process.argv.includes('--test') || process.env.CI === 'true') return false;
  try {
    const absPath = path.resolve(filePath);
    if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/c', 'start', '""', absPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [absPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } else {
      const child = spawn('xdg-open', [absPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies `a2ui.html` and `viz.html` into an Antigravity 2.0 conversation Artifact Directory
 * (`<appDataDir>/brain/<conversation-id>/`) along with `.metadata.json` descriptors so the
 * HTML Auxiliary Pane can render the live interactive studio without reading/echoing ~500 KB of HTML.
 */
export function syncA2uiToArtifactDir(input: {
  artifactDir?: string;
  htmlOutputPath: string;
  bundleVizPath?: string;
  runId?: string;
  title?: string;
  isStage1Only?: boolean;
}): { artifactHtmlPath?: string; artifactVizPath?: string } {
  const rawDir = (input.artifactDir || process.env.AGY_ARTIFACT_DIR || '').trim();
  if (!rawDir) return {};
  try {
    const resolvedDir = path.resolve(rawDir);
    fs.mkdirSync(resolvedDir, { recursive: true });
    let artifactHtmlPath: string | undefined;
    let artifactVizPath: string | undefined;
    const nowIso = new Date().toISOString();
    const labelTitle = input.title || input.runId || 'ICM Run';
    const stageDesc = input.isStage1Only
      ? 'Stage 1 Intermission OKF v0.2 Source Curation & Review Studio'
      : 'Full Stage 1 + Stage 2 A2UI v0.9.1 Interactive Surface Studio';

    if (input.htmlOutputPath && fs.existsSync(input.htmlOutputPath)) {
      artifactHtmlPath = path.join(resolvedDir, 'a2ui_studio.html');
      fs.copyFileSync(input.htmlOutputPath, artifactHtmlPath);
      fs.writeFileSync(
        `${artifactHtmlPath}.metadata.json`,
        JSON.stringify(
          {
            summary: `${labelTitle} — ${stageDesc} (run: ${input.runId || 'workspace'}).`,
            updatedAt: nowIso,
            userFacing: true,
          },
          null,
          2
        ),
        'utf-8'
      );
    }

    if (input.bundleVizPath && fs.existsSync(input.bundleVizPath)) {
      artifactVizPath = path.join(resolvedDir, 'okf_viz_studio.html');
      fs.copyFileSync(input.bundleVizPath, artifactVizPath);
      fs.writeFileSync(
        `${artifactVizPath}.metadata.json`,
        JSON.stringify(
          {
            summary: `${labelTitle} — OKF v0.2 Interactive Knowledge Graph & Provenance Explorer (run: ${input.runId || 'workspace'}).`,
            updatedAt: nowIso,
            userFacing: true,
          },
          null,
          2
        ),
        'utf-8'
      );
    }

    return { artifactHtmlPath, artifactVizPath };
  } catch {
    return {};
  }
}

export const A2UI_PING_PONG_DEFAULT_PORT = 44820;

/**
 * Detects whether the user has Antigravity 2.0 installed with `/browser` capabilities
 * (`~/.gemini/antigravity/browser_recordings`, `~/.gemini/antigravity/html_artifacts`, or
 * `~/.gemini/config/plugins/chrome-devtools-plugin` alongside `~/.gemini/antigravity/brain`).
 * Can also be explicitly overridden via `options.enablePingPong` or `AGY_PING_PONG=1|0`.
 */
export function hasAntigravityBrowserCapability(options?: {
  artifactDir?: string;
  enablePingPong?: boolean;
  homeDir?: string;
}): boolean {
  if (options?.enablePingPong === false || process.env.AGY_PING_PONG === '0') {
    return false;
  }
  if (
    options?.enablePingPong === true ||
    process.env.AGY_PING_PONG === '1' ||
    process.argv.includes('--ping-pong')
  ) {
    return true;
  }
  try {
    const baseHome = options?.homeDir || os.homedir();
    if (!baseHome) return false;
    const agyDir = path.join(baseHome, '.gemini', 'antigravity');
    const brainDir = path.join(agyDir, 'brain');
    if (!fs.existsSync(agyDir) || !fs.existsSync(brainDir)) {
      return false;
    }
    const browserRecordingsDir = path.join(agyDir, 'browser_recordings');
    const htmlArtifactsDir = path.join(agyDir, 'html_artifacts');
    const chromeDevtoolsPluginDir = path.join(
      baseHome,
      '.gemini',
      'config',
      'plugins',
      'chrome-devtools-plugin'
    );
    return (
      fs.existsSync(browserRecordingsDir) ||
      fs.existsSync(htmlArtifactsDir) ||
      fs.existsSync(chromeDevtoolsPluginDir)
    );
  } catch {
    return false;
  }
}

/**
 * Starts a zero-dependency one-shot HTTP loopback listener (`127.0.0.1:44820` by default)
 * for Antigravity 2.0's Reactive Wakeup ("Ping-Pong") workflow.
 * Only activates if Antigravity 2.0 with `/browser` capability is installed (or `force: true` in tests).
 * When the user clicks `🚀 Godkjenn & Send til AGY` in `a2ui.html` / `a2ui_studio.html`, the listener
 * receives the JSON curation payload, logs it to stdout, closes the server, and resolves so the
 * background CLI process exits `0` and wakes up the active Antigravity 2.0 chat.
 */
export function startA2uiPingPongListener(options?: {
  port?: number;
  workspaceRoot?: string;
  runId?: string;
  htmlPath?: string;
  force?: boolean;
}): Promise<{
  skipped?: boolean;
  port: number;
  payload: Record<string, any>;
}> {
  if (
    !options?.force &&
    !hasAntigravityBrowserCapability({ enablePingPong: options?.force })
  ) {
    console.log(
      '[A2UI Ping-Pong]: Skipped (Antigravity 2.0 /browser capability not detected on this system).'
    );
    return Promise.resolve({ skipped: true, port: 0, payload: {} });
  }

  const requestedPort =
    options?.port !== undefined ? options.port : A2UI_PING_PONG_DEFAULT_PORT;
  const workspaceRoot = path.resolve(options?.workspaceRoot || './workspace');
  let resolvedHtmlPath = options?.htmlPath ? path.resolve(options.htmlPath) : '';
  if (!resolvedHtmlPath && options?.runId) {
    const candidate = path.join(workspaceRoot, 'runs', options.runId, 'a2ui.html');
    if (fs.existsSync(candidate)) resolvedHtmlPath = candidate;
  }
  if (!resolvedHtmlPath) {
    const bundleHtml = path.join(workspaceRoot, 'bundle', 'a2ui.html');
    if (fs.existsSync(bundleHtml)) resolvedHtmlPath = bundleHtml;
  }

  return new Promise((resolve, reject) => {
    let handled = false;
    let retriedSupersede = false;
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const actualAddress = server.address();
      const boundPort =
        typeof actualAddress === 'object' && actualAddress
          ? actualAddress.port
          : requestedPort;
      const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);

      if (parsedUrl.pathname === '/' && req.method === 'GET') {
        if (resolvedHtmlPath && fs.existsSync(resolvedHtmlPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(fs.readFileSync(resolvedHtmlPath, 'utf-8'));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'waiting_for_ping_pong', port: boundPort }));
        }
        return;
      }

      if (parsedUrl.pathname === '/supersede') {
        handled = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, superseded: true }));
        console.log(
          `[A2UI Ping-Pong]: Port ${boundPort} superseded by a newer Ping-Pong listener; closing stale listener.`
        );
        server.close(() => {
          resolve({ skipped: true, port: boundPort, payload: { superseded: true } });
        });
        return;
      }

      if (parsedUrl.pathname === '/ping-pong') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString('utf-8');
        });
        req.on('end', () => {
          if (handled) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, duplicate: true }));
            return;
          }
          handled = true;
          const rawPayload = parsedUrl.searchParams.get('payload') || body || '{}';
          let parsed: Record<string, any> = {};
          try {
            parsed = JSON.parse(rawPayload);
          } catch {
            parsed = { raw: rawPayload };
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, received: parsed }));

          console.log('\n=== [AGY PING-PONG REACTIVE WAKEUP TRIGGERED] ===');
          console.log(JSON.stringify(parsed, null, 2));
          server.close(() => {
            resolve({ port: boundPort, payload: parsed });
          });
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    const onListenReady = () => {
      const addr = server.address();
      const boundPort =
        typeof addr === 'object' && addr ? addr.port : requestedPort;
      console.log(
        `[A2UI Ping-Pong Listener]: Waiting for button click on http://127.0.0.1:${boundPort}/ping-pong ...`
      );
    };

    server.on('error', (err: any) => {
      if (err?.code === 'EADDRINUSE' && requestedPort !== 0) {
        if (!retriedSupersede) {
          retriedSupersede = true;
          const supReq = http.request(
            {
              hostname: '127.0.0.1',
              port: requestedPort,
              path: '/supersede',
              method: 'POST',
              timeout: 500,
            },
            (supRes) => {
              supRes.resume();
              supRes.on('end', () => {
                setTimeout(() => server.listen(requestedPort, '127.0.0.1', onListenReady), 120);
              });
            }
          );
          supReq.on('error', () => {
            console.log(
              `[A2UI Ping-Pong]: Port ${requestedPort} is already active; reusing existing listener.`
            );
            resolve({ skipped: true, port: requestedPort, payload: {} });
          });
          supReq.end();
          return;
        }
        console.log(
          `[A2UI Ping-Pong]: Port ${requestedPort} is already active; reusing existing listener.`
        );
        resolve({ skipped: true, port: requestedPort, payload: {} });
        return;
      }
      reject(err);
    });

    server.listen(requestedPort, '127.0.0.1', onListenReady);
  });
}

/**
 * Two-Tier A2UI Catalog Schema combining Tier 1 (A2UI v0.9.1 Basic Catalog Primitives)
 * and Tier 2 (ICM + OKF v0.2 Domain Custom Components).
 */
export const A2UI_ICM_CATALOG_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: A2UI_ICM_CATALOG_ID,
  catalogId: A2UI_ICM_CATALOG_ID,
  extendsCatalogId: A2UI_BASIC_CATALOG_ID,
  version: A2UI_PROTOCOL_VERSION,
  title: 'ICM + OKF v0.2 Two-Tier A2UI Component Catalog',
  tier1BasicComponents: [
    'Text',
    'Image',
    'Icon',
    'Video',
    'AudioPlayer',
    'Row',
    'Column',
    'List',
    'Card',
    'Tabs',
    'Divider',
    'Modal',
    'Button',
    'CheckBox',
    'TextField',
    'DateTimeInput',
    'ChoicePicker',
    'Slider',
    'Badge',
  ],
  tier2DomainComponents: {
    OkfMarkdown: {
      description:
        'Renders OKF v0.2 Markdown with clickable [^id] footnotes, retrieved_at & last_modified source badges, trust-tier & staleness headers, Layer 4 raw Markdown editor, and internal /research/*.md concept navigation.',
      properties: ['title', 'body', 'frontmatter', 'sources', 'trustTier', 'isStale', 'editablePath'],
    },
    OkfKnowledgeGraph: {
      description:
        'Embeds the interactive Cytoscape.js OKF Knowledge Graph (viz.html engine) directly inside an A2UI tab.',
      properties: ['title', 'bundlePath'],
    },
    InteractiveChecklist: {
      description:
        'Renders extracted Markdown checklists (- [ ] ...) with nested category headers, [^id]/LaTeX stripping, and reactive CheckBox completion progress bound two-way to the A2UI data model.',
      properties: ['title', 'subtitle', 'groupsPath'],
    },
    ModuleCarousel: {
      description:
        'Renders Stage 2 trainingModules, lessons, modules, or slides with step-by-step navigation, regulatory/concept metadata, slide cues, action items, and Web Speech TTS narration.',
      properties: ['title', 'modulesPath', 'activeIndexPath'],
    },
    QuizRunner: {
      description:
        'Interactive assessment runner bound to Stage 2 quiz items or lesson quiz questions with ChoicePicker selection, explanation feedback, and live score calculation.',
      properties: ['title', 'questionsPath', 'answersPath'],
    },
    CaseSimulator: {
      description:
        'Interactive scenario & board action simulator bound to Stage 2 cases or trainingModule action items with editable response notes and model resolution reveal.',
      properties: ['title', 'casesPath', 'responsesPath'],
    },
  },
} as const;

function escapeA2uiHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Determines whether a `$...$` candidate inner substring is genuine inline LaTeX math
 * rather than a pair of currency `$` signs or a span crossing Markdown table pipes / footnotes.
 */
export function isInlineLatexMathSpan(inner: string): boolean {
  if (!inner || typeof inner !== 'string') return false;
  if (/^\s|\s$/.test(inner)) return false;
  if (/[\r\n|]/.test(inner)) return false;
  if (inner.includes('[^')) return false;
  if (/\*\*|__/.test(inner)) return false;
  if (/(?:^|[^\\])~$/.test(inner)) return false;
  if (/^[A-Z]{1,5}\/[A-Z]{1,5}$/.test(inner)) return true;
  if (/^[a-zA-Z]$/.test(inner)) return true;
  if (/^\d+\.\d{3,}$/.test(inner)) return true;
  if (/^[a-zA-Z](?:_[a-zA-Z0-9]+)?\s*(?:=|<|>|<=|>=|≈|~|±)\s*[+-]?\d+(?:[.,]\d+)?%?$/.test(inner)) return true;
  if (
    /^\d[\d,.]*(?:\s*(?:[BMKTbmkt](?![\^_])\b|billion|million|trillion|thousand|bn\b|mn\b|\/(?![a-zA-Z0-9_()]*[\^_\\])|\s+(?:per|to|and|or|in|at|for|from|of|vs)\b|-|–|—|\)|\s*$))/i.test(
      inner
    )
  ) {
    return false;
  }
  if (
    !/(?:\\[a-zA-Z !,;:%$&_#]|[A-Za-z0-9)\]}][\^_](?:\{[^{}\r\n]+\}|[A-Za-z0-9+\-°]))/.test(inner)
  ) {
    return false;
  }
  if (/^\d/.test(inner)) {
    if (
      !/^\d+(?:[.,]\d+)*(?:\s*[+\-*/]?\s*(?:\\|[\^_])|\s+[a-zA-Z]{1,4}[\^_]|\s*[*/]\s*[a-zA-Z0-9()]+\s*[\^_])/.test(
        inner
      ) &&
      !/^0\.\d{3,}$/.test(inner)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Safely scans a string for inline `$...$` and display `$$...$$` LaTeX math spans without allowing a rejected currency `$`
 * earlier on a line to consume the opening `$` of a valid inline math span later on the same line,
 * and never matching across Markdown table pipes (`|`) or line breaks.
 */
export function replaceInlineLatexSpansTs(
  str: string,
  replacer: (fullMatch: string, inner: string) => string
): string {
  const s = String(str || '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && s[i + 1] === '$') {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch !== '$') {
      out += ch;
      i++;
      continue;
    }
    if (i + 1 < s.length && s[i + 1] === '$') {
      let j = i + 2;
      while (j + 1 < s.length) {
        if (s[j] === '\\' && j + 1 < s.length) {
          j += 2;
          continue;
        }
        if (s[j] === '$' && s[j + 1] === '$') {
          break;
        }
        if (s[j] === '|' || (s[j] === '\n' && /^\r?\n\s*\r?\n/.test(s.slice(j)))) {
          break;
        }
        j++;
      }
      if (j + 1 < s.length && s[j] === '$' && s[j + 1] === '$') {
        const innerDisp = s.slice(i + 2, j).replace(/\s+/g, ' ').trim();
        if (isInlineLatexMathSpan(innerDisp)) {
          out += replacer(s.slice(i, j + 2), innerDisp);
          i = j + 2;
          continue;
        }
      }
    }
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === '\\' && j + 1 < s.length) {
        j += 2;
        continue;
      }
      if (s[j] === '$' || s[j] === '\n' || s[j] === '\r' || s[j] === '|') {
        break;
      }
      j++;
    }
    if (j < s.length && s[j] === '$') {
      const inner = s.slice(i + 1, j);
      if (isInlineLatexMathSpan(inner)) {
        out += replacer(s.slice(i, j + 1), inner);
        i = j + 1;
        continue;
      }
    }
    out += '$';
    i++;
  }
  return out;
}

/**
 * Strips OKF footnote markers (`[^id]`), inline LaTeX math (`$\text{EI } 60$`, `$30 \text{ min}$`, `$\rightarrow$`),
 * and excess Markdown formatting from extracted checklist items for clean UI labels while preserving currency `$`.
 */
export function cleanChecklistLabel(rawText: string): string {
  const supMap: Record<string, string> = {
    '0': '⁰',
    '1': '¹',
    '2': '²',
    '3': '³',
    '4': '⁴',
    '5': '⁵',
    '6': '⁶',
    '7': '⁷',
    '8': '⁸',
    '9': '⁹',
    '+': '⁺',
    '-': '⁻',
    '=': '⁼',
    '(': '⁽',
    ')': '⁾',
    a: 'ᵃ',
    b: 'ᵇ',
    c: 'ᶜ',
    d: 'ᵈ',
    e: 'ᵉ',
    f: 'ᶠ',
    g: 'ᵍ',
    h: 'ʰ',
    i: 'ⁱ',
    j: 'ʲ',
    k: 'ᵏ',
    l: 'ˡ',
    m: 'ᵐ',
    n: 'ⁿ',
    o: 'ᵒ',
    p: 'ᵖ',
    r: 'ʳ',
    s: 'ˢ',
    t: 'ᵗ',
    u: 'ᵘ',
    v: 'ᵛ',
    w: 'ʷ',
    x: 'ˣ',
    y: 'ʸ',
    z: 'ᶻ',
  };
  const subMap: Record<string, string> = {
    '0': '₀',
    '1': '₁',
    '2': '₂',
    '3': '₃',
    '4': '₄',
    '5': '₅',
    '6': '₆',
    '7': '₇',
    '8': '₈',
    '9': '₉',
    '+': '₊',
    '-': '₋',
    '=': '₌',
    '(': '₍',
    ')': '₎',
    a: 'ₐ',
    e: 'ₑ',
    h: 'ₕ',
    i: 'ᵢ',
    j: 'ⱼ',
    k: 'ₖ',
    l: 'ₗ',
    m: 'ₘ',
    n: 'ₙ',
    o: 'ₒ',
    p: 'ₚ',
    r: 'ᵣ',
    s: 'ₛ',
    t: 'ₜ',
    u: 'ᵤ',
    v: 'ᵥ',
    x: 'ₓ',
  };
  const cleanLatexFragment = (frag: string, isInsideMathSpan: boolean): string => {
    let out = String(frag || '')
      .replace(/\\(?:left|right)\s*([()[\]|.])?/g, '$1')
      .replace(/\\mathcal\{R\}/g, 'ℛ')
      .replace(/\\mathcal\{([A-Za-z0-9]+)\}/g, '$1')
      .replace(/\\(?:[,;:]|\s+|quad\b|qquad\b)/g, ' ')
      .replace(/\\!/g, '')
      .replace(/\\sim(?![a-zA-Z])/g, '~')
      .replace(/\\leftrightarrow/g, '↔')
      .replace(/\\Leftrightarrow|\\iff(?![a-zA-Z])/g, '⇔')
      .replace(/\\rightarrow|\\to(?![a-zA-Z])/g, '→')
      .replace(/\\Rightarrow|\\implies(?![a-zA-Z])/g, '⇒')
      .replace(/\\leftarrow/g, '←')
      .replace(/\\Leftarrow/g, '⇐')
      .replace(/\\(?:ge|geq)(?![a-zA-Z])/g, '≥')
      .replace(/\\(?:le|leq)(?![a-zA-Z])/g, '≤')
      .replace(/\\(?:neq|ne)(?![a-zA-Z])/g, '≠')
      .replace(/\\approx(?![a-zA-Z])/g, '≈')
      .replace(/\\times(?![a-zA-Z])/g, '×')
      .replace(/\\div(?![a-zA-Z])/g, '÷')
      .replace(/\\pm(?![a-zA-Z])/g, '±')
      .replace(/\\cdot(?![a-zA-Z])/g, '·')
      .replace(/\\(?:dots|ldots|cdots)(?![a-zA-Z])/g, '…')
      .replace(/\\infty(?![a-zA-Z])/g, '∞')
      .replace(/\\sum(?![a-zA-Z])/g, '∑')
      .replace(/\\prod(?![a-zA-Z])/g, '∏')
      .replace(/\\int(?![a-zA-Z])/g, '∫')
      .replace(/\\partial(?![a-zA-Z])/g, '∂')
      .replace(/\\nabla(?![a-zA-Z])/g, '∇')
      .replace(/\\propto(?![a-zA-Z])/g, '∝')
      .replace(/\\perp(?![a-zA-Z])/g, '⊥')
      .replace(/\\parallel(?![a-zA-Z])/g, '∥')
      .replace(/\\Delta\s+([a-zA-Z])(?![a-zA-Z])/g, 'Δ$1')
      .replace(/\\Delta(?![a-zA-Z])/g, 'Δ')
      .replace(/\\delta(?![a-zA-Z])/g, 'δ')
      .replace(/\\mu(?![a-zA-Z])/g, 'μ')
      .replace(/\\Omega(?![a-zA-Z])/g, 'Ω')
      .replace(/\\omega(?![a-zA-Z])/g, 'ω')
      .replace(/\\alpha(?![a-zA-Z])/g, 'α')
      .replace(/\\beta(?![a-zA-Z])/g, 'β')
      .replace(/\\gamma(?![a-zA-Z])/g, 'γ')
      .replace(/\\lambda(?![a-zA-Z])/g, 'λ')
      .replace(/\\pi(?![a-zA-Z])/g, 'π')
      .replace(/\\sigma(?![a-zA-Z])/g, 'σ')
      .replace(/\\rho(?![a-zA-Z])/g, 'ρ')
      .replace(/\\theta(?![a-zA-Z])/g, 'θ')
      .replace(/\\tau(?![a-zA-Z])/g, 'τ')
      .replace(/\\phi(?![a-zA-Z])|\\varphi(?![a-zA-Z])/g, 'φ')
      .replace(/\\eta(?![a-zA-Z])/g, 'η')
      .replace(/\\kappa(?![a-zA-Z])/g, 'κ')
      .replace(/\\epsilon(?![a-zA-Z])|\\varepsilon(?![a-zA-Z])/g, 'ε')
      .replace(/\\(?:ln|exp|log|sin|cos|tan|min|max|lim|sup|inf)(?![a-zA-Z])/g, (m) => m.slice(1))
      .replace(/\\(?:circ|degree)(?![a-z])/g, '°')
      .replace(/\\([$&%_#])/g, '$1');
    for (let pass = 0; pass < 3; pass++) {
      out = out
        .replace(/\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\{([^{}]*)\}/g, '$1')
        .replace(/\\(?:xrightleftharpoons|rightleftharpoons)(?:\[[^\]]*\])?(?:\{[^{}]*\})?/g, '⇌')
        .replace(/\\(?:xrightarrow|xleftarrow)(?:\[[^\]]*\])?(?:\{[^{}]*\})?/g, '→')
        .replace(/\\sqrt\{\s*([^{}]+?)\s*\}/g, '√($1)')
        .replace(/\\(?:overline|hat|bar|tilde|vec)\{\s*([^{}]+?)\s*\}/g, '$1')
        .replace(/\^\{\s*(?:°|o)\s*([CFK])?\s*\}|\^°/g, '°$1')
        .replace(
          /\^\{\s*([0-9+\-=()a-pr-z]+)\s*\}|\^([0-9+\-a-pr-z])(?![a-zA-Z0-9])/g,
          (_m, b: string, s: string) =>
            String(b || s).replace(/[0-9+\-=()a-pr-z]/g, (d) => supMap[d] || d)
        )
        .replace(/_\{\s*([+-]?[0-9]+|[+-=()]+)\s*\}/g, (_m, b: string) =>
          String(b).replace(/[0-9+\-=()]/g, (d) => subMap[d] || d)
        );
      if (isInsideMathSpan) {
        out = out
          .replace(/~/g, ' ')
          .replace(/_([+-]?[0-9])(?![0-9])/g, (_sub, s: string) =>
            String(s).replace(/[0-9+-]/g, (d) => subMap[d] || d)
          )
          .replace(
            /_\{\s*([aehijklmnoprstuvx]+)\s*\}|_([aehijklmnoprstuvx])(?![a-zA-Z0-9])/g,
            (_m, b: string, s: string) =>
              String(b || s).replace(/[aehijklmnoprstuvx]/g, (d) => subMap[d] || d)
          )
          .replace(/_\{\s*([^{}]+?)\s*\}/g, '_$1')
          .replace(/\^\{\s*([^{}]+?)\s*\}/g, '^$1');
      }
      out = out.replace(/\\frac\{\s*([^{}]+?)\s*\}\{\s*([^{}]+?)\s*\}/g, '$1/$2');
    }
    return out.replace(/\\([{}])/g, '$1');
  };

  let text = String(rawText || '').trim();
  // Remove footnote references like [^lovdata-brann], [^1] while preserving word boundaries
  text = stripFootnotesPreservingWordBoundaries(text);
  // Process inline TeX math spans $...$ / $$...$$ safely without consuming currency $ pairs
  text = replaceInlineLatexSpansTs(text, (_m, inner: string) =>
    cleanLatexFragment(inner, true).trim()
  );
  // Clean any remaining bare LaTeX macros/superscripts outside $...$
  text = cleanLatexFragment(text, false);
  // Convert bare chemical/classification subscripts outside $...$ (e.g. CO_2, H_2O, O_2, NO_x, A_2) while preserving sone_2
  text = text.replace(
    /\b(CO|H|O|N|SO|NO|CH|A|B|R|EI|REI)_([0-9]|x)(?![a-zA-Z0-9])/g,
    (_m, prefix: string, s: string) => `${prefix}${subMap[s] || s}`
  );
  // Convert markdown links [label](url) -> label
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Strip inline code backticks, bold-italic, bold, and italic markers without stripping spaced multiplication asterisks (e.g. "2 * 3 * 4")
  text = text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*\*(?!\s)([^*]*?\S)\*\*\*/g, '$1')
    .replace(/\*\*(?!\s)([^*]*?\S)\*\*/g, '$1')
    .replace(/\*(?!\s)([^*]*?\S)\*/g, '$1');
  // Normalize whitespace and trailing punctuation spacing
  text = text.replace(/\s+/g, ' ').replace(/\s+([.,;:?!])/g, '$1').trim();
  return text;
}

/**
 * Extracts structured checklist groups and items (`- [ ] ...` or `- [x] ...`) from OKF Markdown,
 * supporting Markdown headings (`### ...`), nested category bullets (`- [ ] **Category**:`),
 * and multi-level (2-level / 3-level+) hierarchical task lists.
 */
export function extractChecklistGroupsFromMarkdown(rawMarkdown: string): A2uiChecklistGroup[] {
  const isNo = detectIcmLanguage(rawMarkdown) === 'no';
  const defaultHeading = isNo ? 'Sjekkliste / Action Items' : 'Checklist / Action Items';
  const defaultGroupFallback = isNo ? 'Generelt' : 'General';
  const lines = String(rawMarkdown || '').split(/\r?\n/);
  const groups: A2uiChecklistGroup[] = [];
  let currentHeading = defaultHeading;
  const categoryStack: Array<{ indent: number; title: string }> = [];
  let sectionGroupStartIdx = 0;
  let itemCounter = 0;

  const getOrCreateGroup = (title: string): A2uiChecklistGroup => {
    const cleanTitle =
      cleanChecklistLabel(title.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/:+\s*$/, '')) ||
      defaultGroupFallback;
    for (let gIdx = groups.length - 1; gIdx >= sectionGroupStartIdx; gIdx--) {
      if (groups[gIdx].title === cleanTitle) {
        return groups[gIdx];
      }
    }
    const created: A2uiChecklistGroup = {
      id: `chk_grp_${groups.length + 1}`,
      title: cleanTitle,
      items: [],
    };
    groups.push(created);
    return created;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{2,4})\s+(.+?)\s*$/);
    if (headingMatch) {
      currentHeading = headingMatch[2].replace(/^\d+(\.\d+)*\.?\s*/, '').trim();
      categoryStack.length = 0;
      sectionGroupStartIdx = groups.length;
      continue;
    }

    const checkboxMatch = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (!checkboxMatch) continue;

    const indent = checkboxMatch[1].length;
    const isChecked = checkboxMatch[2].toLowerCase() === 'x';
    const rawContent = checkboxMatch[3].trim();

    // Pop any category headers at the same or deeper indentation level
    while (categoryStack.length > 0 && categoryStack[categoryStack.length - 1].indent >= indent) {
      categoryStack.pop();
    }

    // Check if this is a parent category line followed by deeper-indented sub-checkboxes
    let hasIndentedSubItems = false;
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      if (!nextLine.trim()) continue;
      const nextCheckbox = nextLine.match(/^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+?)\s*$/);
      if (nextCheckbox && nextCheckbox[1].length > indent) {
        hasIndentedSubItems = true;
      }
      break;
    }

    const contentWithoutFootnotes = stripFootnotesPreservingWordBoundaries(rawContent).trim();
    const isBoldColonHeader = /^\*\*[^*]+\*\*:?\s*$/.test(contentWithoutFootnotes);

    if (isBoldColonHeader || hasIndentedSubItems) {
      const headerTitle = cleanChecklistLabel(
        contentWithoutFootnotes.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/:+\s*$/, '').trim()
      );
      if (headerTitle) {
        categoryStack.push({ indent, title: headerTitle });
      }
      continue;
    }

    let groupTitle = currentHeading;
    const rawItemText = rawContent;

    if (categoryStack.length > 0) {
      const stackTitle = categoryStack.map((c) => c.title).join(' — ');
      groupTitle =
        currentHeading &&
        currentHeading !== defaultHeading &&
        !stackTitle.startsWith(currentHeading)
          ? `${currentHeading} — ${stackTitle}`
          : stackTitle;
    }

    const cleanedLabel = cleanChecklistLabel(rawItemText);
    if (!cleanedLabel) continue;
    itemCounter++;
    const group = getOrCreateGroup(groupTitle);

    group.items.push({
      id: `chk_item_${itemCounter}`,
      label: cleanedLabel,
      checked: isChecked,
      category: group.title,
    });
  }

  return groups.filter((g) => g.items.length > 0);
}

export interface NormalizedA2uiModule {
  id: string;
  number: number;
  title: string;
  subtitleOrBasis: string;
  durationOrMeta: string;
  narration: string;
  spokenNarration?: string;
  actionItem: string;
  bullets: string[];
}

export interface NormalizedA2uiQuizQuestion {
  id: string;
  question: string;
  options: Array<{ label: string; value: string }>;
  correctValue: string;
  explanation: string;
  sourceModule?: string;
}

export interface NormalizedA2uiCaseItem {
  id: string;
  title: string;
  basisOrContext: string;
  scenario: string;
  recommendedAction: string;
}

/**
 * Splits a single monolithic wall of prose (`> 420` characters with no `\n\n` paragraph breaks)
 * into readable 2–3 sentence paragraphs while preserving existing multi-paragraph text intact.
 */
export function formatSingleWallParagraphs(text: string): string {
  const raw = String(text || '').trim();
  if (
    !raw ||
    /\r?\n\s*\r?\n/.test(raw) ||
    raw.length <= 420 ||
    /(?:^|\r?\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/.test(raw)
  ) {
    return raw;
  }
  const abbrevToken = '\u0000';
  const protectedText = raw.replace(
    /\b(e\.g|i\.e|vs|approx|ca|cf|al|Fig|Eq|No|Dr|Mr|Mrs|Ms|Prof|Inc|Corp|Ltd|Co|St|Jr|Sr|U\.S|Ph\.D)\.\s+/gi,
    `$1.${abbrevToken}`
  );
  const sentences = protectedText
    .split(/(?<=[.!?])\s+(?=[\p{Lu}"“'(\[$~+\-0-9])/u)
    .map((s) => s.replaceAll(abbrevToken, ' ').trim())
    .filter(Boolean);
  if (sentences.length < 4) {
    return raw;
  }
  const paragraphs: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    current.push(s);
    currentLen += s.length;
    const remaining = sentences.length - 1 - i;
    if (
      (current.length >= 3 || (current.length >= 2 && currentLen >= 280)) &&
      remaining >= 2
    ) {
      paragraphs.push(current.join(' '));
      current = [];
      currentLen = 0;
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join(' '));
  }
  return paragraphs.join('\n\n');
}

/**
 * Normalizes any Stage 2 `script_draft.json` payload into A2UI data model structures.
 * Works seamlessly across:
 * - Generic Stage 2 output (`{ title, scriptBody, estimatedDuration }`)
 * - Domain compliance studios (`trainingModules`, `keyTakeaways`, `boardActionItem`)
 * - Course studios (`lessons`, `learningObjectives`, `slideCues`, `quizQuestion`/`quizOptions`)
 * - Analytical / IC / decision memos (`pillars`/`analysisPillars`/`sections`, `thesisPoints`/`keyTakeaways`, `recommendation`/`icDirective`, `stressTests`/`scenarios`)
 * - Custom schemas with `modules`, `slides`, `cases`, `scenarios`, or `quiz`/`questions` arrays.
 */
export function normalizeStage2ForA2ui(
  scriptDraft: Record<string, unknown> | null,
  fallbackTitle: string
): {
  title: string;
  subtitle: string;
  targetAudience: string;
  estimatedDuration: number | string;
  scriptBody: string;
  spokenScript: string;
  highlights: string[];
  modules: NormalizedA2uiModule[];
  quiz: NormalizedA2uiQuizQuestion[];
  cases: NormalizedA2uiCaseItem[];
  checklistGroups: A2uiChecklistGroup[];
} {
  if (!scriptDraft || typeof scriptDraft !== 'object') {
    return {
      title: fallbackTitle,
      subtitle: '',
      targetAudience: '',
      estimatedDuration: 0,
      scriptBody: '',
      spokenScript: '',
      highlights: [],
      modules: [],
      quiz: [],
      cases: [],
      checklistGroups: [],
    };
  }

  const stage2Lang = detectIcmLanguage(JSON.stringify(scriptDraft));
  const isNo = stage2Lang === 'no';
  const isPillarSchema =
    Array.isArray(scriptDraft.pillars) || Array.isArray(scriptDraft.analysisPillars);

  const title = String(
    scriptDraft.title ||
      scriptDraft.courseTitle ||
      scriptDraft.reportTitle ||
      scriptDraft.memoTitle ||
      fallbackTitle ||
      'ICM Run Studio'
  );
  const subtitle = String(
    scriptDraft.subtitle || scriptDraft.description || scriptDraft.verdict || ''
  );
  const targetAudience = String(
    scriptDraft.targetAudience || scriptDraft.audience || scriptDraft.verdict || ''
  );

  const rawMinField =
    scriptDraft.totalEstimatedMinutes ??
    scriptDraft.totalDurationMinutes ??
    scriptDraft.durationMinutes ??
    scriptDraft.readingTimeMinutes;
  const rawEstDur = scriptDraft.estimatedDuration ?? scriptDraft.duration;

  let estimatedDuration: number | string = '';
  let hasExplicitMinutesField = false;
  if (typeof rawMinField === 'number' && Number.isFinite(rawMinField) && rawMinField > 0) {
    estimatedDuration = `${rawMinField} min`;
    hasExplicitMinutesField = true;
  } else if (typeof rawMinField === 'string' && rawMinField.trim()) {
    const trimmed = rawMinField.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed) && Number(trimmed) > 0) {
      estimatedDuration = `${Number(trimmed)} min`;
      hasExplicitMinutesField = true;
    } else if (/^\d/.test(trimmed) && /[a-zA-Z]/.test(trimmed)) {
      estimatedDuration = trimmed;
      hasExplicitMinutesField = true;
    }
  } else if (typeof rawEstDur === 'number' && Number.isFinite(rawEstDur) && rawEstDur > 0) {
    estimatedDuration = `${rawEstDur}s`;
  } else if (typeof rawEstDur === 'string' && rawEstDur.trim()) {
    const trimmed = rawEstDur.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed) && Number(trimmed) > 0) {
      estimatedDuration = `${Number(trimmed)}s`;
    } else if (/^\d/.test(trimmed) && /[a-zA-Z]/.test(trimmed)) {
      estimatedDuration = trimmed;
    }
  }

  const rawScriptBody = String(
    scriptDraft.visualSummary ||
      scriptDraft.visualBody ||
      scriptDraft.executiveSummary ||
      scriptDraft.investmentThesis ||
      scriptDraft.memoBody ||
      scriptDraft.overview ||
      scriptDraft.scriptBody ||
      scriptDraft.narration ||
      ''
  );
  const scriptBody = formatSingleWallParagraphs(rawScriptBody);
  const spokenScript = String(
    scriptDraft.spokenScript ||
      scriptDraft.spokenNarration ||
      scriptDraft.narrationScript ||
      (scriptDraft.visualSummary ||
      scriptDraft.visualBody ||
      scriptDraft.executiveSummary ||
      scriptDraft.investmentThesis ||
      scriptDraft.memoBody ||
      scriptDraft.overview
        ? scriptDraft.scriptBody || ''
        : '') ||
      scriptBody
  ).trim();

  // Extract highlights (`keyTakeaways`, `thesisPoints`, `learningObjectives`, or `highlights`)
  const rawHighlights = Array.isArray(scriptDraft.keyTakeaways)
    ? scriptDraft.keyTakeaways
    : Array.isArray(scriptDraft.thesisPoints)
      ? scriptDraft.thesisPoints
      : Array.isArray(scriptDraft.learningObjectives)
        ? scriptDraft.learningObjectives
        : Array.isArray(scriptDraft.highlights)
          ? scriptDraft.highlights
          : [];
  const highlights = rawHighlights.map((h) => String(h || '').trim()).filter(Boolean);

  // Extract modules from `trainingModules`, `modules`, `pillars`, `analysisPillars`, `lessons`, `sections`, or `slides`
  const rawModules = Array.isArray(scriptDraft.trainingModules)
    ? scriptDraft.trainingModules
    : Array.isArray(scriptDraft.modules)
      ? scriptDraft.modules
      : Array.isArray(scriptDraft.pillars)
        ? scriptDraft.pillars
        : Array.isArray(scriptDraft.analysisPillars)
          ? scriptDraft.analysisPillars
          : Array.isArray(scriptDraft.lessons)
            ? scriptDraft.lessons
            : Array.isArray(scriptDraft.sections)
              ? scriptDraft.sections
              : Array.isArray(scriptDraft.slides)
                ? scriptDraft.slides
                : [];

  const modules: NormalizedA2uiModule[] = [];
  const quiz: NormalizedA2uiQuizQuestion[] = [];
  const cases: NormalizedA2uiCaseItem[] = [];

  rawModules.forEach((rawMod: any, idx: number) => {
    if (!rawMod || typeof rawMod !== 'object') return;
    const modNum = Number(
      rawMod.moduleNumber ??
        rawMod.pillarNumber ??
        rawMod.lessonNumber ??
        rawMod.sectionNumber ??
        rawMod.slideNumber ??
        idx + 1
    );
    const modTitle = String(
      rawMod.moduleTitle ||
        rawMod.pillarTitle ||
        rawMod.lessonTitle ||
        rawMod.sectionTitle ||
        rawMod.title ||
        (isPillarSchema ? `Pillar ${modNum}` : `Module ${modNum}`)
    );
    const subtitleOrBasis = String(
      rawMod.regulatoryBasis ||
        rawMod.legalBasis ||
        rawMod.legalReference ||
        rawMod.legalRef ||
        rawMod.lawReference ||
        rawMod.statute ||
        rawMod.analyticalFramework ||
        rawMod.valuationMethodology ||
        rawMod.framework ||
        rawMod.methodology ||
        rawMod.coreConcept ||
        rawMod.subtitle ||
        ''
    );
    const rawModDurVal = rawMod.durationMinutes ?? rawMod.readingTimeMinutes;
    const rawModDurMin =
      rawModDurVal !== undefined && rawModDurVal !== null ? String(rawModDurVal).trim() : '';
    const rawModEstDur =
      rawMod.estimatedDuration !== undefined && rawMod.estimatedDuration !== null
        ? String(rawMod.estimatedDuration).trim()
        : '';
    const durationOrMeta = rawModDurMin
      ? /[a-zA-Z]/.test(rawModDurMin)
        ? rawModDurMin
        : `${rawModDurMin} min`
      : rawModEstDur
        ? /[a-zA-Z]/.test(rawModEstDur)
          ? rawModEstDur
          : `${rawModEstDur}s`
        : '';
    const rawNarration = String(
      rawMod.visualAnalysis ||
        rawMod.visualSummary ||
        rawMod.analysis ||
        rawMod.content ||
        rawMod.summary ||
        rawMod.spokenNarration ||
        rawMod.narrationScript ||
        rawMod.narration ||
        rawMod.scriptBody ||
        ''
    );
    const narration = formatSingleWallParagraphs(rawNarration);
    const spokenNarration = String(
      rawMod.spokenNarration ||
        rawMod.narrationScript ||
        rawMod.spokenScript ||
        narration
    ).trim();
    const actionItem = String(
      rawMod.boardActionItem ||
        rawMod.actionItem ||
        rawMod.recommendation ||
        rawMod.icDirective ||
        rawMod.practicalTask ||
        rawMod.exercise ||
        rawMod.caseActionItem ||
        rawMod.caseResolution ||
        rawMod.recommendedAction ||
        rawMod.mitigation ||
        rawMod.resolution ||
        rawMod.caseSolution ||
        rawMod.solution ||
        ''
    ).trim();
    const bulletsRaw = Array.isArray(rawMod.slideCues)
      ? rawMod.slideCues
      : Array.isArray(rawMod.keyPoints)
        ? rawMod.keyPoints
        : Array.isArray(rawMod.keyTakeaways)
          ? rawMod.keyTakeaways
          : Array.isArray(rawMod.thesisPoints)
            ? rawMod.thesisPoints
            : Array.isArray(rawMod.bullets)
              ? rawMod.bullets
              : [];
    const bullets = bulletsRaw.map((b: unknown) => String(b || '').trim()).filter(Boolean);

    modules.push({
      id: `mod_${idx + 1}`,
      number: modNum,
      title: modTitle,
      subtitleOrBasis,
      durationOrMeta,
      narration,
      spokenNarration,
      actionItem,
      bullets,
    });

    // If module has an embedded quizQuestion (for course/training pipelines)
    if (typeof rawMod.quizQuestion === 'string' && Array.isArray(rawMod.quizOptions)) {
      const options = rawMod.quizOptions.map((opt: unknown, oIdx: number) => ({
        label: String(opt),
        value: String(oIdx),
      }));
      const rawCorrectIdx =
        rawMod.quizCorrectIndex ?? rawMod.correctOptionIndex ?? rawMod.correctIndex;
      const correctIdx =
        typeof rawCorrectIdx === 'number' && Number.isFinite(rawCorrectIdx)
          ? String(rawCorrectIdx)
          : typeof rawCorrectIdx === 'string' && /^\d+$/.test(rawCorrectIdx.trim())
            ? rawCorrectIdx.trim()
            : '0';
      quiz.push({
        id: `quiz_mod_${idx + 1}`,
        question: rawMod.quizQuestion,
        options,
        correctValue: correctIdx,
        explanation: String(rawMod.quizExplanation || ''),
        sourceModule: modTitle,
      });
    }

    // If module has an actionItem / recommendation or explicit caseScenario / stressTest / dilemma, populate a situational scenario case
    const explicitCaseScenario = String(
      rawMod.caseScenario || rawMod.stressTest || rawMod.dilemma || rawMod.scenario || ''
    ).trim();
    const hasPrimaryActionField = Boolean(
      rawMod.boardActionItem || rawMod.actionItem || rawMod.icDirective
    );
    const explicitCaseResolution =
      String(rawMod.caseResolution ?? '').trim() ||
      String(rawMod.recommendedAction ?? '').trim() ||
      String(rawMod.mitigation ?? '').trim() ||
      String(rawMod.resolution ?? '').trim() ||
      String(rawMod.caseSolution ?? '').trim() ||
      String(rawMod.solution ?? '').trim() ||
      String(rawMod.caseActionItem ?? '').trim() ||
      (hasPrimaryActionField ? String(rawMod.recommendation ?? '').trim() : '');
    const caseActionText = explicitCaseResolution || actionItem;
    if (caseActionText || explicitCaseScenario) {
      let synthesizedScenario = explicitCaseScenario;
      if (!synthesizedScenario) {
        const scenarioParts: string[] = [];
        const paragraphs = rawNarration
          .split(/\r?\n\r?\n/)
          .map((p) => p.trim())
          .filter(Boolean);
        const firstPara = paragraphs[0] || '';
        const quizQ = typeof rawMod.quizQuestion === 'string' ? rawMod.quizQuestion.trim() : '';
        if (firstPara && paragraphs.length > 1) {
          scenarioParts.push(firstPara);
        } else if (firstPara && !quizQ) {
          const conciseOpening =
            firstPara.length > 360
              ? firstPara.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ')
              : firstPara;
          scenarioParts.push(conciseOpening);
        }
        if (quizQ) {
          scenarioParts.push(
            isNo ? `Utfordring / Spørsmål: ${quizQ}` : `Challenge / Question: ${quizQ}`
          );
        }
        if (bullets.length > 0) {
          const contextHeader = subtitleOrBasis
            ? isNo
              ? `Sentrale kontrollpunkter (${subtitleOrBasis}):`
              : `Key Checkpoints (${subtitleOrBasis}):`
            : isNo
              ? 'Sentrale kontrollpunkter:'
              : 'Key Checkpoints:';
          scenarioParts.push(
            `${contextHeader}\n${bullets.slice(0, 4).map((b: string) => `• ${b}`).join('\n')}`
          );
        }
        synthesizedScenario = scenarioParts.join('\n\n') || firstPara || rawNarration;
      }

      const quizExpl =
        typeof rawMod.quizExplanation === 'string' ? rawMod.quizExplanation.trim() : '';
      const rationaleLabel = isNo ? '📌 Faglig begrunnelse:' : '📌 Rationale:';
      const enrichedRecommendation =
        !explicitCaseScenario && caseActionText && quizExpl
          ? `${caseActionText}\n\n${rationaleLabel} ${quizExpl}`
          : caseActionText || quizExpl;

      cases.push({
        id: `case_mod_${idx + 1}`,
        title: `${modTitle}`,
        basisOrContext: subtitleOrBasis,
        scenario: synthesizedScenario,
        recommendedAction: enrichedRecommendation,
      });
    }
  });

  if (rawModules.length > 0) {
    const totalModMinutes = rawModules.reduce((acc: number, rm: any) => {
      const rawDm = rm?.durationMinutes ?? rm?.readingTimeMinutes;
      const dm =
        typeof rawDm === 'number'
          ? rawDm
          : typeof rawDm === 'string'
            ? Number(rawDm.replace(/[^\d.]+/g, ''))
            : NaN;
      return Number.isFinite(dm) && dm > 0 ? acc + dm : acc;
    }, 0);
    if (totalModMinutes > 0) {
      if (
        !hasExplicitMinutesField &&
        rawEstDur !== undefined &&
        rawEstDur !== null &&
        rawEstDur !== '' &&
        ((typeof rawEstDur === 'number' && Number.isFinite(rawEstDur) && rawEstDur > 0) ||
          (typeof rawEstDur === 'string' &&
            /^\d+(\.\d+)?$/.test(rawEstDur.trim()) &&
            Number(rawEstDur.trim()) > 0))
      ) {
        estimatedDuration = `${Number(String(rawEstDur).trim())} min`;
      } else if (!estimatedDuration) {
        estimatedDuration = `${totalModMinutes} min`;
      }
    } else if (!estimatedDuration) {
      const totalModSeconds = rawModules.reduce((acc: number, rm: any) => {
        const ds = Number(rm?.estimatedDuration);
        return Number.isFinite(ds) && ds > 0 ? acc + ds : acc;
      }, 0);
      if (totalModSeconds > 0) {
        estimatedDuration = `${totalModSeconds}s`;
      }
    }
  }

  // Synthesize highlights from modules if top-level keyTakeaways / thesisPoints / learningObjectives / highlights is empty
  if (highlights.length === 0 && modules.length > 0) {
    const modPrefix = isNo ? 'Modul' : isPillarSchema ? 'Pillar' : 'Module';
    for (let idx = 0; idx < modules.length; idx++) {
      const m = modules[idx];
      const basisPart = m.subtitleOrBasis ? ` (${m.subtitleOrBasis})` : '';
      const actionPart = m.actionItem ? ` — ${m.actionItem}` : '';
      highlights.push(`${modPrefix} ${idx + 1}: ${m.title}${basisPart}${actionPart}`);
    }
  }

  // Top-level `quiz` or `questions` array
  const rawQuizList = Array.isArray(scriptDraft.quiz)
    ? scriptDraft.quiz
    : Array.isArray(scriptDraft.questions)
      ? scriptDraft.questions
      : [];
  rawQuizList.forEach((q: any, idx: number) => {
    if (!q || typeof q !== 'object') return;
    const rawOpts = Array.isArray(q.options)
      ? q.options
      : Array.isArray(q.quizOptions)
        ? q.quizOptions
        : [];
    const options = rawOpts.map((opt: any, oIdx: number) =>
      typeof opt === 'object' && opt !== null
        ? { label: String(opt.label || opt.text || oIdx), value: String(opt.value ?? oIdx) }
        : { label: String(opt), value: String(oIdx) }
    );
    const correctValue = String(
      q.correctValue ?? q.correctIndex ?? q.quizCorrectIndex ?? q.answer ?? '0'
    );
    quiz.push({
      id: `quiz_${idx + 1}`,
      question: String(q.question || q.quizQuestion || `Question ${idx + 1}`),
      options,
      correctValue,
      explanation: String(q.explanation || q.quizExplanation || ''),
      sourceModule: String(q.moduleTitle || ''),
    });
  });

  // Top-level `cases`, `scenarios`, or `stressTests` array
  const rawCasesList = Array.isArray(scriptDraft.cases)
    ? scriptDraft.cases
    : Array.isArray(scriptDraft.scenarios)
      ? scriptDraft.scenarios
      : Array.isArray(scriptDraft.stressTests)
        ? scriptDraft.stressTests
        : [];
  rawCasesList.forEach((c: any, idx: number) => {
    if (!c || typeof c !== 'object') return;
    cases.push({
      id: `case_${idx + 1}`,
      title: String(c.title || c.caseTitle || c.scenarioTitle || `Scenario ${idx + 1}`),
      basisOrContext: String(
        c.regulatoryBasis ||
          c.legalBasis ||
          c.legalReference ||
          c.legalRef ||
          c.lawReference ||
          c.statute ||
          c.analyticalFramework ||
          c.valuationMethodology ||
          c.framework ||
          c.methodology ||
          c.coreConcept ||
          c.subtitle ||
          c.context ||
          c.category ||
          ''
      ),
      scenario: String(
        c.scenario || c.caseScenario || c.stressTest || c.dilemma || c.description || c.prompt || ''
      ),
      recommendedAction: String(
        c.recommendedAction ||
          c.recommendation ||
          c.mitigation ||
          c.caseResolution ||
          c.resolution ||
          c.caseSolution ||
          c.solution ||
          c.boardActionItem ||
          c.actionItem ||
          c.icDirective ||
          c.caseActionItem ||
          c.practicalTask ||
          c.exercise ||
          ''
      ),
    });
  });

  // Top-level `checklistGroups` (`{ category, items: string[] }[]`)
  const checklistGroups: A2uiChecklistGroup[] = [];
  if (Array.isArray(scriptDraft.checklistGroups)) {
    let chkCounter = 0;
    const defaultGrpPrefix = isNo ? 'Gruppe' : 'Group';
    scriptDraft.checklistGroups.forEach((rawGrp: any, gIdx: number) => {
      if (!rawGrp || typeof rawGrp !== 'object') return;
      const grpTitle =
        cleanChecklistLabel(
          String(
            rawGrp.category ||
              rawGrp.title ||
              rawGrp.groupTitle ||
              `${defaultGrpPrefix} ${gIdx + 1}`
          )
        ) || `${defaultGrpPrefix} ${gIdx + 1}`;
      const rawItems = Array.isArray(rawGrp.items) ? rawGrp.items : [];
      const items: A2uiChecklistItem[] = [];
      rawItems.forEach((it: any) => {
        const rawLabel =
          typeof it === 'object' && it !== null
            ? String(it.label || it.text || it.item || '')
            : String(it || '');
        const cleaned = cleanChecklistLabel(rawLabel);
        if (!cleaned) return;
        chkCounter++;
        items.push({
          id: `chk_s2_${chkCounter}`,
          label: cleaned,
          checked: Boolean(typeof it === 'object' && it !== null && it.checked),
          category: grpTitle,
        });
      });
      if (items.length > 0) {
        checklistGroups.push({
          id: `chk_s2_grp_${checklistGroups.length + 1}`,
          title: grpTitle,
          items,
        });
      }
    });
  }

  return {
    title,
    subtitle,
    targetAudience,
    estimatedDuration,
    scriptBody,
    spokenScript,
    highlights,
    modules,
    quiz,
    cases,
    checklistGroups,
  };
}

/**
 * Resolves an RFC 6901 JSON Pointer path (`/a/b/0`) against a root data model object.
 */
export function resolveJsonPointer(rootModel: unknown, pointer: string, scopeModel?: unknown): unknown {
  if (!pointer) return rootModel;
  if (!pointer.startsWith('/')) {
    // Relative path inside a template collection scope
    const base = scopeModel !== undefined ? scopeModel : rootModel;
    const segments = pointer.split('/').filter(Boolean);
    let cur: any = base;
    for (const seg of segments) {
      if (cur === null || cur === undefined) return undefined;
      const unescaped = seg.replace(/~1/g, '/').replace(/~0/g, '~');
      cur = cur[unescaped];
    }
    return cur;
  }
  if (pointer === '/') return rootModel;
  const segments = pointer.slice(1).split('/');
  let current: any = rootModel;
  for (const rawSeg of segments) {
    if (current === null || current === undefined) return undefined;
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    current = current[seg];
  }
  return current;
}

function cloneJsonValue<T>(val: T): T {
  if (val === null || val === undefined || typeof val !== 'object') {
    return val;
  }
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(val);
    } catch {
      // Fallback to JSON deep clone
    }
  }
  return JSON.parse(JSON.stringify(val));
}

/**
 * Updates an RFC 6901 JSON Pointer path (`/a/b/0`) on a root data model object in-place.
 * Deep-clones assigned object/array values so mutating the live surface data model never
 * mutates historical `updateDataModel` message envelopes by reference aliasing.
 * Follows A2UI v0.9.1 upsert & delete semantics:
 * - If pointer is omitted or `'/'`, replaces the entire root data model in-place.
 * - If `value === undefined`, deletes the key on objects (or sets index to `undefined` on arrays, preserving length).
 */
export function setJsonPointer(rootModel: Record<string, any>, pointer: string, value: unknown): void {
  if (!pointer || pointer === '/') {
    for (const k of Object.keys(rootModel)) {
      delete rootModel[k];
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(rootModel, cloneJsonValue(value));
    }
    return;
  }
  const cleanPointer = pointer.startsWith('/') ? pointer.slice(1) : pointer;
  const segments = cleanPointer.split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: any = rootModel;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const nextSeg = segments[i + 1];
    if (current[seg] === undefined || current[seg] === null || typeof current[seg] !== 'object') {
      current[seg] = /^\d+$/.test(nextSeg) ? [] : {};
    }
    current = current[seg];
  }
  const lastSeg = segments[segments.length - 1];
  if (value === undefined) {
    if (Array.isArray(current) && /^\d+$/.test(lastSeg)) {
      current[Number(lastSeg)] = undefined;
    } else if (current && typeof current === 'object') {
      delete current[lastSeg];
    }
  } else {
    current[lastSeg] = cloneJsonValue(value);
  }
}

let cachedCatalogReqs: Map<string, { required: string[]; properties: Set<string> }> | null = null;

/**
 * Loads and merges Tier 1 (`specification/v0_9_1/catalogs/basic/catalog.json`) and
 * Tier 2 (`specification/v0_9_1/catalogs/icm-okf-v0.2/catalog.json`) A2UI component schemas.
 */
export function loadA2uiCatalogComponentRequirements(): Map<
  string,
  { required: string[]; properties: Set<string> }
> {
  if (cachedCatalogReqs) return cachedCatalogReqs;
  const map = new Map<string, { required: string[]; properties: Set<string> }>();
  const specRootCandidates = [
    path.resolve(process.cwd(), 'specification', 'v0_9_1', 'catalogs'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'specification', 'v0_9_1', 'catalogs'),
  ];
  const specCatalogDir = specRootCandidates.find((d) => fs.existsSync(d));

  const parseCatalogFile = (filePath: string) => {
    if (!fs.existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const comps = parsed?.components;
      if (!comps || typeof comps !== 'object') return;
      for (const [compName, compDef] of Object.entries<any>(comps)) {
        const reqSet = new Set<string>(['id', 'component']);
        const propSet = new Set<string>(['id', 'component', 'weight', 'accessibility']);
        const branches = Array.isArray(compDef?.allOf) ? compDef.allOf : [compDef];
        for (const b of branches) {
          if (Array.isArray(b?.required)) {
            for (const r of b.required) reqSet.add(String(r));
          }
          if (b?.properties && typeof b.properties === 'object') {
            for (const p of Object.keys(b.properties)) propSet.add(p);
          }
        }
        map.set(compName, { required: Array.from(reqSet), properties: propSet });
      }
    } catch {
      // Fallback handled below
    }
  };

  if (specCatalogDir) {
    parseCatalogFile(path.join(specCatalogDir, 'basic', 'catalog.json'));
    parseCatalogFile(path.join(specCatalogDir, 'icm-okf-v0.2', 'catalog.json'));
  }

  // Ensure fallback entries if run outside repo root
  for (const t1 of A2UI_ICM_CATALOG_SCHEMA.tier1BasicComponents) {
    if (!map.has(t1)) {
      map.set(t1, { required: ['id', 'component'], properties: new Set(['id', 'component']) });
    }
  }
  for (const [t2Name, t2Def] of Object.entries(A2UI_ICM_CATALOG_SCHEMA.tier2DomainComponents)) {
    if (!map.has(t2Name)) {
      map.set(t2Name, {
        required: ['id', 'component'],
        properties: new Set(['id', 'component', ...t2Def.properties]),
      });
    }
  }

  cachedCatalogReqs = map;
  return map;
}

/**
 * Validates an array of A2UI v0.9.1 server-to-client messages for protocol structural integrity:
 * - Envelope version === 'v0.9.1'
 * - Exactly one of `createSurface`, `updateComponents`, `updateDataModel`, or `deleteSurface` per message
 * - `createSurface` precedes `updateComponents`, `updateDataModel`, and `deleteSurface` for the same `surfaceId`,
 *   and duplicate `createSurface` without an intervening `deleteSurface` is rejected
 * - Component adjacency list contains a `root` component (`id: "root"`), no duplicate IDs,
 *   all component types and required properties match the merged Tier 1 (`basic/catalog.json`) +
 *   Tier 2 (`icm-okf-v0.2/catalog.json`) schemas, all child component ID references exist,
 *   and there are no circular parent-child references.
 */
export function validateA2uiSurfaceMessages(messages: A2uiEnvelopeMessage[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const createdSurfaces = new Set<string>();
  const catalogReqs = loadA2uiCatalogComponentRequirements();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object') {
      errors.push(`Message[${i}] is not an object`);
      continue;
    }
    if (msg.version !== A2UI_PROTOCOL_VERSION) {
      errors.push(`Message[${i}] has invalid version "${(msg as any).version}", expected "${A2UI_PROTOCOL_VERSION}"`);
    }

    const msgKeys = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'].filter(
      (k) => k in msg
    );
    if (msgKeys.length !== 1) {
      errors.push(
        `Message[${i}] must contain exactly one envelope action (createSurface | updateComponents | updateDataModel | deleteSurface), found ${msgKeys.length}`
      );
      continue;
    }

    if ('createSurface' in msg) {
      const { surfaceId, catalogId } = msg.createSurface;
      if (!surfaceId) errors.push(`Message[${i}] createSurface missing surfaceId`);
      if (!catalogId) errors.push(`Message[${i}] createSurface missing catalogId`);
      if (surfaceId && createdSurfaces.has(surfaceId)) {
        errors.push(
          `Message[${i}] duplicate createSurface for active surface "${surfaceId}" without prior deleteSurface`
        );
      }
      if (surfaceId) createdSurfaces.add(surfaceId);
    } else if ('updateDataModel' in msg) {
      const { surfaceId } = msg.updateDataModel;
      if (!surfaceId) {
        errors.push(`Message[${i}] updateDataModel missing surfaceId`);
      } else if (!createdSurfaces.has(surfaceId)) {
        errors.push(`Message[${i}] updateDataModel references uncreated surface "${surfaceId}"`);
      }
    } else if ('deleteSurface' in msg) {
      const { surfaceId } = msg.deleteSurface;
      if (!surfaceId) {
        errors.push(`Message[${i}] deleteSurface missing surfaceId`);
      } else if (!createdSurfaces.has(surfaceId)) {
        errors.push(`Message[${i}] deleteSurface references uncreated surface "${surfaceId}"`);
      } else {
        createdSurfaces.delete(surfaceId);
      }
    } else if ('updateComponents' in msg) {
      const { surfaceId, components } = msg.updateComponents;
      if (!createdSurfaces.has(surfaceId)) {
        errors.push(`Message[${i}] updateComponents references uncreated surface "${surfaceId}"`);
      }
      if (!Array.isArray(components) || components.length === 0) {
        errors.push(`Message[${i}] updateComponents.components must be a non-empty array`);
        continue;
      }

      const byId = new Map<string, A2uiComponent>();
      for (const comp of components) {
        if (!comp.id || typeof comp.id !== 'string') {
          errors.push(`Component missing string id`);
          continue;
        }
        if (!comp.component || typeof comp.component !== 'string') {
          errors.push(`Component "${comp.id}" missing component type name`);
        } else {
          const schemaEntry = catalogReqs.get(comp.component);
          if (!schemaEntry) {
            errors.push(
              `Component "${comp.id}" uses unknown component type "${comp.component}" not present in Basic or ICM/OKF catalog`
            );
          } else {
            for (const reqProp of schemaEntry.required) {
              if (!(reqProp in comp) || comp[reqProp] === undefined) {
                errors.push(
                  `Component "${comp.id}" (${comp.component}) missing required catalog property "${reqProp}"`
                );
              }
            }
          }
        }
        if (byId.has(comp.id)) {
          errors.push(`Duplicate component id "${comp.id}" in surface "${surfaceId}"`);
        }
        byId.set(comp.id, comp);
      }

      if (!byId.has('root')) {
        errors.push(`Surface "${surfaceId}" is missing required component with id="root"`);
      }

      // Check child references & cycle detection
      const getChildIds = (comp: A2uiComponent): string[] => {
        const refs: string[] = [];
        if (typeof comp.child === 'string') refs.push(comp.child);
        if (typeof comp.trigger === 'string') refs.push(comp.trigger);
        if (typeof comp.content === 'string') refs.push(comp.content);
        if (Array.isArray(comp.children)) {
          for (const c of comp.children) {
            if (typeof c === 'string') refs.push(c);
          }
        } else if (comp.children && typeof comp.children === 'object' && typeof (comp.children as any).componentId === 'string') {
          refs.push((comp.children as any).componentId);
        }
        if (Array.isArray(comp.tabs)) {
          for (const tab of comp.tabs as any[]) {
            if (tab && typeof tab.child === 'string') refs.push(tab.child);
          }
        }
        return refs;
      };

      for (const [id, comp] of byId.entries()) {
        for (const childId of getChildIds(comp)) {
          if (!byId.has(childId)) {
            errors.push(`Component "${id}" references non-existent child component "${childId}"`);
          }
        }
      }

      const visiting = new Set<string>();
      const visited = new Set<string>();
      const dfs = (nodeId: string) => {
        if (visiting.has(nodeId)) {
          errors.push(`Circular component reference detected involving "${nodeId}"`);
          return;
        }
        if (visited.has(nodeId)) return;
        visiting.add(nodeId);
        const comp = byId.get(nodeId);
        if (comp) {
          for (const childId of getChildIds(comp)) {
            if (byId.has(childId)) dfs(childId);
          }
        }
        visiting.delete(nodeId);
        visited.add(nodeId);
      };
      if (byId.has('root')) {
        dfs('root');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

const A2UI_STUDIO_CSS = `
:root {
  color-scheme: light;
  --bg: #f8fafc;
  --surface: #ffffff;
  --surface-subtle: #f1f5f9;
  --border: #e2e8f0;
  --border-strong: #cbd5e1;
  --text: #0f172a;
  --text-muted: #475569;
  --text-light: #64748b;
  --primary: #1d4ed8;
  --primary-soft: #eff6ff;
  --primary-border: #bfdbfe;
  --accent: #6d28d9;
  --accent-soft: #f5f3ff;
  --success: #047857;
  --success-soft: #ecfdf5;
  --success-border: #a7f3d0;
  --warn: #b45309;
  --warn-soft: #fffbeb;
  --warn-border: #fde68a;
  --danger: #b91c1c;
  --danger-soft: #fef2f2;
  --danger-border: #fecaca;
  --radius: 10px;
  --shadow: 0 1px 3px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text);
  background: var(--bg);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.a2ui-topbar {
  background: #0f172a;
  color: #f8fafc;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid #1e293b;
  position: sticky;
  top: 0;
  z-index: 40;
}
.a2ui-topbar-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.a2ui-protocol-pill {
  background: linear-gradient(135deg, #2563eb, #7c3aed);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.4px;
  padding: 3px 9px;
  border-radius: 999px;
  white-space: nowrap;
}
.a2ui-topbar-title {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.a2ui-run-switcher {
  color-scheme: dark;
  background: #1e293b;
  color: #f8fafc;
  border: 1px solid #3b82f6;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  max-width: 340px;
  text-overflow: ellipsis;
}
.a2ui-run-switcher:focus {
  outline: 2px solid #60a5fa;
  outline-offset: 1px;
}
.a2ui-topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.a2ui-top-btn {
  background: #1e293b;
  color: #e2e8f0;
  border: 1px solid #334155;
  padding: 5px 11px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.a2ui-top-btn:hover { background: #334155; color: #fff; }
.a2ui-root-Mount {
  max-width: 1360px;
  width: 100%;
  margin: 0 auto;
  padding: 20px 24px 48px;
  flex: 1;
}
/* Basic Catalog Primitives */
.a2ui-col { display: flex; flex-direction: column; gap: 16px; }
.a2ui-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.a2ui-row.justify-between { justify-content: space-between; }
.a2ui-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
  box-shadow: var(--shadow);
}
.a2ui-divider {
  border: none;
  border-top: 1px solid var(--border);
  margin: 8px 0;
}
.a2ui-h1 { font-size: 22px; font-weight: 700; margin: 0; color: var(--text); letter-spacing: -0.01em; }
.a2ui-h2 { font-size: 18px; font-weight: 650; margin: 0; color: var(--text); }
.a2ui-h3 { font-size: 15px; font-weight: 600; margin: 0; color: var(--text); }
.a2ui-h4 { font-size: 13.5px; font-weight: 600; margin: 0; color: var(--text-muted); }
.a2ui-caption { font-size: 12px; color: var(--text-light); margin: 0; }
.a2ui-body { font-size: 14px; color: var(--text); margin: 0; white-space: pre-wrap; }
.a2ui-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  border: 1px solid transparent;
}
.a2ui-badge.primary { background: var(--primary-soft); color: var(--primary); border-color: var(--primary-border); }
.a2ui-badge.success { background: var(--success-soft); color: var(--success); border-color: var(--success-border); }
.a2ui-badge.warn { background: var(--warn-soft); color: var(--warn); border-color: var(--warn-border); }
.a2ui-badge.danger { background: var(--danger-soft); color: var(--danger); border-color: var(--danger-border); }
.a2ui-badge.accent { background: var(--accent-soft); color: var(--accent); border-color: #ddd6fe; }
.a2ui-badge.neutral { background: var(--surface-subtle); color: var(--text-muted); border-color: var(--border-strong); }

.a2ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 7px;
  cursor: pointer;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  transition: all 0.12s ease;
}
.a2ui-btn:hover { background: var(--surface-subtle); }
.a2ui-btn.primary { background: var(--primary); color: #fff; border-color: var(--primary); }
.a2ui-btn.primary:hover { background: #1e40af; }
.a2ui-btn.borderless { border-color: transparent; background: transparent; color: var(--primary); }
.a2ui-btn.borderless:hover { background: var(--primary-soft); }

/* Tabs */
.a2ui-tabs-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  border-bottom: 2px solid var(--border);
  padding-bottom: 0;
  margin-bottom: 18px;
}
.a2ui-tab-btn {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  padding: 10px 16px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border-radius: 6px 6px 0 0;
}
.a2ui-tab-btn:hover { color: var(--text); background: var(--surface-subtle); }
.a2ui-tab-btn.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
  background: var(--primary-soft);
}

/* Inputs */
.a2ui-checkbox-label {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
  padding: 8px 10px;
  border-radius: 7px;
  transition: background 0.12s;
}
.a2ui-checkbox-label:hover { background: var(--surface-subtle); }
.a2ui-checkbox-label input[type="checkbox"] {
  margin-top: 3px;
  width: 16px;
  height: 16px;
  accent-color: var(--primary);
  cursor: pointer;
  flex-shrink: 0;
}
.a2ui-checkbox-label.checked span {
  text-decoration: line-through;
  color: var(--text-light);
}
.a2ui-input {
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-family: inherit;
  background: #ffffff;
  color: #0f172a;
  caret-color: #0f172a;
}
.a2ui-textfield {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.a2ui-textfield label { font-size: 12.5px; font-weight: 600; color: var(--text-muted); }
.a2ui-textfield input, .a2ui-textfield textarea {
  width: 100%;
  padding: 8px 11px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-size: 13.5px;
  font-family: inherit;
  background: #ffffff;
  color: #0f172a;
  caret-color: #0f172a;
}
.a2ui-input::placeholder,
.a2ui-textfield input::placeholder,
.a2ui-textfield textarea::placeholder,
.okf-replace-url-input::placeholder,
.okf-add-source-box input::placeholder {
  color: #64748b;
  opacity: 1;
}
.a2ui-choice-group { display: flex; flex-direction: column; gap: 6px; }
.a2ui-choice-opt {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  cursor: pointer;
  background: var(--surface);
}
.a2ui-choice-opt:hover { background: var(--surface-subtle); }
.a2ui-choice-opt.selected { border-color: var(--primary); background: var(--primary-soft); }

/* Progress Bar */
.a2ui-progress-wrap {
  background: var(--surface-subtle);
  height: 10px;
  border-radius: 999px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.a2ui-progress-fill {
  background: linear-gradient(90deg, #2563eb, #10b981);
  height: 100%;
  transition: width 0.25s ease;
}

/* Tier 2: OkfMarkdown */
.okf-md-container {
  display: grid;
  grid-template-columns: 1fr 330px;
  gap: 20px;
  align-items: start;
}
@media (max-width: 980px) {
  .okf-md-container { grid-template-columns: 1fr; }
}
.okf-md-body {
  font-size: 14px;
  line-height: 1.65;
  color: var(--text);
}
.okf-md-body > p:first-child, .okf-md-body > ul:first-child, .okf-md-body > ol:first-child { margin-top: 0; }
.okf-md-body > p:last-child, .okf-md-body > ul:last-child, .okf-md-body > ol:last-child { margin-bottom: 0; }
.okf-md-body blockquote {
  margin: 10px 0;
  padding: 8px 14px;
  border-left: 3px solid var(--primary);
  background: var(--surface-subtle);
  border-radius: 0 6px 6px 0;
}
.okf-md-body h1 { font-size: 20px; border-bottom: 1px solid var(--border); padding-bottom: 6px; margin-top: 20px; }
.okf-md-body h2 { font-size: 17px; margin-top: 18px; color: #1e293b; }
.okf-md-body h3 { font-size: 15px; margin-top: 14px; color: #334155; }
.okf-md-body table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
.okf-md-body th, .okf-md-body td { border: 1px solid var(--border); padding: 7px 10px; text-align: left; }
.okf-md-body th { background: var(--surface-subtle); font-weight: 600; }
.okf-md-body code { background: var(--surface-subtle); padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
.okf-md-body pre { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; overflow-x: auto; }
.okf-md-body pre code { background: transparent; color: inherit; padding: 0; }
.okf-md-body sup.fn-ref a {
  color: var(--primary);
  text-decoration: none;
  font-weight: 700;
  padding: 0 2px;
}
.okf-source-card {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
  background: var(--bg);
  font-size: 12.5px;
}
.okf-source-card.highlight {
  border-color: var(--primary);
  background: var(--primary-soft);
}
.okf-source-card.replaced {
  border-color: #60a5fa;
  background: #f0f7ff;
}
.src-chip {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10.5px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  margin-right: 4px;
  margin-top: 4px;
}
.src-chip.retrieved { background: #e2e8f0; color: #334155; }
.src-chip.modified { background: #dbeafe; color: #1e40af; }
.src-chip.citations { background: #e0f2fe; color: #0369a1; font-weight: 600; }
.src-chip.sole-warning { background: #fef3c7; color: #92400e; font-weight: 600; border: 1px solid #f59e0b; }
.src-chip.domain-host { background: #f1f5f9; color: #0f172a; font-weight: 700; border: 1px solid #cbd5e1; }
.src-chip.domain-mismatch { background: #ffedd5; color: #9a3412; font-weight: 700; border: 1px solid #f97316; }
.src-chip.replaced-badge { background: #dcfce7; color: #166534; font-weight: 700; border: 1px solid #22c55e; }
.src-chip.rejected-badge { background: #fee2e2; color: #991b1b; font-weight: 700; border: 1px solid #f87171; }
.src-chip.added-badge { background: #dcfce7; color: #166534; font-weight: 700; border: 1px solid #4ade80; }
.okf-replace-row {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: #fff7ed;
  border: 1px solid #fdba74;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  font-size: 11.5px;
  color: #7c2d12;
}
.okf-replace-row.swap-mode {
  background: #eff6ff;
  border-color: #93c5fd;
  color: #1e3a8a;
}
.okf-replace-row.swap-mode .okf-replace-select,
.okf-replace-row.swap-mode .okf-replace-url-input {
  border-color: #60a5fa;
}
.okf-replace-select-wrap {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.okf-replace-select {
  flex: 1;
  min-width: 170px;
  padding: 3px 6px;
  border-radius: 5px;
  border: 1px solid #fb923c;
  background: #fff;
  font-size: 11.5px;
  color: #0f172a;
}
.okf-replace-url-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.okf-replace-url-input {
  flex: 1;
  min-width: 190px;
  padding: 3px 7px;
  border-radius: 5px;
  border: 1px solid #fb923c;
  background: #fff;
  font-size: 11.5px;
  color: #0f172a;
}
.okf-replace-url-btn {
  padding: 3px 8px;
  font-size: 11px;
  white-space: nowrap;
}
.okf-md-outer {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.okf-curation-banner {
  border-left: 4px solid var(--primary);
  background: linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.okf-curation-prompt-box {
  background: #0f172a;
  color: #e2e8f0;
  padding: 9px 12px;
  border-radius: 7px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
}
.okf-source-card.rejected {
  border: 1px dashed #ef4444;
  background: #fef2f2;
  opacity: 0.88;
}
.okf-source-card.rejected .okf-src-title {
  text-decoration: line-through;
  color: #991b1b !important;
}
.okf-md-body sup.fn-ref.fn-rejected a {
  color: #dc2626 !important;
  text-decoration: line-through !important;
  background: #fee2e2;
  border-radius: 3px;
  padding: 0 3px;
}
.okf-add-source-box {
  padding: 10px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  background: var(--surface-subtle);
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.okf-add-source-box input {
  width: 100%;
  padding: 6px 9px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  background: #ffffff;
  color: #0f172a;
  caret-color: #0f172a;
}
.okf-search-log-details {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
  font-size: 12.5px;
  margin-bottom: 10px;
}
.okf-search-log-details summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--text);
}
.okf-sole-claims-details {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  font-size: 11.5px;
  color: #78350f;
}
.okf-sole-claims-details summary {
  cursor: pointer;
  font-weight: 600;
}

/* Tier 2: OkfKnowledgeGraph */
.okf-graph-split {
  display: grid;
  grid-template-columns: 1fr 380px;
  height: 580px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--surface);
}
.okf-graph-canvas { width: 100%; height: 100%; background: #fff; border-right: 1px solid var(--border); }
.okf-graph-detail { padding: 16px; overflow-y: auto; height: 100%; background: var(--bg); }

/* Inspector Modal */
.a2ui-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 24px;
}
.a2ui-modal-backdrop[hidden] { display: none !important; }
.a2ui-modal-dialog {
  background: var(--surface);
  border-radius: 12px;
  max-width: 960px;
  width: 100%;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}
.a2ui-modal-header {
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.a2ui-modal-body {
  padding: 18px 20px;
  overflow-y: auto;
  flex: 1;
}
`.trim();

const A2UI_STUDIO_JS = `
(function () {
  function detectTextLang(text) {
    const sample = String(text || "");
    const noCharCount = (sample.match(/[æøåÆØÅ]/g) || []).length;
    const noStopMatches =
      sample.match(
        /\\b(ikke|eller|brann\\w*|styret|virksomhet\\w*|forskrift\\w*|sjekkliste\\w*|kurset|kursdeltaker\\w*|deltaker\\w*|opplæring\\w*|ansvar\\w*|tiltak\\w*|arbeidsgiver\\w*|krav(?:ene|et)?|kontroll(?:en|er)?|lovpålagt\\w*|vurdering\\w*|gjennomfør\\w*)\\b/gi
      ) || [];
    const noShortMatches =
      sample.match(/\\b(og|det|som|med|til|fra|lov|skal|må|kan|ved|av|på|en|et)\\b/g) || [];
    const enStopMatches =
      sample.match(
        /\\b(the|and|with|from|that|this|are|was|were|have|has|had|will|would|should|could|which|their|there|about|into|between|without|within|through|during|before|after|under|above|below|while|where|when|what|these|those)\\b/gi
      ) || [];
    const noScore = noCharCount * 2 + noStopMatches.length * 3 + noShortMatches.length;
    const enScore = enStopMatches.length * 2;
    if (noScore === 0) return "en";
    if (enScore === 0) {
      if (noCharCount >= 1 || noStopMatches.length >= 1 || noShortMatches.length >= 2) return "no";
      return "en";
    }
    return noScore >= enScore ? "no" : "en";
  }

  function isInlineLatexMath(inner) {
    if (!inner || typeof inner !== "string") return false;
    if (/^\\s|\\s$/.test(inner)) return false;
    if (/[\\r\\n|]/.test(inner)) return false;
    if (inner.indexOf("[^") !== -1) return false;
    if (/\\*\\*|__/.test(inner)) return false;
    if (/(?:^|[^\\\\])~$/.test(inner)) return false;
    if (/^\\d+\\.\\d{3,}$/.test(inner)) return true;
    if (/^\\d[\\d,.]*(?:\\s*(?:[BMKTbmkt](?![\\^_])\\b|billion|million|trillion|thousand|bn\\b|mn\\b|\\s+(?:per|to|and|or|in|at|for|from|of|vs)\\b|\\)|\\s*$))/i.test(inner)) {
      return false;
    }
    if (/^\\d[\\d,.]*\\s*\\/\\s*(?:sh|share|yr|year|mo|month|wk|week|day|hr|hour|oz|lb|lbs|kg|g|ton|tonne|t|bbl|gal|mwh|kwh|kw|mw|gw|user|sub|seat|unit|launch|flight|km|m|sqft|ft)\\b/i.test(inner)) {
      return false;
    }
    if (/^\\d[\\d,.]*\\s*[-–—]\\s*(?:\\$|~|$)/.test(inner)) {
      return false;
    }
    if (/^[A-Z]{1,5}\\/[A-Z]{1,5}$/.test(inner)) {
      return true;
    }
    if (/^[a-zA-Z]$/.test(inner)) {
      return true;
    }
    if (/^[a-zA-Z](?:_[a-zA-Z0-9]+)?\\s*[=<>≤≥≈~±+\\-]\\s*[+-]?\\d[\\d.,%a-zA-Z\\s/\\-]*$/.test(inner)) {
      return true;
    }
    const hasTeXOrSubSup = /(?:\\\\[a-zA-Z !,;:%$&_#]|[A-Za-z0-9)\\]}][\\^_](?:\\{[^{}\\r\\n]+\\}|[A-Za-z0-9+\\-°]))/.test(inner);
    if (/^\\d/.test(inner)) {
      if (hasTeXOrSubSup) return true;
      if (/^\\d+(?:[.,]\\d+)*(?:\\s*(?:\\\\|[\\^_+*=<>≤≥±×÷]|\\/[a-zA-Z0-9]+)|\\s+[a-zA-Z]{1,3}[\\^_])/.test(inner)) {
        return true;
      }
      if (/^\\d+\\.\\d+$/.test(inner) && !/^\\d+\\.\\d{2}$/.test(inner)) {
        return true;
      }
      return false;
    }
    if (!hasTeXOrSubSup) {
      return false;
    }
    return true;
  }

  function replaceInlineLatexSpans(str, replacer) {
    const s = String(str || "");
    let out = "";
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\\\" && i + 1 < s.length && s[i + 1] === "$") {
        out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch !== "$") {
        out += ch;
        i++;
        continue;
      }
      if (i + 1 < s.length && s[i + 1] === "$") {
        let k = i + 2;
        const closeIdx = s.indexOf("$$", k);
        if (closeIdx !== -1) {
          while (k < closeIdx) {
            if (s[k] === "|" || (s[k] === "\\n" && /^\\r?\\n\\s*\\r?\\n/.test(s.slice(k)))) {
              break;
            }
            k++;
          }
          if (k === closeIdx) {
            const innerDisplay = s.slice(i + 2, closeIdx).replace(/\\s+/g, " ").trim();
            if (innerDisplay && isInlineLatexMath(innerDisplay)) {
              out += replacer(s.slice(i, closeIdx + 2), innerDisplay);
              i = closeIdx + 2;
              continue;
            }
          }
        }
      }
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "\\\\" && j + 1 < s.length) {
          j += 2;
          continue;
        }
        if (s[j] === "$" || s[j] === "\\n" || s[j] === "\\r" || s[j] === "|") {
          break;
        }
        j++;
      }
      if (j < s.length && s[j] === "$") {
        const inner = s.slice(i + 1, j);
        if (isInlineLatexMath(inner)) {
          out += replacer(s.slice(i, j + 1), inner);
          i = j + 1;
          continue;
        }
      }
      out += "$";
      i++;
    }
    return out;
  }

  function detectSpeechLang(text) {
    return detectTextLang(text) === "no" ? "nb-NO" : "en-US";
  }

  function stripClientFootnotesPreservingBoundaries(text) {
    return String(text || "")
      .replace(/([A-Za-z0-9\\u00C0-\\u024F)%°²³¹⁰⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉])(?:\\[\\^[^\\r\\n\\]]+\\][ \\t]*)+(?=[A-Za-z0-9\\u00C0-\\u024F($~€£])/g, "$1 ")
      .replace(/\\[\\^[^\\r\\n\\]]+\\]/g, "");
  }

  function normalizeTextForTts(text, langOrIsNo) {
    const raw = String(text || "");
    const isNo =
      langOrIsNo === true ||
      langOrIsNo === "no" ||
      langOrIsNo === "nb-NO" ||
      (langOrIsNo == null && detectTextLang(raw) === "no");
    let s = cleanClientChecklistLabel(raw);
    // Expand currency ranges ($1.77T–$1.98T, $62M–$70M) before individual currency tokens
    s = s.replace(/(\\$[0-9][0-9,.]*(?:\\s*(?:B|M|T|K|bn|mn|billion|million|trillion|thousand))?)\\s*[–—-]\\s*(\\$[0-9])/gi, function (_m, left, right) {
      return left + (isNo ? " til " : " to ") + right;
    });
    // Replace negative currency (-$1,795.7M), positive currency (+$43.0M), and approximate currency (~$420.00)
    s = s.replace(/(^|[\\s(])-\\s*\\$(?=\\d)/g, "$1" + (isNo ? "minus $" : "negative $"));
    s = s.replace(/(^|[\\s(])\\+\\s*\\$(?=\\d)/g, "$1" + (isNo ? "pluss $" : "plus $"));
    s = s.replace(/~\\s*\\$(?=\\d)/g, isNo ? "omtrent $" : "approximately $");
    s = s.replace(/~(?=\\d)/g, isNo ? "omtrent " : "approximately ");
    // Expand currency with magnitude suffixes + optional unit slash ($10,000/kg, $1,795.7M, $800.0B)
    const unitSlashMapEn = {
      kg: "kilogram",
      g: "gram",
      t: "metric ton",
      ton: "ton",
      tonne: "metric ton",
      oz: "ounce",
      sh: "share",
      share: "share",
      yr: "year",
      year: "year",
      mo: "month",
      month: "month",
      kwh: "kilowatt-hour",
      mwh: "megawatt-hour",
      kw: "kilowatt",
      mw: "megawatt",
    };
    const unitSlashMapNo = {
      kg: "kilogram",
      g: "gram",
      t: "tonn",
      ton: "tonn",
      tonne: "tonn",
      oz: "unse",
      sh: "aksje",
      share: "aksje",
      yr: "år",
      year: "år",
      mo: "måned",
      month: "måned",
      kwh: "kilowattime",
      mwh: "megawattime",
      kw: "kilowatt",
      mw: "megawatt",
    };
    const magMapEn = { B: "billion", M: "million", T: "trillion", K: "thousand", bn: "billion", mn: "million" };
    const magMapNo = { B: "milliarder", M: "millioner", T: "billioner", K: "tusen", bn: "milliarder", mn: "millioner" };
    s = s.replace(/\\$([0-9][0-9,.]*)\\s*(B|M|T|K|bn|mn)\\b(?:\\s*\\/\\s*([a-zA-Z]+)\\b)?/g, function (_m, num, mag, unit) {
      const magWord = (isNo ? magMapNo[mag] : magMapEn[mag]) || mag;
      const base = num + " " + magWord + (isNo ? " dollar" : " dollars");
      if (!unit) return base;
      const uLower = unit.toLowerCase();
      const uWord = (isNo ? unitSlashMapNo[uLower] : unitSlashMapEn[uLower]) || unit;
      return base + " per " + uWord;
    });
    s = s.replace(/\\$([0-9][0-9,.]*)\\s*(billion|million|trillion|thousand)\\b/gi, function (_m, num, word) {
      return num + " " + word.toLowerCase() + (isNo ? " dollar" : " dollars");
    });
    s = s.replace(/\\$([0-9][0-9,.]*)\\s*\\/\\s*([a-zA-Z]+)\\b/g, function (_m, num, unit) {
      const uLower = unit.toLowerCase();
      const uWord = (isNo ? unitSlashMapNo[uLower] : unitSlashMapEn[uLower]) || unit;
      return num + (isNo ? " dollar per " : " dollars per ") + uWord;
    });
    s = s.replace(/\\$([0-9][0-9,.]*)\\b/g, function (_m, num) {
      return num + (isNo ? " dollar" : " dollars");
    });
    // Expand scientific units and symbols before generic subscript stripping
    s = s
      .replace(/(^|[^A-Za-z0-9])(?:Iₛₚ|I_sp|Isp)(?![A-Za-z0-9])/g, function (_m, pre) {
        return pre + (isNo ? "spesifikk impuls" : "specific impulse");
      })
      .replace(/Δv\\b/g, "delta-v")
      .replace(/Δ/g, "delta ")
      .replace(/±/g, isNo ? " pluss eller minus " : " plus or minus ")
      .replace(/≥/g, isNo ? " større enn eller lik " : " greater than or equal to ")
      .replace(/≤/g, isNo ? " mindre enn eller lik " : " less than or equal to ")
      .replace(/≈/g, isNo ? " omtrent " : " approximately ")
      .replace(/≠/g, isNo ? " ikke lik " : " not equal to ")
      .replace(/×/g, isNo ? " ganger " : " times ")
      .replace(/÷/g, isNo ? " delt på " : " divided by ")
      .replace(/⇌|↔|⇔/g, isNo ? " i likevekt med " : " in equilibrium with ")
      .replace(/→|⇒/g, isNo ? " til " : " to ")
      .replace(/\\bg\\s*\\/\\s*cm(?:³|\\^3|3)(?![a-zA-Z0-9])/g, isNo ? "gram per kubikkcentimeter" : "grams per cubic centimeter")
      .replace(/\\bkg\\s*\\/\\s*m(?:³|\\^3|3)(?![a-zA-Z0-9])/g, isNo ? "kilogram per kubikkmeter" : "kilograms per cubic meter")
      .replace(/\\bkm\\s*\\/\\s*s(?![a-zA-Z0-9])/g, isNo ? "kilometer per sekund" : "kilometers per second")
      .replace(/\\bm\\s*\\/\\s*s(?:²|\\^2|2)(?![a-zA-Z0-9])/g, isNo ? "meter per sekund i annen" : "meters per second squared")
      .replace(/\\bm\\s*\\/\\s*s(?![a-zA-Z0-9])/g, isNo ? "meter per sekund" : "meters per second")
      .replace(/\\bW\\s*\\/\\s*m(?:²|\\^2|2)(?![a-zA-Z0-9])/g, isNo ? "watt per kvadratmeter" : "watts per square meter")
      .replace(/\\bkW\\s*\\/\\s*kg(?![a-zA-Z0-9])/g, isNo ? "kilowatt per kilogram" : "kilowatts per kilogram")
      .replace(/\\bkm(?:²|\\^2)(?![a-zA-Z0-9])/g, isNo ? "kvadratkilometer" : "square kilometers")
      .replace(/\\bm(?:²|\\^2)(?![a-zA-Z0-9])/g, isNo ? "kvadratmeter" : "square meters")
      .replace(/\\bm(?:³|\\^3)(?![a-zA-Z0-9])/g, isNo ? "kubikkmeter" : "cubic meters")
      .replace(/\\bh⁻¹(?![a-zA-Z0-9])/g, isNo ? "per time" : "per hour")
      .replace(/\\bs⁻¹(?![a-zA-Z0-9])/g, isNo ? "per sekund" : "per second")
      .replace(/(?:μ|µ)g\\b/g, isNo ? "mikro-g" : "micro-g")
      .replace(/(?:μ|µ)m\\b/g, isNo ? "mikrometer" : "micrometers")
      .replace(/§§\\s*(\\d+[A-Za-z]?(?:-\\d+[A-Za-z]?)?)\\s*(?:[–—]|\\s+-\\s+)\\s*(\\d+[A-Za-z]?(?:-\\d+[A-Za-z]?)?)/g, function (_m, a, b) {
        return (isNo ? "paragrafene " : "sections ") + a + (isNo ? " til " : " to ") + b;
      })
      .replace(/§§\\s*(\\d+)-(\\d+)\\b/g, function (full, a, b, offset, str) {
        const rest = String(str).slice(offset + full.length);
        if (/^\\s*(?:og|and|eller|or|,)\\s*\\d+-/i.test(rest) || Number(a) >= Number(b)) {
          return (isNo ? "paragrafene " : "sections ") + a + "-" + b;
        }
        return (isNo ? "paragrafene " : "sections ") + a + (isNo ? " til " : " to ") + b;
      })
      .replace(/§§\\s*(?=\\d)/g, isNo ? "paragrafene " : "sections ")
      .replace(/§\\s*(?=\\d)/g, isNo ? "paragraf " : "section ")
      .replace(/(^|[\\s(])[−-]\\s*(\\d+[0-9,.]*)\\s*°([CF])\\b/g, function (_m, pre, num, scale) {
        return pre + "minus " + num + " °" + scale;
      })
      .replace(/°C\\b/g, isNo ? " grader celsius" : " degrees Celsius")
      .replace(/°F\\b/g, isNo ? " grader fahrenheit" : " degrees Fahrenheit")
      .replace(/°/g, isNo ? " grader " : " degrees ");
    // Normalize subscript/superscript digits in identifiers (e.g. NPV₈ -> NPV 8, CO₂ -> CO2)
    const subDigits = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9", "ₓ": "x" };
    const supDigits = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-" };
    s = s.replace(/\\b(NPV|IRR|TRL|Tier)_?([₀₁₂₃₄₅₆₇₈₉0-9]+)/gi, function (_m, prefix, digits) {
      const cleanD = String(digits).replace(/[₀₁₂₃₄₅₆₇₈₉]/g, function (d) { return subDigits[d] || d; });
      return prefix + " " + cleanD;
    });
    s = s.replace(/[₀₁₂₃₄₅₆₇₈₉ₓ]/g, function (d) { return subDigits[d] || d; });
    s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]/g, function (d) { return supDigits[d] || d; });
    return s.replace(/\\s+/g, " ").trim();
  }

  function cloneDataValue(val) {
    if (val === null || val === undefined || typeof val !== "object") return val;
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(val);
      } catch (_e) {}
    }
    try {
      return JSON.parse(JSON.stringify(val));
    } catch (_e) {
      return val;
    }
  }

  function resolveClientConceptId(href, currentConceptId) {
    const cleanHref = String(href || "").trim().split("#")[0].split("?")[0];
    if (
      !cleanHref ||
      /^[a-z][a-z0-9+.-]*:/i.test(cleanHref) ||
      cleanHref.startsWith("//")
    ) {
      return null;
    }
    if (cleanHref.startsWith("/")) {
      return cleanHref.replace(/^\\/+/, "").replace(/\\.md$/i, "") || null;
    }
    if (!cleanHref.toLowerCase().endsWith(".md")) {
      return null;
    }
    const baseId = String(currentConceptId || "research/current")
      .replace(/^\\/+/, "")
      .replace(/\\.md$/i, "");
    const baseParts = baseId.split("/").filter(Boolean);
    baseParts.pop();
    const relParts = cleanHref.replace(/\\.md$/i, "").split("/");
    for (const part of relParts) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (baseParts.length > 0) baseParts.pop();
      } else {
        baseParts.push(part);
      }
    }
    return baseParts.join("/") || null;
  }

  function syncSurfaceBadgeTones(surface) {
    if (!surface || !surface.components) return;
    const status = String(resolvePointer(surface.dataModel, "/okf/status") || "draft");
    const trustTier = String(resolvePointer(surface.dataModel, "/okf/trustTier") || "unverified");
    const isStale = Boolean(resolvePointer(surface.dataModel, "/okf/isStale"));
    if (surface.components["badge_status"]) {
      surface.components["badge_status"].tone = status === "stable" ? "success" : "warn";
    }
    if (surface.components["badge_trust"]) {
      surface.components["badge_trust"].tone = trustTier === "human-reviewed" ? "accent" : "primary";
    }
    if (surface.components["badge_freshness"]) {
      surface.components["badge_freshness"].tone = isStale ? "danger" : "success";
    }
  }

  function switchActiveRun(surface, targetRunId, bundleRunsOverride) {
    if (!surface || !targetRunId) return false;
    const runs =
      bundleRunsOverride ||
      (typeof payload !== "undefined" && payload && Array.isArray(payload.bundleRuns)
        ? payload.bundleRuns
        : []);
    surface.runStates = surface.runStates || {};
    const curRunId = surface.activeRunId || resolvePointer(surface.dataModel, "/meta/runId");
    if (curRunId) {
      if (
        surface.viewingStubConcept ||
        Boolean(resolvePointer(surface.dataModel, "/okf/viewingStubConcept"))
      ) {
        if (typeof syncChecklistToOkfBody === "function") {
          syncChecklistToOkfBody(surface);
        }
        const primaryCid = resolvePointer(surface.dataModel, "/okf/primaryConceptId") || "";
        navigateOkfMarkdownConcept(surface, primaryCid);
        surface.viewingStubConcept = false;
      }
      surface.runStates[curRunId] = cloneDataValue(surface.dataModel);
    }
    const targetEntry = runs.find((r) => r && r.runId === targetRunId);
    if (!surface.runStates[targetRunId] && targetEntry && targetEntry.dataModel) {
      surface.runStates[targetRunId] = cloneDataValue(targetEntry.dataModel);
    }
    const nextState = surface.runStates[targetRunId];
    if (!nextState) return false;

    const prevIsStage1Only = Boolean(resolvePointer(surface.dataModel, "/meta/isStage1Only"));
    if (typeof stopActiveSpeech === "function") {
      stopActiveSpeech();
    }
    setPointer(surface.dataModel, "/", nextState);
    surface.activeRunId = targetRunId;
    surface.viewingStubConcept = Boolean(
      resolvePointer(surface.dataModel, "/okf/viewingStubConcept")
    );
    syncSurfaceBadgeTones(surface);

    const nextIsStage1Only = Boolean(
      resolvePointer(surface.dataModel, "/meta/isStage1Only") ||
        (targetEntry && targetEntry.isStage1Only)
    );
    if (surface.components) {
      if (surface.components["overview_narration_col"]) {
        surface.components["overview_narration_col"].children = nextIsStage1Only
          ? ["overview_narration_heading", "overview_narration_body"]
          : surface.components["overview_tts_player"]
            ? ["overview_narration_heading", "overview_tts_player", "overview_narration_body"]
            : ["overview_narration_heading", "overview_narration_body"];
      }
      if (surface.components["tab_overview"]) {
        surface.components["tab_overview"].children = nextIsStage1Only
          ? ["overview_narration_card"]
          : surface.components["overview_highlights_card"]
            ? ["overview_narration_card", "overview_highlights_card"]
            : ["overview_narration_card"];
      }
    }
    if (
      surface.components &&
      surface.components["main_tabs"] &&
      Array.isArray(surface.components["main_tabs"].tabs)
    ) {
      if (
        (prevIsStage1Only !== nextIsStage1Only || nextIsStage1Only) &&
        targetEntry &&
        Array.isArray(targetEntry.tabs) &&
        targetEntry.tabs.length > 0
      ) {
        surface.components["main_tabs"].tabs = cloneDataValue(targetEntry.tabs);
        if (surface.uiState && surface.uiState.activeTabs) {
          surface.uiState.activeTabs["main_tabs"] = 0;
        }
      }
      const clCount = Number(resolvePointer(surface.dataModel, "/checklist/totalCount") || 0);
      for (const tab of surface.components["main_tabs"].tabs) {
        if (!tab || !tab.child) continue;
        if (targetEntry && targetEntry.tabTitles && targetEntry.tabTitles[tab.child]) {
          tab.title = targetEntry.tabTitles[tab.child];
        }
        if (tab.child === "tab_checklist" && typeof tab.title === "string") {
          tab.title = tab.title.replace(/\\(\\d+\\)\\s*$/, "(" + clCount + ")");
        }
      }
      updateSourcesBadgeInStudio(surface);
    }

    const nextTitle =
      resolvePointer(surface.dataModel, "/meta/title") ||
      (targetEntry && targetEntry.title) ||
      targetRunId;
    if (typeof document !== "undefined") {
      const topbarTitleEl = document.querySelector(".a2ui-topbar-title");
      if (topbarTitleEl) {
        topbarTitleEl.textContent = String(nextTitle);
      }
      if (document.title) {
        document.title = String(nextTitle) + " — A2UI v0.9.1 Studio";
      }
      const switcherEl = document.getElementById("a2ui-run-switcher-select");
      if (switcherEl && switcherEl.value !== targetRunId) {
        switcherEl.value = targetRunId;
      }
    }

    if (
      typeof renderSurface === "function" &&
      typeof document !== "undefined" &&
      document.getElementById &&
      document.getElementById("a2ui-surface-root")
    ) {
      renderSurface();
    }
    return true;
  }

  function navigateOkfMarkdownConcept(surface, targetConceptId, fallbackLabel, bundleGraphOverride) {
    if (!surface) return false;
    const bg =
      bundleGraphOverride ||
      (typeof bundleGraph !== "undefined" && bundleGraph ? bundleGraph : { bodies: {}, conceptMeta: {} });
    const isNo = isNorwegianSurface(surface);
    const primaryConceptId = String(resolvePointer(surface.dataModel, "/okf/primaryConceptId") || "");

    if (
      !surface.viewingStubConcept &&
      !resolvePointer(surface.dataModel, "/okf/viewingStubConcept")
    ) {
      setPointer(surface.dataModel, "/okf/primaryBody", resolvePointer(surface.dataModel, "/okf/body") || "");
      setPointer(surface.dataModel, "/okf/primaryTitle", resolvePointer(surface.dataModel, "/okf/title") || "");
      setPointer(surface.dataModel, "/okf/primarySources", resolvePointer(surface.dataModel, "/okf/sources") || []);
      setPointer(
        surface.dataModel,
        "/okf/primaryStatus",
        resolvePointer(surface.dataModel, "/okf/status") || "draft"
      );
      setPointer(
        surface.dataModel,
        "/okf/primaryTrustTier",
        resolvePointer(surface.dataModel, "/okf/trustTier") || "unverified"
      );
      setPointer(
        surface.dataModel,
        "/okf/primaryIsStale",
        Boolean(resolvePointer(surface.dataModel, "/okf/isStale"))
      );
      setPointer(
        surface.dataModel,
        "/okf/primaryStatusBadge",
        resolvePointer(surface.dataModel, "/okf/statusBadge") || ""
      );
      setPointer(
        surface.dataModel,
        "/okf/primaryTrustBadge",
        resolvePointer(surface.dataModel, "/okf/trustBadge") || ""
      );
      setPointer(
        surface.dataModel,
        "/okf/primaryFreshnessBadge",
        resolvePointer(surface.dataModel, "/okf/freshnessBadge") || ""
      );
      setPointer(
        surface.dataModel,
        "/okf/primarySourcesBadge",
        resolvePointer(surface.dataModel, "/okf/sourcesBadge") || ""
      );
    }

    if (!targetConceptId || (primaryConceptId && targetConceptId === primaryConceptId)) {
      const origBody = resolvePointer(surface.dataModel, "/okf/primaryBody");
      const origTitle = resolvePointer(surface.dataModel, "/okf/primaryTitle");
      const origSources = resolvePointer(surface.dataModel, "/okf/primarySources");
      const origStatus = resolvePointer(surface.dataModel, "/okf/primaryStatus");
      const origTrustTier = resolvePointer(surface.dataModel, "/okf/primaryTrustTier");
      const origIsStale = resolvePointer(surface.dataModel, "/okf/primaryIsStale");
      const origStatusBadge = resolvePointer(surface.dataModel, "/okf/primaryStatusBadge");
      const origTrustBadge = resolvePointer(surface.dataModel, "/okf/primaryTrustBadge");
      const origFreshnessBadge = resolvePointer(surface.dataModel, "/okf/primaryFreshnessBadge");
      const origSourcesBadge = resolvePointer(surface.dataModel, "/okf/primarySourcesBadge");
      if (origBody !== undefined) setPointer(surface.dataModel, "/okf/body", origBody);
      if (origTitle !== undefined) setPointer(surface.dataModel, "/okf/title", origTitle);
      if (origSources !== undefined) setPointer(surface.dataModel, "/okf/sources", origSources);
      if (origStatus !== undefined) setPointer(surface.dataModel, "/okf/status", origStatus);
      if (origTrustTier !== undefined) setPointer(surface.dataModel, "/okf/trustTier", origTrustTier);
      if (origIsStale !== undefined) setPointer(surface.dataModel, "/okf/isStale", Boolean(origIsStale));
      if (origStatusBadge) setPointer(surface.dataModel, "/okf/statusBadge", origStatusBadge);
      if (origTrustBadge) setPointer(surface.dataModel, "/okf/trustBadge", origTrustBadge);
      if (origFreshnessBadge) setPointer(surface.dataModel, "/okf/freshnessBadge", origFreshnessBadge);
      if (origSourcesBadge) setPointer(surface.dataModel, "/okf/sourcesBadge", origSourcesBadge);
      setPointer(surface.dataModel, "/okf/activeConceptId", primaryConceptId || targetConceptId || "");
      setPointer(surface.dataModel, "/okf/viewingStubConcept", false);
      surface.viewingStubConcept = false;
      setPointer(surface.dataModel, "/okf/editMode", false);
      syncSurfaceBadgeTones(surface);
      syncOkfBodyToChecklist(surface);
      return true;
    }

    const cMeta = (bg.conceptMeta && bg.conceptMeta[targetConceptId]) || null;
    const stubNote = isNo
      ? "\\n\\n*Dette OKF-konseptet (\\x60/" + targetConceptId + ".md\\x60) er kryssreferert fra hovedkonseptet.*"
      : "\\n\\n*This OKF concept (\\x60/" + targetConceptId + ".md\\x60) is cross-referenced from the primary concept.*";
    const targetBody =
      (bg.bodies && bg.bodies[targetConceptId]) ||
      "# " + (fallbackLabel || (cMeta && cMeta.title) || targetConceptId).trim() + stubNote;

    setPointer(surface.dataModel, "/okf/activeConceptId", targetConceptId);
    setPointer(surface.dataModel, "/okf/body", targetBody);
    setPointer(
      surface.dataModel,
      "/okf/title",
      (cMeta && cMeta.title) || fallbackLabel || targetConceptId
    );
    setPointer(surface.dataModel, "/okf/sources", (cMeta && cMeta.sources) || []);
    setPointer(
      surface.dataModel,
      "/okf/status",
      (cMeta && cMeta.status) || "draft"
    );
    setPointer(
      surface.dataModel,
      "/okf/trustTier",
      (cMeta && cMeta.trustTier) || "unverified"
    );
    setPointer(surface.dataModel, "/okf/isStale", Boolean(cMeta && cMeta.isStale));
    if (cMeta) {
      if (cMeta.statusBadge) setPointer(surface.dataModel, "/okf/statusBadge", cMeta.statusBadge);
      if (cMeta.trustBadge) setPointer(surface.dataModel, "/okf/trustBadge", cMeta.trustBadge);
      if (cMeta.freshnessBadge) setPointer(surface.dataModel, "/okf/freshnessBadge", cMeta.freshnessBadge);
      if (cMeta.sourcesBadge) setPointer(surface.dataModel, "/okf/sourcesBadge", cMeta.sourcesBadge);
    }
    setPointer(surface.dataModel, "/okf/viewingStubConcept", true);
    surface.viewingStubConcept = true;
    setPointer(surface.dataModel, "/okf/editMode", false);
    syncSurfaceBadgeTones(surface);
    syncOkfBodyToChecklist(surface);
    return true;
  }

  function inspectSourceCitationsInBody(bodyMd, srcId, rejectedSourceIds) {
    if (Array.isArray(srcId)) {
      const mapRes = {};
      for (let idx = 0; idx < srcId.length; idx++) {
        const sItem = srcId[idx];
        const sid = sItem && typeof sItem === "object" ? sItem.id : sItem;
        if (sid) {
          mapRes[String(sid)] = inspectSourceCitationsInBody(bodyMd, String(sid), rejectedSourceIds);
        }
      }
      return mapRes;
    }
    const targetId = String(srcId || "").trim().replace(/^\\[\\^?/, "").replace(/\\]$/, "");
    if (!targetId) {
      return { mentionCount: 0, soleClaimLines: [] };
    }
    const rejectedSet = new Set(
      Array.isArray(rejectedSourceIds)
        ? rejectedSourceIds.map(function (r) {
            return String(r || "").trim().replace(/^\\[\\^?/, "").replace(/\\]$/, "");
          })
        : []
    );
    const lines = String(bodyMd || "").split(/\\r?\\n/);
    let mentionCount = 0;
    const soleClaimLines = [];
    function extractCitedIds(text) {
      const fnRegex = /\\[\\^([^\\r\\n\\]]+)\\]/g;
      const ids = [];
      let m;
      while ((m = fnRegex.exec(text)) !== null) {
        const cid = String(m[1] || "").trim();
        if (cid) ids.push(cid);
      }
      return ids;
    }
    function pushCleanClaim(rawSegment) {
      const cleanClaim = stripClientFootnotesPreservingBoundaries(rawSegment)
        .replace(/^\\s*(?:[-*+]|\\d+[.)])\\s+(?:\\[[ xX]\\]\\s+)?/, "")
        .replace(/\\s+/g, " ")
        .trim();
      if (cleanClaim && soleClaimLines.indexOf(cleanClaim) === -1) {
        soleClaimLines.push(cleanClaim);
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\\s*\\[\\^[^\\]]+\\]:/.test(trimmed)) continue;
      const citedIds = extractCitedIds(trimmed);
      if (citedIds.length === 0) continue;
      let citesTargetCount = 0;
      for (let j = 0; j < citedIds.length; j++) {
        if (citedIds[j] === targetId) citesTargetCount++;
      }
      if (citesTargetCount === 0) continue;
      mentionCount += citesTargetCount;
      const remainingActive = citedIds.filter(function (id) {
        return id !== targetId && !rejectedSet.has(id);
      });
      if (remainingActive.length === 0) {
        pushCleanClaim(trimmed);
      } else {
        const subSegments =
          trimmed.startsWith("|") && trimmed.endsWith("|")
            ? trimmed
                .split("|")
                .map(function (s) {
                  return s.trim();
                })
                .filter(Boolean)
            : trimmed
                .split(/(?<=[.?!](?:\\s*\\[\\^[^\\]]+\\])*)\\s+/)
                .map(function (s) {
                  return s.trim();
                })
                .filter(Boolean);
        if (subSegments.length > 1) {
          for (let sIdx = 0; sIdx < subSegments.length; sIdx++) {
            const seg = subSegments[sIdx];
            const segIds = extractCitedIds(seg);
            if (segIds.indexOf(targetId) === -1) continue;
            const segRemaining = segIds.filter(function (id) {
              return id !== targetId && !rejectedSet.has(id);
            });
            if (segRemaining.length === 0) {
              pushCleanClaim(seg);
            }
          }
        }
      }
    }
    return { mentionCount: mentionCount, soleClaimLines: soleClaimLines };
  }

  function updateSourcesBadgeInStudio(surface) {
    if (!surface || !surface.dataModel) return;
    const sources = resolvePointer(surface.dataModel, "/okf/sources") || [];
    const rejected = resolvePointer(surface.dataModel, "/okf/rejectedSources") || [];
    const rejSet = new Set(rejected.map(String));
    const activeCount = sources.filter(function (s) {
      return s && !rejSet.has(String(s.id));
    }).length;
    const isNo = isNorwegianSurface(surface);
    const badgeText = activeCount + (isNo ? " verifiserte" + " kilder" : " verified sources");
    setPointer(surface.dataModel, "/okf/sourcesBadge", badgeText);
    if (
      !surface.viewingStubConcept &&
      !resolvePointer(surface.dataModel, "/okf/viewingStubConcept")
    ) {
      setPointer(surface.dataModel, "/okf/primarySourcesBadge", badgeText);
    }
    if (
      surface.components &&
      surface.components["main_tabs"] &&
      Array.isArray(surface.components["main_tabs"].tabs)
    ) {
      for (let i = 0; i < surface.components["main_tabs"].tabs.length; i++) {
        const tab = surface.components["main_tabs"].tabs[i];
        if (tab && tab.child === "tab_okf_markdown" && typeof tab.title === "string") {
          tab.title = tab.title.replace(/\\(\\d+\\)\\s*$/, "(" + activeCount + ")");
        }
      }
    }
  }

  function inspectClientSourceDomainProvenance(src) {
    const rawUrl = String((src && (src.url || src.resource)) || "").trim();
    if (!rawUrl || rawUrl.indexOf("vertexaisearch.cloud.google.com/grounding-api-redirect/") !== -1) {
      return { hostname: "", isDirectFileAsset: false, claimedPublisher: "", domainMismatch: false };
    }
    let parsed = null;
    try {
      parsed = new URL(rawUrl);
    } catch (_e) {
      return { hostname: "", isDirectFileAsset: false, claimedPublisher: "", domainMismatch: false };
    }
    const hostname = String(parsed.hostname || "").toLowerCase().replace(/^www\\./, "");
    if (!hostname) {
      return { hostname: "", isDirectFileAsset: false, claimedPublisher: "", domainMismatch: false };
    }
    const isDirectFileAsset =
      /\\.(?:pdf|docx?|xlsx?|pptx?)(?:$|[?#])/i.test(parsed.pathname || "") ||
      /\\/(?:s3assets[^/]*|getfile(?:\\.aspx)?|wp-content\\/uploads|uploads|attachments)\\b/i.test(
        parsed.pathname || ""
      ) ||
      /(?:amazonaws\\.com|cloudfront\\.net|blob\\.core\\.windows\\.net|storage\\.googleapis\\.com)$/i.test(
        hostname
      );
    const rawTitle = String((src && src.title) || "").trim();
    if (!rawTitle) {
      return { hostname: hostname, isDirectFileAsset: isDirectFileAsset, claimedPublisher: "", domainMismatch: false };
    }
    const viaAnnotMatch = rawTitle.match(/\\s*\\(via\\s+([a-z0-9.-]+\\.[a-z]{2,})\\)\\s*$/i);
    const titleWithoutVia = viaAnnotMatch
      ? rawTitle.slice(0, rawTitle.length - viaAnnotMatch[0].length).trim()
      : rawTitle;
    const sepMatch = titleWithoutVia.match(/\\s+(?:([|])|[–—]|-\\s)\\s*([^–—|]{2,60})\\s*$/);
    if (!sepMatch) {
      return { hostname: hostname, isDirectFileAsset: isDirectFileAsset, claimedPublisher: "", domainMismatch: false };
    }
    const prefixHostCandidate = titleWithoutVia
      .slice(0, sepMatch.index || 0)
      .trim()
      .toLowerCase()
      .replace(/^www\\./, "");
    if (
      prefixHostCandidate &&
      (prefixHostCandidate === hostname ||
        hostname.slice(-prefixHostCandidate.length - 1) === "." + prefixHostCandidate)
    ) {
      return { hostname: hostname, isDirectFileAsset: isDirectFileAsset, claimedPublisher: "", domainMismatch: false };
    }
    const isPipeSep = sepMatch[1] === "|";
    const candidatePub = sepMatch[2].trim();
    const pubWords = candidatePub.split(/\\s+/).filter(Boolean);
    if (pubWords.length === 0 || pubWords.length > 6) {
      return { hostname: hostname, isDirectFileAsset: isDirectFileAsset, claimedPublisher: "", domainMismatch: false };
    }
    if (
      (/^[a-zæøåäö]/.test(candidatePub) && !/\\.[a-z]{2,}$/i.test(candidatePub)) ||
      /^(?:§+|kap(?:ittel|\\.)?\\s*\\d|del\\s+\\d|part\\s+\\d|ch(?:apter|\\.)\\s*\\d|sec(?:tion\\b|\\.\\s*\\d|\\s+\\d)|mod(?:ul|ule|\\.)\\s*\\d|steg\\s+\\d|step\\s+\\d|fase\\s+\\d|phase\\s+\\d|tabell\\b|table\\b|figur\\b|figure\\b|vedlegg\\b|appendix\\b|rev(?:ision\\b|\\.\\s*\\d|\\s+\\d)|v\\d|\\d{4}\\b|q[1-4]\\b)/i.test(
        candidatePub
      ) ||
      /^\\d+[\\d\\s.,:\\-–/]*$/.test(candidatePub)
    ) {
      return { hostname: hostname, isDirectFileAsset: isDirectFileAsset, claimedPublisher: "", domainMismatch: false };
    }
    function normClientAscii(s) {
      return String(s || "")
        .toLowerCase()
        .replace(/æ/g, "ae")
        .replace(/ø/g, "oe")
        .replace(/å/g, "aa")
        .normalize("NFD")
        .replace(/[\\u0300-\\u036f]/g, "");
    }
    const pubSlug = normClientAscii(candidatePub)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const srcIdLower = String((src && src.id) || "").toLowerCase();
    const idEncodesPub = Boolean(
      pubSlug &&
        pubSlug.length >= 3 &&
        (srcIdLower.slice(-pubSlug.length - 1) === "-" + pubSlug ||
          srcIdLower.indexOf(pubSlug + "-") === 0)
    );
    const hasParenAcronym = /\\([A-ZÆØÅ0-9]{2,10}\\)\\s*$/.test(candidatePub);
    if (
      !isPipeSep &&
      !hasParenAcronym &&
      !idEncodesPub &&
      (pubWords.length > 4 ||
        /\\b(?:oversikt|overview|innledning|introduction|sammendrag|summary|veiledning|veileder|guide|guidelines|sjekkliste|checklist|kontrollrutiner|gjennomforing|gjennomføring|analyse|analysis|vurdering|assessment|krav|requirements|praksis|tiltak|actions|rapport|report|utgave|edition|hovedpunkter|key\\s+points)\\b/i.test(
          candidatePub
        ))
    ) {
      return { hostname: hostname, isDirectFileAsset: isDirectFileAsset, claimedPublisher: "", domainMismatch: false };
    }
    if (
      /\\.(?:gov|gov\\.[a-z]{2}|mil|int)$/i.test(hostname) ||
      /(?:^|\\.)(?:regjeringen\\.no|stortinget\\.no|europa\\.eu|canada\\.ca|gov\\.uk|usa\\.gov|who\\.int|un\\.org|oecd\\.org|worldbank\\.org)$/i.test(
        hostname
      )
    ) {
      return {
        hostname: hostname,
        isDirectFileAsset: isDirectFileAsset,
        claimedPublisher: candidatePub,
        domainMismatch: false,
      };
    }
    const hostIgnore = new Set([
      "www", "www2", "wwwex", "web", "secure", "portal", "app", "api", "docs", "cdn", "static", "files", "media",
      "no", "com", "org", "net", "edu", "gov", "int", "eu", "uk", "de", "se", "dk", "fi", "is", "nl", "fr", "es",
      "it", "ch", "at", "be", "ca", "au", "nz", "us", "io", "ai", "co"
    ]);
    const hostTokens = hostname
      .split(".")
      .map(function (p) { return p.replace(/[^a-z0-9]/g, ""); })
      .filter(function (p) { return p.length >= 2 && !hostIgnore.has(p); });
    if (hostTokens.length === 0) {
      return {
        hostname: hostname,
        isDirectFileAsset: isDirectFileAsset,
        claimedPublisher: candidatePub,
        domainMismatch: false,
      };
    }
    const pubStop = new Set([
      "for", "og", "and", "of", "the", "in", "on", "til", "av", "om", "i", "de", "la", "du", "des", "und", "fur", "van", "het", "us", "uk"
    ]);
    const rawPubTokens = normClientAscii(candidatePub.replace(/\\([^)]*\\)/g, " "))
      .split(/[^a-z0-9]+/)
      .filter(function (t) { return t.length >= 2 && !pubStop.has(t); });
    const pubJoined = rawPubTokens.join("");
    const acronyms = new Set();
    const parenRe = /\\(([A-Za-zÆØÅæøå0-9]{2,12})\\)/g;
    let pm;
    while ((pm = parenRe.exec(candidatePub)) !== null) {
      acronyms.add(normClientAscii(pm[1]).replace(/[^a-z0-9]/g, ""));
    }
    const upperRe = /\\b([A-ZÆØÅ]{2,10})\\b/g;
    let um;
    while ((um = upperRe.exec(candidatePub)) !== null) {
      acronyms.add(normClientAscii(um[1]).replace(/[^a-z0-9]/g, ""));
    }
    if (rawPubTokens.length >= 2) {
      acronyms.add(rawPubTokens.map(function (t) { return t[0]; }).join(""));
    }
    const matchesHost = hostTokens.some(function (hp) {
      if (acronyms.has(hp)) return true;
      let acMatch = false;
      acronyms.forEach(function (ac) {
        if (ac.length >= 3 && (hp.indexOf(ac) !== -1 || ac.indexOf(hp) !== -1)) acMatch = true;
      });
      if (acMatch) return true;
      for (let k = 0; k < rawPubTokens.length; k++) {
        const pt = rawPubTokens[k];
        if (pt === hp) return true;
        if (pt.length >= 4 && hp.indexOf(pt) !== -1) return true;
        if (hp.length >= 4 && pt.indexOf(hp) !== -1) return true;
      }
      if (hp.length >= 4 && pubJoined.indexOf(hp[0]) === 0 && pubJoined.indexOf(hp.slice(1)) !== -1) {
        return true;
      }
      for (let splitAt = 2; splitAt <= Math.min(4, hp.length - 3); splitAt++) {
        if (
          pubJoined.indexOf(hp.slice(0, splitAt)) === 0 &&
          pubJoined.indexOf(hp.slice(splitAt), splitAt) !== -1
        ) {
          return true;
        }
      }
      if (rawPubTokens.length >= 2 && hp.length >= 3 && hp.length <= 8) {
        function matchClientSyllabicTokens(tokIdx, hpIdx) {
          if (tokIdx === rawPubTokens.length) return hpIdx === hp.length;
          if (hpIdx >= hp.length) return false;
          const tok = rawPubTokens[tokIdx];
          if (tok[0] !== hp[hpIdx]) return false;
          const maxPrefix = Math.min(4, tok.length, hp.length - hpIdx);
          for (let len = 1; len <= maxPrefix; len++) {
            if (tok.slice(0, len) === hp.slice(hpIdx, hpIdx + len)) {
              if (matchClientSyllabicTokens(tokIdx + 1, hpIdx + len)) return true;
            }
          }
          if (tok.length >= 8) {
            const maxStem = Math.min(4, hp.length - hpIdx - 1);
            for (let remLen = 1; remLen <= maxStem; remLen++) {
              const sub = hp.slice(hpIdx + 1, hpIdx + 1 + remLen);
              const minOffset = remLen === 1 ? 3 : 2;
              if (tok.indexOf(sub, minOffset) !== -1) {
                if (matchClientSyllabicTokens(tokIdx + 1, hpIdx + 1 + remLen)) return true;
              }
            }
          }
          return false;
        }
        if (matchClientSyllabicTokens(0, 0)) return true;
      }
      return false;
    });
    return {
      hostname: hostname,
      isDirectFileAsset: isDirectFileAsset,
      claimedPublisher: candidatePub,
      domainMismatch: !matchesHost || Boolean(viaAnnotMatch),
    };
  }

  function buildCurationPrompts(surface) {
    if (!surface || !surface.dataModel) {
      return { agyText: "", cliText: "" };
    }
    const isNo = isNorwegianSurface(surface);
    const isStage1Only = Boolean(
      resolvePointer(surface.dataModel, "/stage1/isStage1Only") ||
        resolvePointer(surface.dataModel, "/meta/isStage1Only")
    );
    const runId = String(resolvePointer(surface.dataModel, "/meta/runId") || "<runId>");
    const rejectedRaw = (resolvePointer(surface.dataModel, "/okf/rejectedSources") || [])
      .filter(Boolean)
      .map(String);
    const rejectedSet = new Set(rejectedRaw);
    const addedRaw = (resolvePointer(surface.dataModel, "/okf/addedSources") || []).filter(function (a) {
      return a && a.url;
    });
    const addedIdSet = new Set(
      addedRaw
        .map(function (a) {
          return String(a.id || "");
        })
        .filter(Boolean)
    );
    const rejected = rejectedRaw.filter(function (id) {
      return !addedIdSet.has(id);
    });
    const added = addedRaw.filter(function (a) {
      return !a.id || !rejectedSet.has(String(a.id));
    });
    const replacedRaw = resolvePointer(surface.dataModel, "/okf/replacedSources") || {};
    const replaceKeySet = new Set();
    for (let rIdx = 0; rIdx < rejected.length; rIdx++) {
      replaceKeySet.add(rejected[rIdx]);
    }
    Object.keys(replacedRaw).forEach(function (k) {
      if (k) replaceKeySet.add(String(k));
    });
    const replacePairs = [];
    replaceKeySet.forEach(function (oldKey) {
      const replTarget = String(replacedRaw[oldKey] || "").trim();
      if (replTarget && replTarget !== oldKey && !rejectedSet.has(replTarget)) {
        replacePairs.push(oldKey + "=" + replTarget);
      }
    });
    let byActor = String(resolvePointer(surface.dataModel, "/okf/verifierActor") || "").trim();
    if (!byActor || byActor === "human:styrer" || byActor === "human:reviewer") {
      try {
        const savedActor =
          typeof localStorage !== "undefined"
            ? String(localStorage.getItem("icm_a2ui_verifier_actor") || "").trim()
            : "";
        if (savedActor) byActor = savedActor;
      } catch (_e) {}
    }
    if (!byActor) {
      byActor = isNo ? "human:styrer" : "human:reviewer";
    } else if (
      byActor.indexOf("human:") !== 0 &&
      byActor.indexOf("process:") !== 0 &&
      byActor.indexOf("/") === -1
    ) {
      byActor = "human:" + byActor;
    }
    const byFlagPart = /\\s/.test(byActor)
      ? '--by "' + byActor.replace(/"/g, '\\\\"') + '"'
      : "--by " + byActor;

    const cliParts = ["npm run cli:verify -- " + runId];
    if (rejected.length > 0) {
      cliParts.push("--reject-source " + rejected.join(","));
    }
    for (let rpIdx = 0; rpIdx < replacePairs.length; rpIdx++) {
      const rp = replacePairs[rpIdx];
      cliParts.push(
        /[\\s|&;()"]/.test(rp)
          ? '--replace-source "' + rp.replace(/"/g, '\\\\"') + '"'
          : "--replace-source " + rp
      );
    }
    for (let i = 0; i < added.length; i++) {
      const item = added[i];
      const spec =
        item.title && item.title !== item.url ? item.url + "|" + item.title : item.url;
      cliParts.push('--add-source "' + String(spec).replace(/"/g, '\\\\"') + '"');
    }
    cliParts.push(byFlagPart);
    const cliText = cliParts.join(" ");

    let agyText = "";
    if (rejected.length === 0 && added.length === 0 && replacePairs.length === 0) {
      if (isStage1Only) {
        agyText = isNo
          ? "Jeg har gjennomgått a2ui.html og godkjenner alle kildene — kjør " +
            cliText +
            " og gå videre til Stage 2."
          : "I have reviewed a2ui.html and approve all sources — run " +
            cliText +
            " and proceed to Stage 2.";
      } else {
        agyText = isNo
          ? "Jeg har gjennomgått a2ui.html og godkjenner alle kildene — kjør " +
            cliText +
            " og oppdater A2UI-studioet."
          : "I have reviewed a2ui.html and approve all sources — run " +
            cliText +
            " and refresh the A2UI studio.";
      }
    } else {
      const rejList = rejected.join(", ");
      const addList = added
        .map(function (a) {
          return a.title && a.title !== a.url ? a.url + "|" + a.title : a.url;
        })
        .join(", ");
      const segs = [];
      if (isNo) {
        if (rejected.length > 0) segs.push("Avvis kilder: [" + rejList + "].");
        if (replacePairs.length > 0) segs.push("Erstatt siteringer: [" + replacePairs.join(", ") + "].");
        if (added.length > 0) segs.push("Legg til kilder: [" + addList + "].");
        segs.push(
          isStage1Only
            ? "Kjør " +
                cliText +
                " (bruk --replace-source gammelId=nyId_eller_URL i cli:verify for å re-ankre siteringer fra avviste kilder til eksisterende/nye kilder uten å omskrive hele research_summary.md; rediger kun enkeltsetninger ved reelle faktaendringer) og gå videre til Stage 2."
            : "Kjør " +
                cliText +
                " (bruk --replace-source gammelId=nyId_eller_URL i cli:verify for å re-ankre siteringer uten å omskrive hele research_summary.md) for å oppdatere kunnskapsgrunnlaget og A2UI-studioet (uten å kjøre Stage 2 på nytt med mindre påstander i kurset må endres)."
        );
      } else {
        if (rejected.length > 0) segs.push("Reject sources: [" + rejList + "].");
        if (replacePairs.length > 0) segs.push("Replace citations: [" + replacePairs.join(", ") + "].");
        if (added.length > 0) segs.push("Add sources: [" + addList + "].");
        segs.push(
          isStage1Only
            ? "Run " +
                cliText +
                " (use --replace-source oldId=newId_or_URL in cli:verify to re-anchor citations from rejected sources to existing/added sources without rewriting research_summary.md; only edit specific sentences if factual claims must change) and proceed to Stage 2."
            : "Run " +
                cliText +
                " (use --replace-source oldId=newId_or_URL in cli:verify to re-anchor citations without rewriting research_summary.md) to refresh the knowledge base and A2UI studio (without re-running Stage 2 unless course claims changed)."
        );
      }
      agyText = segs.join(" ");
    }

    setPointer(surface.dataModel, "/okf/curationAgyText", agyText);
    setPointer(surface.dataModel, "/okf/curationCliText", cliText);
    return { agyText: agyText, cliText: cliText };
  }

  function slugifySourceIdInStudio(rawText, existingIds) {
    const existingSet =
      existingIds instanceof Set
        ? existingIds
        : new Set(Array.isArray(existingIds) ? existingIds.map(String) : []);
    const base =
      String(rawText || "")
        .toLowerCase()
        .replace(/æ/g, "ae")
        .replace(/ø/g, "oe")
        .replace(/å/g, "aa")
        .replace(/^https?:\\/\\/(?:www\\.)?/i, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 28)
        .replace(/-+$/g, "") || "kilde";
    let candidate = base;
    let counter = 2;
    while (existingSet.has(candidate)) {
      candidate = base + "-" + counter;
      counter++;
    }
    return candidate;
  }

  function setReplaceSourceInStudio(surface, oldId, newTarget) {
    const cleanOld = String(oldId || "").trim();
    if (!surface || !surface.dataModel || !cleanOld) return {};
    const currentMap = Object.assign(
      {},
      resolvePointer(surface.dataModel, "/okf/replacedSources") || {}
    );
    const openMap = Object.assign(
      {},
      resolvePointer(surface.dataModel, "/okf/replaceOpenSources") || {}
    );
    let cleanTarget = String(newTarget || "").trim();
    if (
      cleanTarget &&
      !/^[A-Za-z0-9_\\-]+$/.test(cleanTarget) &&
      !/^https?:\\/\\//i.test(cleanTarget) &&
      /^[a-z0-9.-]+\\.[a-z]{2,}\\/\\S*$/i.test(cleanTarget)
    ) {
      cleanTarget = "https://" + cleanTarget;
    }
    if (!cleanTarget || cleanTarget === cleanOld) {
      delete currentMap[cleanOld];
    } else {
      currentMap[cleanOld] = cleanTarget;
      openMap[cleanOld] = true;
    }
    setPointer(surface.dataModel, "/okf/replacedSources", currentMap);
    setPointer(surface.dataModel, "/okf/replaceOpenSources", openMap);
    buildCurationPrompts(surface);
    if (
      typeof renderSurface === "function" &&
      typeof document !== "undefined" &&
      document.getElementById &&
      document.getElementById("a2ui-surface-root")
    ) {
      renderSurface();
    }
    return currentMap;
  }

  function toggleReplacePanelInStudio(surface, srcId) {
    const cleanId = String(srcId || "").trim();
    if (!surface || !surface.dataModel || !cleanId) return {};
    const openMap = Object.assign(
      {},
      resolvePointer(surface.dataModel, "/okf/replaceOpenSources") || {}
    );
    const replacedMap = Object.assign(
      {},
      resolvePointer(surface.dataModel, "/okf/replacedSources") || {}
    );
    const rejectedList = resolvePointer(surface.dataModel, "/okf/rejectedSources") || [];
    const isRej = rejectedList.indexOf(cleanId) !== -1;
    if (!isRej && replacedMap[cleanId]) {
      delete replacedMap[cleanId];
      delete openMap[cleanId];
    } else if (openMap[cleanId]) {
      delete openMap[cleanId];
    } else {
      openMap[cleanId] = true;
    }
    setPointer(surface.dataModel, "/okf/replacedSources", replacedMap);
    setPointer(surface.dataModel, "/okf/replaceOpenSources", openMap);
    buildCurationPrompts(surface);
    if (
      typeof renderSurface === "function" &&
      typeof document !== "undefined" &&
      document.getElementById &&
      document.getElementById("a2ui-surface-root")
    ) {
      renderSurface();
    }
    return openMap;
  }

  function toggleRejectSourceInStudio(surface, srcId) {
    const cleanId = String(srcId || "").trim();
    if (!surface || !surface.dataModel || !cleanId) return [];
    const current = (resolvePointer(surface.dataModel, "/okf/rejectedSources") || []).slice();
    const replacedMap = Object.assign(
      {},
      resolvePointer(surface.dataModel, "/okf/replacedSources") || {}
    );
    const openMap = Object.assign(
      {},
      resolvePointer(surface.dataModel, "/okf/replaceOpenSources") || {}
    );
    delete openMap[cleanId];
    const idx = current.indexOf(cleanId);
    if (idx === -1) {
      current.push(cleanId);
      const sourcesList = resolvePointer(surface.dataModel, "/okf/sources") || [];
      let rejUrl = "";
      for (let i = 0; i < sourcesList.length; i++) {
        if (sourcesList[i] && String(sourcesList[i].id) === cleanId) {
          rejUrl = String(sourcesList[i].url || sourcesList[i].resource || "");
          break;
        }
      }
      Object.keys(replacedMap).forEach(function (k) {
        if (replacedMap[k] === cleanId || (rejUrl && replacedMap[k] === rejUrl)) {
          delete replacedMap[k];
        }
      });
    } else {
      current.splice(idx, 1);
      delete replacedMap[cleanId];
    }
    setPointer(surface.dataModel, "/okf/rejectedSources", current);
    setPointer(surface.dataModel, "/okf/replacedSources", replacedMap);
    setPointer(surface.dataModel, "/okf/replaceOpenSources", openMap);

    const bodyMd = String(resolvePointer(surface.dataModel, "/okf/body") || "");
    const sources = resolvePointer(surface.dataModel, "/okf/sources") || [];
    const statsMap = {};
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      if (s && s.id) {
        statsMap[s.id] = inspectSourceCitationsInBody(bodyMd, s.id, current);
      }
    }
    setPointer(surface.dataModel, "/okf/sourceCitationStats", statsMap);
    updateSourcesBadgeInStudio(surface);
    buildCurationPrompts(surface);

    if (
      typeof renderSurface === "function" &&
      typeof document !== "undefined" &&
      document.getElementById &&
      document.getElementById("a2ui-surface-root")
    ) {
      renderSurface();
    }
    return current;
  }

  function addSourceInStudio(surface, url, title) {
    const cleanUrl = String(url || "").trim();
    if (!surface || !surface.dataModel || !cleanUrl) return null;
    const rawTitle = String(title || "").trim();
    const cleanTitle = rawTitle || cleanUrl;
    const sources = (resolvePointer(surface.dataModel, "/okf/sources") || []).slice();
    const existingIds = new Set(
      sources.map(function (s) {
        return String((s && s.id) || "");
      })
    );
    const id = slugifySourceIdInStudio(rawTitle || cleanUrl, existingIds);
    const retrievedAt = new Date().toISOString().replace(/\\.\\d{3}Z$/, "Z");
    const newSrc = {
      id: id,
      resource: cleanUrl,
      url: cleanUrl,
      title: cleanTitle,
      retrieved_at: retrievedAt,
      addedByHuman: true,
    };
    sources.push(newSrc);
    setPointer(surface.dataModel, "/okf/sources", sources);

    const added = (resolvePointer(surface.dataModel, "/okf/addedSources") || []).slice();
    added.push({ id: id, url: cleanUrl, title: rawTitle });
    setPointer(surface.dataModel, "/okf/addedSources", added);

    const curBody = String(resolvePointer(surface.dataModel, "/okf/body") || "");
    const updatedBody = curBody.replace(/\\s*$/, "") + "\\n[^" + id + "]: " + cleanTitle + "\\n";
    setPointer(surface.dataModel, "/okf/body", updatedBody);
    if (
      !surface.viewingStubConcept &&
      !resolvePointer(surface.dataModel, "/okf/viewingStubConcept")
    ) {
      setPointer(surface.dataModel, "/okf/primaryBody", updatedBody);
      setPointer(surface.dataModel, "/okf/primarySources", sources);
    }

    updateSourcesBadgeInStudio(surface);
    buildCurationPrompts(surface);

    if (
      typeof renderSurface === "function" &&
      typeof document !== "undefined" &&
      document.getElementById &&
      document.getElementById("a2ui-surface-root")
    ) {
      renderSurface();
    }
    return newSrc;
  }

  var payload = (typeof window !== "undefined" && window.A2UI_SURFACE_PAYLOAD) || {};
  var messages = payload.messages || [];
  var bundleGraph = payload.bundleGraph || { nodes: [], edges: [], bodies: {}, types: [], palette: {}, conceptMeta: {}, sourceNodeByFnId: {}, sourceNodeByAnyFnId: {} };
  var bundleRuns = Array.isArray(payload.bundleRuns) ? payload.bundleRuns : [];

  // A2UI Client Surface State (Adjacency List + RFC 6901 JSON Pointer Data Model)
  const surfaces = {};
  const actionLog = [];
  let activeSurfaceId = payload.surfaceId || "icm_run_studio";

  function mountSurface(surface) {
    if (surface && surface.surfaceId) {
      surfaces[surface.surfaceId] = surface;
      activeSurfaceId = surface.surfaceId;
    }
    return surface;
  }

  if (typeof window !== "undefined" && window.__ICM_TEST_HOOKS__) {
    window.__ICM_TEST_HOOKS__.formatInlineLatexAndFootnotes = formatInlineLatexAndFootnotes;
    window.__ICM_TEST_HOOKS__.cleanClientChecklistLabel = cleanClientChecklistLabel;
    window.__ICM_TEST_HOOKS__.extractChecklistGroupsClient = extractChecklistGroupsClient;
    window.__ICM_TEST_HOOKS__.isInlineLatexMath = isInlineLatexMath;
    window.__ICM_TEST_HOOKS__.replaceInlineLatexSpans = replaceInlineLatexSpans;
    window.__ICM_TEST_HOOKS__.detectSpeechLang = detectSpeechLang;
    window.__ICM_TEST_HOOKS__.normalizeTextForTts = normalizeTextForTts;
    window.__ICM_TEST_HOOKS__.resolvePointer = resolvePointer;
    window.__ICM_TEST_HOOKS__.setPointer = setPointer;
    window.__ICM_TEST_HOOKS__.cloneDataValue = cloneDataValue;
    window.__ICM_TEST_HOOKS__.resolveClientConceptId = resolveClientConceptId;
    window.__ICM_TEST_HOOKS__.switchActiveRun = switchActiveRun;
    window.__ICM_TEST_HOOKS__.navigateOkfMarkdownConcept = navigateOkfMarkdownConcept;
    window.__ICM_TEST_HOOKS__.syncChecklistToOkfBody = syncChecklistToOkfBody;
    window.__ICM_TEST_HOOKS__.syncOkfBodyToChecklist = syncOkfBodyToChecklist;
    window.__ICM_TEST_HOOKS__.inspectSourceCitationsInBody = inspectSourceCitationsInBody;
    window.__ICM_TEST_HOOKS__.inspectClientSourceDomainProvenance = inspectClientSourceDomainProvenance;
    window.__ICM_TEST_HOOKS__.buildCurationPrompts = buildCurationPrompts;
    window.__ICM_TEST_HOOKS__.setReplaceSourceInStudio = setReplaceSourceInStudio;
    window.__ICM_TEST_HOOKS__.toggleReplacePanelInStudio = toggleReplacePanelInStudio;
    window.__ICM_TEST_HOOKS__.toggleRejectSourceInStudio = toggleRejectSourceInStudio;
    window.__ICM_TEST_HOOKS__.addSourceInStudio = addSourceInStudio;
    window.__ICM_TEST_HOOKS__.parseBuiltInMarkdown = parseBuiltInMarkdown;
    window.__ICM_TEST_HOOKS__.renderMarkdownBlock = renderMarkdownBlock;
    window.__ICM_TEST_HOOKS__.renderInlineMarkdown = renderInlineMarkdown;
    window.__ICM_TEST_HOOKS__.renderComponent = renderComponent;
    window.__ICM_TEST_HOOKS__.renderSurface = renderSurface;
    window.__ICM_TEST_HOOKS__.mountSurface = mountSurface;
    return;
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function resolvePointer(root, pointer, scopeData) {
    if (pointer === undefined || pointer === null) return undefined;
    if (typeof pointer !== "string") return pointer;
    if (!pointer.startsWith("/")) {
      const base = scopeData !== undefined ? scopeData : root;
      const parts = pointer.split("/").filter(Boolean);
      let cur = base;
      for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p.replace(/~1/g, "/").replace(/~0/g, "~")];
      }
      return cur;
    }
    if (pointer === "/") return root;
    const parts = pointer.slice(1).split("/");
    let cur = root;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return cur;
  }

  function setPointer(root, pointer, value, scopePath) {
    let fullPointer = pointer;
    if (!pointer.startsWith("/") && scopePath) {
      fullPointer = scopePath.replace(/\\/$/, "") + "/" + pointer;
    }
    const clonedValue = cloneDataValue(value);
    if (!fullPointer || fullPointer === "/") {
      for (const k of Object.keys(root)) {
        delete root[k];
      }
      if (clonedValue && typeof clonedValue === "object" && !Array.isArray(clonedValue)) {
        Object.assign(root, clonedValue);
      }
      return;
    }
    const clean = fullPointer.startsWith("/") ? fullPointer.slice(1) : fullPointer;
    const parts = clean.split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      const nextK = parts[i + 1];
      if (cur[k] == null || typeof cur[k] !== "object") {
        cur[k] = /^\\d+$/.test(nextK) ? [] : {};
      }
      cur = cur[k];
    }
    const lastPart = parts[parts.length - 1];
    if (clonedValue === undefined) {
      if (Array.isArray(cur) && /^\\d+$/.test(lastPart)) {
        cur[Number(lastPart)] = undefined;
      } else if (cur && typeof cur === "object") {
        delete cur[lastPart];
      }
    } else {
      cur[lastPart] = clonedValue;
    }
  }

  function isNorwegianSurface(surface) {
    const metaLang = surface && resolvePointer(surface.dataModel, "/meta/lang");
    if (metaLang === "no") return true;
    if (metaLang === "en") return false;
    const docLang =
      typeof document !== "undefined" && document.documentElement
        ? document.documentElement.lang
        : "";
    return docLang === "no" || docLang === "nb";
  }

  function isAnalysisSurface(surface) {
    const dm = surface && resolvePointer(surface.dataModel, "/meta/domainMode");
    return dm === "analysis";
  }

  function stringifyInterpolated(val) {
    if (val === null || val === undefined) return "";
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
  }

  function evaluateFunctionCall(fnObj, surface, scopeData) {
    const callName = fnObj.call;
    const args = fnObj.args || {};
    if (callName === "formatString") {
      const rawTemplate = String(args.value ?? "");
      return rawTemplate.replace(/(\\\\?)\\$\\{([^}]+)\\}/g, function (match, esc, expr) {
        if (esc === "\\\\") return match.slice(1);
        const trimmed = String(expr || "").trim();
        const resolved = resolvePointer(surface.dataModel, trimmed, scopeData);
        return stringifyInterpolated(resolved);
      });
    }
    if (callName === "required") {
      const v = resolveDynamic(args.value, surface, scopeData);
      if (v === null || v === undefined) return false;
      if (typeof v === "string") return v.trim().length > 0;
      if (Array.isArray(v)) return v.length > 0;
      return Boolean(v);
    }
    if (callName === "regex") {
      const v = String(resolveDynamic(args.value, surface, scopeData) ?? "");
      try {
        return new RegExp(String(args.pattern || "")).test(v);
      } catch {
        return false;
      }
    }
    if (callName === "length") {
      const v = String(resolveDynamic(args.value, surface, scopeData) ?? "");
      if (typeof args.min === "number" && v.length < args.min) return false;
      if (typeof args.max === "number" && v.length > args.max) return false;
      return true;
    }
    if (callName === "numeric") {
      const n = Number(resolveDynamic(args.value, surface, scopeData));
      if (Number.isNaN(n)) return false;
      if (typeof args.min === "number" && n < args.min) return false;
      if (typeof args.max === "number" && n > args.max) return false;
      return true;
    }
    if (callName === "email") {
      const v = String(resolveDynamic(args.value, surface, scopeData) ?? "");
      return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v);
    }
    if (callName === "and") {
      const list = Array.isArray(args.values) ? args.values : [];
      return list.every((item) => Boolean(resolveDynamic(item, surface, scopeData)));
    }
    if (callName === "or") {
      const list = Array.isArray(args.values) ? args.values : [];
      return list.some((item) => Boolean(resolveDynamic(item, surface, scopeData)));
    }
    if (callName === "not") {
      return !Boolean(resolveDynamic(args.value, surface, scopeData));
    }
    if (callName === "openUrl") {
      const url = String(resolveDynamic(args.url, surface, scopeData) || "");
      if (url && typeof window !== "undefined" && window.open) {
        window.open(url, "_blank", "noopener");
      }
      return true;
    }
    return "";
  }

  function resolveDynamic(val, surface, scopeData) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      if (typeof val.path === "string") {
        return resolvePointer(surface.dataModel, val.path, scopeData);
      }
      if (typeof val.call === "string") {
        return evaluateFunctionCall(val, surface, scopeData);
      }
    }
    return val;
  }

  // Process A2UI v0.9.1 Server-to-Client Message Stream
  function processMessage(msg) {
    if (!msg || (msg.version !== "v0.9.1" && msg.version !== "v0.9")) return;
    if (msg.createSurface) {
      const s = msg.createSurface;
      surfaces[s.surfaceId] = {
        surfaceId: s.surfaceId,
        catalogId: s.catalogId,
        theme: cloneDataValue(s.theme || {}),
        sendDataModel: !!s.sendDataModel,
        components: {},
        dataModel: {},
        runStates: {},
        uiState: { activeTabs: {} },
      };
      activeSurfaceId = s.surfaceId;
    } else if (msg.updateComponents) {
      const s = surfaces[msg.updateComponents.surfaceId];
      if (!s) return;
      for (const c of msg.updateComponents.components || []) {
        s.components[c.id] = cloneDataValue(c);
      }
    } else if (msg.updateDataModel) {
      const s = surfaces[msg.updateDataModel.surfaceId];
      if (!s) return;
      const p = msg.updateDataModel.path || "/";
      setPointer(s.dataModel, p, cloneDataValue(msg.updateDataModel.value));
    } else if (msg.deleteSurface) {
      delete surfaces[msg.deleteSurface.surfaceId];
    }
  }

  for (const m of messages) {
    processMessage(m);
  }

  // Pre-seed per-run dataModels on the active surface and mount the topbar run/course switcher when >1 run exists
  const initialSurface = surfaces[activeSurfaceId];
  if (initialSurface && bundleRuns.length > 0) {
    initialSurface.runStates = initialSurface.runStates || {};
    for (const r of bundleRuns) {
      if (r && r.runId && r.dataModel) {
        initialSurface.runStates[r.runId] = cloneDataValue(r.dataModel);
      }
    }
    const activeRunId = resolvePointer(initialSurface.dataModel, "/meta/runId");
    if (activeRunId) {
      initialSurface.activeRunId = activeRunId;
      initialSurface.runStates[activeRunId] = cloneDataValue(initialSurface.dataModel);
    }
    if (bundleRuns.length > 1 && typeof document !== "undefined") {
      const brandEl = document.querySelector(".a2ui-topbar-brand");
      if (brandEl && !document.getElementById("a2ui-run-switcher-select")) {
        const selectEl = document.createElement("select");
        selectEl.id = "a2ui-run-switcher-select";
        selectEl.className = "a2ui-run-switcher";
        const isNo = isNorwegianSurface(initialSurface);
        selectEl.setAttribute(
          "aria-label",
          isNo ? "Velg kurs / kjøring" : "Switch active course / run"
        );
        bundleRuns.forEach((r, idx) => {
          const opt = document.createElement("option");
          opt.value = r.runId;
          const prefix = isNo ? "Kurs " + (idx + 1) + ": " : "Run " + (idx + 1) + ": ";
          opt.textContent = r.shortLabel || (prefix + (r.title || r.runId));
          if (r.runId === activeRunId) {
            opt.selected = true;
          }
          selectEl.appendChild(opt);
        });
        selectEl.addEventListener("change", (ev) => {
          const nextRunId = ev.target && ev.target.value;
          if (nextRunId) {
            switchActiveRun(initialSurface, nextRunId);
          }
        });
        brandEl.appendChild(selectEl);
      }
    }
  }

  function stopActiveSpeech() {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }

  function cleanClientChecklistLabel(rawText) {
    const supMap = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ" };
    const subMap = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ" };
    function cleanLatexFrag(frag, isInsideMathSpan) {
      let out = String(frag || "")
        .replace(/\\\\(?:left|right)\\s*([()[\\]|.])?/g, "$1")
        .replace(/\\\\mathcal\\{R\\}/g, "ℛ")
        .replace(/\\\\mathcal\\{([A-Za-z])\\}/g, "$1")
        .replace(/\\\\sqrt\\{\\s*([^{}]+?)\\s*\\}/g, "√($1)")
        .replace(/\\\\overline\\{\\s*([^{}]+?)\\s*\\}/g, "$1")
        .replace(/\\\\(?:hat|bar|tilde|vec)\\{\\s*([^{}]+?)\\s*\\}/g, "$1")
        .replace(/\\\\(?:[,;:]|\\s+|quad\\b|qquad\\b)/g, " ")
        .replace(/\\\\!/g, "")
        .replace(/\\\\sim(?![a-zA-Z])/g, "~")
        .replace(/\\\\simeq(?![a-zA-Z])/g, "≃")
        .replace(/\\\\cong(?![a-zA-Z])/g, "≅")
        .replace(/\\\\propto(?![a-zA-Z])/g, "∝")
        .replace(/\\\\perp(?![a-zA-Z])/g, "⊥")
        .replace(/\\\\parallel(?![a-zA-Z])/g, "∥")
        .replace(/\\\\leftrightarrow/g, "↔")
        .replace(/\\\\Leftrightarrow|\\\\iff(?![a-zA-Z])/g, "⇔")
        .replace(/\\\\rightarrow|\\\\to(?![a-zA-Z])/g, "→")
        .replace(/\\\\Rightarrow|\\\\implies(?![a-zA-Z])/g, "⇒")
        .replace(/\\\\leftarrow/g, "←")
        .replace(/\\\\Leftarrow/g, "⇐")
        .replace(/\\\\(?:ge|geq)(?![a-zA-Z])/g, "≥")
        .replace(/\\\\(?:le|leq)(?![a-zA-Z])/g, "≤")
        .replace(/\\\\(?:neq|ne)(?![a-zA-Z])/g, "≠")
        .replace(/\\\\approx(?![a-zA-Z])/g, "≈")
        .replace(/\\\\equiv(?![a-zA-Z])/g, "≡")
        .replace(/\\\\ll(?![a-zA-Z])/g, "≪")
        .replace(/\\\\gg(?![a-zA-Z])/g, "≫")
        .replace(/\\\\times(?![a-zA-Z])/g, "×")
        .replace(/\\\\div(?![a-zA-Z])/g, "÷")
        .replace(/\\\\pm(?![a-zA-Z])/g, "±")
        .replace(/\\\\mp(?![a-zA-Z])/g, "∓")
        .replace(/\\\\cdot(?![a-zA-Z])/g, "·")
        .replace(/\\\\(?:dots|ldots|cdots)(?![a-zA-Z])/g, "…")
        .replace(/\\\\infty(?![a-zA-Z])/g, "∞")
        .replace(/\\\\partial(?![a-zA-Z])/g, "∂")
        .replace(/\\\\nabla(?![a-zA-Z])/g, "∇")
        .replace(/\\\\sum(?![a-zA-Z])/g, "∑")
        .replace(/\\\\prod(?![a-zA-Z])/g, "∏")
        .replace(/\\\\int(?![a-zA-Z])/g, "∫")
        .replace(/\\\\Delta\\s+([a-zA-Z])(?![a-zA-Z])/g, "Δ$1")
        .replace(/\\\\Delta(?![a-zA-Z])/g, "Δ")
        .replace(/\\\\delta(?![a-zA-Z])/g, "δ")
        .replace(/\\\\mu(?![a-zA-Z])/g, "μ")
        .replace(/\\\\Omega(?![a-zA-Z])/g, "Ω")
        .replace(/\\\\omega(?![a-zA-Z])/g, "ω")
        .replace(/\\\\alpha(?![a-zA-Z])/g, "α")
        .replace(/\\\\beta(?![a-zA-Z])/g, "β")
        .replace(/\\\\gamma(?![a-zA-Z])/g, "γ")
        .replace(/\\\\Gamma(?![a-zA-Z])/g, "Γ")
        .replace(/\\\\lambda(?![a-zA-Z])/g, "λ")
        .replace(/\\\\Lambda(?![a-zA-Z])/g, "Λ")
        .replace(/\\\\pi(?![a-zA-Z])/g, "π")
        .replace(/\\\\Pi(?![a-zA-Z])/g, "Π")
        .replace(/\\\\sigma(?![a-zA-Z])/g, "σ")
        .replace(/\\\\Sigma(?![a-zA-Z])/g, "Σ")
        .replace(/\\\\rho(?![a-zA-Z])/g, "ρ")
        .replace(/\\\\theta(?![a-zA-Z])/g, "θ")
        .replace(/\\\\Theta(?![a-zA-Z])/g, "Θ")
        .replace(/\\\\tau(?![a-zA-Z])/g, "τ")
        .replace(/\\\\phi(?![a-zA-Z])|\\\\varphi(?![a-zA-Z])/g, "φ")
        .replace(/\\\\Phi(?![a-zA-Z])/g, "Φ")
        .replace(/\\\\eta(?![a-zA-Z])/g, "η")
        .replace(/\\\\kappa(?![a-zA-Z])/g, "κ")
        .replace(/\\\\epsilon(?![a-zA-Z])|\\\\varepsilon(?![a-zA-Z])/g, "ε")
        .replace(/\\\\zeta(?![a-zA-Z])/g, "ζ")
        .replace(/\\\\nu(?![a-zA-Z])/g, "ν")
        .replace(/\\\\xi(?![a-zA-Z])/g, "ξ")
        .replace(/\\\\chi(?![a-zA-Z])/g, "χ")
        .replace(/\\\\psi(?![a-zA-Z])/g, "ψ")
        .replace(/\\\\Psi(?![a-zA-Z])/g, "Ψ")
        .replace(/\\\\(?:ln|exp|log|sin|cos|tan|min|max|lim|sup|inf)(?![a-zA-Z])/g, function (m) {
          return m.slice(1);
        })
        .replace(/\\\\(?:circ|degree)(?![a-z])/g, "°");
      for (let pass = 0; pass < 3; pass++) {
        out = out
          .replace(/\\\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\\{([^{}]*)\\}/g, "$1")
          .replace(/\\\\(?:xrightleftharpoons|rightleftharpoons)(?:\\[[^\\]]*\\])?(?:\\{[^{}]*\\})?/g, "⇌")
          .replace(/\\\\(?:xrightarrow|xleftarrow)(?:\\[[^\\]]*\\])?(?:\\{[^{}]*\\})?/g, "→")
          .replace(/\\\\frac\\{\\s*([^{}]+?)\\s*\\}\\{\\s*([^{}]+?)\\s*\\}/g, "$1/$2")
          .replace(/\\^\\{\\s*(?:°|o)\\s*([CFK])?\\s*\\}|\\^°/g, "°$1")
          .replace(/\\^\\{\\s*([0-9+\\-=()a-pr-z]+)\\s*\\}|\\^([0-9+\\-a-pr-z])(?![a-zA-Z0-9])/g, function (_m, b, s) {
            return String(b || s).replace(/[0-9+\\-=()a-pr-z]/g, function (d) {
              return supMap[d] || d;
            });
          })
          .replace(/_\\{\\s*([+-]?[0-9]+|[+-])\\s*\\}/g, function (_m, b) {
            return String(b).replace(/[0-9+-]/g, function (d) {
              return subMap[d] || d;
            });
          });
        if (isInsideMathSpan) {
          out = out
            .replace(/~/g, " ")
            .replace(/_([+-]?[0-9])(?![0-9])/g, function (_sub, s) {
              return String(s).replace(/[0-9+-]/g, function (d) {
                return subMap[d] || d;
              });
            })
            .replace(/_\\{\\s*([aehijklmnoprstuvx]+)\\s*\\}|_([aehijklmnoprstuvx])(?![a-zA-Z0-9])/g, function (_m, b, s) {
              return String(b || s).replace(/[aehijklmnoprstuvx]/g, function (d) {
                return subMap[d] || d;
              });
            })
            .replace(/_\\{\\s*([^{}]+?)\\s*\\}/g, "_$1")
            .replace(/\\^\\{\\s*([^{}]+?)\\s*\\}/g, "^$1");
        }
      }
      return out
        .replace(/\\\\([$&%_#{}])/g, "$1")
        .replace(/\\\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\\{([^{}]*)\\}/g, "$1");
    }

    let text = String(rawText || "").trim();
    text = stripClientFootnotesPreservingBoundaries(text);
    text = replaceInlineLatexSpans(text, function (_m, inner) {
      return cleanLatexFrag(inner, true).trim();
    });
    text = cleanLatexFrag(text, false);
    text = text.replace(/\\b(CO|H|O|N|SO|NO|CH|Fe|Ni|Si|Mg|Al|Ca|Ti|A|B|R|EI|REI|NPV|IRR)_([0-9]+|x)(?![a-zA-Z0-9])/g, function (_m, prefix, s) {
      return prefix + String(s).replace(/[0-9x]/g, function (d) { return subMap[d] || d; });
    });
    text = text.replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, "$1");
    text = text
      .replace(/\\x60([^\\x60]+)\\x60/g, "$1")
      .replace(/\\*\\*\\*(?!\\s)([^*]*?\\S)\\*\\*\\*/g, "$1")
      .replace(/\\*\\*(?!\\s)([^*]*?\\S)\\*\\*/g, "$1")
      .replace(/\\*(?!\\s)([^*]*?\\S)\\*/g, "$1");
    text = text.replace(/\\s+/g, " ").replace(/\\s+([.,;:?!])/g, "$1").trim();
    return text;
  }

  function extractChecklistGroupsClient(rawMarkdown) {
    const sample = String(rawMarkdown || "");
    const isNo = detectTextLang(sample) === "no";
    const defaultHeading = isNo ? "Sjekkliste / Action Items" : "Checklist / Action Items";
    const defaultFallback = isNo ? "Generelt" : "General";
    const lines = sample.split(/\\r?\\n/);
    const groups = [];
    let currentHeading = defaultHeading;
    const categoryStack = [];
    let sectionGroupStartIdx = 0;
    let itemCounter = 0;

    function getOrCreateGroup(title) {
      const cleanTitle =
        cleanClientChecklistLabel(title.replace(/\\*\\*([^*]+)\\*\\*/g, "$1").replace(/:+\\s*$/, "")) || defaultFallback;
      for (let gIdx = groups.length - 1; gIdx >= sectionGroupStartIdx; gIdx--) {
        if (groups[gIdx].title === cleanTitle) {
          return groups[gIdx];
        }
      }
      const created = {
        id: "chk_grp_" + (groups.length + 1),
        title: cleanTitle,
        items: [],
      };
      groups.push(created);
      return created;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{2,4})\\s+(.+?)\\s*$/);
      if (headingMatch) {
        currentHeading = headingMatch[2].replace(/^\\d+(\\.\\d+)*\\.?\\s*/, "").trim();
        categoryStack.length = 0;
        sectionGroupStartIdx = groups.length;
        continue;
      }
      const checkboxMatch = line.match(/^(\\s*)(?:[-*+]|\\d+[.)])\\s+\\[([ xX])\\]\\s+(.+?)\\s*$/);
      if (!checkboxMatch) continue;

      const indent = checkboxMatch[1].length;
      const isChecked = checkboxMatch[2].toLowerCase() === "x";
      const rawContent = checkboxMatch[3].trim();

      while (categoryStack.length > 0 && categoryStack[categoryStack.length - 1].indent >= indent) {
        categoryStack.pop();
      }

      let hasIndentedSubItems = false;
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        if (!nextLine.trim()) continue;
        const nextCheckbox = nextLine.match(/^(\\s*)(?:[-*+]|\\d+[.)])\\s+\\[([ xX])\\]\\s+(.+?)\\s*$/);
        if (nextCheckbox && nextCheckbox[1].length > indent) {
          hasIndentedSubItems = true;
        }
        break;
      }

      const contentWithoutFootnotes = stripClientFootnotesPreservingBoundaries(rawContent).trim();
      const isBoldColonHeader = /^\\*\\*[^*]+\\*\\*:?\\s*$/.test(contentWithoutFootnotes);

      if (isBoldColonHeader || hasIndentedSubItems) {
        const headerTitle = cleanClientChecklistLabel(
          contentWithoutFootnotes.replace(/\\*\\*([^*]+)\\*\\*/g, "$1").replace(/:+\\s*$/, "").trim()
        );
        if (headerTitle) {
          categoryStack.push({ indent: indent, title: headerTitle });
        }
        continue;
      }

      let groupTitle = currentHeading;
      const rawItemText = rawContent;

      if (categoryStack.length > 0) {
        const stackTitle = categoryStack.map((c) => c.title).join(" — ");
        groupTitle =
          currentHeading &&
          currentHeading !== defaultHeading &&
          !stackTitle.startsWith(currentHeading)
            ? currentHeading + " — " + stackTitle
            : stackTitle;
      }

      const cleanedLabel = cleanClientChecklistLabel(rawItemText);
      if (!cleanedLabel) continue;
      itemCounter++;
      const group = getOrCreateGroup(groupTitle);

      group.items.push({
        id: "chk_item_" + itemCounter,
        label: cleanedLabel,
        checked: isChecked,
        category: group.title,
      });
    }

    return groups.filter((g) => g.items.length > 0);
  }

  function syncChecklistToOkfBody(surface) {
    if (resolvePointer(surface.dataModel, "/checklist/fromStage2")) {
      return;
    }
    const isViewingStub = Boolean(
      surface.viewingStubConcept || resolvePointer(surface.dataModel, "/okf/viewingStubConcept")
    );
    const targetBodyPath = isViewingStub ? "/okf/primaryBody" : "/okf/body";
    const body = resolvePointer(surface.dataModel, targetBodyPath);
    if (typeof body !== "string" || !body) return;
    const groups = resolvePointer(surface.dataModel, "/checklist/groups") || [];
    const flatChecked = [];
    const checkedByLeafNum = {};
    let hasLeafIds = false;
    for (const g of groups) {
      for (const it of g.items || []) {
        const val = Boolean(it.checked);
        flatChecked.push(val);
        const idMatch = String(it.id || "").match(/^chk_item_(\\d+)$/);
        if (idMatch) {
          checkedByLeafNum[Number(idMatch[1])] = val;
          hasLeafIds = true;
        }
      }
    }
    if (flatChecked.length === 0) return;

    const lines = body.split(/\\r?\\n/);
    let leafIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\\s*(?:[-*+]|\\d+[.)])\\s+\\[)([ xX])(\\]\\s+)(.+?)\\s*$/);
      if (!m) continue;
      const indent = (lines[i].match(/^(\\s*)/) || ["", ""])[1].length;
      const rawContent = m[4].trim();
      let hasIndentedSubItems = false;
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        if (!nextLine.trim()) continue;
        const nextCheckbox = nextLine.match(/^(\\s*)(?:[-*+]|\\d+[.)])\\s+\\[([ xX])\\]\\s+(.+?)\\s*$/);
        if (nextCheckbox && nextCheckbox[1].length > indent) {
          hasIndentedSubItems = true;
        }
        break;
      }
      const contentWithoutFootnotes = stripClientFootnotesPreservingBoundaries(rawContent).trim();
      const isBoldColonHeader = /^\\*\\*[^*]+\\*\\*:?\\s*$/.test(contentWithoutFootnotes);
      if (isBoldColonHeader || hasIndentedSubItems) {
        continue;
      }
      const leafNum = leafIdx + 1;
      if (hasLeafIds && Object.prototype.hasOwnProperty.call(checkedByLeafNum, leafNum)) {
        lines[i] = m[1] + (checkedByLeafNum[leafNum] ? "x" : " ") + m[3] + m[4];
        leafIdx++;
      } else if (leafIdx < flatChecked.length) {
        lines[i] = m[1] + (flatChecked[leafIdx] ? "x" : " ") + m[3] + m[4];
        leafIdx++;
      }
    }
    const updatedBody = lines.join("\\n");
    setPointer(surface.dataModel, targetBodyPath, updatedBody);
    if (!isViewingStub) {
      setPointer(surface.dataModel, "/okf/primaryBody", updatedBody);
    }
  }

  function syncOkfBodyToChecklist(surface) {
    if (
      resolvePointer(surface.dataModel, "/checklist/fromStage2") ||
      surface.viewingStubConcept ||
      resolvePointer(surface.dataModel, "/okf/viewingStubConcept")
    ) {
      return;
    }
    const body = resolvePointer(surface.dataModel, "/okf/body");
    if (typeof body !== "string") return;
    const newGroups = extractChecklistGroupsClient(body);
    if (newGroups.length > 0) {
      setPointer(surface.dataModel, "/checklist/groups", newGroups);
      recomputeChecklistSummary(surface);
      const total = resolvePointer(surface.dataModel, "/checklist/totalCount") || 0;
      if (
        surface.components &&
        surface.components["main_tabs"] &&
        Array.isArray(surface.components["main_tabs"].tabs)
      ) {
        const isNo = isNorwegianSurface(surface);
        for (const tab of surface.components["main_tabs"].tabs) {
          if (tab && tab.child === "tab_checklist") {
            tab.title = isNo
              ? "✅ Interaktiv Sjekkliste (" + total + ")"
              : "✅ Interactive Checklist (" + total + ")";
          }
        }
      }
    }
  }

  function dispatchClientAction(surface, sourceComponentId, name, contextObj) {
    const evt = {
      version: "v0.9.1",
      action: {
        name: name,
        surfaceId: surface.surfaceId,
        sourceComponentId: sourceComponentId,
        timestamp: new Date().toISOString(),
        context: contextObj || {},
      },
    };
    actionLog.unshift(evt);
    if (name === "resetChecklist") {
      const groups = resolvePointer(surface.dataModel, "/checklist/groups") || [];
      groups.forEach((g) => (g.items || []).forEach((it) => { it.checked = false; }));
      recomputeChecklistSummary(surface);
      syncChecklistToOkfBody(surface);
      renderSurface();
    } else if (name === "checkAllChecklist") {
      const groups = resolvePointer(surface.dataModel, "/checklist/groups") || [];
      groups.forEach((g) => (g.items || []).forEach((it) => { it.checked = true; }));
      recomputeChecklistSummary(surface);
      syncChecklistToOkfBody(surface);
      renderSurface();
    } else if (name === "speakText") {
      const txt = (contextObj && contextObj.text) || "";
      speakNarration(txt);
    } else if (name === "stopSpeech") {
      stopActiveSpeech();
    } else if (name === "exportSurfaceJson") {
      downloadJson(
        surface.surfaceId + "_state.json",
        JSON.stringify({ messages, currentDataModel: surface.dataModel, actionLog }, null, 2)
      );
    }
  }

  function recomputeChecklistSummary(surface) {
    const groups = resolvePointer(surface.dataModel, "/checklist/groups") || [];
    let total = 0;
    let completed = 0;
    for (const g of groups) {
      for (const it of g.items || []) {
        total++;
        if (it.checked) completed++;
      }
    }
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const doneWord = isNorwegianSurface(surface) ? " fullført (" : " completed (";
    setPointer(surface.dataModel, "/checklist/completedCount", completed);
    setPointer(surface.dataModel, "/checklist/totalCount", total);
    setPointer(surface.dataModel, "/checklist/percent", pct);
    setPointer(
      surface.dataModel,
      "/checklist/summaryText",
      completed + " / " + total + doneWord + pct + "%)"
    );
  }

  function speakNarration(text) {
    if (!window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const lang = detectSpeechLang(text);
    const spokenText = normalizeTextForTts(text, lang);
    const utter = new SpeechSynthesisUtterance(spokenText);
    utter.lang = lang;
    window.speechSynthesis.speak(utter);
  }

  function downloadJson(filename, content) {
    const blob = new Blob([content], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }

  function formatInlineLatexAndFootnotes(md, sources, rejectedSourceIds) {
    const supMap = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ" };
    const subMap = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ" };
    let out = String(md || "");
    // Strip redundant leading H1 heading (# <Title>) since the concept title is already rendered in the card/panel header
    out = out.replace(/^\\s*#\\s+[^\\r\\n]+(?:\\r?\\n+---(?=\\r?\\n|$))?\\r?\\n*/, "");
    // Strip standalone bottom footnote definitions ([^id]: Title) so they don't render as raw lines below prose
    out = out.replace(/^\\s*\\[\\^([A-Za-z0-9_\\-]+)\\]:\\s*(.+)$/gm, "");
    out = out.replace(/\\r?\\n+---\\s*$/g, "");
    out = out.replace(/(?:\\r?\\n+---)?\\r?\\n+#{1,4}\\s+(?:\\*\\*|__)?(?:\\d+(?:\\.\\d+)*\\.?\\s+)?(?:Sources?(?:\\s*(?:&|and|\\/)\\s*(?:Citations?|Footnotes?|References?))?|References?(?:\\s*(?:&|and|\\/)\\s*(?:Footnotes?|Citations?|Sources?))?|Citations?(?:\\s*(?:&|and|\\/)\\s*(?:Footnotes?|References?))?|Footnotes?(?:\\s*(?:&|and|\\/)\\s*(?:References?|Sources?))?|Grounded\\s+Search\\s+References|Kildehenvisninger(?:\\s*(?:og|&|\\/)\\s*(?:referanser|fotnoter))?|Kilder(?:\\s*(?:og|&|\\/)\\s*(?:referanser|fotnoter|kildehenvisninger))?|Kildeliste(?:\\s*(?:og|&|\\/)\\s*fotnoter)?|Referanser(?:\\s*(?:og|&|\\/)\\s*(?:fotnoter|kilder))?|Referanseliste(?:\\s*(?:og|&|\\/)\\s*fotnoter)?|Fotnoter(?:\\s*(?:og|&|\\/)\\s*(?:kilder|referanser))?):?(?:\\*\\*|__)?(?:\\r?\\n+---)?\\s*$/i, "");
    out = out.replace(/\\r?\\n+---\\s*$/g, "").trim();
    // Normalize stray BPE space immediately after list-item opening bold marker (e.g. '2. ** label**:' -> '2. **label**:')
    out = out.replace(/^(\\s*(?:[-*+]|\\d+[.)])\\s+(?:\\[[ xX]\\]\\s+)?)\\*\\*[ \\t]+([^\\s*\\r\\n][^*\\r\\n]*?\\*\\*)/gm, "$1**$2");
    // Format inline TeX math spans ($...$ and $$...$$) safely without matching currency $ pairs or table pipes
    out = replaceInlineLatexSpans(out, function (_, inner) {
      let cleaned = String(inner)
        .replace(/\\\\(?:left|right)\\s*([()[\\]|.])?/g, "$1")
        .replace(/\\\\mathcal\\{R\\}/g, "ℛ")
        .replace(/\\\\mathcal\\{([A-Za-z])\\}/g, "$1")
        .replace(/\\\\sqrt\\{\\s*([^{}]+?)\\s*\\}/g, "√($1)")
        .replace(/\\\\overline\\{\\s*([^{}]+?)\\s*\\}/g, "$1")
        .replace(/\\\\(?:hat|bar|tilde|vec)\\{\\s*([^{}]+?)\\s*\\}/g, "$1")
        .replace(/\\\\(?:[,;:]|\\s+|quad\\b|qquad\\b)/g, " ")
        .replace(/~/g, " ")
        .replace(/\\\\!/g, "")
        .replace(/\\\\sim(?![a-zA-Z])/g, "~")
        .replace(/\\\\simeq(?![a-zA-Z])/g, "≃")
        .replace(/\\\\cong(?![a-zA-Z])/g, "≅")
        .replace(/\\\\propto(?![a-zA-Z])/g, "∝")
        .replace(/\\\\perp(?![a-zA-Z])/g, "⊥")
        .replace(/\\\\parallel(?![a-zA-Z])/g, "∥")
        .replace(/\\\\leftrightarrow/g, "↔")
        .replace(/\\\\Leftrightarrow|\\\\iff(?![a-zA-Z])/g, "⇔")
        .replace(/\\\\rightarrow|\\\\to(?![a-zA-Z])/g, "→")
        .replace(/\\\\Rightarrow|\\\\implies(?![a-zA-Z])/g, "⇒")
        .replace(/\\\\leftarrow/g, "←")
        .replace(/\\\\Leftarrow/g, "⇐")
        .replace(/\\\\(?:ge|geq)(?![a-zA-Z])/g, "≥")
        .replace(/\\\\(?:le|leq)(?![a-zA-Z])/g, "≤")
        .replace(/\\\\(?:neq|ne)(?![a-zA-Z])/g, "≠")
        .replace(/\\\\approx(?![a-zA-Z])/g, "≈")
        .replace(/\\\\equiv(?![a-zA-Z])/g, "≡")
        .replace(/\\\\ll(?![a-zA-Z])/g, "≪")
        .replace(/\\\\gg(?![a-zA-Z])/g, "≫")
        .replace(/\\\\times(?![a-zA-Z])/g, "×")
        .replace(/\\\\div(?![a-zA-Z])/g, "÷")
        .replace(/\\\\pm(?![a-zA-Z])/g, "±")
        .replace(/\\\\mp(?![a-zA-Z])/g, "∓")
        .replace(/\\\\cdot(?![a-zA-Z])/g, "·")
        .replace(/\\\\(?:dots|ldots|cdots)(?![a-zA-Z])/g, "…")
        .replace(/\\\\infty(?![a-zA-Z])/g, "∞")
        .replace(/\\\\partial(?![a-zA-Z])/g, "∂")
        .replace(/\\\\nabla(?![a-zA-Z])/g, "∇")
        .replace(/\\\\sum(?![a-zA-Z])/g, "∑")
        .replace(/\\\\prod(?![a-zA-Z])/g, "∏")
        .replace(/\\\\int(?![a-zA-Z])/g, "∫")
        .replace(/\\\\Delta\\s+([a-zA-Z])(?![a-zA-Z])/g, "Δ$1")
        .replace(/\\\\Delta(?![a-zA-Z])/g, "Δ")
        .replace(/\\\\delta(?![a-zA-Z])/g, "δ")
        .replace(/\\\\mu(?![a-zA-Z])/g, "μ")
        .replace(/\\\\Omega(?![a-zA-Z])/g, "Ω")
        .replace(/\\\\omega(?![a-zA-Z])/g, "ω")
        .replace(/\\\\alpha(?![a-zA-Z])/g, "α")
        .replace(/\\\\beta(?![a-zA-Z])/g, "β")
        .replace(/\\\\gamma(?![a-zA-Z])/g, "γ")
        .replace(/\\\\Gamma(?![a-zA-Z])/g, "Γ")
        .replace(/\\\\lambda(?![a-zA-Z])/g, "λ")
        .replace(/\\\\Lambda(?![a-zA-Z])/g, "Λ")
        .replace(/\\\\pi(?![a-zA-Z])/g, "π")
        .replace(/\\\\Pi(?![a-zA-Z])/g, "Π")
        .replace(/\\\\sigma(?![a-zA-Z])/g, "σ")
        .replace(/\\\\Sigma(?![a-zA-Z])/g, "Σ")
        .replace(/\\\\rho(?![a-zA-Z])/g, "ρ")
        .replace(/\\\\theta(?![a-zA-Z])/g, "θ")
        .replace(/\\\\Theta(?![a-zA-Z])/g, "Θ")
        .replace(/\\\\tau(?![a-zA-Z])/g, "τ")
        .replace(/\\\\phi(?![a-zA-Z])|\\\\varphi(?![a-zA-Z])/g, "φ")
        .replace(/\\\\Phi(?![a-zA-Z])/g, "Φ")
        .replace(/\\\\eta(?![a-zA-Z])/g, "η")
        .replace(/\\\\kappa(?![a-zA-Z])/g, "κ")
        .replace(/\\\\epsilon(?![a-zA-Z])|\\\\varepsilon(?![a-zA-Z])/g, "ε")
        .replace(/\\\\zeta(?![a-zA-Z])/g, "ζ")
        .replace(/\\\\nu(?![a-zA-Z])/g, "ν")
        .replace(/\\\\xi(?![a-zA-Z])/g, "ξ")
        .replace(/\\\\chi(?![a-zA-Z])/g, "χ")
        .replace(/\\\\psi(?![a-zA-Z])/g, "ψ")
        .replace(/\\\\Psi(?![a-zA-Z])/g, "Ψ")
        .replace(/\\\\(?:ln|exp|log|sin|cos|tan|min|max|lim|sup|inf)(?![a-zA-Z])/g, function (m) {
          return m.slice(1);
        })
        .replace(/\\\\(?:circ|degree)(?![a-z])/g, "°");
      for (let pass = 0; pass < 3; pass++) {
        cleaned = cleaned
          .replace(/\\\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\\{([^{}]*)\\}/g, "$1")
          .replace(/\\\\(?:xrightleftharpoons|rightleftharpoons)(?:\\[[^\\]]*\\])?(?:\\{[^{}]*\\})?/g, "⇌")
          .replace(/\\\\(?:xrightarrow|xleftarrow)(?:\\[[^\\]]*\\])?(?:\\{[^{}]*\\})?/g, "→")
          .replace(/\\^\\{\\s*(?:°|o)\\s*([CFK])?\\s*\\}|\\^°/g, "°$1")
          .replace(/\\^\\{\\s*([0-9+\\-=()a-pr-z]+)\\s*\\}|\\^([0-9+\\-a-pr-z])(?![a-zA-Z0-9])/g, function (_m, b, s) {
            return String(b || s).replace(/[0-9+\\-=()a-pr-z]/g, function (d) {
              return supMap[d] || d;
            });
          })
          .replace(/_\\{\\s*([+-]?[0-9]+|[+-])\\s*\\}|_([+-]?[0-9])(?![0-9])/g, function (_m, b, s) {
            return String(b || s).replace(/[0-9+-]/g, function (d) {
              return subMap[d] || d;
            });
          })
          .replace(/_\\{\\s*([aehijklmnoprstuvx]+)\\s*\\}|_([aehijklmnoprstuvx])(?![a-zA-Z0-9])/g, function (_m, b, s) {
            return String(b || s).replace(/[aehijklmnoprstuvx]/g, function (d) {
              return subMap[d] || d;
            });
          })
          .replace(/_\\{\\s*([^{}]+?)\\s*\\}|_([a-zA-Z0-9,]+)(?![a-zA-Z0-9])/g, function (_m, b, s) {
            return "<sub>" + escapeHtml(String(b || s)) + "</sub>";
          })
          .replace(/\\^\\{\\s*([^{}]+?)\\s*\\}|\\^([a-zA-Z0-9+\\-]+)(?![a-zA-Z0-9])/g, function (_m, b, s) {
            return "<sup>" + escapeHtml(String(b || s)) + "</sup>";
          })
          .replace(/\\\\frac\\{\\s*([^{}]+?)\\s*\\}\\{\\s*([^{}]+?)\\s*\\}/g, "$1/$2");
      }
      cleaned = cleaned
        .replace(/\\\\([$&%_#{}])/g, "$1")
        .replace(/\\s+/g, " ")
        .trim();
      if (!/[\\\\{}^_]/.test(cleaned)) {
        return cleaned;
      }
      return "<code>" + escapeHtml(cleaned) + "</code>";
    });
    out = out.replace(/\\x60(\\/[A-Za-z0-9_\\-\\/]+\\.md)\\x60/g, '<a href="$1"><code>$1</code></a>');
    const rejectedFnSet = new Set(
      Array.isArray(rejectedSourceIds)
        ? rejectedSourceIds.map(function (r) {
            return String(r || "").trim();
          })
        : []
    );
    out = out.replace(/\\[\\^([^\\]]+)\\]/g, function (_, id) {
      const cleanId = String(id || "").trim();
      const safeId = escapeHtml(cleanId);
      const isRej = rejectedFnSet.has(cleanId);
      return (
        '<sup class="fn-ref' +
        (isRej ? " fn-rejected" : "") +
        '"><a href="#okf-src-' +
        safeId +
        '" data-fn="' +
        safeId +
        '">[' +
        safeId +
        "]</a></sup>"
      );
    });
    return out;
  }

  function renderInlineMarkdown(rawText) {
    const stash = [];
    function putStash(htmlFrag) {
      const idx = stash.length;
      stash.push(htmlFrag);
      return "\\x00ISTASH_" + idx + "\\x00";
    }
    let s = replaceInlineLatexSpans(String(rawText == null ? "" : rawText), function (_m, inner) {
      return escapeHtml(inner);
    });
    s = s.replace(/\\x60([^\\x60\\r\\n]+)\\x60/g, function (_m, code) {
      return putStash("<code>" + escapeHtml(code) + "</code>");
    });
    s = escapeHtml(s);
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function (_m, lbl, rawHref) {
      const cleanHref = rawHref.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      const isExt = /^https?:\\/\\//i.test(cleanHref);
      const safeHref = /^(?:https?:\\/\\/|mailto:|\\/|\\.\\/|\\.\\.\\/|#|[A-Za-z0-9_\\-\\/]+\\.md)/i.test(cleanHref)
        ? escapeHtml(cleanHref)
        : "#";
      const extAttrs = isExt ? ' target="_blank" rel="noopener noreferrer"' : "";
      return putStash("<a" + extAttrs + ' href="' + safeHref + '">' + lbl + "</a>");
    });
    s = s
      .replace(/\\*\\*\\*([^*\\r\\n]+?)\\*\\*\\*/g, "<strong><em>$1</em></strong>")
      .replace(/\\*\\*([^*\\r\\n]+?)\\*\\*/g, "<strong>$1</strong>")
      .replace(/(^|[\\s(])__([^_\\r\\n]+?)__(?=$|[\\s).,;:!?])/g, "$1<strong>$2</strong>")
      .replace(/(^|[^*])\\*([^\\s*][^*\\r\\n]*?)\\*(?!\\*)/g, "$1<em>$2</em>")
      .replace(/(^|[\\s(])_([^\\s_][^_\\r\\n]*?)_(?=$|[\\s).,;:!?])/g, "$1<em>$2</em>")
      .replace(/~~([^~\\r\\n]+?)~~/g, "<del>$1</del>");
    for (let pass = 0; pass < 3; pass++) {
      if (s.indexOf("\\x00ISTASH_") === -1) break;
      s = s.replace(/\\x00ISTASH_(\\d+)\\x00/g, function (_m, n) {
        return stash[Number(n)] || "";
      });
    }
    return s;
  }

  function parseBuiltInMarkdown(rawMd) {
    const stash = [];
    function putStash(htmlFrag) {
      const idx = stash.length;
      stash.push(htmlFrag);
      return "\\x00STASH_" + idx + "\\x00";
    }
    let text = String(rawMd || "").replace(/\\r\\n/g, "\\n");
    // Preserve trusted inline HTML emitted by formatInlineLatexAndFootnotes before escaping
    text = text.replace(
      /<sup class="fn-ref[^"]*"><a [^>]+>\\[[^\\]]+\\]<\\/a><\\/sup>|<(?:sub|sup|code)>[^<]*<\\/(?:sub|sup|code)>|<a href="[^"]+"><code>[^<]+<\\/code><\\/a>/g,
      function (m) {
        return putStash(m);
      }
    );
    const fenceStash = [];
    text = text.replace(/^\\x60\\x60\\x60[^\\n]*\\n([\\s\\S]*?)^\\x60\\x60\\x60\\s*$/gm, function (_m, codeBody) {
      const idx = fenceStash.length;
      fenceStash.push("<pre><code>" + escapeHtml(codeBody.replace(/\\n$/, "")) + "</code></pre>");
      return "\\x00FENCE_" + idx + "\\x00";
    });
    function formatInline(s) {
      let line = String(s || "");
      line = line.replace(/\\x60([^\\x60\\n]+)\\x60/g, function (_m, code) {
        return putStash("<code>" + escapeHtml(code) + "</code>");
      });
      line = line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      line = line.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function (_m, lbl, rawHref) {
        const cleanHref = rawHref.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
        const isExt = /^https?:\\/\\//i.test(cleanHref);
        const safeHref = /^(?:https?:\\/\\/|mailto:|\\/|\\.\\/|\\.\\.\\/|#|[A-Za-z0-9_\\-\\/]+\\.md)/i.test(cleanHref)
          ? escapeHtml(cleanHref)
          : "#";
        const extAttrs = isExt ? ' target="_blank" rel="noopener noreferrer"' : "";
        const unescapedLbl = lbl
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&");
        return putStash("<a" + extAttrs + ' href="' + safeHref + '">' + formatInline(unescapedLbl) + "</a>");
      });
      line = line
        .replace(/\\*\\*\\*([^*\\n]+?)\\*\\*\\*/g, "<strong><em>$1</em></strong>")
        .replace(/\\*\\*([^*\\n]+?)\\*\\*/g, "<strong>$1</strong>")
        .replace(/(^|[\\s(])__([^_\\n]+?)__(?=$|[\\s).,;:!?])/g, "$1<strong>$2</strong>")
        .replace(/(^|[^*])\\*([^\\s*][^*\\n]*?)\\*(?!\\*)/g, "$1<em>$2</em>")
        .replace(/(^|[\\s(])_([^\\s_][^_\\n]*?)_(?=$|[\\s).,;:!?])/g, "$1<em>$2</em>")
        .replace(/~~([^~\\n]+?)~~/g, "<del>$1</del>");
      for (let pass = 0; pass < 3; pass++) {
        if (line.indexOf("\\x00STASH_") === -1) break;
        line = line.replace(/\\x00STASH_(\\d+)\\x00/g, function (_m, n) {
          return stash[Number(n)] || "";
        });
      }
      return line;
    }
    const lines = text.split("\\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();
      if (!trimmed) {
        i++;
        continue;
      }
      const fenceM = trimmed.match(/^\\x00FENCE_(\\d+)\\x00$/);
      if (fenceM) {
        out.push(fenceStash[Number(fenceM[1])] || "");
        i++;
        continue;
      }
      if (/^(?:---+|\\*\\*\\*+|___+)$/.test(trimmed)) {
        out.push("<hr>");
        i++;
        continue;
      }
      const hM = trimmed.match(/^(#{1,6})\\s+(.+?)\\s*#*\\s*$/);
      if (hM) {
        const lvl = hM[1].length;
        out.push("<h" + lvl + ">" + formatInline(hM[2]) + "</h" + lvl + ">");
        i++;
        continue;
      }
      if (
        trimmed.indexOf("|") !== -1 &&
        i + 1 < lines.length &&
        /^\\s*\\|?\\s*:?-{2,}:?(?:\\s*\\|\\s*:?-{2,}:?)+\\s*\\|?\\s*$/.test(lines[i + 1])
      ) {
        const splitCells = function (rowStr) {
          return rowStr
            .trim()
            .replace(/^\\|/, "")
            .replace(/\\|$/, "")
            .split("|")
            .map(function (c) {
              return c.trim();
            });
        };
        const headers = splitCells(rawLine);
        i += 2;
        let tbl =
          "<table><thead><tr>" +
          headers
            .map(function (h) {
              return "<th>" + formatInline(h) + "</th>";
            })
            .join("") +
          "</tr></thead><tbody>";
        while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") !== -1) {
          const cells = splitCells(lines[i]);
          tbl +=
            "<tr>" +
            headers
              .map(function (_h, cIdx) {
                return "<td>" + formatInline(cells[cIdx] || "") + "</td>";
              })
              .join("") +
            "</tr>";
          i++;
        }
        tbl += "</tbody></table>";
        out.push(tbl);
        continue;
      }
      if (/^>\\s?/.test(trimmed)) {
        const qLines = [];
        while (i < lines.length && /^\\s*>\\s?/.test(lines[i])) {
          qLines.push(lines[i].replace(/^\\s*>\\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + parseBuiltInMarkdown(qLines.join("\\n")) + "</blockquote>");
        continue;
      }
      const listM = rawLine.match(/^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$/);
      if (listM) {
        const renderListBlock = function (baseIndent) {
          const firstM = lines[i].match(/^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$/);
          const isOrd = /^\\d/.test(firstM[2]);
          const tag = isOrd ? "ol" : "ul";
          let listHtml = "<" + tag + ">";
          while (i < lines.length) {
            if (!lines[i].trim()) {
              if (i + 1 < lines.length && /^(\\s*)([-*+]|\\d+[.)])\\s+/.test(lines[i + 1])) {
                i++;
                continue;
              }
              break;
            }
            const m = lines[i].match(/^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$/);
            if (!m) break;
            const ind = m[1].length;
            if (ind < baseIndent) break;
            if (ind > baseIndent) {
              listHtml = listHtml.replace(/<\\/li>$/, "") + renderListBlock(ind) + "</li>";
              continue;
            }
            let itemBody = m[3];
            const taskM = itemBody.match(/^\\[([ xX])\\]\\s+(.*)$/);
            let prefix = "";
            if (taskM) {
              prefix =
                '<input type="checkbox" disabled' +
                (taskM[1].toLowerCase() === "x" ? " checked" : "") +
                "> ";
              itemBody = taskM[2];
            }
            i++;
            while (
              i < lines.length &&
              lines[i].trim() &&
              !/^\\s*([-*+]|\\d+[.)])\\s+/.test(lines[i]) &&
              !/^\\s*(?:#{1,6}\\s+|---+|\\*\\*\\*+|>|\\x60\\x60\\x60|\\x00FENCE_)/.test(lines[i])
            ) {
              itemBody += " " + lines[i].trim();
              i++;
            }
            let subHtml = "";
            if (i < lines.length) {
              const nextM = lines[i].match(/^(\\s*)([-*+]|\\d+[.)])\\s+/);
              if (nextM && nextM[1].length > baseIndent) {
                subHtml = renderListBlock(nextM[1].length);
              }
            }
            listHtml += "<li>" + prefix + formatInline(itemBody) + subHtml + "</li>";
          }
          listHtml += "</" + tag + ">";
          return listHtml;
        };
        out.push(renderListBlock(listM[1].length));
        continue;
      }
      const pLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\\s*(?:#{1,6}\\s+|---+|\\*\\*\\*+|___+|>\\s?|[-*+]\\s+|\\d+[.)]\\s+|\\x00FENCE_)/.test(lines[i]) &&
        !(
          lines[i].indexOf("|") !== -1 &&
          i + 1 < lines.length &&
          /^\\s*\\|?\\s*:?-{2,}:?(?:\\s*\\|\\s*:?-{2,}:?)+\\s*\\|?\\s*$/.test(lines[i + 1])
        )
      ) {
        pLines.push(lines[i].trim());
        i++;
      }
      if (pLines.length > 0) {
        out.push("<p>" + formatInline(pLines.join(" ")) + "</p>");
      } else {
        i++;
      }
    }
    return out.join("\\n");
  }

  function renderMarkdownBlock(rawMd, sources, rejectedSourceIds) {
    const formatted = formatInlineLatexAndFootnotes(rawMd, sources || [], rejectedSourceIds);
    if (typeof window !== "undefined" && window.marked && typeof window.marked.parse === "function") {
      return window.marked.parse(formatted);
    }
    return parseBuiltInMarkdown(formatted);
  }

  // Component Renderer (Tier 1 Basic Catalog + Tier 2 ICM/OKF Domain Catalog)
  function renderComponentById(surface, compId, scopeData, scopePath) {
    const comp = surface.components[compId];
    if (!comp) {
      const missing = document.createElement("div");
      missing.className = "a2ui-caption";
      missing.textContent = "[Missing component: " + compId + "]";
      return missing;
    }
    return renderComponent(surface, comp, scopeData, scopePath);
  }

  function renderChildList(surface, childrenSpec, containerEl, scopeData, scopePath) {
    if (Array.isArray(childrenSpec)) {
      for (const childId of childrenSpec) {
        containerEl.appendChild(renderComponentById(surface, childId, scopeData, scopePath));
      }
    } else if (childrenSpec && typeof childrenSpec === "object" && childrenSpec.path && childrenSpec.componentId) {
      const listData = resolvePointer(surface.dataModel, childrenSpec.path, scopeData);
      if (Array.isArray(listData)) {
        listData.forEach((itemData, idx) => {
          const itemScopePath = (childrenSpec.path.startsWith("/") ? childrenSpec.path : (scopePath || "") + "/" + childrenSpec.path) + "/" + idx;
          containerEl.appendChild(renderComponentById(surface, childrenSpec.componentId, itemData, itemScopePath));
        });
      }
    }
  }

  function renderComponent(surface, comp, scopeData, scopePath) {
    const type = comp.component;

    // --- TIER 1: A2UI v0.9.1 BASIC CATALOG PRIMITIVES ---
    if (type === "Column") {
      const el = document.createElement("div");
      el.className = "a2ui-col";
      renderChildList(surface, comp.children, el, scopeData, scopePath);
      return el;
    }

    if (type === "Row") {
      const el = document.createElement("div");
      el.className = "a2ui-row" + (comp.justify === "spaceBetween" ? " justify-between" : "");
      renderChildList(surface, comp.children, el, scopeData, scopePath);
      return el;
    }

    if (type === "List") {
      const el = document.createElement("div");
      el.className = comp.direction === "horizontal" ? "a2ui-row" : "a2ui-col";
      renderChildList(surface, comp.children, el, scopeData, scopePath);
      return el;
    }

    if (type === "Card") {
      const el = document.createElement("div");
      el.className = "a2ui-card";
      if (typeof comp.child === "string") {
        el.appendChild(renderComponentById(surface, comp.child, scopeData, scopePath));
      } else if (comp.children) {
        renderChildList(surface, comp.children, el, scopeData, scopePath);
      }
      return el;
    }

    if (type === "Divider") {
      const hr = document.createElement("hr");
      hr.className = "a2ui-divider";
      return hr;
    }

    if (type === "Text") {
      const variant = resolveDynamic(comp.variant, surface, scopeData) || "body";
      const rawText = String(resolveDynamic(comp.text, surface, scopeData) ?? "");
      const tagMap = { h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", caption: "p", body: "div" };
      const el = document.createElement(tagMap[variant] || "div");
      el.className = "a2ui-" + (tagMap[variant] ? variant : "body");
      if (comp.markdown) {
        el.style.whiteSpace = "normal";
        el.classList.add("okf-md-body");
        el.innerHTML = renderMarkdownBlock(rawText, []);
      } else if (variant === "body" && /(\\*\\*[^*]+\\*\\*|\\x60[^\\x60]+\\x60|\\[[^\\]]+\\]\\([^)\\s]+\\))/.test(rawText)) {
        el.innerHTML = renderInlineMarkdown(rawText);
      } else {
        el.textContent = rawText;
      }
      return el;
    }

    if (type === "Badge") {
      const el = document.createElement("span");
      const tone = resolveDynamic(comp.tone, surface, scopeData) || "neutral";
      el.className = "a2ui-badge " + tone;
      el.textContent = String(resolveDynamic(comp.text, surface, scopeData) ?? "");
      return el;
    }

    if (type === "Button") {
      const btn = document.createElement("button");
      const variant = comp.variant || "default";
      btn.className = "a2ui-btn " + variant;
      if (typeof comp.child === "string") {
        btn.appendChild(renderComponentById(surface, comp.child, scopeData, scopePath));
      } else {
        btn.textContent = String(resolveDynamic(comp.label ?? comp.text, surface, scopeData) || "Action");
      }
      btn.addEventListener("click", () => {
        if (comp.action && comp.action.event) {
          const ctx = {};
          const rawCtx = comp.action.event.context || {};
          for (const k of Object.keys(rawCtx)) {
            ctx[k] = resolveDynamic(rawCtx[k], surface, scopeData);
          }
          dispatchClientAction(surface, comp.id, comp.action.event.name, ctx);
        } else if (comp.action && comp.action.functionCall) {
          evaluateFunctionCall(comp.action.functionCall, surface, scopeData);
        }
      });
      return btn;
    }

    if (type === "CheckBox") {
      const labelEl = document.createElement("label");
      const checkedVal = Boolean(resolveDynamic(comp.value, surface, scopeData));
      labelEl.className = "a2ui-checkbox-label" + (checkedVal ? " checked" : "");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = checkedVal;
      const span = document.createElement("span");
      span.textContent = String(resolveDynamic(comp.label, surface, scopeData) ?? "");
      input.addEventListener("change", () => {
        if (comp.value && typeof comp.value === "object" && comp.value.path) {
          setPointer(surface.dataModel, comp.value.path, input.checked, scopePath);
          recomputeChecklistSummary(surface);
          syncChecklistToOkfBody(surface);
          dispatchClientAction(surface, comp.id, "checkboxChanged", {
            path: comp.value.path,
            checked: input.checked,
          });
          renderSurface();
        }
      });
      labelEl.appendChild(input);
      labelEl.appendChild(span);
      return labelEl;
    }

    if (type === "TextField") {
      const wrap = document.createElement("div");
      wrap.className = "a2ui-textfield";
      const lbl = resolveDynamic(comp.label, surface, scopeData);
      if (lbl) {
        const l = document.createElement("label");
        l.textContent = String(lbl);
        wrap.appendChild(l);
      }
      const isLong = comp.variant === "longText";
      const input = document.createElement(isLong ? "textarea" : "input");
      if (isLong) {
        input.rows = 3;
      } else if (comp.variant === "number") {
        input.type = "number";
      } else if (comp.variant === "obscured") {
        input.type = "password";
      } else {
        input.type = "text";
      }
      input.value = String(resolveDynamic(comp.value, surface, scopeData) ?? "");
      if (comp.placeholder) input.placeholder = String(comp.placeholder);
      input.addEventListener("input", () => {
        if (comp.value && typeof comp.value === "object" && comp.value.path) {
          const nextVal = comp.variant === "number" ? Number(input.value) : input.value;
          setPointer(surface.dataModel, comp.value.path, nextVal, scopePath);
        }
      });
      wrap.appendChild(input);
      return wrap;
    }

    if (type === "ChoicePicker") {
      const wrap = document.createElement("div");
      wrap.className = "a2ui-choice-group";
      const lbl = resolveDynamic(comp.label, surface, scopeData);
      if (lbl) {
        const l = document.createElement("div");
        l.className = "a2ui-h4";
        l.textContent = String(lbl);
        wrap.appendChild(l);
      }
      const options = resolveDynamic(comp.options, surface, scopeData) || [];
      const currentVal = resolveDynamic(comp.value, surface, scopeData);
      const isMulti = comp.variant === "multipleSelection";
      const selectedArr = Array.isArray(currentVal)
        ? currentVal.map(String)
        : currentVal != null && currentVal !== ""
          ? [String(currentVal)]
          : [];

      options.forEach((opt) => {
        const valStr = String(opt.value);
        const isSel = selectedArr.includes(valStr);
        const row = document.createElement("label");
        row.className = "a2ui-choice-opt" + (isSel ? " selected" : "");
        const inp = document.createElement("input");
        inp.type = isMulti ? "checkbox" : "radio";
        inp.checked = isSel;
        inp.addEventListener("change", () => {
          if (comp.value && typeof comp.value === "object" && comp.value.path) {
            if (isMulti) {
              const nextSet = new Set(selectedArr);
              if (inp.checked) {
                nextSet.add(valStr);
              } else {
                nextSet.delete(valStr);
              }
              setPointer(surface.dataModel, comp.value.path, Array.from(nextSet), scopePath);
            } else if (Array.isArray(currentVal)) {
              setPointer(surface.dataModel, comp.value.path, [valStr], scopePath);
            } else {
              setPointer(surface.dataModel, comp.value.path, valStr, scopePath);
            }
            renderSurface();
          }
        });
        const txt = document.createElement("span");
        txt.textContent = String(resolveDynamic(opt.label, surface, scopeData) ?? opt.value);
        row.appendChild(inp);
        row.appendChild(txt);
        wrap.appendChild(row);
      });
      return wrap;
    }

    if (type === "AudioPlayer") {
      const isNo = isNorwegianSurface(surface);
      const wrap = document.createElement("div");
      wrap.className = "a2ui-row";
      const desc = String(resolveDynamic(comp.description, surface, scopeData) || "Audio Narration");
      const textToSpeak = String(resolveDynamic(comp.ttsText, surface, scopeData) || "");
      const url = resolveDynamic(comp.url, surface, scopeData);
      if (url && !String(url).startsWith("tts://")) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = String(url);
        wrap.appendChild(audio);
      } else {
        const playBtn = document.createElement("button");
        playBtn.className = "a2ui-btn primary";
        playBtn.textContent = isNo
          ? "🔊 Spill av opplesning (" + desc + ")"
          : "🔊 Listen to narration (" + desc + ")";
        playBtn.addEventListener("click", () => speakNarration(textToSpeak));
        const stopBtn = document.createElement("button");
        stopBtn.className = "a2ui-btn";
        stopBtn.textContent = isNo ? "⏹ Stopp" : "⏹ Stop";
        stopBtn.addEventListener("click", () => stopActiveSpeech());
        wrap.appendChild(playBtn);
        wrap.appendChild(stopBtn);
      }
      return wrap;
    }

    if (type === "Image") {
      const img = document.createElement("img");
      img.src = String(resolveDynamic(comp.url, surface, scopeData) || "");
      img.alt = String(resolveDynamic(comp.description ?? comp.alt, surface, scopeData) || "");
      img.style.maxWidth = "100%";
      img.style.borderRadius = "8px";
      if (comp.fit) img.style.objectFit = String(comp.fit);
      return img;
    }

    if (type === "Icon") {
      const span = document.createElement("span");
      span.className = "a2ui-badge neutral";
      const iconName = resolveDynamic(comp.name, surface, scopeData);
      span.textContent = typeof iconName === "object" && iconName && iconName.path ? iconName.path : String(iconName || "•");
      return span;
    }

    if (type === "Video") {
      const video = document.createElement("video");
      video.controls = true;
      video.src = String(resolveDynamic(comp.url, surface, scopeData) || "");
      video.style.maxWidth = "100%";
      video.style.borderRadius = "8px";
      return video;
    }

    if (type === "Slider") {
      const wrap = document.createElement("div");
      wrap.className = "a2ui-textfield";
      const lbl = resolveDynamic(comp.label, surface, scopeData);
      const curVal = Number(resolveDynamic(comp.value, surface, scopeData) ?? comp.min ?? 0);
      if (lbl) {
        const l = document.createElement("label");
        l.textContent = String(lbl) + ": " + curVal;
        wrap.appendChild(l);
      }
      const inp = document.createElement("input");
      inp.type = "range";
      inp.min = String(comp.min ?? 0);
      inp.max = String(comp.max ?? 100);
      inp.value = String(curVal);
      inp.addEventListener("input", () => {
        if (comp.value && typeof comp.value === "object" && comp.value.path) {
          setPointer(surface.dataModel, comp.value.path, Number(inp.value), scopePath);
          renderSurface();
        }
      });
      wrap.appendChild(inp);
      return wrap;
    }

    if (type === "DateTimeInput") {
      const wrap = document.createElement("div");
      wrap.className = "a2ui-textfield";
      const lbl = resolveDynamic(comp.label, surface, scopeData);
      if (lbl) {
        const l = document.createElement("label");
        l.textContent = String(lbl);
        wrap.appendChild(l);
      }
      const inp = document.createElement("input");
      inp.type = comp.enableTime && comp.enableDate !== false ? "datetime-local" : comp.enableTime ? "time" : "date";
      inp.value = String(resolveDynamic(comp.value, surface, scopeData) || "");
      inp.addEventListener("change", () => {
        if (comp.value && typeof comp.value === "object" && comp.value.path) {
          setPointer(surface.dataModel, comp.value.path, inp.value, scopePath);
        }
      });
      wrap.appendChild(inp);
      return wrap;
    }

    if (type === "Modal") {
      const isNo = isNorwegianSurface(surface);
      const wrap = document.createElement("div");
      const trigId = comp.trigger || comp.entryPointChild;
      const contentId = comp.content || comp.contentChild;
      const isOpen = Boolean(surface.uiState["modal_" + comp.id]);
      if (typeof trigId === "string") {
        const trigEl = renderComponentById(surface, trigId, scopeData, scopePath);
        trigEl.addEventListener("click", () => {
          surface.uiState["modal_" + comp.id] = true;
          renderSurface();
        });
        wrap.appendChild(trigEl);
      }
      if (isOpen && typeof contentId === "string") {
        const backdrop = document.createElement("div");
        backdrop.className = "a2ui-modal-backdrop";
        const dialog = document.createElement("div");
        dialog.className = "a2ui-modal-dialog";
        const header = document.createElement("div");
        header.className = "a2ui-modal-header";
        header.innerHTML = "<strong>Modal</strong>";
        const closeBtn = document.createElement("button");
        closeBtn.className = "a2ui-btn";
        closeBtn.textContent = isNo ? "Lukk" : "Close";
        closeBtn.addEventListener("click", () => {
          surface.uiState["modal_" + comp.id] = false;
          renderSurface();
        });
        header.appendChild(closeBtn);
        const body = document.createElement("div");
        body.className = "a2ui-modal-body";
        body.appendChild(renderComponentById(surface, contentId, scopeData, scopePath));
        dialog.appendChild(header);
        dialog.appendChild(body);
        backdrop.appendChild(dialog);
        wrap.appendChild(backdrop);
      }
      return wrap;
    }

    if (type === "Tabs") {
      const wrap = document.createElement("div");
      const tabsList = comp.tabs || comp.tabItems || [];
      const activeIdx = surface.uiState.activeTabs[comp.id] || 0;

      const nav = document.createElement("div");
      nav.className = "a2ui-tabs-nav";
      tabsList.forEach((tab, idx) => {
        const btn = document.createElement("button");
        btn.className = "a2ui-tab-btn" + (idx === activeIdx ? " active" : "");
        btn.textContent = String(resolveDynamic(tab.title, surface, scopeData) || "Tab " + (idx + 1));
        btn.addEventListener("click", () => {
          stopActiveSpeech();
          surface.uiState.activeTabs[comp.id] = idx;
          renderSurface();
        });
        nav.appendChild(btn);
      });
      wrap.appendChild(nav);

      const activeTab = tabsList[activeIdx] || tabsList[0];
      if (activeTab && typeof activeTab.child === "string") {
        wrap.appendChild(renderComponentById(surface, activeTab.child, scopeData, scopePath));
      }
      return wrap;
    }

    // --- TIER 2: ICM + OKF v0.2 DOMAIN CUSTOM COMPONENTS ---
    if (type === "InteractiveChecklist") {
      const isNo = isNorwegianSurface(surface);
      const wrap = document.createElement("div");
      wrap.className = "a2ui-col";
      const groups = resolvePointer(surface.dataModel, comp.groupsPath || "/checklist/groups") || [];
      const summaryText = resolvePointer(surface.dataModel, "/checklist/summaryText") || "";
      const pct = Number(resolvePointer(surface.dataModel, "/checklist/percent") || 0);

      const headerCard = document.createElement("div");
      headerCard.className = "a2ui-card a2ui-col";
      const topRow = document.createElement("div");
      topRow.className = "a2ui-row justify-between";
      const titleEl = document.createElement("h2");
      titleEl.className = "a2ui-h2";
      titleEl.textContent = String(
        resolveDynamic(comp.title, surface, scopeData) ||
          (isNo ? "Interaktiv Sjekkliste" : "Interactive Checklist")
      );
      const badge = document.createElement("span");
      badge.className = "a2ui-badge " + (pct === 100 ? "success" : "primary");
      badge.textContent = summaryText;
      topRow.appendChild(titleEl);
      topRow.appendChild(badge);
      headerCard.appendChild(topRow);

      const progWrap = document.createElement("div");
      progWrap.className = "a2ui-progress-wrap";
      const progFill = document.createElement("div");
      progFill.className = "a2ui-progress-fill";
      progFill.style.width = pct + "%";
      progWrap.appendChild(progFill);
      headerCard.appendChild(progWrap);

      const btnRow = document.createElement("div");
      btnRow.className = "a2ui-row";
      const checkAllBtn = document.createElement("button");
      checkAllBtn.className = "a2ui-btn";
      checkAllBtn.textContent = isNo ? "✓ Marker alle" : "✓ Check all";
      checkAllBtn.addEventListener("click", () => dispatchClientAction(surface, comp.id, "checkAllChecklist", {}));
      const resetBtn = document.createElement("button");
      resetBtn.className = "a2ui-btn";
      resetBtn.textContent = isNo ? "↺ Nullstill sjekkliste" : "↺ Reset checklist";
      resetBtn.addEventListener("click", () => dispatchClientAction(surface, comp.id, "resetChecklist", {}));
      btnRow.appendChild(checkAllBtn);
      btnRow.appendChild(resetBtn);
      headerCard.appendChild(btnRow);
      wrap.appendChild(headerCard);

      groups.forEach((grp, gIdx) => {
        const grpCard = document.createElement("div");
        grpCard.className = "a2ui-card a2ui-col";
        const grpHeader = document.createElement("div");
        grpHeader.className = "a2ui-row justify-between";
        const h3 = document.createElement("h3");
        h3.className = "a2ui-h3";
        h3.textContent = grp.title;
        const doneInGrp = (grp.items || []).filter((i) => i.checked).length;
        const subBadge = document.createElement("span");
        subBadge.className = "a2ui-badge " + (doneInGrp === (grp.items || []).length ? "success" : "neutral");
        subBadge.textContent = doneInGrp + " / " + (grp.items || []).length;
        grpHeader.appendChild(h3);
        grpHeader.appendChild(subBadge);
        grpCard.appendChild(grpHeader);

        const itemsCol = document.createElement("div");
        itemsCol.className = "a2ui-col";
        itemsCol.style.gap = "4px";
        (grp.items || []).forEach((item, iIdx) => {
          const itemPath = (comp.groupsPath || "/checklist/groups") + "/" + gIdx + "/items/" + iIdx + "/checked";
          const chkComp = {
            id: comp.id + "_" + grp.id + "_" + item.id,
            component: "CheckBox",
            label: item.label,
            value: { path: itemPath },
          };
          itemsCol.appendChild(renderComponent(surface, chkComp, undefined, undefined));
        });
        grpCard.appendChild(itemsCol);
        wrap.appendChild(grpCard);
      });

      return wrap;
    }

    if (type === "ModuleCarousel") {
      const isNo = isNorwegianSurface(surface);
      const isAnalysis = isAnalysisSurface(surface);
      const wrap = document.createElement("div");
      wrap.className = "a2ui-col";
      const modules = resolvePointer(surface.dataModel, comp.modulesPath || "/stage2/modules") || [];
      const activeIdxPath = comp.activeIndexPath || "/stage2/activeModuleIndex";
      let idx = Number(resolvePointer(surface.dataModel, activeIdxPath) || 0);
      if (idx < 0 || idx >= modules.length) idx = 0;

      if (modules.length === 0) {
        const empty = document.createElement("div");
        empty.className = "a2ui-card a2ui-caption";
        empty.textContent = isNo
          ? "Ingen moduler funnet i Stage 2-artefaktet."
          : "No modules or pillars found in Stage 2 artifact.";
        return empty;
      }

      const mod = modules[idx];
      const navRow = document.createElement("div");
      navRow.className = "a2ui-row justify-between";
      const pillRow = document.createElement("div");
      pillRow.className = "a2ui-row";
      modules.forEach((m, mIdx) => {
        const b = document.createElement("button");
        b.className = "a2ui-btn" + (mIdx === idx ? " primary" : "");
        b.textContent = (m.number || mIdx + 1) + ". " + m.title;
        b.addEventListener("click", () => {
          stopActiveSpeech();
          setPointer(surface.dataModel, activeIdxPath, mIdx);
          renderSurface();
        });
        pillRow.appendChild(b);
      });
      navRow.appendChild(pillRow);
      wrap.appendChild(navRow);

      const card = document.createElement("div");
      card.className = "a2ui-card a2ui-col";
      const headRow = document.createElement("div");
      headRow.className = "a2ui-row justify-between";
      const h2 = document.createElement("h2");
      h2.className = "a2ui-h2";
      const itemLabel = isNo
        ? isAnalysis
          ? "Pilar "
          : "Modul "
        : isAnalysis
          ? "Pillar "
          : "Module ";
      h2.textContent = itemLabel + (mod.number || idx + 1) + ": " + mod.title;
      headRow.appendChild(h2);
      const badgeWrap = document.createElement("div");
      badgeWrap.className = "a2ui-row";
      if (mod.durationOrMeta) {
        const durBadge = document.createElement("span");
        durBadge.className = "a2ui-badge neutral";
        const durTxt = String(mod.durationOrMeta).trim();
        durBadge.textContent = durTxt.startsWith("⏱") ? durTxt : "⏱️ " + durTxt;
        badgeWrap.appendChild(durBadge);
      }
      if (mod.subtitleOrBasis) {
        const basisBadge = document.createElement("span");
        basisBadge.className = "a2ui-badge accent";
        basisBadge.textContent = mod.subtitleOrBasis;
        badgeWrap.appendChild(basisBadge);
      }
      if (badgeWrap.childNodes.length > 0) {
        headRow.appendChild(badgeWrap);
      }
      card.appendChild(headRow);

      if (mod.narration) {
        const narBox = document.createElement("div");
        narBox.className = "a2ui-body okf-md-body";
        narBox.style.padding = "14px 16px";
        narBox.style.background = "var(--bg)";
        narBox.style.borderRadius = "8px";
        narBox.style.borderLeft = "4px solid var(--primary)";
        narBox.style.whiteSpace = "normal";
        narBox.innerHTML = renderMarkdownBlock(mod.narration, []);
        card.appendChild(narBox);

        const ttsPlayer = renderComponent(surface, {
          id: comp.id + "_tts_" + idx,
          component: "AudioPlayer",
          url: "tts://web-speech/module/" + (idx + 1),
          description: mod.title,
          ttsText: mod.spokenNarration || mod.narration,
        });
        card.appendChild(ttsPlayer);
      }

      if (Array.isArray(mod.bullets) && mod.bullets.length > 0) {
        const ulWrap = document.createElement("div");
        ulWrap.className = "a2ui-col";
        const h4 = document.createElement("h4");
        h4.className = "a2ui-h4";
        h4.textContent = isNo
          ? isAnalysis
            ? "Nøkkelpunkter & Analyse"
            : "Nøkkelpunkter / Lysbilder"
          : isAnalysis
            ? "Key Analytical Takeaways"
            : "Key Points / Slide Cues";
        ulWrap.appendChild(h4);
        const ul = document.createElement("ul");
        ul.style.margin = "0";
        mod.bullets.forEach((bText) => {
          const li = document.createElement("li");
          li.innerHTML = renderInlineMarkdown(bText);
          ul.appendChild(li);
        });
        ulWrap.appendChild(ul);
        card.appendChild(ulWrap);
      }

      if (mod.actionItem) {
        const actBox = document.createElement("div");
        actBox.style.padding = "12px 14px";
        actBox.style.background = "var(--success-soft)";
        actBox.style.border = "1px solid var(--success-border)";
        actBox.style.borderRadius = "8px";
        const actTitle = isNo
          ? isAnalysis
            ? "⚡ Anbefaling / Beslutningspunkt:"
            : "⚡ Praktisk tiltak / Handlingspunkt:"
          : isAnalysis
            ? "⚡ IC Directive / Recommended Action:"
            : "⚡ Practical Action Item:";
        actBox.innerHTML =
          "<strong>" +
          actTitle +
          "</strong><div class='okf-md-body' style='margin-top:4px'>" +
          renderMarkdownBlock(mod.actionItem, []) +
          "</div>";
        card.appendChild(actBox);
      }

      const pager = document.createElement("div");
      pager.className = "a2ui-row justify-between";
      const prevBtn = document.createElement("button");
      prevBtn.className = "a2ui-btn";
      prevBtn.disabled = idx === 0;
      prevBtn.textContent = isNo
        ? isAnalysis
          ? "← Forrige pilar"
          : "← Forrige modul"
        : isAnalysis
          ? "← Previous pillar"
          : "← Previous module";
      prevBtn.addEventListener("click", () => {
        if (idx > 0) {
          stopActiveSpeech();
          setPointer(surface.dataModel, activeIdxPath, idx - 1);
          renderSurface();
        }
      });
      const nextBtn = document.createElement("button");
      nextBtn.className = "a2ui-btn primary";
      nextBtn.disabled = idx >= modules.length - 1;
      nextBtn.textContent = isNo
        ? isAnalysis
          ? "Neste pilar →"
          : "Neste modul →"
        : isAnalysis
          ? "Next pillar →"
          : "Next module →";
      nextBtn.addEventListener("click", () => {
        if (idx < modules.length - 1) {
          stopActiveSpeech();
          setPointer(surface.dataModel, activeIdxPath, idx + 1);
          renderSurface();
        }
      });
      pager.appendChild(prevBtn);
      pager.appendChild(nextBtn);
      card.appendChild(pager);

      wrap.appendChild(card);
      return wrap;
    }

    if (type === "QuizRunner") {
      const isNo = isNorwegianSurface(surface);
      const wrap = document.createElement("div");
      wrap.className = "a2ui-col";
      const questions = resolvePointer(surface.dataModel, comp.questionsPath || "/stage2/quiz") || [];
      const answersPath = comp.answersPath || "/stage2/quizAnswers";
      const answers = resolvePointer(surface.dataModel, answersPath) || {};

      let answeredCount = 0;
      let correctCount = 0;
      questions.forEach((q) => {
        if (answers[q.id] !== undefined) {
          answeredCount++;
          const ansVal = Array.isArray(answers[q.id]) ? answers[q.id][0] : answers[q.id];
          if (String(ansVal) === String(q.correctValue)) correctCount++;
        }
      });

      const scoreCard = document.createElement("div");
      scoreCard.className = "a2ui-card a2ui-row justify-between";
      const scoreTitle = document.createElement("h2");
      scoreTitle.className = "a2ui-h2";
      scoreTitle.textContent = String(
        resolveDynamic(comp.title, surface, scopeData) ||
          (isNo ? "Kunnskapssjekk" : "Knowledge Check")
      );
      const scoreBadge = document.createElement("span");
      scoreBadge.className = "a2ui-badge " + (correctCount === questions.length && questions.length > 0 ? "success" : "primary");
      scoreBadge.textContent = isNo
        ? "Resultat: " + correctCount + " / " + questions.length + " riktige (" + answeredCount + " besvart)"
        : "Score: " + correctCount + " / " + questions.length + " correct (" + answeredCount + " answered)";
      scoreCard.appendChild(scoreTitle);
      scoreCard.appendChild(scoreBadge);
      wrap.appendChild(scoreCard);

      questions.forEach((q, qIdx) => {
        const qCard = document.createElement("div");
        qCard.className = "a2ui-card a2ui-col";
        const qHeadRow = document.createElement("div");
        qHeadRow.className = "a2ui-row justify-between";
        const qHead = document.createElement("h3");
        qHead.className = "a2ui-h3";
        qHead.innerHTML = renderInlineMarkdown((qIdx + 1) + ". " + q.question);
        qHeadRow.appendChild(qHead);
        if (q.sourceModule) {
          const srcModBadge = document.createElement("span");
          srcModBadge.className = "a2ui-badge neutral";
          srcModBadge.textContent = q.sourceModule;
          qHeadRow.appendChild(srcModBadge);
        }
        qCard.appendChild(qHeadRow);

        const picker = renderComponent(surface, {
          id: comp.id + "_q_" + q.id,
          component: "ChoicePicker",
          variant: "mutuallyExclusive",
          options: q.options,
          value: { path: answersPath + "/" + q.id },
        });
        qCard.appendChild(picker);

        const rawChosen = answers[q.id];
        const chosen = Array.isArray(rawChosen) ? rawChosen[0] : rawChosen;
        if (chosen !== undefined) {
          const isRight = String(chosen) === String(q.correctValue);
          const fb = document.createElement("div");
          fb.style.padding = "10px 12px";
          fb.style.borderRadius = "7px";
          fb.style.background = isRight ? "var(--success-soft)" : "var(--danger-soft)";
          fb.style.border = "1px solid " + (isRight ? "var(--success-border)" : "var(--danger-border)");
          fb.innerHTML =
            "<strong>" +
            (isRight
              ? isNo
                ? "✓ Riktig svar!"
                : "✓ Correct!"
              : isNo
                ? "✗ Ikke helt."
                : "✗ Not quite.") +
            "</strong> " +
            renderInlineMarkdown(q.explanation || "");
          qCard.appendChild(fb);
        }
        wrap.appendChild(qCard);
      });
      return wrap;
    }

    if (type === "CaseSimulator") {
      const isNo = isNorwegianSurface(surface);
      const isAnalysis = isAnalysisSurface(surface);
      const wrap = document.createElement("div");
      wrap.className = "a2ui-col";
      const cases = resolvePointer(surface.dataModel, comp.casesPath || "/stage2/cases") || [];
      const responsesPath = comp.responsesPath || "/stage2/caseResponses";
      const revealedPath = "/stage2/caseRevealed";
      const revealed = resolvePointer(surface.dataModel, revealedPath) || {};

      cases.forEach((c, cIdx) => {
        const card = document.createElement("div");
        card.className = "a2ui-card a2ui-col";
        const top = document.createElement("div");
        top.className = "a2ui-row justify-between";
        const h3 = document.createElement("h3");
        h3.className = "a2ui-h3";
        const casePrefix = isNo
          ? "Case "
          : isAnalysis
            ? "Scenario "
            : "Case ";
        h3.textContent = casePrefix + (cIdx + 1) + ": " + c.title;
        top.appendChild(h3);
        if (c.basisOrContext) {
          const b = document.createElement("span");
          b.className = "a2ui-badge accent";
          b.textContent = c.basisOrContext;
          top.appendChild(b);
        }
        card.appendChild(top);

        const scen = document.createElement("div");
        scen.className = "a2ui-body okf-md-body";
        scen.style.whiteSpace = "normal";
        scen.innerHTML = renderMarkdownBlock(c.scenario, []);
        card.appendChild(scen);

        const tf = renderComponent(surface, {
          id: comp.id + "_input_" + c.id,
          component: "TextField",
          variant: "longText",
          label: isNo
            ? "Ditt løsningsforslag / handlingsplan (lagres i A2UI Data Model):"
            : isAnalysis
              ? "Your analytical assessment / decision notes (saved in A2UI Data Model):"
              : "Your proposed solution / action plan (saved in A2UI Data Model):",
          placeholder: isNo
            ? "Beskriv din vurdering og foreslåtte tiltak her..."
            : isAnalysis
              ? "Document your risk assessment, conviction, or IC condition here..."
              : "Describe your assessment and proposed actions here...",
          value: { path: responsesPath + "/" + c.id },
        });
        card.appendChild(tf);

        if (c.recommendedAction) {
          const toggleBtn = document.createElement("button");
          toggleBtn.className = "a2ui-btn";
          const isRev = Boolean(revealed[c.id]);
          toggleBtn.textContent = isNo
            ? isRev
              ? "Skjul anbefalt tiltak"
              : "Vis anbefalt tiltak (Fasit)"
            : isRev
              ? "Hide recommended action"
              : "💡 Show Recommended Action / Resolution";
          toggleBtn.addEventListener("click", () => {
            setPointer(surface.dataModel, revealedPath + "/" + c.id, !isRev);
            renderSurface();
          });
          card.appendChild(toggleBtn);

          if (isRev) {
            const rec = document.createElement("div");
            rec.style.padding = "12px";
            rec.style.background = "var(--success-soft)";
            rec.style.border = "1px solid var(--success-border)";
            rec.style.borderRadius = "8px";
            const recHeader = isNo
              ? "⚡ Anbefalt tiltak & Løsning:"
              : "⚡ Recommended Action & Resolution:";
            rec.innerHTML =
              "<strong>" +
              recHeader +
              "</strong><div class='okf-md-body' style='margin-top:6px'>" +
              renderMarkdownBlock(c.recommendedAction, []) +
              "</div>";
            card.appendChild(rec);
          }
        }
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (type === "OkfMarkdown") {
      const isNo = isNorwegianSurface(surface);
      const outerWrap = document.createElement("div");
      outerWrap.className = "okf-md-outer";
      const wrap = document.createElement("div");
      wrap.className = "okf-md-container okf-split";
      const bodyMd = String(resolveDynamic(comp.body, surface, scopeData) || "");
      const sources = resolveDynamic(comp.sources, surface, scopeData) || [];
      const trustTier = String(resolveDynamic(comp.trustTier, surface, scopeData) || "unverified");
      const statusVal = String(resolvePointer(surface.dataModel, "/okf/status") || "draft");
      const isStale = Boolean(resolveDynamic(comp.isStale, surface, scopeData));
      const editModePath = "/okf/editMode";
      const isEditing = Boolean(resolvePointer(surface.dataModel, editModePath));
      const viewingStub = Boolean(resolvePointer(surface.dataModel, "/okf/viewingStubConcept"));
      if (resolvePointer(surface.dataModel, "/okf/rejectedSources") === undefined) {
        setPointer(surface.dataModel, "/okf/rejectedSources", []);
      }
      if (resolvePointer(surface.dataModel, "/okf/replacedSources") === undefined) {
        setPointer(surface.dataModel, "/okf/replacedSources", {});
      }
      if (resolvePointer(surface.dataModel, "/okf/replaceOpenSources") === undefined) {
        setPointer(surface.dataModel, "/okf/replaceOpenSources", {});
      }
      if (resolvePointer(surface.dataModel, "/okf/addedSources") === undefined) {
        setPointer(surface.dataModel, "/okf/addedSources", []);
      }
      const rejectedSources = (resolvePointer(surface.dataModel, "/okf/rejectedSources") || []).map(String);
      const rejectedSet = new Set(rejectedSources);
      const replacedSources = resolvePointer(surface.dataModel, "/okf/replacedSources") || {};
      const replaceOpenSources = resolvePointer(surface.dataModel, "/okf/replaceOpenSources") || {};
      const addedSources = resolvePointer(surface.dataModel, "/okf/addedSources") || [];
      const activeSourcesList = sources.filter(function (s) {
        return s && !rejectedSet.has(String(s.id || ""));
      });
      const activeSourceCount = activeSourcesList.length;
      const replacedSourceCount = Object.keys(replacedSources).filter(function (k) {
        const tgt = String(replacedSources[k] || "").trim();
        return Boolean(tgt) && tgt !== k && !rejectedSet.has(tgt);
      }).length;
      const curationPrompts = buildCurationPrompts(surface);

      if (!viewingStub) {
        const curationBanner = document.createElement("div");
        curationBanner.className = "a2ui-card okf-curation-banner";
        curationBanner.id = "okf-curation-banner";

        const bannerTop = document.createElement("div");
        bannerTop.className = "a2ui-row justify-between";
        const bannerLeft = document.createElement("div");
        bannerLeft.className = "a2ui-row";
        const isStage1OnlyBanner = Boolean(
          resolvePointer(surface.dataModel, "/stage1/isStage1Only") ||
            resolvePointer(surface.dataModel, "/meta/isStage1Only")
        );
        const bannerTitle = document.createElement("strong");
        bannerTitle.style.fontSize = "14px";
        bannerTitle.textContent = isStage1OnlyBanner
          ? isNo
            ? "🛡️ Intermission Kildekuratering & Godkjenning (Stage 1 → Stage 2)"
            : "🛡️ Intermission Source Curation & Sign-Off (Stage 1 → Stage 2)"
          : isNo
            ? "🛡️ OKF v0.2 Kildekuratering & Verifisering"
            : "🛡️ OKF v0.2 Source Curation & Verification";
        bannerLeft.appendChild(bannerTitle);

        const statusChip = document.createElement("span");
        statusChip.className = "a2ui-badge " + (statusVal === "stable" ? "success" : "warn");
        statusChip.textContent = "status: " + statusVal;
        bannerLeft.appendChild(statusChip);

        const trustChip = document.createElement("span");
        trustChip.className = "a2ui-badge " + (trustTier === "human-reviewed" ? "accent" : "primary");
        trustChip.textContent = "trust: " + trustTier;
        bannerLeft.appendChild(trustChip);

        const activeChip = document.createElement("span");
        activeChip.className = "a2ui-badge primary";
        activeChip.textContent = isNo
          ? "✅ " + activeSourceCount + " aktive kilder"
          : "✅ " + activeSourceCount + " active sources";
        bannerLeft.appendChild(activeChip);

        if (rejectedSources.length > 0) {
          const rejChip = document.createElement("span");
          rejChip.className = "a2ui-badge danger";
          rejChip.textContent = isNo
            ? "🚫 " + rejectedSources.length + " avvist"
            : "🚫 " + rejectedSources.length + " rejected";
          bannerLeft.appendChild(rejChip);
        }
        if (replacedSourceCount > 0) {
          const replChip = document.createElement("span");
          replChip.className = "a2ui-badge accent";
          replChip.textContent = isNo
            ? "🔀 " + replacedSourceCount + " erstattet"
            : "🔀 " + replacedSourceCount + " replaced";
          bannerLeft.appendChild(replChip);
        }
        if (addedSources.length > 0) {
          const addChip = document.createElement("span");
          addChip.className = "a2ui-badge success";
          addChip.textContent = isNo
            ? "➕ " + addedSources.length + " lagt til"
            : "➕ " + addedSources.length + " added";
          bannerLeft.appendChild(addChip);
        }

        const jumpSourcesBtn = document.createElement("button");
        jumpSourcesBtn.type = "button";
        jumpSourcesBtn.className = "a2ui-btn";
        jumpSourcesBtn.id = "okf-jump-sources-btn";
        jumpSourcesBtn.style.padding = "3px 9px";
        jumpSourcesBtn.style.fontSize = "11.5px";
        jumpSourcesBtn.textContent = isNo
          ? "⬇️ Kilder & Erstatt (" + sources.length + ")"
          : "⬇️ Sources & Replace (" + sources.length + ")";
        jumpSourcesBtn.addEventListener("click", function () {
          const panelEl = document.getElementById("okf-sources-panel");
          if (panelEl && panelEl.scrollIntoView) {
            panelEl.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        });
        bannerLeft.appendChild(jumpSourcesBtn);

        const bannerRight = document.createElement("div");
        bannerRight.className = "a2ui-row";

        const verifierWrap = document.createElement("label");
        verifierWrap.className = "a2ui-row";
        verifierWrap.style.gap = "6px";
        verifierWrap.style.fontSize = "12px";
        verifierWrap.style.color = "var(--text-muted)";
        verifierWrap.textContent = isNo ? "Godkjent av:" : "Verifier:";
        const verifierInput = document.createElement("input");
        verifierInput.type = "text";
        verifierInput.className = "a2ui-input";
        verifierInput.id = "okf-verifier-actor-input";
        verifierInput.style.width = "175px";
        verifierInput.style.padding = "4px 8px";
        verifierInput.style.fontSize = "12px";
        let initialVerifier = String(resolvePointer(surface.dataModel, "/okf/verifierActor") || "").trim();
        if (
          !initialVerifier ||
          initialVerifier === "human:styrer" ||
          initialVerifier === "human:reviewer"
        ) {
          try {
            const savedV =
              typeof localStorage !== "undefined"
                ? String(localStorage.getItem("icm_a2ui_verifier_actor") || "").trim()
                : "";
            if (savedV) initialVerifier = savedV;
          } catch (_e) {}
        }
        verifierInput.value = initialVerifier || (isNo ? "human:styrer" : "human:reviewer");
        verifierInput.placeholder = isNo ? "human:Navn eller rolle" : "human:Name or role";
        verifierInput.addEventListener("input", function () {
          const val = String(verifierInput.value || "").trim();
          setPointer(surface.dataModel, "/okf/verifierActor", val);
          try {
            if (typeof localStorage !== "undefined" && val) {
              localStorage.setItem("icm_a2ui_verifier_actor", val);
            }
          } catch (_e) {}
          const updated = buildCurationPrompts(surface);
          const agyEl = document.getElementById("okf-curation-agy-text");
          if (agyEl) agyEl.textContent = updated.agyText;
          const cliEl = document.getElementById("okf-curation-cli-text");
          if (cliEl) cliEl.textContent = updated.cliText;
        });
        verifierWrap.appendChild(verifierInput);
        bannerRight.appendChild(verifierWrap);

        function bindCopyBtn(btn, getText, defaultLabel) {
          btn.addEventListener("click", function () {
            const txt = getText();
            if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(txt).catch(function () {});
            }
            btn.textContent = isNo ? "✓ Kopiert!" : "✓ Copied!";
            setTimeout(function () {
              btn.textContent = defaultLabel;
            }, 1800);
          });
        }

        const canPingPong = Boolean(resolvePointer(surface.dataModel, "/meta/canPingPong"));
        if (canPingPong) {
          const pingPongLabel = isNo ? "🚀 Godkjenn & Send til AGY" : "🚀 Approve & Send to AGY";
          const pingPongBtn = document.createElement("button");
          pingPongBtn.className = "a2ui-btn primary";
          pingPongBtn.id = "okf-pingpong-agy-btn";
          pingPongBtn.style.background = "linear-gradient(135deg, #059669, #10b981)";
          pingPongBtn.style.borderColor = "#059669";
          pingPongBtn.textContent = pingPongLabel;
          pingPongBtn.addEventListener("click", function () {
            const currentPrompts = buildCurationPrompts(surface);
            const payloadObj = {
              runId: String(resolvePointer(surface.dataModel, "/meta/runId") || ""),
              verifierActor: String(
                resolvePointer(surface.dataModel, "/okf/verifierActor") || verifierInput.value || ""
              ).trim(),
              rejectedSources: (resolvePointer(surface.dataModel, "/okf/rejectedSources") || []).map(String),
              replacedSources: resolvePointer(surface.dataModel, "/okf/replacedSources") || {},
              addedSources: resolvePointer(surface.dataModel, "/okf/addedSources") || [],
              agyText: currentPrompts.agyText,
              cliText: currentPrompts.cliText,
              timestamp: new Date().toISOString(),
            };
            const jsonStr = JSON.stringify(payloadObj);
            const url =
              "http://127.0.0.1:44820/ping-pong?payload=" + encodeURIComponent(jsonStr);
            if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(currentPrompts.agyText).catch(function () {});
            }
            pingPongBtn.textContent = isNo ? "⏳ Sender til AGY..." : "⏳ Sending to AGY...";
            let sentOk = false;
            fetch(url, {
              method: "POST",
              mode: "no-cors",
              headers: { "Content-Type": "text/plain;charset=utf-8" },
              body: jsonStr,
            })
              .then(function () {
                sentOk = true;
                pingPongBtn.textContent = isNo
                  ? "✅ Sendt til AGY! (Sjekk chatten)"
                  : "✅ Sent to AGY! (Check chat)";
              })
              .catch(function () {
                try {
                  const img = new Image();
                  img.src = url;
                  pingPongBtn.textContent = isNo
                    ? "✅ Sendt via beacon! (Sjekk chatten)"
                    : "✅ Sent via beacon! (Check chat)";
                } catch (_e) {
                  pingPongBtn.textContent = isNo
                    ? "📋 Kopiert (lim inn i AGY)"
                    : "📋 Copied (paste in AGY)";
                }
              });
            setTimeout(function () {
              if (!sentOk) {
                try {
                  const img = new Image();
                  img.src = url;
                } catch (_e) {}
              }
            }, 400);
          });
          bannerRight.appendChild(pingPongBtn);
        }

        const copyAgyLabel = isNo ? "📋 Kopier svar til AGY" : "📋 Copy Reply for AGY";
        const copyAgyBtn = document.createElement("button");
        copyAgyBtn.className = canPingPong ? "a2ui-btn" : "a2ui-btn primary";
        copyAgyBtn.id = "okf-copy-agy-btn";
        copyAgyBtn.textContent = copyAgyLabel;
        bindCopyBtn(
          copyAgyBtn,
          function () {
            return String(resolvePointer(surface.dataModel, "/okf/curationAgyText") || curationPrompts.agyText);
          },
          copyAgyLabel
        );

        const copyCliLabel = isNo ? "💻 Kopier CLI-kommando" : "💻 Copy CLI Command";
        const copyCliBtn = document.createElement("button");
        copyCliBtn.className = "a2ui-btn";
        copyCliBtn.id = "okf-copy-cli-btn";
        copyCliBtn.textContent = copyCliLabel;
        bindCopyBtn(
          copyCliBtn,
          function () {
            return String(resolvePointer(surface.dataModel, "/okf/curationCliText") || curationPrompts.cliText);
          },
          copyCliLabel
        );

        bannerRight.appendChild(copyAgyBtn);
        bannerRight.appendChild(copyCliBtn);
        bannerTop.appendChild(bannerLeft);
        bannerTop.appendChild(bannerRight);
        curationBanner.appendChild(bannerTop);

        const agyBox = document.createElement("div");
        agyBox.className = "okf-curation-prompt-box";
        agyBox.id = "okf-curation-agy-text";
        agyBox.textContent = curationPrompts.agyText;
        curationBanner.appendChild(agyBox);

        const cliBox = document.createElement("div");
        cliBox.className = "okf-curation-prompt-box";
        cliBox.id = "okf-curation-cli-text";
        cliBox.style.opacity = "0.9";
        cliBox.textContent = curationPrompts.cliText;
        curationBanner.appendChild(cliBox);

        outerWrap.appendChild(curationBanner);
      }

      const mainCard = document.createElement("div");
      mainCard.className = "a2ui-card a2ui-col";
      const toolbar = document.createElement("div");
      toolbar.className = "a2ui-row justify-between";
      const leftHead = document.createElement("div");
      leftHead.className = "a2ui-row";
      const tTitle = document.createElement("h3");
      tTitle.className = "a2ui-h3";
      tTitle.textContent = String(
        resolveDynamic(comp.title, surface, scopeData) ||
          (isNo ? "Stage 1 OKF v0.2 Kunnskapsgrunnlag" : "Stage 1 OKF v0.2 Knowledge Base")
      );
      const trustBadge = document.createElement("span");
      trustBadge.className = "a2ui-badge " + (trustTier === "human-reviewed" ? "accent" : "primary");
      trustBadge.textContent = "trust: " + trustTier;
      const freshBadge = document.createElement("span");
      freshBadge.className = "a2ui-badge " + (isStale ? "danger" : "success");
      freshBadge.textContent = isStale ? "stale" : "fresh";
      leftHead.appendChild(tTitle);
      leftHead.appendChild(trustBadge);
      leftHead.appendChild(freshBadge);

      const rightActions = document.createElement("div");
      rightActions.className = "a2ui-row";
      if (viewingStub) {
        const activeCid = String(resolvePointer(surface.dataModel, "/okf/activeConceptId") || "");
        const cMeta = bundleGraph.conceptMeta && bundleGraph.conceptMeta[activeCid];
        const currentRunId = String(resolvePointer(surface.dataModel, "/meta/runId") || "");
        if (cMeta && cMeta.runId && cMeta.runId !== currentRunId && bundleRuns.some((r) => r.runId === cMeta.runId)) {
          const switchRunBtn = document.createElement("button");
          switchRunBtn.className = "a2ui-btn success";
          switchRunBtn.id = "okf-md-switch-run-btn";
          switchRunBtn.textContent = isNo
            ? "🚀 Åpne fullt kurs (" + cMeta.runId + ")"
            : "🚀 Switch to Run (" + cMeta.runId + ")";
          switchRunBtn.addEventListener("click", () => {
            switchActiveRun(surface, cMeta.runId);
          });
          rightActions.appendChild(switchRunBtn);
        }
        const backPrimaryBtn = document.createElement("button");
        backPrimaryBtn.className = "a2ui-btn primary";
        backPrimaryBtn.id = "okf-md-back-primary-btn";
        backPrimaryBtn.textContent = isNo
          ? "← Tilbake til hovedkonsept"
          : "← Back to primary concept";
        backPrimaryBtn.addEventListener("click", () => {
          const primaryCid =
            resolvePointer(surface.dataModel, "/okf/primaryConceptId") ||
            "research/current";
          navigateOkfMarkdownConcept(surface, primaryCid);
          renderSurface();
        });
        rightActions.appendChild(backPrimaryBtn);
      }

      const editBtn = document.createElement("button");
      editBtn.className = "a2ui-btn";
      editBtn.textContent = isNo
        ? isEditing
          ? "👁 Forhåndsvis OKF Markdown"
          : "✏️ Rediger Layer 4 Markdown"
        : isEditing
          ? "👁 Preview OKF Markdown"
          : "✏️ Edit Layer 4 Markdown";
      editBtn.addEventListener("click", () => {
        if (isEditing) {
          syncOkfBodyToChecklist(surface);
        }
        setPointer(surface.dataModel, editModePath, !isEditing);
        renderSurface();
      });
      rightActions.appendChild(editBtn);
      toolbar.appendChild(leftHead);
      toolbar.appendChild(rightActions);
      mainCard.appendChild(toolbar);

      if (isEditing) {
        const editor = renderComponent(surface, {
          id: comp.id + "_editor",
          component: "TextField",
          variant: "longText",
          label: isNo
            ? "Redigerbar OKF v0.2 Markdown (oppdaterer A2UI Data Model og Sjekkliste direkte):"
            : "Editable OKF v0.2 Markdown (live-updates A2UI Data Model and Checklist):",
          value: comp.body,
        });
        const ta = editor.querySelector("textarea");
        if (ta) {
          ta.rows = 22;
          ta.addEventListener("input", () => {
            syncOkfBodyToChecklist(surface);
          });
        }
        mainCard.appendChild(editor);
      } else {
        const mdBody = document.createElement("div");
        mdBody.className = "okf-md-body";
        mdBody.innerHTML = renderMarkdownBlock(bodyMd, sources, rejectedSources);
        // Wire internal /research/*.md concept links & [^id] footnote scroll/highlight
        mdBody.querySelectorAll("a[href]").forEach((a) => {
          const href = a.getAttribute("href") || "";
          const fnId = a.getAttribute("data-fn");
          if (fnId) {
            a.addEventListener("click", (e) => {
              e.preventDefault();
              const targetEl = document.getElementById("okf-src-" + fnId);
              if (targetEl) {
                document.querySelectorAll(".okf-source-card").forEach((el) => el.classList.remove("highlight"));
                targetEl.classList.add("highlight");
                targetEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
              }
            });
            return;
          }
          const activeCid =
            resolvePointer(surface.dataModel, "/okf/activeConceptId") ||
            resolvePointer(surface.dataModel, "/okf/primaryConceptId") ||
            "research/current";
          const conceptId = resolveClientConceptId(href, activeCid);
          if (conceptId) {
            a.style.color = "var(--accent)";
            a.style.fontWeight = "600";
            a.addEventListener("click", (e) => {
              e.preventDefault();
              navigateOkfMarkdownConcept(surface, conceptId, (a.textContent || conceptId).trim());
              renderSurface();
            });
          }
        });
        mainCard.appendChild(mdBody);
      }

      const sideCard = document.createElement("div");
      sideCard.className = "a2ui-card a2ui-col";
      sideCard.id = "okf-sources-panel";
      const sHead = document.createElement("h3");
      sHead.className = "a2ui-h3";
      const countDisplay =
        rejectedSources.length > 0
          ? activeSourceCount + " / " + sources.length
          : String(sources.length);
      sHead.textContent = isNo
        ? "Kilder & Sporbarhet (" + countDisplay + ")"
        : "Sources & Provenance (" + countDisplay + ")";
      sideCard.appendChild(sHead);

      const stage1Trace = resolvePointer(surface.dataModel, "/okf/stage1Trace") || null;
      const searchQueries =
        stage1Trace && Array.isArray(stage1Trace.searchQueries)
          ? stage1Trace.searchQueries
          : [];
      if (searchQueries.length > 0 && !viewingStub) {
        const searchDetails = document.createElement("details");
        searchDetails.className = "okf-search-log-details";
        const searchSummary = document.createElement("summary");
        searchSummary.textContent = isNo
          ? "🔎 Stage 1 Google-søkelogg (" + searchQueries.length + " søk)"
          : "🔎 Stage 1 Search Queries (" + searchQueries.length + " queries)";
        searchDetails.appendChild(searchSummary);
        const qList = document.createElement("ol");
        qList.style.margin = "8px 0 0 18px";
        qList.style.padding = "0";
        searchQueries.forEach(function (q) {
          const li = document.createElement("li");
          li.style.marginBottom = "3px";
          li.textContent = String(q);
          qList.appendChild(li);
        });
        searchDetails.appendChild(qList);
        sideCard.appendChild(searchDetails);
      }

      if (!viewingStub) {
        const addBox = document.createElement("div");
        addBox.className = "okf-add-source-box";
        const addLabel = document.createElement("div");
        addLabel.style.fontWeight = "600";
        addLabel.style.fontSize = "12px";
        addLabel.textContent = isNo
          ? "➕ Legg til savnet kilde (f.eks. Lovdata / DSB / forskrift)"
          : "➕ Add Missing Source (URL + optional title)";
        const urlInput = document.createElement("input");
        urlInput.type = "url";
        urlInput.id = "okf-add-source-url";
        urlInput.placeholder = isNo ? "https://lovdata.no/dokument/..." : "https://...";
        const titleInput = document.createElement("input");
        titleInput.type = "text";
        titleInput.id = "okf-add-source-title";
        titleInput.placeholder = isNo
          ? "Valgfri tittel (f.eks. Brann- og eksplosjonsvernloven § 19)"
          : "Optional title (e.g. Regulatory Standard § 12)";
        const addBtn = document.createElement("button");
        addBtn.className = "a2ui-btn primary";
        addBtn.id = "okf-add-source-btn";
        addBtn.textContent = isNo ? "➕ Legg til kilde" : "➕ Add Source";
        addBtn.addEventListener("click", function () {
          const u = (urlInput.value || "").trim();
          const t = (titleInput.value || "").trim();
          if (!u) return;
          addSourceInStudio(surface, u, t);
          urlInput.value = "";
          titleInput.value = "";
        });
        addBox.appendChild(addLabel);
        addBox.appendChild(urlInput);
        addBox.appendChild(titleInput);
        addBox.appendChild(addBtn);
        sideCard.appendChild(addBox);
      }

      const srcList = document.createElement("div");
      const statsMap = {};
      sources.forEach((src) => {
        const sc = document.createElement("div");
        const rawId = String(src.id || "src");
        const isRej = rejectedSet.has(rawId);
        const rawReplacedTarget = String(replacedSources[rawId] || "").trim();
        const replacedTarget =
          rawReplacedTarget && rawReplacedTarget !== rawId && !rejectedSet.has(rawReplacedTarget)
            ? rawReplacedTarget
            : "";
        const isReplaceOpen = Boolean(replaceOpenSources[rawId]);
        sc.className =
          "okf-source-card" + (isRej ? " rejected" : replacedTarget ? " replaced" : "");
        const safeId = escapeHtml(rawId);
        const rawUrl = src.url || src.resource || "";
        const safeTitle = escapeHtml(src.title || rawUrl || "");
        const safeUrl = rawUrl ? escapeHtml(rawUrl) : "";
        const strippedUrl = rawUrl ? rawUrl.replace(/^https?:[/][/](www[.])?/i, "") : "";
        const shortUrl = strippedUrl
          ? escapeHtml(strippedUrl.slice(0, 68) + (strippedUrl.length > 68 ? "…" : ""))
          : "";
        const citeStats = inspectSourceCitationsInBody(bodyMd, rawId, rejectedSources);
        statsMap[rawId] = citeStats;
        const prov = inspectClientSourceDomainProvenance(src);

        sc.id = "okf-src-" + rawId;
        const headerHtml =
          '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">' +
          '<div><strong>[^' +
          safeId +
          "]</strong> " +
          (safeUrl
            ? '<a class="okf-src-title" href="' +
              safeUrl +
              '" target="_blank" rel="noopener noreferrer" style="color:var(--primary);font-weight:600;text-decoration:none">' +
              safeTitle +
              " ↗</a>"
            : '<span class="okf-src-title">' + safeTitle + "</span>") +
          (isRej
            ? ' <span class="src-chip rejected-badge">' + (isNo ? "🚫 AVVIST" : "🚫 REJECTED") + "</span>"
            : "") +
          (replacedTarget
            ? ' <span class="src-chip replaced-badge">🔀 → ' + escapeHtml(replacedTarget) + "</span>"
            : "") +
          (src.addedByHuman
            ? ' <span class="src-chip added-badge">' + (isNo ? "➕ NY" : "➕ ADDED") + "</span>"
            : "") +
          "</div>" +
          "</div>" +
          (safeUrl
            ? '<div style="margin-top:2px;font-size:11px;word-break:break-all"><a href="' +
              safeUrl +
              '" target="_blank" rel="noopener noreferrer" style="color:var(--text-muted)">' +
              shortUrl +
              "</a></div>"
            : "") +
          "<div>" +
          (prov.hostname
            ? '<span class="src-chip domain-host">🌐 ' +
              escapeHtml(prov.hostname) +
              (prov.isDirectFileAsset ? " 📄" : "") +
              "</span>"
            : "") +
          (prov.domainMismatch && prov.hostname && prov.claimedPublisher
            ? '<span class="src-chip domain-mismatch">⚠️ ' +
              (isNo ? "Domeneavvik: " : "Domain mismatch: ") +
              escapeHtml(prov.hostname) +
              ' ≠ "' +
              escapeHtml(prov.claimedPublisher) +
              '"</span>'
            : "") +
          (src.retrieved_at
            ? '<span class="src-chip retrieved">retrieved: ' + escapeHtml(src.retrieved_at) + "</span>"
            : "") +
          (src.last_modified
            ? '<span class="src-chip modified">modified: ' + escapeHtml(src.last_modified) + "</span>"
            : "") +
          '<span class="src-chip citations">🔗 ' +
          citeStats.mentionCount +
          " " +
          (isNo ? "siteringer" : "citations") +
          "</span>" +
          (citeStats.soleClaimLines.length > 0 && !replacedTarget
            ? '<span class="src-chip sole-warning">⚠️ ' +
              (isNo
                ? "Eneste kilde for " + citeStats.soleClaimLines.length + " punkt(er)"
                : "Sole source for " + citeStats.soleClaimLines.length + " claim(s)") +
              "</span>"
            : "") +
          "</div>";
        sc.innerHTML = headerHtml;

        if (!viewingStub) {
          const actionRow = document.createElement("div");
          actionRow.style.marginTop = "6px";
          actionRow.style.display = "flex";
          actionRow.style.justifyContent = "flex-end";
          actionRow.style.gap = "6px";
          actionRow.style.flexWrap = "wrap";

          if (!isRej && citeStats.mentionCount > 0) {
            const swapBtn = document.createElement("button");
            swapBtn.type = "button";
            swapBtn.className = "a2ui-btn okf-open-replace-btn";
            swapBtn.setAttribute("data-src-id", rawId);
            swapBtn.style.padding = "3px 8px";
            swapBtn.style.fontSize = "11.5px";
            swapBtn.textContent = replacedTarget
              ? isNo
                ? "↩ Angre erstatning"
                : "↩ Undo replace"
              : isReplaceOpen
                ? isNo
                  ? "✕ Lukk erstatt"
                  : "✕ Close replace"
                : isNo
                  ? "🔀 Erstatt kilde"
                  : "🔀 Replace source";
            swapBtn.addEventListener("click", function () {
              toggleReplacePanelInStudio(surface, rawId);
            });
            actionRow.appendChild(swapBtn);
          }

          const rejBtn = document.createElement("button");
          rejBtn.type = "button";
          rejBtn.className = "a2ui-btn okf-reject-btn" + (isRej ? "" : " danger");
          rejBtn.setAttribute("data-src-id", rawId);
          rejBtn.style.padding = "3px 8px";
          rejBtn.style.fontSize = "11.5px";
          rejBtn.textContent = isRej
            ? isNo
              ? "↩ Angre avvisning"
              : "↩ Undo reject"
            : isNo
              ? "🚫 Avvis kilde"
              : "🚫 Reject source";
          rejBtn.addEventListener("click", function () {
            toggleRejectSourceInStudio(surface, rawId);
          });
          actionRow.appendChild(rejBtn);
          sc.appendChild(actionRow);

          if ((isRej || isReplaceOpen || Boolean(replacedTarget)) && citeStats.mentionCount > 0) {
            const replRow = document.createElement("div");
            replRow.className = "okf-replace-row" + (isRej ? "" : " swap-mode");
            const selectWrap = document.createElement("div");
            selectWrap.className = "okf-replace-select-wrap";
            const replLbl = document.createElement("label");
            replLbl.style.fontWeight = "600";
            replLbl.textContent = isNo
              ? "🔀 Erstatt " + citeStats.mentionCount + " sitering(er) med:"
              : "🔀 Replace " + citeStats.mentionCount + " citation(s) with:";
            selectWrap.appendChild(replLbl);

            let matchedDropdownOption = false;
            if (activeSourcesList.length > 0 || replacedTarget) {
              const replSelect = document.createElement("select");
              replSelect.className = "okf-replace-select";
              replSelect.setAttribute("data-src-id", rawId);
              const defaultOpt = document.createElement("option");
              defaultOpt.value = "";
              defaultOpt.textContent = isRej
                ? isNo
                  ? "(La AGY velge / fjern fotnote)"
                  : "(Let AGY choose / strip footnote)"
                : isNo
                  ? "(Velg eksisterende kilde eller lim inn lenke under…)"
                  : "(Select existing source or paste URL below…)";
              replSelect.appendChild(defaultOpt);
              activeSourcesList.forEach(function (actSrc) {
                const actId = String(actSrc.id || "");
                const actUrl = String(actSrc.url || actSrc.resource || "");
                const optVal = actSrc.addedByHuman && actUrl ? actUrl : actId;
                if (!optVal || actId === rawId) return;
                if (replacedSources[actId] && actId !== replacedTarget && optVal !== replacedTarget) {
                  return;
                }
                const opt = document.createElement("option");
                opt.value = optVal;
                const shortT = String(actSrc.title || actUrl || actId);
                opt.textContent =
                  (actSrc.addedByHuman ? "➕ " : "") +
                  "[^" +
                  actId +
                  "] " +
                  (shortT.length > 52 ? shortT.slice(0, 52) + "…" : shortT);
                if (replacedTarget === optVal || replacedTarget === actId) {
                  opt.selected = true;
                  matchedDropdownOption = true;
                }
                replSelect.appendChild(opt);
              });
              if (replacedTarget && !matchedDropdownOption) {
                const customUrlOpt = document.createElement("option");
                customUrlOpt.value = replacedTarget;
                customUrlOpt.textContent =
                  "🌐 " +
                  (replacedTarget.length > 58
                    ? replacedTarget.slice(0, 58) + "…"
                    : replacedTarget);
                customUrlOpt.selected = true;
                replSelect.appendChild(customUrlOpt);
              }
              replSelect.addEventListener("change", function () {
                setReplaceSourceInStudio(surface, rawId, replSelect.value);
              });
              selectWrap.appendChild(replSelect);
            }
            replRow.appendChild(selectWrap);

            const urlWrap = document.createElement("div");
            urlWrap.className = "okf-replace-url-wrap";
            const urlInput = document.createElement("input");
            urlInput.type = "url";
            urlInput.className = "okf-replace-url-input";
            urlInput.setAttribute("data-src-id", rawId);
            urlInput.placeholder = isNo
              ? "Eller lim inn gjeldende https://-lenke direkte (1 steg)…"
              : "Or paste canonical https:// URL directly (1 step)…";
            if (replacedTarget && !matchedDropdownOption && /^https?:\\/\\//i.test(replacedTarget)) {
              urlInput.value = replacedTarget;
            }
            const urlBtn = document.createElement("button");
            urlBtn.type = "button";
            urlBtn.className = "a2ui-btn okf-replace-url-btn";
            urlBtn.textContent = isNo ? "Bruk lenke" : "Use URL";
            urlBtn.addEventListener("click", function () {
              setReplaceSourceInStudio(surface, rawId, urlInput.value);
            });
            urlInput.addEventListener("keydown", function (ev) {
              if (ev && ev.key === "Enter") {
                ev.preventDefault();
                setReplaceSourceInStudio(surface, rawId, urlInput.value);
              }
            });
            urlWrap.appendChild(urlInput);
            urlWrap.appendChild(urlBtn);
            replRow.appendChild(urlWrap);
            sc.appendChild(replRow);
          }
        }

        if (citeStats.soleClaimLines.length > 0) {
          const soleDetails = document.createElement("details");
          soleDetails.className = "okf-sole-claims-details";
          const soleSummary = document.createElement("summary");
          const openBracketCaret = "[" + "^";
          soleSummary.textContent = isNo
            ? "Vis " + citeStats.soleClaimLines.length + " påstand(er) som kun hviler på " + openBracketCaret + rawId + "]"
            : "Show " + citeStats.soleClaimLines.length + " claim(s) backed solely by " + openBracketCaret + rawId + "]";
          soleDetails.appendChild(soleSummary);
          const soleUl = document.createElement("ul");
          soleUl.style.margin = "5px 0 0 16px";
          soleUl.style.padding = "0";
          citeStats.soleClaimLines.forEach(function (cl) {
            const li = document.createElement("li");
            li.style.marginBottom = "3px";
            li.textContent = cl;
            soleUl.appendChild(li);
          });
          soleDetails.appendChild(soleUl);
          sc.appendChild(soleDetails);
        }

        srcList.appendChild(sc);
      });
      setPointer(surface.dataModel, "/okf/sourceCitationStats", statsMap);
      sideCard.appendChild(srcList);

      wrap.appendChild(mainCard);
      wrap.appendChild(sideCard);
      outerWrap.appendChild(wrap);
      return outerWrap;
    }

    if (type === "OkfKnowledgeGraph") {
      const isNo = isNorwegianSurface(surface);
      const backToConceptLabel = isNo ? "← Tilbake til konsept" : "← Back to concept";
      const wrap = document.createElement("div");
      wrap.className = "a2ui-col";
      const split = document.createElement("div");
      split.className = "okf-graph-split";
      const canvas = document.createElement("div");
      canvas.className = "okf-graph-canvas";
      const detail = document.createElement("div");
      detail.className = "okf-graph-detail";
      detail.id = "okf-graph-detail-view";
      detail.innerHTML = isNo
        ? '<div class="a2ui-caption">Klikk på en OKF-node i grafen for å inspisere konseptet og relasjoner.</div>'
        : '<div class="a2ui-caption">Click an OKF node in the graph to inspect the concept and its citations.</div>';
      split.appendChild(canvas);
      split.appendChild(detail);
      wrap.appendChild(split);

      let cy = null;
      let lastConceptData = null;
      let currentSelectedNodeId = null;

      function renderGraphNodeDetail(d) {
        if (!d) return;
        currentSelectedNodeId = d.id || null;
        const rawBody = (bundleGraph.bodies && bundleGraph.bodies[d.id]) || "";
        const nodeSources = Array.isArray(d.sources) ? d.sources : [];
        const formattedBody = formatInlineLatexAndFootnotes(rawBody, nodeSources);
        const isSource = d.group === "source";
        const isSubNode = isSource || d.type === "Linked Concept";
        if (!isSubNode) {
          lastConceptData = d;
        }
        const displayTitle = d.fullTitle || d.label || d.id;

        let headerHtml = "";
        if (isSource) {
          headerHtml =
            '<div class="a2ui-row justify-between" style="margin-bottom:6px">' +
            '<div class="a2ui-row" style="gap:6px">' +
            '<span class="a2ui-badge success">' +
            escapeHtml(d.type || "Verified Source") +
            "</span>" +
            (d.trust_tier
              ? '<span class="a2ui-badge ' +
                (d.trust_tier === "human-reviewed" ? "accent" : "primary") +
                '">trust: ' +
                escapeHtml(d.trust_tier) +
                "</span>"
              : "") +
            "</div>" +
            '<button type="button" class="a2ui-btn" id="okf-graph-back-btn" style="padding:4px 10px;font-size:12px">' +
            backToConceptLabel +
            "</button>" +
            "</div>" +
            '<h3 class="a2ui-h3" style="margin-top:6px">' +
            escapeHtml(displayTitle) +
            "</h3>" +
            (d.description
              ? /^https?:\\/\\//i.test(d.description)
                ? '<p class="a2ui-caption" style="margin-top:4px;word-break:break-all"><a href="' +
                  escapeHtml(d.description) +
                  '" target="_blank" rel="noopener noreferrer" style="color:var(--primary);font-weight:600">' +
                  escapeHtml(d.description) +
                  " ↗</a></p>"
                : '<p class="a2ui-caption" style="margin-top:4px;word-break:break-all">' +
                  escapeHtml(d.description) +
                  "</p>"
              : "");
        } else {
          const badgesHtml =
            '<div class="a2ui-row" style="gap:6px">' +
            '<span class="a2ui-badge primary">' +
            escapeHtml(d.type || "Concept") +
            "</span>" +
            '<span class="a2ui-badge ' +
            (d.status === "stable" ? "success" : "warn") +
            '">status: ' +
            escapeHtml(d.status || "draft") +
            "</span>" +
            '<span class="a2ui-badge ' +
            (d.trust_tier === "human-reviewed" ? "accent" : "primary") +
            '">trust: ' +
            escapeHtml(d.trust_tier || "unverified") +
            "</span>" +
            '<span class="a2ui-badge ' +
            (d.stale ? "danger" : "success") +
            '">' +
            (d.stale ? "STALE" : "fresh") +
            "</span>" +
            "</div>";
          const activeRunId = resolvePointer(surface.dataModel, "/meta/runId");
          const canSwitchRun = Boolean(d.runId && d.runId !== activeRunId && bundleRuns.length > 1);
          headerHtml =
            (isSubNode
              ? '<div class="a2ui-row justify-between" style="margin-bottom:6px">' +
                badgesHtml +
                '<button type="button" class="a2ui-btn" id="okf-graph-back-btn" style="padding:4px 10px;font-size:12px">' +
                backToConceptLabel +
                "</button>" +
                "</div>"
              : '<div class="a2ui-row justify-between" style="margin-bottom:6px;flex-wrap:wrap;gap:6px">' +
                badgesHtml +
                (canSwitchRun
                  ? '<button type="button" class="a2ui-btn primary" id="okf-graph-switch-run-btn" style="padding:4px 10px;font-size:12px">' +
                    (isNo ? "🚀 Åpne fullt kurs" : "🚀 Switch to Run") +
                    "</button>"
                  : "") +
                "</div>") +
            '<h3 class="a2ui-h3" style="margin-top:8px">' +
            escapeHtml(displayTitle) +
            "</h3>" +
            '<p class="a2ui-caption" style="margin-top:4px">' +
            escapeHtml(d.description || "") +
            "</p>";
        }

        let footerHtml = "";
        if (!isSource) {
          const backlinks = Array.isArray(d.backlinks) ? d.backlinks : [];
          if (nodeSources.length > 0 || backlinks.length > 0) {
            footerHtml += "<hr class='a2ui-divider'>";
            if (nodeSources.length > 0) {
              footerHtml +=
                '<div style="margin-bottom:10px"><strong style="font-size:12px;color:var(--text-muted)">' +
                (isNo ? "Kilder (" + nodeSources.length + "):" : "Sources (" + nodeSources.length + "):") +
                "</strong><div style='margin-top:6px;display:flex;flex-direction:column;gap:4px'>";
              nodeSources.forEach((s) => {
                const sid = escapeHtml(s.id || "src");
                const stitle = escapeHtml(s.title || s.resource || s.url || sid);
                footerHtml +=
                  '<div style="font-size:12px"><a href="#fn-' +
                  sid +
                  '" data-fn="' +
                  sid +
                  '" style="color:var(--primary);font-weight:600;text-decoration:none">[^' +
                  sid +
                  "] " +
                  stitle +
                  "</a></div>";
              });
              footerHtml += "</div></div>";
            }
            if (backlinks.length > 0) {
              footerHtml +=
                '<div><strong style="font-size:12px;color:var(--text-muted)">' +
                (isNo ? "Referert av (" + backlinks.length + "):" : "Cited by (" + backlinks.length + "):") +
                "</strong><div style='margin-top:6px;display:flex;flex-direction:column;gap:4px'>";
              backlinks.forEach((bl) => {
                const bid = escapeHtml(bl.id || "");
                const btitle = escapeHtml(bl.title || bid);
                footerHtml +=
                  '<div style="font-size:12px"><a href="/' +
                  bid +
                  '.md" style="color:var(--accent);font-weight:600;text-decoration:none">← ' +
                  btitle +
                  "</a></div>";
              });
              footerHtml += "</div></div>";
            }
          }
        }

        detail.innerHTML =
          headerHtml +
          "<hr class='a2ui-divider'>" +
          '<div class="okf-md-body">' +
          (window.marked && typeof window.marked.parse === "function"
            ? window.marked.parse(formattedBody)
            : parseBuiltInMarkdown(formattedBody)) +
          "</div>" +
          footerHtml;

        const switchRunBtn = detail.querySelector("#okf-graph-switch-run-btn");
        if (switchRunBtn && d.runId) {
          switchRunBtn.addEventListener("click", () => {
            switchActiveRun(surface, d.runId);
          });
        }

        const backBtn = detail.querySelector("#okf-graph-back-btn");
        if (backBtn) {
          backBtn.addEventListener("click", () => {
            const parentWrapper = d.parentConceptId
              ? (bundleGraph.nodes || []).find((n) => (n.data && n.data.id === d.parentConceptId) || n.id === d.parentConceptId)
              : null;
            const fallbackWrapper = (bundleGraph.nodes || []).find(
              (n) =>
                (n.group === "concept" || (n.data && n.data.group === "concept")) &&
                (!n.data || n.data.type !== "Linked Concept")
            );
            const conceptData =
              lastConceptData ||
              (parentWrapper ? parentWrapper.data || parentWrapper : null) ||
              (fallbackWrapper ? fallbackWrapper.data || fallbackWrapper : null);
            if (conceptData) {
              if (cy) {
                cy.elements().unselect();
                cy.getElementById(conceptData.id).select();
              }
              renderGraphNodeDetail(conceptData);
              detail.scrollTop = 0;
            }
          });
        }

        detail.querySelectorAll("a[href^='http']").forEach((a) => {
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer");
        });
        detail.querySelectorAll("a[data-fn]").forEach((a) => {
          a.addEventListener("click", (ev) => {
            ev.preventDefault();
            const fnId = a.getAttribute("data-fn");
            const srcNodeId =
              (d.id &&
                bundleGraph.sourceNodeByFnId &&
                bundleGraph.sourceNodeByFnId[d.id] &&
                bundleGraph.sourceNodeByFnId[d.id][fnId]) ||
              (bundleGraph.sourceNodeByAnyFnId && bundleGraph.sourceNodeByAnyFnId[fnId]) ||
              "source:" + fnId;
            const found = (bundleGraph.nodes || []).find((n) => n.data && n.data.id === srcNodeId);
            const targetNode = found ? found.data : null;
            if (targetNode) {
              if (cy) {
                cy.elements().unselect();
                cy.getElementById(targetNode.id).select();
              }
              renderGraphNodeDetail(targetNode);
              detail.scrollTop = 0;
            }
          });
        });
        detail.querySelectorAll("a[href]").forEach((a) => {
          const href = a.getAttribute("href") || "";
          if (a.hasAttribute("data-fn") || href.startsWith("#") || /^https?:\\/\\//i.test(href)) {
            return;
          }
          const baseConceptForLink =
            d.group === "source" ? d.parentConceptId || "research/current" : d.id;
          const conceptId = resolveClientConceptId(href, baseConceptForLink);
          if (conceptId) {
            a.style.color = "var(--accent)";
            a.style.fontWeight = "600";
            a.addEventListener("click", (ev) => {
              ev.preventDefault();
              const found = (bundleGraph.nodes || []).find((n) => n.data && n.data.id === conceptId);
              const targetNode = found ? found.data : null;
              if (targetNode) {
                if (cy) {
                  cy.elements().unselect();
                  cy.getElementById(targetNode.id).select();
                }
                renderGraphNodeDetail(targetNode);
                detail.scrollTop = 0;
              }
            });
          }
        });
      }

      const nodesList = bundleGraph.nodes || [];
      const activeCidForGraph =
        resolvePointer(surface.dataModel, "/okf/activeConceptId") ||
        resolvePointer(surface.dataModel, "/okf/primaryConceptId");
      const initialNodeWrapper =
        (activeCidForGraph &&
          nodesList.find((n) => n.data && n.data.id === activeCidForGraph)) ||
        nodesList.find((n) => n.group === "concept" || (n.data && n.data.group === "concept")) ||
        nodesList[0];
      if (initialNodeWrapper && initialNodeWrapper.data) {
        renderGraphNodeDetail(initialNodeWrapper.data);
      }

      setTimeout(() => {
        if (!window.cytoscape) {
          const allNodes = bundleGraph.nodes || [];
          const allEdges = bundleGraph.edges || [];
          if (allNodes.length === 0) {
            canvas.innerHTML =
              '<div style="padding:20px" class="a2ui-caption">' +
              (isNo ? "Ingen noder i OKF-kunnskapsgrafen ennå." : "No nodes in OKF knowledge graph yet.") +
              "</div>";
            return;
          }
          const ns = "http://www.w3.org/2000/svg";
          const W = 760;
          const H = 520;
          const svg = document.createElementNS(ns, "svg");
          svg.setAttribute("viewBox", "0 0 " + W + " " + H);
          svg.style.width = "100%";
          svg.style.height = "100%";
          svg.style.display = "block";
          svg.style.userSelect = "none";
          const concepts = allNodes.filter((n) => n && n.data && n.data.group !== "source");
          const sources = allNodes.filter((n) => n && n.data && n.data.group === "source");
          const posById = {};
          concepts.forEach((c, idx) => {
            if (concepts.length === 1) {
              posById[c.data.id] = { x: W / 2, y: H / 2 };
            } else {
              const ang = (2 * Math.PI * idx) / concepts.length - Math.PI / 2;
              posById[c.data.id] = { x: W / 2 + 110 * Math.cos(ang), y: H / 2 + 90 * Math.sin(ang) };
            }
          });
          sources.forEach((s, idx) => {
            const ang = (2 * Math.PI * idx) / Math.max(1, sources.length) - Math.PI / 2;
            posById[s.data.id] = { x: W / 2 + 270 * Math.cos(ang), y: H / 2 + 195 * Math.sin(ang) };
          });
          const edgeGroup = document.createElementNS(ns, "g");
          const nodeGroup = document.createElementNS(ns, "g");
          svg.appendChild(edgeGroup);
          svg.appendChild(nodeGroup);
          allEdges.forEach((e) => {
            if (!e || !e.data) return;
            const sp = posById[e.data.source];
            const tp = posById[e.data.target];
            if (!sp || !tp) return;
            const line = document.createElementNS(ns, "line");
            line.setAttribute("x1", String(sp.x));
            line.setAttribute("y1", String(sp.y));
            line.setAttribute("x2", String(tp.x));
            line.setAttribute("y2", String(tp.y));
            line.setAttribute("stroke", "#94a3b8");
            line.setAttribute("stroke-width", "1.75");
            edgeGroup.appendChild(line);
          });
          const circleById = {};
          allNodes.forEach((n) => {
            if (!n || !n.data) return;
            const d = n.data;
            const p = posById[d.id] || { x: W / 2, y: H / 2 };
            const r = Math.max(11, Math.min(24, Number(d.size || 24) / 2));
            const g = document.createElementNS(ns, "g");
            g.style.cursor = "pointer";
            const circle = document.createElementNS(ns, "circle");
            circle.setAttribute("cx", String(p.x));
            circle.setAttribute("cy", String(p.y));
            circle.setAttribute("r", String(r));
            circle.setAttribute("fill", d.color || "#2563eb");
            circle.setAttribute("stroke", d.id === currentSelectedNodeId ? "#1d4ed8" : "#0f172a");
            circle.setAttribute("stroke-width", d.id === currentSelectedNodeId ? "3.5" : "1.5");
            circleById[d.id] = circle;
            const lbl = document.createElementNS(ns, "text");
            lbl.setAttribute("x", String(p.x));
            lbl.setAttribute("y", String(p.y + r + 13));
            lbl.setAttribute("text-anchor", "middle");
            lbl.setAttribute("font-size", "10.5");
            lbl.setAttribute("fill", "#0f172a");
            const rawLbl = String(d.label || d.id || "");
            lbl.textContent = rawLbl.length > 26 ? rawLbl.slice(0, 25) + "…" : rawLbl;
            g.appendChild(circle);
            g.appendChild(lbl);
            g.addEventListener("click", () => {
              Object.keys(circleById).forEach((k) => {
                circleById[k].setAttribute("stroke", k === d.id ? "#1d4ed8" : "#0f172a");
                circleById[k].setAttribute("stroke-width", k === d.id ? "3.5" : "1.5");
              });
              renderGraphNodeDetail(d);
            });
            nodeGroup.appendChild(g);
          });
          cy = {
            elements: () => ({
              unselect: () => {
                Object.keys(circleById).forEach((k) => {
                  circleById[k].setAttribute("stroke", "#0f172a");
                  circleById[k].setAttribute("stroke-width", "1.5");
                });
              },
            }),
            getElementById: (id) => ({
              select: () => {
                if (circleById[id]) {
                  circleById[id].setAttribute("stroke", "#1d4ed8");
                  circleById[id].setAttribute("stroke-width", "3.5");
                }
              },
            }),
          };
          canvas.innerHTML = "";
          canvas.appendChild(svg);
          return;
        }
        cy = window.cytoscape({
          container: canvas,
          elements: { nodes: bundleGraph.nodes || [], edges: bundleGraph.edges || [] },
          style: [
            {
              selector: "node",
              style: {
                "background-color": "data(color)",
                label: "data(label)",
                width: "data(size)",
                height: "data(size)",
                "font-size": 11,
                color: "#0f172a",
                "text-valign": "bottom",
                "text-margin-y": 5,
                "text-wrap": "wrap",
                "text-max-width": 140,
              },
            },
            {
              selector: "node:selected",
              style: {
                "border-width": 3,
                "border-color": "#1d4ed8",
              },
            },
            {
              selector: "edge",
              style: {
                width: 2,
                "line-color": "#94a3b8",
                "target-arrow-color": "#94a3b8",
                "target-arrow-shape": "triangle",
                "curve-style": "bezier",
              },
            },
          ],
          layout: { name: (bundleGraph.nodes || []).length > 1 ? "cose" : "grid", padding: 40 },
        });
        if (currentSelectedNodeId) {
          cy.getElementById(currentSelectedNodeId).select();
        }
        cy.on("tap", "node", (evt) => {
          renderGraphNodeDetail(evt.target.data());
        });
      }, 30);

      return wrap;
    }

    const fallback = document.createElement("div");
    fallback.className = "a2ui-card";
    fallback.textContent = "[" + type + ": " + comp.id + "]";
    return fallback;
  }

  function renderSurface() {
    const mount = document.getElementById("a2ui-surface-root");
    if (!mount) return;
    const prevScrollY = typeof window !== "undefined" ? window.scrollY : 0;
    const surface = surfaces[activeSurfaceId];
    if (!surface || !surface.components["root"]) {
      mount.textContent = "No active A2UI surface found.";
      return;
    }
    const nextTree = renderComponentById(surface, "root", undefined, "");
    mount.replaceChildren(nextTree);
    if (typeof window !== "undefined" && prevScrollY > 0) {
      window.scrollTo(0, prevScrollY);
    }
  }

  // Inspector Modal Wiring
  const modal = document.getElementById("a2ui-inspector-modal");
  const inspectBtn = document.getElementById("a2ui-open-inspector");
  const closeBtn = document.getElementById("a2ui-close-inspector");
  const exportBtn = document.getElementById("a2ui-export-json");

  if (inspectBtn && modal) {
    inspectBtn.addEventListener("click", () => {
      const surface = surfaces[activeSurfaceId];
      const pre = document.getElementById("a2ui-inspector-content");
      if (pre && surface) {
        pre.textContent = JSON.stringify(
          {
            protocolVersion: "v0.9.1",
            surfaceId: surface.surfaceId,
            catalogId: surface.catalogId,
            componentCount: Object.keys(surface.components).length,
            dataModel: surface.dataModel,
            clientActionEvents: actionLog,
            serverToClientMessages: messages,
          },
          null,
          2
        );
      }
      modal.hidden = false;
    });
  }
  if (closeBtn && modal) {
    closeBtn.addEventListener("click", () => {
      modal.hidden = true;
    });
  }
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      const surface = surfaces[activeSurfaceId];
      if (surface) dispatchClientAction(surface, "topbar", "exportSurfaceJson", {});
    });
  }

  renderSurface();
})();
`.trim();

/**
 * Generates an A2UI v0.9.1 Declarative Surface (`a2ui_surface.json` + `a2ui_surface.jsonl`)
 * and a zero-dependency Bi-Directional A2UI Studio HTML renderer (`a2ui.html`) for any ICM run.
 */
export function generateA2uiSurface(
  runIdOrOptions?: string | A2uiSurfaceGenerationOptions,
  maybeOptions?: A2uiSurfaceGenerationOptions
): A2uiSurfaceGenerationResult {
  const options: A2uiSurfaceGenerationOptions =
    typeof runIdOrOptions === 'string'
      ? { ...maybeOptions, runId: runIdOrOptions }
      : { ...runIdOrOptions, ...maybeOptions };

  const workspaceRoot = path.resolve(options.workspaceRoot || './workspace');
  const bundleRoot = path.resolve(options.bundleRoot || path.join(workspaceRoot, 'bundle'));
  const runsRoot = path.join(workspaceRoot, 'runs');

  if (fs.existsSync(bundleRoot)) {
    injectBidirectionalBundleLinks(bundleRoot, undefined, undefined, workspaceRoot);
  }

  // Resolve target run directory
  let resolvedRunDir = '';
  let resolvedRunId = options.runId || '';

  const isValidRunDir = (dirPath: string): boolean =>
    fs.existsSync(path.join(dirPath, 'meta.json')) ||
    fs.existsSync(path.join(dirPath, 'stages', '01_research', 'output', 'research_summary.md')) ||
    fs.existsSync(path.join(dirPath, 'stages', '02_script', 'output', 'script_draft.json'));

  const isCompleteRunDir = (dirPath: string): boolean =>
    fs.existsSync(path.join(dirPath, 'stages', '01_research', 'output', 'research_summary.md')) &&
    fs.existsSync(path.join(dirPath, 'stages', '02_script', 'output', 'script_draft.json'));

  if (resolvedRunId && fs.existsSync(resolvedRunId) && fs.statSync(resolvedRunId).isDirectory()) {
    resolvedRunDir = path.resolve(resolvedRunId);
    resolvedRunId = path.basename(resolvedRunDir);
  } else if (
    resolvedRunId &&
    fs.existsSync(path.join(runsRoot, resolvedRunId)) &&
    fs.statSync(path.join(runsRoot, resolvedRunId)).isDirectory() &&
    isValidRunDir(path.join(runsRoot, resolvedRunId))
  ) {
    resolvedRunDir = path.join(runsRoot, resolvedRunId);
  } else if (fs.existsSync(runsRoot)) {
    const allDirs = fs
      .readdirSync(runsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== '_dry_run')
      .map((d) => {
        const fullPath = path.join(runsRoot, d.name);
        return {
          name: d.name,
          fullPath,
          complete: isCompleteRunDir(fullPath),
          valid: isValidRunDir(fullPath),
          mtime: fs.statSync(fullPath).mtimeMs,
        };
      });
    const completeCandidates = allDirs.filter((d) => d.complete).sort((a, b) => b.mtime - a.mtime);
    const validCandidates = allDirs.filter((d) => d.valid).sort((a, b) => b.mtime - a.mtime);
    const candidates =
      completeCandidates.length > 0
        ? completeCandidates
        : validCandidates.length > 0
          ? validCandidates
          : allDirs.sort((a, b) => b.mtime - a.mtime);
    if (candidates.length > 0) {
      resolvedRunId = candidates[0].name;
      resolvedRunDir = candidates[0].fullPath;
    } else if (resolvedRunId) {
      resolvedRunDir = path.join(runsRoot, resolvedRunId);
    }
  } else if (resolvedRunId) {
    resolvedRunDir = path.join(runsRoot, resolvedRunId);
  }

  // Load Run Metadata, Stage 1 OKF v0.2 Artifact, and Stage 2 JSON Artifact
  let meta: Record<string, any> = {};
  if (resolvedRunDir && fs.existsSync(path.join(resolvedRunDir, 'meta.json'))) {
    try {
      meta = JSON.parse(fs.readFileSync(path.join(resolvedRunDir, 'meta.json'), 'utf-8'));
    } catch {
      meta = {};
    }
  }

  let rawOkfMarkdown = '';
  const stage1OutputPath = resolvedRunDir
    ? path.join(resolvedRunDir, 'stages', '01_research', 'output', 'research_summary.md')
    : '';
  if (stage1OutputPath && fs.existsSync(stage1OutputPath)) {
    rawOkfMarkdown = fs.readFileSync(stage1OutputPath, 'utf-8');
  } else if (fs.existsSync(bundleRoot)) {
    const bundleConcepts = walkBundleConcepts(bundleRoot);
    if (bundleConcepts.length > 0) {
      const firstPath = path.join(bundleRoot, `${bundleConcepts[0].id}.md`);
      if (fs.existsSync(firstPath)) {
        rawOkfMarkdown = fs.readFileSync(firstPath, 'utf-8');
      }
    }
  }

  const okfDoc = rawOkfMarkdown
    ? parseOkfDocument(rawOkfMarkdown)
    : { frontmatter: { title: resolvedRunId || 'ICM Studio', status: 'draft' }, body: '' };
  const okfDocHealed = healOrphanOkfFootnotes(okfDoc);
  const okfTrustTier = getOkfTrustTier(okfDoc.frontmatter);
  const okfStale = isOkfStale(okfDoc.frontmatter);
  const okfSources = Array.isArray(okfDoc.frontmatter.sources) ? okfDoc.frontmatter.sources : [];
  if (okfDocHealed && stage1OutputPath && fs.existsSync(stage1OutputPath)) {
    fs.writeFileSync(stage1OutputPath, serializeOkfDocument(okfDoc), 'utf-8');
  }
  if (fs.existsSync(bundleRoot) && stage1OutputPath && fs.existsSync(stage1OutputPath)) {
    const rawTitleSlug = transliterateNordicAscii(String(okfDoc.frontmatter.title || resolvedRunId))
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/-\d{10,}$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const canonicalTitleSlug = truncateSlugAtWordBoundary(rawTitleSlug, 48) || 'research-concept';
    const existingCid = String(meta?.okf?.bundleConceptId || '').trim();
    const existingSlug = existingCid.startsWith('research/')
      ? existingCid.slice('research/'.length)
      : '';
    let migratedSlug = false;
    if (existingSlug && rawTitleSlug.startsWith(existingSlug) && existingSlug !== canonicalTitleSlug) {
      const oldBundleFile = path.join(bundleRoot, 'research', `${existingSlug}.md`);
      const newBundleFile = path.join(bundleRoot, 'research', `${canonicalTitleSlug}.md`);
      if (fs.existsSync(oldBundleFile)) {
        if (!fs.existsSync(newBundleFile)) {
          fs.renameSync(oldBundleFile, newBundleFile);
        } else {
          fs.unlinkSync(oldBundleFile);
        }
        migratedSlug = true;
      }
      if (meta?.okf) {
        meta.okf.bundleConceptId = `research/${canonicalTitleSlug}`;
        const metaPath = path.join(resolvedRunDir, 'meta.json');
        if (fs.existsSync(metaPath)) {
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        }
      }
      const logPath = path.join(bundleRoot, 'log.md');
      if (fs.existsSync(logPath)) {
        const logTxt = fs.readFileSync(logPath, 'utf-8');
        const updatedLog = logTxt.replaceAll(
          `/research/${existingSlug}.md`,
          `/research/${canonicalTitleSlug}.md`
        );
        if (updatedLog !== logTxt) {
          fs.writeFileSync(logPath, updatedLog, 'utf-8');
        }
      }
    }
    const targetSlug =
      existingSlug && (!rawTitleSlug.startsWith(existingSlug) || existingSlug === canonicalTitleSlug)
        ? existingSlug
        : canonicalTitleSlug;
    const targetBundleFile = path.join(bundleRoot, 'research', `${targetSlug}.md`);
    if ((okfDocHealed || migratedSlug) && fs.existsSync(targetBundleFile)) {
      fs.writeFileSync(targetBundleFile, serializeOkfDocument(okfDoc), 'utf-8');
      regenerateBundleIndexes(bundleRoot);
    } else if (migratedSlug) {
      regenerateBundleIndexes(bundleRoot);
    }
  }

  let rawStage2: Record<string, unknown> | null = null;
  const stage2OutputPath = resolvedRunDir
    ? path.join(resolvedRunDir, 'stages', '02_script', 'output', 'script_draft.json')
    : '';
  if (stage2OutputPath && fs.existsSync(stage2OutputPath)) {
    try {
      rawStage2 = JSON.parse(fs.readFileSync(stage2OutputPath, 'utf-8'));
    } catch {
      rawStage2 = null;
    }
  }
  const isStage1Only = !(stage2OutputPath && fs.existsSync(stage2OutputPath) && rawStage2);

  const extractStage1Trace = (runDir: string, runMeta: Record<string, any>) => {
    const tel = (
      runMeta && typeof runMeta.stage1Telemetry === 'object' && runMeta.stage1Telemetry
        ? runMeta.stage1Telemetry
        : {}
    ) as Record<string, any>;
    const tracePath = runDir
      ? path.join(runDir, 'stages', '01_research', 'output', 'thinking_trace.md')
      : '';
    const thinkingTraceMarkdown =
      tracePath && fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf-8') : '';
    const rawQueries: string[] = Array.isArray(tel.searchQueries)
      ? tel.searchQueries.map((q: unknown) => String(q || '').trim()).filter(Boolean)
      : [];
    if (rawQueries.length === 0 && thinkingTraceMarkdown) {
      const sqSectionMatch = thinkingTraceMarkdown.match(
        /##\s+Executed Google Search Queries[\s\S]*?(?=\n##\s+|\s*$)/i
      );
      if (sqSectionMatch) {
        for (const line of sqSectionMatch[0].split(/\r?\n/)) {
          const m = line.match(/^\s*(?:[-*+]|\d+\.)\s+`?([^`\r\n]+?)`?\s*$/);
          if (m && m[1] && !/^\*?No search queries/i.test(m[1].trim())) {
            rawQueries.push(m[1].trim());
          }
        }
      }
    }
    return {
      thinkingLevel: String(tel.thinkingLevel || 'HIGH'),
      thoughtSteps: Number(tel.thoughtSteps || 0),
      searchQueries: rawQueries,
      inputTokens: Number(tel.inputTokens || 0),
      thoughtsTokens: Number(tel.thoughtsTokens || 0),
      outputTokens: Number(tel.outputTokens || 0),
      totalTokens: Number(tel.totalTokens || 0),
      durationMs: Number(tel.durationMs || 0),
      thinkingTraceMarkdown,
    };
  };

  const formatStage1TraceOverviewBody = (
    trace: ReturnType<typeof extractStage1Trace>,
    isNoLang: boolean,
    fallbackDesc: string
  ): string => {
    const lines: string[] = [];
    lines.push(
      isNoLang
        ? '### 📊 Stage 1 Telemetri & Grounding-statistikk'
        : '### 📊 Stage 1 Telemetry & Grounding Metrics'
    );
    lines.push(
      isNoLang
        ? `- **Thinking Level:** \`${trace.thinkingLevel}\`  •  **Resonneringssteg:** ${trace.thoughtSteps}  •  **Google-søk utført:** ${trace.searchQueries.length}`
        : `- **Thinking Level:** \`${trace.thinkingLevel}\`  •  **Reasoning Steps:** ${trace.thoughtSteps}  •  **Google Searches Executed:** ${trace.searchQueries.length}`
    );
    if (trace.totalTokens > 0 || trace.durationMs > 0) {
      const sec = (trace.durationMs / 1000).toFixed(1);
      lines.push(
        isNoLang
          ? `- **Tokens:** ${trace.totalTokens} totalt (input: ${trace.inputTokens}, thinking: ${trace.thoughtsTokens}, output: ${trace.outputTokens})  •  **Varighet:** ${sec}s`
          : `- **Tokens:** ${trace.totalTokens} total (input: ${trace.inputTokens}, thinking: ${trace.thoughtsTokens}, output: ${trace.outputTokens})  •  **Duration:** ${sec}s`
      );
    }
    lines.push('');
    lines.push(
      isNoLang
        ? `### 🔎 Utførte Google-søk (${trace.searchQueries.length})`
        : `### 🔎 Executed Google Search Queries (${trace.searchQueries.length})`
    );
    if (trace.searchQueries.length > 0) {
      trace.searchQueries.forEach((q, idx) => {
        lines.push(`${idx + 1}. \`${q}\``);
      });
    } else {
      lines.push(
        isNoLang
          ? '*Ingen søkespørringer logget i meta.json.*'
          : '*No search queries logged in meta.json.*'
      );
    }
    if (trace.thinkingTraceMarkdown.trim()) {
      const cleanedTrace = trace.thinkingTraceMarkdown
        .replace(/^\s*#\s+[^\r\n]*(?:\r?\n|$)/, '')
        .replace(
          /^\s*(?:[-*+]\s+\*\*(?:Model|Thinking Level|Duration|Input Tokens|Thinking Tokens|Output Tokens|Total Tokens):\*\*[^\r\n]*(?:\r?\n|$))+\s*/i,
          ''
        )
        .replace(/(?:^|\r?\n)##\s+Executed Google Search Queries\b[\s\S]*?(?=\r?\n##\s+|$)/i, '')
        .trim();
      if (cleanedTrace) {
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(cleanedTrace);
      }
    } else if (fallbackDesc.trim()) {
      lines.push('');
      lines.push(fallbackDesc.trim());
    }
    return lines.join('\n');
  };

  const stage1Trace = extractStage1Trace(resolvedRunDir, meta);

  const fallbackTitle = String(
    okfDoc.frontmatter.title || meta.topic || resolvedRunId || 'ICM Studio Surface'
  );
  const surfaceLang = detectIcmLanguage(
    `${okfDoc.frontmatter.title || ''} ${okfDoc.frontmatter.description || ''} ${okfDoc.body || ''} ${JSON.stringify(rawStage2 || {})}`
  );
  const isNo = surfaceLang === 'no';
  const stage2Norm = normalizeStage2ForA2ui(rawStage2, fallbackTitle);
  const domainMode = detectIcmDomainMode(
    rawStage2,
    stage2Norm.quiz.length,
    `${okfDoc.frontmatter.title || ''} ${okfDoc.frontmatter.description || ''} ${stage2Norm.title} ${stage2Norm.scriptBody}`
  );
  const isAnalysis = domainMode === 'analysis';
  const mdChecklistGroups = extractChecklistGroupsFromMarkdown(okfDoc.body);
  const checklistFromStage2 = stage2Norm.checklistGroups.length > 0;
  const checklistGroups = checklistFromStage2
    ? stage2Norm.checklistGroups
    : mdChecklistGroups;

  let totalChecklistItems = 0;
  for (const g of checklistGroups) {
    totalChecklistItems += g.items.length;
  }

  const deriveRunConceptId = (
    runMeta: Record<string, any>,
    runOkfDoc: OKFDocument,
    runIdStr: string
  ): string => {
    const existing = String(runMeta?.okf?.bundleConceptId || '').trim();
    if (existing) return existing;
    const rawSlug = transliterateNordicAscii(String(runOkfDoc.frontmatter.title || runIdStr))
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/-\d{10,}$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `research/${truncateSlugAtWordBoundary(rawSlug, 48) || 'current'}`;
  };

  const primaryConceptId = deriveRunConceptId(meta, okfDoc, resolvedRunId || 'current');

  // Helper to build a run's dataModel and tabTitles for multi-run A2UI Studio switching
  const buildRunBundleEntry = (
    rId: string,
    rDir: string,
    rMeta: Record<string, any>,
    rOkfDoc: OKFDocument,
    rRawStage2: Record<string, unknown> | null,
    graphNodeCount: number,
    runIndex = 0
  ): A2uiBundleRunEntry => {
    const rIsStage1Only = !rRawStage2;
    const rStage1Trace = extractStage1Trace(rDir, rMeta);
    const rFallbackTitle = String(
      rOkfDoc.frontmatter.title || rMeta.topic || rId || 'ICM Studio Surface'
    );
    const rLang = detectIcmLanguage(
      `${rOkfDoc.frontmatter.title || ''} ${rOkfDoc.frontmatter.description || ''} ${rOkfDoc.body || ''} ${JSON.stringify(rRawStage2 || {})}`
    );
    const rIsNo = rLang === 'no';
    const rStage2Norm = normalizeStage2ForA2ui(rRawStage2, rFallbackTitle);
    const rDomainMode = detectIcmDomainMode(
      rRawStage2,
      rStage2Norm.quiz.length,
      `${rOkfDoc.frontmatter.title || ''} ${rOkfDoc.frontmatter.description || ''} ${rStage2Norm.title} ${rStage2Norm.scriptBody}`
    );
    const rIsAnalysis = rDomainMode === 'analysis';
    const rMdChecklistGroups = extractChecklistGroupsFromMarkdown(rOkfDoc.body);
    const rChecklistFromStage2 = rStage2Norm.checklistGroups.length > 0;
    const rChecklistGroups = rChecklistFromStage2
      ? rStage2Norm.checklistGroups
      : rMdChecklistGroups;
    let rTotalChecklist = 0;
    for (const g of rChecklistGroups) {
      rTotalChecklist += g.items.length;
    }
    const rCompletedChecklist = rChecklistGroups.reduce(
      (acc, g) => acc + g.items.filter((i) => i.checked).length,
      0
    );
    const rChecklistPct =
      rTotalChecklist > 0 ? Math.round((rCompletedChecklist / rTotalChecklist) * 100) : 0;
    const rFormattedDuration = rStage2Norm.estimatedDuration
      ? /[a-zA-Z]/.test(String(rStage2Norm.estimatedDuration))
        ? String(rStage2Norm.estimatedDuration)
        : `${rStage2Norm.estimatedDuration}s`
      : '';
    const rStatus = String(rOkfDoc.frontmatter.status || 'draft');
    const rTrustTier = getOkfTrustTier(rOkfDoc.frontmatter);
    const rStale = isOkfStale(rOkfDoc.frontmatter);
    const rVerifiedList = normalizeVerified(rOkfDoc.frontmatter);
    const rNonDefaultVerifier = [...rVerifiedList]
      .reverse()
      .find((v) => v.by && v.by !== 'human:styrer' && v.by !== 'human:reviewer');
    const rVerifierActor =
      rNonDefaultVerifier?.by ||
      rVerifiedList[rVerifiedList.length - 1]?.by ||
      (rIsNo ? 'human:styrer' : 'human:reviewer');
    const rSources = Array.isArray(rOkfDoc.frontmatter.sources)
      ? rOkfDoc.frontmatter.sources
      : [];
    const rConceptId = deriveRunConceptId(rMeta, rOkfDoc, rId || 'current');
    const rTitle = String(rOkfDoc.frontmatter.title || rStage2Norm.title);
    const rBody =
      rOkfDoc.body ||
      (rIsNo ? '*Ingen Stage 1 OKF-kropp funnet.*' : '*No Stage 1 OKF body found.*');
    const rStatusBadge = `status: ${rStatus}`;
    const rTrustBadge = `trust: ${rTrustTier}`;
    const rFreshnessBadge = rStale ? 'stale' : 'fresh';
    const rSourcesBadge = rIsNo
      ? `${rSources.length} verifiserte kilder`
      : `${rSources.length} verified sources`;
    const rShortTitle =
      rStage2Norm.title.length > 52
        ? `${rStage2Norm.title.slice(0, 52).trimEnd()}…`
        : rStage2Norm.title;
    const rShortLabel = rIsNo
      ? `Kurs ${runIndex + 1}: ${rShortTitle}`
      : `Run ${runIndex + 1}: ${rShortTitle}`;

    const rOverviewBody = rIsStage1Only
      ? formatStage1TraceOverviewBody(
          rStage1Trace,
          rIsNo,
          String(rOkfDoc.frontmatter.description || '')
        )
      : rStage2Norm.scriptBody ||
        String(rOkfDoc.frontmatter.description || '') ||
        (rIsNo
          ? 'Ingen Stage 2-manustekst generert ennå.'
          : 'No Stage 2 synthesis text generated yet.');

    const rOverviewHeading = rIsStage1Only
      ? rIsNo
        ? 'Stage 1 Google-søkelogg, Telemetri & Resonnering'
        : 'Stage 1 Search Queries, Telemetry & Reasoning Trace'
      : rIsNo
        ? 'Stage 2 Syntese & Hovedbudskap'
        : rIsAnalysis
          ? 'Stage 2 Executive Synthesis & Thesis'
          : 'Stage 2 Synthesis & Core Narrative';

    const canPingPongRun = hasAntigravityBrowserCapability({
      artifactDir: options.artifactDir,
      enablePingPong: options.enablePingPong,
    });
    const rDataModel = {
      meta: {
        runId: rId || 'workspace',
        lang: rLang,
        domainMode: rDomainMode,
        isStage1Only: rIsStage1Only,
        canPingPong: canPingPongRun,
        title: rStage2Norm.title,
        subtitle: rStage2Norm.subtitle,
        targetAudience: rStage2Norm.targetAudience,
        estimatedDuration: rStage2Norm.estimatedDuration,
        model: rMeta.model || GEMINI_4_ARGON_MODEL,
        subtitleLine: [
          rStage2Norm.targetAudience
            ? `${rIsNo ? 'Målgruppe' : 'Target Audience'}: ${rStage2Norm.targetAudience}`
            : '',
          rFormattedDuration ? `${rIsNo ? 'Varighet' : 'Duration'}: ${rFormattedDuration}` : '',
          `${rIsNo ? 'Modell' : 'Model'}: ${rMeta.model || GEMINI_4_ARGON_MODEL}`,
          `Run: ${rId || 'workspace'}`,
        ]
          .filter(Boolean)
          .join('  •  '),
      },
      okf: {
        primaryConceptId: rConceptId,
        activeConceptId: rConceptId,
        viewingStubConcept: false,
        primaryTitle: rTitle,
        primaryBody: rBody,
        primarySources: rSources,
        primaryStatus: rStatus,
        primaryTrustTier: rTrustTier,
        primaryIsStale: rStale,
        primaryStatusBadge: rStatusBadge,
        primaryTrustBadge: rTrustBadge,
        primaryFreshnessBadge: rFreshnessBadge,
        primarySourcesBadge: rSourcesBadge,
        title: rTitle,
        type: String(rOkfDoc.frontmatter.type || 'Research Concept'),
        status: rStatus,
        trustTier: rTrustTier,
        isStale: rStale,
        statusBadge: rStatusBadge,
        trustBadge: rTrustBadge,
        freshnessBadge: rFreshnessBadge,
        sourcesBadge: rSourcesBadge,
        sources: rSources,
        verifierActor: rVerifierActor,
        rejectedSources: [] as string[],
        replacedSources: {} as Record<string, string>,
        addedSources: [] as Array<{ id: string; url: string; title: string }>,
        stage1Trace: rStage1Trace,
        body: rBody,
        editMode: false,
      },
      checklist: {
        groups: rChecklistGroups,
        fromStage2: rChecklistFromStage2,
        completedCount: rCompletedChecklist,
        totalCount: rTotalChecklist,
        percent: rChecklistPct,
        summaryText: `${rCompletedChecklist} / ${rTotalChecklist} ${rIsNo ? 'fullført' : 'completed'} (${rChecklistPct}%)`,
      },
      stage2: {
        overviewHeading: rOverviewHeading,
        scriptBody: rOverviewBody,
        spokenScript:
          rStage2Norm.spokenScript ||
          rStage2Norm.scriptBody ||
          rOkfDoc.frontmatter.description ||
          (rIsNo
            ? 'Ingen Stage 2-manustekst generert ennå.'
            : 'No Stage 2 synthesis text generated yet.'),
        highlights: rStage2Norm.highlights,
        highlightsObjects: rStage2Norm.highlights.map((h, idx) => ({
          id: `hl_${idx + 1}`,
          label: `• ${h}`,
        })),
        modules: rStage2Norm.modules,
        activeModuleIndex: 0,
        cases: rStage2Norm.cases,
        caseResponses: {},
        caseRevealed: {},
        quiz: rStage2Norm.quiz,
        quizAnswers: {},
      },
    };

    const rTabTitles: Record<string, string> = {
      tab_overview: rIsStage1Only
        ? rIsNo
          ? `🔎 Søkelogg & Resonnering (${rStage1Trace.searchQueries.length} søk)`
          : `🔎 Search & Grounding Trace (${rStage1Trace.searchQueries.length} queries)`
        : rIsNo
          ? '📋 Oversikt & Sammendrag'
          : rIsAnalysis
            ? '📋 Executive Summary'
            : '📋 Overview & Summary',
      tab_okf_markdown: rIsStage1Only
        ? rIsNo
          ? `📚 OKF v0.2 Kunnskapsgrunnlag & Kilder (${rSources.length})`
          : `📚 OKF v0.2 Knowledge Base & Sources (${rSources.length})`
        : rIsNo
          ? '📚 OKF v0.2 Kunnskapsgrunnlag'
          : '📚 OKF v0.2 Knowledge Base',
      tab_okf_graph: rIsNo
        ? `🕸️ OKF Kunnskapsgraf (${graphNodeCount})`
        : `🕸️ OKF Knowledge Graph (${graphNodeCount})`,
    };
    if (rTotalChecklist > 0) {
      rTabTitles.tab_checklist = rIsNo
        ? `✅ Interaktiv Sjekkliste (${rTotalChecklist})`
        : `✅ Interactive Checklist (${rTotalChecklist})`;
    }
    if (rStage2Norm.modules.length > 0) {
      rTabTitles.tab_modules = rIsNo
        ? rIsAnalysis
          ? `📊 Analyse-pilarer (${rStage2Norm.modules.length})`
          : `🎓 Moduler (${rStage2Norm.modules.length})`
        : rIsAnalysis
          ? `📊 Deep-Dive Pillars (${rStage2Norm.modules.length})`
          : `🎓 Modules (${rStage2Norm.modules.length})`;
    }
    if (rStage2Norm.cases.length > 0) {
      rTabTitles.tab_cases = rIsNo
        ? `⚖️ Case & Tiltak (${rStage2Norm.cases.length})`
        : rIsAnalysis
          ? `⚖️ Scenario Simulator (${rStage2Norm.cases.length})`
          : `⚖️ Cases & Actions (${rStage2Norm.cases.length})`;
    }
    if (rStage2Norm.quiz.length > 0) {
      rTabTitles.tab_quiz = rIsNo
        ? `🧪 Quiz (${rStage2Norm.quiz.length})`
        : `🧪 Knowledge Check (${rStage2Norm.quiz.length})`;
    }

    return {
      runId: rId || 'workspace',
      conceptId: rConceptId,
      title: rStage2Norm.title,
      shortLabel: rShortLabel,
      isStage1Only: rIsStage1Only,
      status: rStatus,
      trustTier: rTrustTier,
      isStale: rStale,
      sourcesCount: rSources.length,
      checklistCount: rTotalChecklist,
      checklistItemCount: rTotalChecklist,
      moduleCount: rStage2Norm.modules.length,
      caseCount: rStage2Norm.cases.length,
      quizCount: rStage2Norm.quiz.length,
      tabTitles: rTabTitles,
      dataModel: rDataModel,
    };
  };

  // Discover all runs in workspace/runs for multi-run switching in A2UI Studio
  const hasStage1OrComplete = (dirPath: string): boolean =>
    fs.existsSync(path.join(dirPath, 'stages', '01_research', 'output', 'research_summary.md')) ||
    fs.existsSync(path.join(dirPath, 'stages', '02_script', 'output', 'script_draft.json'));

  const candidateRunDirs: Array<{
    name: string;
    fullPath: string;
    sortKey: number;
    hasArtifact: boolean;
  }> = [];
  if (fs.existsSync(runsRoot)) {
    for (const d of fs.readdirSync(runsRoot, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === '_dry_run') continue;
      const fullPath = path.join(runsRoot, d.name);
      if (!isValidRunDir(fullPath)) continue;
      const tsMatch = d.name.match(/-(\d{10,})$/);
      const sortKey = tsMatch ? Number(tsMatch[1]) : fs.statSync(fullPath).mtimeMs;
      candidateRunDirs.push({
        name: d.name,
        fullPath,
        sortKey,
        hasArtifact: hasStage1OrComplete(fullPath),
      });
    }
  }
  const hasAnyArtifactRun = candidateRunDirs.some((d) => d.hasArtifact);
  const rawRunDirs: Array<{ name: string; fullPath: string; sortKey: number }> = (
    hasAnyArtifactRun ? candidateRunDirs.filter((d) => d.hasArtifact) : candidateRunDirs
  ).map(({ name, fullPath, sortKey }) => ({ name, fullPath, sortKey }));

  if (
    resolvedRunDir &&
    fs.existsSync(resolvedRunDir) &&
    !rawRunDirs.some((d) => path.resolve(d.fullPath) === path.resolve(resolvedRunDir))
  ) {
    const tsMatch = (resolvedRunId || '').match(/-(\d{10,})$/);
    const sortKey = tsMatch ? Number(tsMatch[1]) : fs.statSync(resolvedRunDir).mtimeMs;
    rawRunDirs.push({
      name: resolvedRunId || path.basename(resolvedRunDir),
      fullPath: resolvedRunDir,
      sortKey,
    });
  }
  rawRunDirs.sort((a, b) => a.sortKey - b.sortKey || a.name.localeCompare(b.name));

  // Collect OKF Bundle Graph Data for OkfKnowledgeGraph
  const concepts = fs.existsSync(bundleRoot) ? walkBundleConcepts(bundleRoot) : [];
  if (concepts.length === 0 && okfDoc.body) {
    const synthId = primaryConceptId || `research/${resolvedRunId || 'current'}`;
    concepts.push({
      id: synthId,
      type: String(okfDoc.frontmatter.type || 'Research Concept'),
      title: String(okfDoc.frontmatter.title || stage2Norm.title),
      description: String(okfDoc.frontmatter.description || ''),
      resource: String(okfDoc.frontmatter.resource || ''),
      tags: Array.isArray(okfDoc.frontmatter.tags) ? okfDoc.frontmatter.tags.map(String) : [],
      body: okfDoc.body,
      status: String(okfDoc.frontmatter.status || 'draft'),
      generated: (okfDoc.frontmatter.generated as any) || {},
      verified: [],
      stale_after: String(okfDoc.frontmatter.stale_after || ''),
      sources: okfSources,
      trust_tier: okfTrustTier,
      stale: okfStale,
      links_to: extractConceptLinks(
        okfDoc.body,
        okfDoc.frontmatter,
        path.join(bundleRoot, 'research'),
        bundleRoot
      ),
    });
  }

  // Pre-build bundleRuns entries (we will update tab_okf_graph count once graphNodes is finalized)
  const bundleRuns: A2uiBundleRunEntry[] = [];
  for (let rIdx = 0; rIdx < rawRunDirs.length; rIdx++) {
    const rd = rawRunDirs[rIdx];
    if (resolvedRunDir && path.resolve(rd.fullPath) === path.resolve(resolvedRunDir)) {
      bundleRuns.push(buildRunBundleEntry(rd.name, rd.fullPath, meta, okfDoc, rawStage2, 0, rIdx));
      continue;
    }
    let rMeta: Record<string, any> = {};
    const rMetaPath = path.join(rd.fullPath, 'meta.json');
    if (fs.existsSync(rMetaPath)) {
      try {
        rMeta = JSON.parse(fs.readFileSync(rMetaPath, 'utf-8'));
      } catch {
        rMeta = {};
      }
    }
    const rStage1Path = path.join(
      rd.fullPath,
      'stages',
      '01_research',
      'output',
      'research_summary.md'
    );
    const rStage2Path = path.join(
      rd.fullPath,
      'stages',
      '02_script',
      'output',
      'script_draft.json'
    );
    const rRawOkf = fs.existsSync(rStage1Path) ? fs.readFileSync(rStage1Path, 'utf-8') : '';
    const rOkfDoc = rRawOkf
      ? parseOkfDocument(rRawOkf)
      : { frontmatter: { title: rd.name, status: 'draft' }, body: '' };
    healOrphanOkfFootnotes(rOkfDoc);
    let rRawStage2: Record<string, unknown> | null = null;
    if (fs.existsSync(rStage2Path)) {
      try {
        rRawStage2 = JSON.parse(fs.readFileSync(rStage2Path, 'utf-8'));
      } catch {
        rRawStage2 = null;
      }
    }
    bundleRuns.push(buildRunBundleEntry(rd.name, rd.fullPath, rMeta, rOkfDoc, rRawStage2, 0, rIdx));
  }
  if (bundleRuns.length === 0) {
    bundleRuns.push(
      buildRunBundleEntry(resolvedRunId || 'workspace', resolvedRunDir, meta, okfDoc, rawStage2, 0, 0)
    );
  }

  const conceptToRunId = new Map<string, string>();
  for (const br of bundleRuns) {
    if (br.conceptId) {
      conceptToRunId.set(br.conceptId, br.runId);
    }
  }

  const conceptBacklinks = new Map<string, Array<{ id: string; title: string }>>();
  for (const c of concepts) {
    for (const target of c.links_to) {
      if (target === c.id) continue;
      const list = conceptBacklinks.get(target) || [];
      if (!list.some((b) => b.id === c.id)) {
        list.push({ id: c.id, title: c.title || c.id });
      }
      conceptBacklinks.set(target, list);
    }
  }

  const conceptMeta: Record<string, Record<string, any>> = {};
  for (const c of concepts) {
    const cSources = Array.isArray(c.sources) ? c.sources : [];
    conceptMeta[c.id] = {
      id: c.id,
      title: c.title || c.id,
      type: c.type,
      description: c.description,
      status: c.status,
      trustTier: c.trust_tier,
      isStale: c.stale,
      statusBadge: `status: ${c.status || 'draft'}`,
      trustBadge: `trust: ${c.trust_tier || 'unverified'}`,
      freshnessBadge: c.stale ? 'stale' : 'fresh',
      sourcesBadge: isNo
        ? `${cSources.length} verifiserte kilder`
        : `${cSources.length} verified sources`,
      sources: cSources,
      backlinks: conceptBacklinks.get(c.id) || [],
      runId: conceptToRunId.get(c.id) || null,
    };
  }

  const conceptIds = new Set(concepts.map((c) => c.id));
  const graphNodes: Array<{ data: Record<string, any> }> = concepts.map((c) => ({
    data: {
      id: c.id,
      group: 'concept',
      label: c.title || c.id,
      type: c.type,
      description: c.description,
      status: c.status,
      trust_tier: c.trust_tier,
      stale: c.stale,
      sources: c.sources || [],
      tags: c.tags || [],
      generated: c.generated || {},
      verified: c.verified || [],
      stale_after: c.stale_after || '',
      backlinks: conceptBacklinks.get(c.id) || [],
      runId: conceptToRunId.get(c.id) || null,
      color: getOkfTypeColor(c.type),
      size: 32 + Math.min(48, Math.floor(c.body.length / 250)),
    },
  }));
  const graphBodies: Record<string, string> = {};
  for (const c of concepts) {
    graphBodies[c.id] = c.body;
  }

  // Ensure every discovered run's concept metadata and body are registered even if bundle wasn't synced yet
  for (const br of bundleRuns) {
    const cid = br.conceptId;
    const rOkf = br.dataModel?.okf;
    if (cid && rOkf) {
      if (!graphBodies[cid] && rOkf.primaryBody) {
        graphBodies[cid] = rOkf.primaryBody;
      }
      if (!conceptMeta[cid]) {
        conceptMeta[cid] = {
          id: cid,
          title: rOkf.primaryTitle || br.title,
          type: rOkf.type || 'Research Concept',
          description: '',
          status: rOkf.status || 'draft',
          trustTier: rOkf.primaryTrustTier || 'unverified',
          isStale: Boolean(rOkf.primaryIsStale),
          statusBadge: rOkf.primaryStatusBadge || 'status: draft',
          trustBadge: rOkf.primaryTrustBadge || 'trust: unverified',
          freshnessBadge: rOkf.primaryFreshnessBadge || 'fresh',
          sourcesBadge: rOkf.primarySourcesBadge || '0 sources',
          sources: rOkf.primarySources || [],
          backlinks: conceptBacklinks.get(cid) || [],
          runId: br.runId,
        };
      }
    }
  }

  const graphEdges: Array<{ data: { id: string; source: string; target: string; label?: string } }> = [];
  const seenEdgeKeys = new Set<string>();
  const sourceNodeIdByCanonicalUrl = new Map<string, string>();
  const sourceNodeDataById = new Map<string, Record<string, any>>();
  const sourceNodeByFnId: Record<string, Record<string, string>> = {};
  const sourceNodeByAnyFnId: Record<string, string> = {};

  for (const c of concepts) {
    sourceNodeByFnId[c.id] = {};
    for (const target of c.links_to) {
      if (target === c.id) continue;
      if (!conceptIds.has(target)) {
        conceptIds.add(target);
        const shortLabel = target
          .replace(/^research\//, '')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (m) => m.toUpperCase());
        graphNodes.push({
          data: {
            id: target,
            group: 'concept',
            label: shortLabel,
            parentConceptId: c.id,
            type: 'Linked Concept',
            description: isNo
              ? `Referert OKF-konsept fra ${c.id}`
              : `Referenced OKF concept from ${c.id}`,
            status: 'draft',
            trust_tier: 'unverified',
            stale: false,
            sources: [],
            backlinks: conceptBacklinks.get(target) || [],
            color: '#64748b',
            size: 28,
          },
        });
        graphBodies[target] = isNo
          ? `# ${shortLabel}\n\n*Dette OKF-konseptet (\`/${target}.md\`) er referert fra **${c.title || c.id}**.*\n\nKjør \`npm run cli:stage1 -- "${shortLabel}"\` for å generere og verifisere dette konseptet i kunnskapsbunten.`
          : `# ${shortLabel}\n\n*This OKF concept (\`/${target}.md\`) is referenced from **${c.title || c.id}**.*\n\nRun \`npm run cli:stage1 -- "${shortLabel}"\` to generate and verify this concept in the knowledge bundle.`;
      }
      const key = `${c.id}__${target}`;
      if (seenEdgeKeys.has(key)) continue;
      seenEdgeKeys.add(key);
      graphEdges.push({ data: { id: key, source: c.id, target } });
    }
    for (const src of c.sources || []) {
      const rawSrcId = String(src.id || src.title || 'ref').trim();
      const srcUrl = String((src as any).url || (src as any).resource || '').trim();
      const canonicalUrl = normalizeCanonicalSourceUrl(srcUrl);
      const decodedTitle = decodeHtmlEntities(String(src.title || srcUrl || rawSrcId).trim());
      const fullTitleText = enrichBareDomainSourceTitle(decodedTitle, srcUrl) || decodedTitle;
      const shortTitleText =
        fullTitleText.length > 42
          ? `${fullTitleText.slice(0, 42).trimEnd()}…`
          : fullTitleText;
      const refLine = isNo
        ? `- **Referert i konsept:** [/${c.id}.md](/${c.id}.md) (*${c.title || c.id}*)`
        : `- **Referenced in concept:** [/${c.id}.md](/${c.id}.md) (*${c.title || c.id}*)`;

      let srcNodeId = '';
      if (canonicalUrl && sourceNodeIdByCanonicalUrl.has(canonicalUrl)) {
        srcNodeId = sourceNodeIdByCanonicalUrl.get(canonicalUrl)!;
        const existingNodeData = sourceNodeDataById.get(srcNodeId);
        if (existingNodeData) {
          const curTitleSummary = String(existingNodeData.titleSummary || '');
          if (shouldUpgradeSourceTitle(curTitleSummary, fullTitleText, srcUrl)) {
            const primaryFnId = String(existingNodeData.primaryFnId || rawSrcId);
            existingNodeData.titleSummary = fullTitleText;
            existingNodeData.fullTitle = `[^${primaryFnId}] ${fullTitleText}`;
            existingNodeData.label = `[^${primaryFnId}] ${shortTitleText}`;
          }
          const citedBy = Array.isArray(existingNodeData.citedByConcepts)
            ? (existingNodeData.citedByConcepts as string[])
            : [];
          if (!citedBy.includes(c.id)) {
            citedBy.push(c.id);
            existingNodeData.citedByConcepts = citedBy;
          }
        }
        if (graphBodies[srcNodeId] && !graphBodies[srcNodeId].includes(refLine)) {
          graphBodies[srcNodeId] = `${graphBodies[srcNodeId]}\n${refLine}`;
        }
      } else {
        let candidateNodeId = `source:${rawSrcId}`;
        let suffix = 2;
        while (conceptIds.has(candidateNodeId)) {
          candidateNodeId = `source:${rawSrcId}--${suffix}`;
          suffix++;
        }
        srcNodeId = candidateNodeId;
        conceptIds.add(srcNodeId);
        if (canonicalUrl) {
          sourceNodeIdByCanonicalUrl.set(canonicalUrl, srcNodeId);
        }
        const displayFnId = srcNodeId.replace(/^source:/, '');
        let effectiveFullTitle = fullTitleText;
        let effectiveShortTitle = shortTitleText;
        if (displayFnId !== rawSrcId) {
          const firstBaseNode = sourceNodeDataById.get(`source:${rawSrcId}`);
          const firstBaseTitle = String(
            firstBaseNode?.baseTitle || firstBaseNode?.titleSummary || ''
          ).trim();
          if (firstBaseTitle && firstBaseTitle.toLowerCase() === fullTitleText.toLowerCase()) {
            const pathSlug = extractLastUrlPathSlug(srcUrl);
            if (pathSlug) {
              effectiveFullTitle = `${fullTitleText} (${pathSlug})`;
              effectiveShortTitle = `${shortTitleText} (${pathSlug})`;
            }
          }
        }
        const nodeData: Record<string, any> = {
          id: srcNodeId,
          group: 'source',
          primaryFnId: displayFnId,
          baseTitle: fullTitleText,
          titleSummary: effectiveFullTitle,
          label: `[^${displayFnId}] ${effectiveShortTitle}`,
          fullTitle: `[^${displayFnId}] ${effectiveFullTitle}`,
          parentConceptId: c.id,
          citedByConcepts: [c.id],
          type: 'Verified Source',
          description: srcUrl || effectiveFullTitle,
          resource: srcUrl,
          status: 'stable',
          trust_tier: c.trust_tier,
          stale: false,
          color: '#10b981',
          size: 24,
        };
        sourceNodeDataById.set(srcNodeId, nodeData);
        graphNodes.push({ data: nodeData });
        graphBodies[srcNodeId] = [
          src.retrieved_at
            ? isNo
              ? `- **Hentet (\`retrieved_at\`):** \`${src.retrieved_at}\``
              : `- **Retrieved (\`retrieved_at\`):** \`${src.retrieved_at}\``
            : '',
          src.last_modified
            ? isNo
              ? `- **Sist endret (\`last_modified\`):** \`${src.last_modified}\``
              : `- **Last modified (\`last_modified\`):** \`${src.last_modified}\``
            : '',
          refLine,
        ]
          .filter(Boolean)
          .join('\n');
      }
      sourceNodeByFnId[c.id][rawSrcId] = srcNodeId;
      if (!sourceNodeByAnyFnId[rawSrcId]) {
        sourceNodeByAnyFnId[rawSrcId] = srcNodeId;
      }
      const edgeKey = `${c.id}__${srcNodeId}`;
      if (!seenEdgeKeys.has(edgeKey)) {
        seenEdgeKeys.add(edgeKey);
        graphEdges.push({ data: { id: edgeKey, source: c.id, target: srcNodeId, label: 'cites' } });
      }
    }
  }

  const anyRunHasHighlights =
    stage2Norm.highlights.length > 0 ||
    bundleRuns.some((r) => (r.dataModel?.stage2?.highlights?.length || 0) > 0);
  const anyRunHasChecklist =
    totalChecklistItems > 0 || bundleRuns.some((r) => r.checklistItemCount > 0);
  const anyRunHasModules =
    stage2Norm.modules.length > 0 || bundleRuns.some((r) => r.moduleCount > 0);
  const anyRunHasCases =
    stage2Norm.cases.length > 0 || bundleRuns.some((r) => r.caseCount > 0);
  const anyRunHasQuiz =
    stage2Norm.quiz.length > 0 || bundleRuns.some((r) => r.quizCount > 0);

  for (const br of bundleRuns) {
    const rIsNo = br.dataModel?.meta?.lang === 'no';
    const rIsAnalysis = br.dataModel?.meta?.domainMode === 'analysis';
    br.tabTitles.tab_okf_graph = rIsNo
      ? `🕸️ OKF Kunnskapsgraf (${graphNodes.length})`
      : `🕸️ OKF Knowledge Graph (${graphNodes.length})`;
    if (anyRunHasChecklist && !br.tabTitles.tab_checklist) {
      br.tabTitles.tab_checklist = rIsNo
        ? `✅ Interaktiv Sjekkliste (${br.checklistCount})`
        : `✅ Interactive Checklist (${br.checklistCount})`;
    }
    if (anyRunHasModules && !br.tabTitles.tab_modules) {
      br.tabTitles.tab_modules = rIsNo
        ? rIsAnalysis
          ? `📊 Analyse-pilarer (${br.moduleCount})`
          : `🎓 Moduler (${br.moduleCount})`
        : rIsAnalysis
          ? `📊 Deep-Dive Pillars (${br.moduleCount})`
          : `🎓 Modules (${br.moduleCount})`;
    }
    if (anyRunHasCases && !br.tabTitles.tab_cases) {
      br.tabTitles.tab_cases = rIsNo
        ? `⚖️ Case & Tiltak (${br.caseCount})`
        : rIsAnalysis
          ? `⚖️ Scenario Simulator (${br.caseCount})`
          : `⚖️ Cases & Actions (${br.caseCount})`;
    }
    if (anyRunHasQuiz && !br.tabTitles.tab_quiz) {
      br.tabTitles.tab_quiz = rIsNo
        ? `🧪 Quiz (${br.quizCount})`
        : `🧪 Knowledge Check (${br.quizCount})`;
    }
    if (br.isStage1Only) {
      const brTabs: Array<{ title: string; child: string }> = [
        { title: br.tabTitles.tab_okf_markdown, child: 'tab_okf_markdown' },
        { title: br.tabTitles.tab_overview, child: 'tab_overview' },
        { title: br.tabTitles.tab_okf_graph, child: 'tab_okf_graph' },
      ];
      if (br.checklistCount > 0 && br.tabTitles.tab_checklist) {
        brTabs.push({ title: br.tabTitles.tab_checklist, child: 'tab_checklist' });
      }
      br.tabs = brTabs;
    } else {
      const brTabs: Array<{ title: string; child: string }> = [
        { title: br.tabTitles.tab_overview, child: 'tab_overview' },
      ];
      if (anyRunHasChecklist && br.tabTitles.tab_checklist) {
        brTabs.push({ title: br.tabTitles.tab_checklist, child: 'tab_checklist' });
      }
      if (anyRunHasModules && br.tabTitles.tab_modules) {
        brTabs.push({ title: br.tabTitles.tab_modules, child: 'tab_modules' });
      }
      if (anyRunHasCases && br.tabTitles.tab_cases) {
        brTabs.push({ title: br.tabTitles.tab_cases, child: 'tab_cases' });
      }
      if (anyRunHasQuiz && br.tabTitles.tab_quiz) {
        brTabs.push({ title: br.tabTitles.tab_quiz, child: 'tab_quiz' });
      }
      brTabs.push(
        { title: br.tabTitles.tab_okf_markdown, child: 'tab_okf_markdown' },
        { title: br.tabTitles.tab_okf_graph, child: 'tab_okf_graph' }
      );
      br.tabs = brTabs;
    }
  }

  const surfaceId =
    options.surfaceId ||
    `icm_${(resolvedRunId || 'workspace').replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  // Construct A2UI v0.9.1 Component Adjacency List
  const components: A2uiComponent[] = [];
  const tabs: Array<{ title: string; child: string }> = [];

  // Header Components
  components.push(
    {
      id: 'header_card',
      component: 'Card',
      child: 'header_col',
    },
    {
      id: 'header_col',
      component: 'Column',
      children: ['header_top_row', 'header_meta_row'],
    },
    {
      id: 'header_top_row',
      component: 'Row',
      justify: 'spaceBetween',
      children: ['header_title', 'header_badges_row'],
    },
    {
      id: 'header_title',
      component: 'Text',
      variant: 'h1',
      text: { path: '/meta/title' },
    },
    {
      id: 'header_badges_row',
      component: 'Row',
      children: ['badge_status', 'badge_trust', 'badge_freshness', 'badge_sources'],
    },
    {
      id: 'badge_status',
      component: 'Badge',
      tone: okfDoc.frontmatter.status === 'stable' ? 'success' : 'warn',
      text: { path: '/okf/statusBadge' },
    },
    {
      id: 'badge_trust',
      component: 'Badge',
      tone: okfTrustTier === 'human-reviewed' ? 'accent' : 'primary',
      text: { path: '/okf/trustBadge' },
    },
    {
      id: 'badge_freshness',
      component: 'Badge',
      tone: okfStale ? 'danger' : 'success',
      text: { path: '/okf/freshnessBadge' },
    },
    {
      id: 'badge_sources',
      component: 'Badge',
      tone: 'neutral',
      text: { path: '/okf/sourcesBadge' },
    },
    {
      id: 'header_meta_row',
      component: 'Row',
      children: ['header_subtitle'],
    },
    {
      id: 'header_subtitle',
      component: 'Text',
      variant: 'caption',
      text: { path: '/meta/subtitleLine' },
    }
  );

  // Overview / Search & Grounding Trace Component Tree
  const overviewChildren = ['overview_narration_card'];
  if (!isStage1Only && anyRunHasHighlights) {
    overviewChildren.push('overview_highlights_card');
  }
  const overviewNarrationChildren = isStage1Only
    ? ['overview_narration_heading', 'overview_narration_body']
    : ['overview_narration_heading', 'overview_tts_player', 'overview_narration_body'];
  components.push(
    {
      id: 'tab_overview',
      component: 'Column',
      children: overviewChildren,
    },
    {
      id: 'overview_narration_card',
      component: 'Card',
      child: 'overview_narration_col',
    },
    {
      id: 'overview_narration_col',
      component: 'Column',
      children: overviewNarrationChildren,
    },
    {
      id: 'overview_narration_heading',
      component: 'Text',
      variant: 'h2',
      text: { path: '/stage2/overviewHeading' },
    },
    {
      id: 'overview_tts_player',
      component: 'AudioPlayer',
      url: 'tts://web-speech/stage2/spokenScript',
      description: { path: '/meta/title' },
      ttsText: { path: '/stage2/spokenScript' },
    },
    {
      id: 'overview_narration_body',
      component: 'Text',
      variant: 'body',
      markdown: true,
      text: { path: '/stage2/scriptBody' },
    }
  );

  if (anyRunHasHighlights) {
    components.push(
      {
        id: 'overview_highlights_card',
        component: 'Card',
        child: 'overview_highlights_col',
      },
      {
        id: 'overview_highlights_col',
        component: 'Column',
        children: ['overview_highlights_title', 'overview_highlights_list'],
      },
      {
        id: 'overview_highlights_title',
        component: 'Text',
        variant: 'h3',
        text: isNo
          ? 'Hovedpunkter & Læringsmål'
          : isAnalysis
            ? 'Key Takeaways & Thesis Highlights'
            : 'Key Takeaways & Learning Objectives',
      },
      {
        id: 'overview_highlights_list',
        component: 'List',
        children: {
          path: '/stage2/highlightsObjects',
          componentId: 'highlight_item_text',
        },
      },
      {
        id: 'highlight_item_text',
        component: 'Text',
        variant: 'body',
        text: { path: 'label' },
      }
    );
  }

  // Register Conditional & Domain Components
  if (anyRunHasChecklist) {
    components.push({
      id: 'tab_checklist',
      component: 'InteractiveChecklist',
      title: isNo
        ? 'Interaktiv Sjekkliste (OKF v0.2 Kontrollpunkter)'
        : 'Interactive Checklist (OKF v0.2 Verification Items)',
      groupsPath: '/checklist/groups',
    });
  }

  if (anyRunHasModules) {
    components.push({
      id: 'tab_modules',
      component: 'ModuleCarousel',
      title: isNo
        ? 'Opplæringsmoduler & Leksjoner'
        : isAnalysis
          ? 'Analytical Pillars & Valuation Deep-Dives'
          : 'Training Modules & Lessons',
      modulesPath: '/stage2/modules',
      activeIndexPath: '/stage2/activeModuleIndex',
    });
  }

  if (anyRunHasCases) {
    components.push({
      id: 'tab_cases',
      component: 'CaseSimulator',
      title: isNo
        ? 'Scenario- og vedtakssimulator'
        : isAnalysis
          ? 'Scenario & Decision Simulator'
          : 'Case & Action Simulator',
      casesPath: '/stage2/cases',
      responsesPath: '/stage2/caseResponses',
    });
  }

  if (anyRunHasQuiz) {
    components.push({
      id: 'tab_quiz',
      component: 'QuizRunner',
      title: isNo ? 'Interaktiv Kunnskapssjekk' : 'Interactive Knowledge Check',
      questionsPath: '/stage2/quiz',
      answersPath: '/stage2/quizAnswers',
    });
  }

  components.push(
    {
      id: 'tab_okf_markdown',
      component: 'OkfMarkdown',
      title: { path: '/okf/title' },
      body: { path: '/okf/body' },
      sources: { path: '/okf/sources' },
      trustTier: { path: '/okf/trustTier' },
      isStale: { path: '/okf/isStale' },
    },
    {
      id: 'tab_okf_graph',
      component: 'OkfKnowledgeGraph',
      title: isNo ? 'OKF v0.2 Kunnskapsgraf' : 'OKF v0.2 Knowledge Graph',
    }
  );

  // Assemble `tabs` order based on `isStage1Only` vs Full Studio Mode
  if (isStage1Only) {
    tabs.push(
      {
        title: isNo
          ? `📚 OKF v0.2 Kunnskapsgrunnlag & Kilder (${okfSources.length})`
          : `📚 OKF v0.2 Knowledge Base & Sources (${okfSources.length})`,
        child: 'tab_okf_markdown',
      },
      {
        title: isNo
          ? `🔎 Søkelogg & Resonnering (${stage1Trace.searchQueries.length} søk)`
          : `🔎 Search & Grounding Trace (${stage1Trace.searchQueries.length} queries)`,
        child: 'tab_overview',
      },
      {
        title: isNo
          ? `🕸️ OKF Kunnskapsgraf (${graphNodes.length})`
          : `🕸️ OKF Knowledge Graph (${graphNodes.length})`,
        child: 'tab_okf_graph',
      }
    );
    if (totalChecklistItems > 0) {
      tabs.push({
        title: isNo
          ? `✅ Interaktiv Sjekkliste (${totalChecklistItems})`
          : `✅ Interactive Checklist (${totalChecklistItems})`,
        child: 'tab_checklist',
      });
    }
  } else {
    tabs.push({
      title: isNo
        ? '📋 Oversikt & Sammendrag'
        : isAnalysis
          ? '📋 Executive Summary'
          : '📋 Overview & Summary',
      child: 'tab_overview',
    });
    if (anyRunHasChecklist) {
      tabs.push({
        title: isNo
          ? `✅ Interaktiv Sjekkliste (${totalChecklistItems})`
          : `✅ Interactive Checklist (${totalChecklistItems})`,
        child: 'tab_checklist',
      });
    }
    if (anyRunHasModules) {
      tabs.push({
        title: isNo
          ? isAnalysis
            ? `📊 Analyse-pilarer (${stage2Norm.modules.length})`
            : `🎓 Moduler (${stage2Norm.modules.length})`
          : isAnalysis
            ? `📊 Deep-Dive Pillars (${stage2Norm.modules.length})`
            : `🎓 Modules (${stage2Norm.modules.length})`,
        child: 'tab_modules',
      });
    }
    if (anyRunHasCases) {
      tabs.push({
        title: isNo
          ? `⚖️ Case & Tiltak (${stage2Norm.cases.length})`
          : isAnalysis
            ? `⚖️ Scenario Simulator (${stage2Norm.cases.length})`
            : `⚖️ Cases & Actions (${stage2Norm.cases.length})`,
        child: 'tab_cases',
      });
    }
    if (anyRunHasQuiz) {
      tabs.push({
        title: isNo
          ? `🧪 Quiz (${stage2Norm.quiz.length})`
          : `🧪 Knowledge Check (${stage2Norm.quiz.length})`,
        child: 'tab_quiz',
      });
    }
    tabs.push(
      {
        title: isNo ? '📚 OKF v0.2 Kunnskapsgrunnlag' : '📚 OKF v0.2 Knowledge Base',
        child: 'tab_okf_markdown',
      },
      {
        title: isNo
          ? `🕸️ OKF Kunnskapsgraf (${graphNodes.length})`
          : `🕸️ OKF Knowledge Graph (${graphNodes.length})`,
        child: 'tab_okf_graph',
      }
    );
  }

  // Root & Main Tabs Component
  components.push(
    {
      id: 'main_tabs',
      component: 'Tabs',
      tabs,
    },
    {
      id: 'root',
      component: 'Column',
      children: ['header_card', 'main_tabs'],
    }
  );

  const completedChecklistCount = checklistGroups.reduce(
    (acc, g) => acc + g.items.filter((i) => i.checked).length,
    0
  );
  const checklistPct =
    totalChecklistItems > 0 ? Math.round((completedChecklistCount / totalChecklistItems) * 100) : 0;

  const formattedDuration = stage2Norm.estimatedDuration
    ? /[a-zA-Z]/.test(String(stage2Norm.estimatedDuration))
      ? String(stage2Norm.estimatedDuration)
      : `${stage2Norm.estimatedDuration}s`
    : '';

  const primaryTitleStr = String(okfDoc.frontmatter.title || stage2Norm.title);
  const primaryBodyStr =
    okfDoc.body ||
    (isNo ? '*Ingen Stage 1 OKF-kropp funnet.*' : '*No Stage 1 OKF body found.*');
  const primaryStatusStr = String(okfDoc.frontmatter.status || 'draft');
  const primaryVerifiedList = normalizeVerified(okfDoc.frontmatter);
  const primaryNonDefaultVerifier = [...primaryVerifiedList]
    .reverse()
    .find((v) => v.by && v.by !== 'human:styrer' && v.by !== 'human:reviewer');
  const primaryVerifierActor =
    primaryNonDefaultVerifier?.by ||
    primaryVerifiedList[primaryVerifiedList.length - 1]?.by ||
    (isNo ? 'human:styrer' : 'human:reviewer');
  const primaryStatusBadgeStr = `status: ${primaryStatusStr}`;
  const primaryTrustBadgeStr = `trust: ${okfTrustTier}`;
  const primaryFreshnessBadgeStr = okfStale ? 'stale' : 'fresh';
  const primarySourcesBadgeStr = isNo
    ? `${okfSources.length} verifiserte kilder`
    : `${okfSources.length} verified sources`;

  const activeOverviewBody = isStage1Only
    ? formatStage1TraceOverviewBody(
        stage1Trace,
        isNo,
        String(okfDoc.frontmatter.description || '')
      )
    : stage2Norm.scriptBody ||
      String(okfDoc.frontmatter.description || '') ||
      (isNo
        ? 'Ingen Stage 2-manustekst generert ennå.'
        : 'No Stage 2 synthesis text generated yet.');

  const activeOverviewHeading = isStage1Only
    ? isNo
      ? 'Stage 1 Google-søkelogg, Telemetri & Resonnering'
      : 'Stage 1 Search Queries, Telemetry & Reasoning Trace'
    : isNo
      ? 'Stage 2 Syntese & Hovedbudskap'
      : isAnalysis
        ? 'Stage 2 Executive Synthesis & Thesis'
        : 'Stage 2 Synthesis & Core Narrative';

  const canPingPongMain = hasAntigravityBrowserCapability({
    artifactDir: options.artifactDir,
    enablePingPong: options.enablePingPong,
  });
  const dataModel = {
    meta: {
      runId: resolvedRunId || 'workspace',
      lang: surfaceLang,
      domainMode,
      isStage1Only,
      canPingPong: canPingPongMain,
      title: stage2Norm.title,
      subtitle: stage2Norm.subtitle,
      targetAudience: stage2Norm.targetAudience,
      estimatedDuration: stage2Norm.estimatedDuration,
      model: meta.model || GEMINI_4_ARGON_MODEL,
      subtitleLine: [
        stage2Norm.targetAudience
          ? `${isNo ? 'Målgruppe' : 'Target Audience'}: ${stage2Norm.targetAudience}`
          : '',
        formattedDuration ? `${isNo ? 'Varighet' : 'Duration'}: ${formattedDuration}` : '',
        `${isNo ? 'Modell' : 'Model'}: ${meta.model || GEMINI_4_ARGON_MODEL}`,
        `Run: ${resolvedRunId || 'workspace'}`,
      ]
        .filter(Boolean)
        .join('  •  '),
    },
    okf: {
      primaryConceptId,
      activeConceptId: primaryConceptId,
      viewingStubConcept: false,
      primaryTitle: primaryTitleStr,
      primaryBody: primaryBodyStr,
      primarySources: okfSources,
      primaryStatus: primaryStatusStr,
      primaryTrustTier: okfTrustTier,
      primaryIsStale: okfStale,
      primaryStatusBadge: primaryStatusBadgeStr,
      primaryTrustBadge: primaryTrustBadgeStr,
      primaryFreshnessBadge: primaryFreshnessBadgeStr,
      primarySourcesBadge: primarySourcesBadgeStr,
      title: primaryTitleStr,
      type: String(okfDoc.frontmatter.type || 'Research Concept'),
      status: primaryStatusStr,
      trustTier: okfTrustTier,
      isStale: okfStale,
      verifierActor: primaryVerifierActor,
      statusBadge: primaryStatusBadgeStr,
      trustBadge: primaryTrustBadgeStr,
      freshnessBadge: primaryFreshnessBadgeStr,
      sourcesBadge: primarySourcesBadgeStr,
      sources: okfSources,
      rejectedSources: [] as string[],
      replacedSources: {} as Record<string, string>,
      addedSources: [] as Array<{ id: string; url: string; title: string }>,
      stage1Trace,
      body: primaryBodyStr,
      editMode: false,
    },
    checklist: {
      groups: checklistGroups,
      fromStage2: checklistFromStage2,
      completedCount: completedChecklistCount,
      totalCount: totalChecklistItems,
      percent: checklistPct,
      summaryText: `${completedChecklistCount} / ${totalChecklistItems} ${isNo ? 'fullført' : 'completed'} (${checklistPct}%)`,
    },
    stage2: {
      overviewHeading: activeOverviewHeading,
      scriptBody: activeOverviewBody,
      spokenScript:
        stage2Norm.spokenScript ||
        stage2Norm.scriptBody ||
        okfDoc.frontmatter.description ||
        (isNo
          ? 'Ingen Stage 2-manustekst generert ennå.'
          : 'No Stage 2 synthesis text generated yet.'),
      highlights: stage2Norm.highlights,
      highlightsObjects: stage2Norm.highlights.map((h, idx) => ({
        id: `hl_${idx + 1}`,
        label: `• ${h}`,
      })),
      modules: stage2Norm.modules,
      activeModuleIndex: 0,
      cases: stage2Norm.cases,
      caseResponses: {},
      caseRevealed: {},
      quiz: stage2Norm.quiz,
      quizAnswers: {},
    },
  };

  const messages: A2uiEnvelopeMessage[] = [
    {
      version: A2UI_PROTOCOL_VERSION,
      createSurface: {
        surfaceId,
        catalogId: A2UI_ICM_CATALOG_ID,
        theme: {
          primaryColor: '#1d4ed8',
          agentDisplayName: 'ICM + OKF v0.2 A2UI Studio',
        },
        sendDataModel: true,
      },
    },
    {
      version: A2UI_PROTOCOL_VERSION,
      updateComponents: {
        surfaceId,
        components,
      },
    },
    {
      version: A2UI_PROTOCOL_VERSION,
      updateDataModel: {
        surfaceId,
        path: '/',
        value: dataModel,
      },
    },
  ];

  const validation = validateA2uiSurfaceMessages(messages);
  if (!validation.valid) {
    throw new Error(`Invalid A2UI v0.9.1 surface generated: ${validation.errors.join('; ')}`);
  }

  // Determine output paths (supports `outputDir` override for non-destructive external testing)
  const baseOutDir = options.outputDir
    ? path.resolve(options.outputDir)
    : resolvedRunDir || workspaceRoot;
  const stageSubDir = isStage1Only
    ? path.join('stages', '01_research', 'output')
    : path.join('stages', '02_script', 'output');
  const stageOutDir = options.outputDir
    ? path.join(baseOutDir, stageSubDir)
    : resolvedRunDir
      ? path.join(resolvedRunDir, stageSubDir)
      : path.join(workspaceRoot, 'bundle');

  fs.mkdirSync(stageOutDir, { recursive: true });

  const surfaceJsonPath = path.join(stageOutDir, 'a2ui_surface.json');
  const surfaceJsonlPath = path.join(stageOutDir, 'a2ui_surface.jsonl');
  const htmlOutputPath = options.outputHtmlPath
    ? path.resolve(options.outputHtmlPath)
    : path.join(baseOutDir, 'a2ui.html');

  const surfaceJsonDoc = {
    version: A2UI_PROTOCOL_VERSION,
    surfaceId,
    catalogId: A2UI_ICM_CATALOG_ID,
    catalogSchema: A2UI_ICM_CATALOG_SCHEMA,
    generatedAt: new Date().toISOString(),
    runId: resolvedRunId || 'workspace',
    messages,
  };

  const serializedSurfaceJson = JSON.stringify(surfaceJsonDoc, null, 2);
  const serializedSurfaceJsonl = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  fs.writeFileSync(surfaceJsonPath, serializedSurfaceJson, 'utf-8');
  fs.writeFileSync(surfaceJsonlPath, serializedSurfaceJsonl, 'utf-8');

  // Also mirror `a2ui_surface.json` & `a2ui_surface.jsonl` at the run root (`workspace/runs/<runId>/`) alongside `a2ui.html`
  if (resolvedRunDir && path.resolve(baseOutDir) !== path.resolve(stageOutDir)) {
    fs.mkdirSync(baseOutDir, { recursive: true });
    fs.writeFileSync(path.join(baseOutDir, 'a2ui_surface.json'), serializedSurfaceJson, 'utf-8');
    fs.writeFileSync(path.join(baseOutDir, 'a2ui_surface.jsonl'), serializedSurfaceJsonl, 'utf-8');
  }

  const clientPayload = {
    surfaceId,
    catalogId: A2UI_ICM_CATALOG_ID,
    messages,
    bundleRuns,
    bundleGraph: {
      nodes: graphNodes,
      edges: graphEdges,
      bodies: graphBodies,
      conceptMeta,
      sourceNodeByFnId,
      sourceNodeByAnyFnId,
    },
  };

  const renderA2uiHtmlDocument = (
    docLang: string,
    docTitle: string,
    docIsNo: boolean,
    payload: Record<string, any>
  ): string => `<!DOCTYPE html>
<html lang="${docLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeA2uiHtml(docTitle)} — A2UI v0.9.1 Studio</title>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.28.1/dist/cytoscape.min.js"></script>
<style>
${A2UI_STUDIO_CSS}
</style>
</head>
<body>
<header class="a2ui-topbar">
  <div class="a2ui-topbar-brand">
    <span class="a2ui-protocol-pill">A2UI ${A2UI_PROTOCOL_VERSION}</span>
    <span class="a2ui-topbar-title">${escapeA2uiHtml(docTitle)}</span>
  </div>
  <div class="a2ui-topbar-actions">
    <button class="a2ui-top-btn" id="a2ui-open-inspector">🔍 A2UI Surface &amp; Data Model Inspector</button>
    <button class="a2ui-top-btn" id="a2ui-export-json">${docIsNo ? '⬇ Eksporter A2UI Tilstand (.json)' : '⬇ Export A2UI State (.json)'}</button>
  </div>
</header>

<main class="a2ui-root-Mount" id="a2ui-surface-root"></main>

<div class="a2ui-modal-backdrop" id="a2ui-inspector-modal" hidden>
  <div class="a2ui-modal-dialog">
    <div class="a2ui-modal-header">
      <strong>${docIsNo ? 'A2UI v0.9.1 Deklarativ Surface, Data Model &amp; Action Log' : 'A2UI v0.9.1 Declarative Surface, Data Model &amp; Action Log'}</strong>
      <button class="a2ui-btn" id="a2ui-close-inspector">${docIsNo ? 'Lukk' : 'Close'}</button>
    </div>
    <div class="a2ui-modal-body">
      <pre id="a2ui-inspector-content" style="background:#0f172a;color:#e2e8f0;padding:14px;border-radius:8px;font-size:12px;overflow-x:auto;margin:0"></pre>
    </div>
  </div>
</div>

<script>
window.A2UI_SURFACE_PAYLOAD = ${JSON.stringify(payload).replace(/<\//g, '<\\/')};
</script>
<script>
${A2UI_STUDIO_JS}
</script>
</body>
</html>
`;

  const html = renderA2uiHtmlDocument(surfaceLang, stage2Norm.title, isNo, clientPayload);

  fs.mkdirSync(path.dirname(htmlOutputPath), { recursive: true });
  fs.writeFileSync(htmlOutputPath, html, 'utf-8');

  let bundleHtmlPath: string | undefined;
  let bundleVizPath: string | undefined;
  const shouldMirrorBundle =
    options.mirrorBundleHtml !== undefined ? options.mirrorBundleHtml : !options.outputDir;
  if (shouldMirrorBundle) {
    fs.mkdirSync(bundleRoot, { recursive: true });
    bundleHtmlPath = path.join(bundleRoot, 'a2ui.html');
    fs.writeFileSync(bundleHtmlPath, html, 'utf-8');
    try {
      const vizResult = generateBundleVisualization(bundleRoot);
      bundleVizPath = vizResult.outputPath;
    } catch {
      // Non-fatal if bundle has no concepts yet
    }
  }

  // Also refresh sibling runs' a2ui.html so every run has the full multi-run switcher and unified bundle graph
  if (shouldMirrorBundle && bundleRuns.length > 1) {
    const activeRunKey = resolvedRunId || 'workspace';
    for (const br of bundleRuns) {
      if (!br.runId || br.runId === activeRunKey || br.runId === 'workspace') continue;
      const siblingRunDir = path.join(runsRoot, br.runId);
      if (!fs.existsSync(siblingRunDir) || !hasStage1OrComplete(siblingRunDir)) continue;
      const siblingHtmlPath = path.join(siblingRunDir, 'a2ui.html');
      if (path.resolve(siblingHtmlPath) === path.resolve(htmlOutputPath)) continue;
      const siblingSurfaceId = `icm_${br.runId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const siblingLang = String(br.dataModel?.meta?.lang || surfaceLang);
      const siblingIsNo = siblingLang === 'no';
      const siblingComponents = components.map((comp) => {
        if (comp.id === 'badge_status') {
          return { ...comp, tone: br.status === 'stable' ? 'success' : 'warn' };
        }
        if (comp.id === 'badge_trust') {
          return { ...comp, tone: br.trustTier === 'human-reviewed' ? 'accent' : 'primary' };
        }
        if (comp.id === 'badge_freshness') {
          return { ...comp, tone: br.isStale ? 'danger' : 'success' };
        }
        if (comp.id === 'tab_overview') {
          return {
            ...comp,
            children:
              !br.isStage1Only && anyRunHasHighlights
                ? ['overview_narration_card', 'overview_highlights_card']
                : ['overview_narration_card'],
          };
        }
        if (comp.id === 'overview_narration_col') {
          return {
            ...comp,
            children: br.isStage1Only
              ? ['overview_narration_heading', 'overview_narration_body']
              : ['overview_narration_heading', 'overview_tts_player', 'overview_narration_body'],
          };
        }
        if (comp.id === 'main_tabs' && Array.isArray((comp as any).tabs)) {
          return {
            ...comp,
            tabs: Array.isArray(br.tabs) && br.tabs.length > 0
              ? br.tabs
              : (comp as any).tabs.map((t: { title: string; child: string }) => ({
                  ...t,
                  title: br.tabTitles?.[t.child] || t.title,
                })),
          };
        }
        return comp;
      });
      const siblingMessages: A2uiEnvelopeMessage[] = [
        {
          version: A2UI_PROTOCOL_VERSION,
          createSurface: {
            surfaceId: siblingSurfaceId,
            catalogId: A2UI_ICM_CATALOG_ID,
            theme: {
              primaryColor: '#1d4ed8',
              agentDisplayName: 'ICM + OKF v0.2 A2UI Studio',
            },
            sendDataModel: true,
          },
        },
        {
          version: A2UI_PROTOCOL_VERSION,
          updateComponents: {
            surfaceId: siblingSurfaceId,
            components: siblingComponents,
          },
        },
        {
          version: A2UI_PROTOCOL_VERSION,
          updateDataModel: {
            surfaceId: siblingSurfaceId,
            path: '/',
            value: br.dataModel,
          },
        },
      ];
      const siblingPayload = {
        surfaceId: siblingSurfaceId,
        catalogId: A2UI_ICM_CATALOG_ID,
        messages: siblingMessages,
        bundleRuns,
        bundleGraph: clientPayload.bundleGraph,
      };
      const siblingHtml = renderA2uiHtmlDocument(
        siblingLang,
        br.title || stage2Norm.title,
        siblingIsNo,
        siblingPayload
      );
      fs.writeFileSync(siblingHtmlPath, siblingHtml, 'utf-8');
    }
  }

  const artifactSynced = syncA2uiToArtifactDir({
    artifactDir: options.artifactDir,
    htmlOutputPath,
    bundleVizPath,
    runId: resolvedRunId || 'workspace',
    title: stage2Norm.title,
    isStage1Only,
  });

  const shouldOpenBrowser =
    Boolean(options.openBrowser) ||
    process.argv.includes('--open') ||
    process.env.ICM_OPEN_A2UI === '1';
  const browserOpened = shouldOpenBrowser ? openFileInSystemBrowser(htmlOutputPath) : false;

  return {
    runId: resolvedRunId || 'workspace',
    surfaceId,
    catalogId: A2UI_ICM_CATALOG_ID,
    isStage1Only,
    componentCount: components.length,
    tabCount: tabs.length,
    checklistItemCount: totalChecklistItems,
    moduleCount: stage2Norm.modules.length,
    quizCount: stage2Norm.quiz.length,
    caseCount: stage2Norm.cases.length,
    conceptCount: graphNodes.length,
    surfaceJsonPath,
    surfaceJsonlPath,
    htmlOutputPath,
    bundleHtmlPath,
    bundleVizPath,
    artifactHtmlPath: artifactSynced.artifactHtmlPath,
    artifactVizPath: artifactSynced.artifactVizPath,
    browserOpened,
    messages,
    bundleRuns,
  };
}

/**
 * Runs a zero-token, zero-network self-test suite covering:
 * 1. OKF v0.2 parser/serializer round-trip, trust tiers, and staleness detection (`retrieved_at`, `last_modified`).
 * 2. `cleanGroundingLinks()` multi-byte UTF-8 byte-offset snapping (`æ`, `ø`, `å`, `§`, `—`), Markdown heading/table guards,
 *    closing emphasis/bracket snapping (`**bold**`, `(RK 1)`), `.^id` / `.[^id]` normalization, `isFinalStep` filtering,
 *    and cited-only footnote definitions (`citedFootnoteIds`).
 * 3. A2UI v0.9.1 `validateA2uiSurfaceMessages()`, `cleanChecklistLabel()` (`**bold**`, `*italic*`, `` `code` ``, `[^id]`),
 *    and `normalizeStage2ForA2ui()` concise `CaseSimulator` synthesis.
 */
export async function runIcmSelfTests(): Promise<{ passed: number }> {
  let assertions = 0;
  function assert(condition: unknown, message: string): void {
    if (!condition) {
      throw new Error(`[ICM Self-Test FAILED] ${message}`);
    }
    assertions++;
  }

  // 0. Programmatic TypeScript typecheck (tsc --noEmit) so `npm test` needs no shell `&&` chaining
  const pkgRootFromArgv = path.resolve(path.dirname(process.argv[1] || process.cwd()), '..');
  const tscCandidates = [
    path.resolve(process.cwd(), 'node_modules/typescript/bin/tsc'),
    path.resolve(process.cwd(), 'node_modules/typescript/lib/tsc.js'),
    path.resolve(pkgRootFromArgv, 'node_modules/typescript/bin/tsc'),
    path.resolve(pkgRootFromArgv, 'node_modules/typescript/lib/tsc.js'),
  ];
  const resolvedTscBin = tscCandidates.find((p) => fs.existsSync(p));
  const tscCwd = fs.existsSync(path.resolve(process.cwd(), 'tsconfig.json'))
    ? process.cwd()
    : pkgRootFromArgv;
  try {
    if (resolvedTscBin) {
      execFileSync(process.execPath, [resolvedTscBin, '--noEmit'], {
        cwd: tscCwd,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } else {
      const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      execFileSync(npxCmd, ['tsc', '--noEmit'], {
        cwd: tscCwd,
        stdio: 'pipe',
        encoding: 'utf-8',
        shell: process.platform === 'win32',
      });
    }
    assertions++;
  } catch (err: any) {
    const stderr = err?.stderr || err?.stdout || err?.message || String(err);
    throw new Error(`[ICM Self-Test FAILED] TypeScript typecheck (tsc --noEmit) failed:\n${stderr}`);
  }

  // 1. OKF v0.2 round-trip, trust tier, and staleness
  const rawOkfSample = [
    '---',
    'type: Research Concept',
    'title: "Brannvernleders plikter — æøå § 11"',
    'description: "Systematisk sikkerhetsarbeid i henhold til FOB og BPL."',
    'tags: [brannvern, fob, kontroll]',
    'status: draft',
    'generated:',
    '  by: agent:gemini-4-argon',
    '  at: 2026-10-30T10:00:00Z',
    'stale_after: 2099-01-01',
    'sources:',
    '  - id: lovdata-fob',
    '    title: "Forskrift om brannforebygging (FOB)"',
    '    resource: "https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710"',
    '    retrieved_at: 2026-10-30',
    '    last_modified: 2024-01-01',
    '---',
    '',
    '# Oversikt',
    '',
    'Eier skal dokumentere brannsikkerhet[^lovdata-fob].',
    '',
    '[^lovdata-fob]: Forskrift om brannforebygging (FOB)',
    '',
  ].join('\n');

  const parsedOkf = parseOkfDocument(rawOkfSample);
  assert(parsedOkf.frontmatter.title === 'Brannvernleders plikter — æøå § 11', 'OKF title parsed');
  assert(getOkfTrustTier(parsedOkf.frontmatter) === 'unverified', 'Draft status maps to unverified trust tier');
  assert(isOkfStale(parsedOkf.frontmatter) === false, 'Future stale_after is fresh');
  assert(
    Array.isArray(parsedOkf.frontmatter.sources) &&
      parsedOkf.frontmatter.sources[0]?.retrieved_at === '2026-10-30' &&
      parsedOkf.frontmatter.sources[0]?.last_modified === '2024-01-01',
    'OKF source retrieved_at and last_modified preserved on parse'
  );

  const serializedOkf = serializeOkfDocument(parsedOkf);
  const reparsedOkf = parseOkfDocument(serializedOkf);
  assert(
    reparsedOkf.frontmatter.sources?.[0]?.retrieved_at === '2026-10-30T00:00:00Z' &&
      reparsedOkf.frontmatter.sources?.[0]?.last_modified === '2024-01-01T00:00:00Z',
    'OKF source retrieved_at and last_modified normalize to ISO 8601 UTC and survive serialize -> parse round-trip'
  );
  assert(
    getOkfTrustTier({ status: 'stable', verified: [{ by: 'human:cato', at: '2026-10-30' }] }) === 'human-reviewed',
    'Human verifier yields human-reviewed trust tier'
  );
  assert(
    getOkfTrustTier({ status: 'stable', verified: [{ by: 'agent:gemini-4-argon', at: '2026-10-30' }] }) ===
      'machine-confirmed',
    'Agent verifier yields machine-confirmed trust tier'
  );
  assert(isOkfStale({ stale_after: '2020-01-01' }) === true, 'Past stale_after is detected as stale');

  // 2. cleanGroundingLinks() UTF-8, heading/table skip, closing emphasis/paren/section snap, slash-joined word snap, .^id typo, isFinalStep, citedFootnoteIds, bare-domain enrichment & uncited fm.sources filtering
  const lineHeading = '## 1. Hovedkrav for særskilte brannobjekter (§ 13)';
  const lineTable = '| Risikoklasse | Krav til rømningsvei | Kontroll |';
  const lineProse =
    'Etter FOB § 4 skal brannvernleder påse at **rømningsveier** og (RK 1) er frie og forebygge overtredelser/avvik i drift. Kravet gjelder også næringsbygg.^dibk-no.^lovdata-fob Dette er påbudt.[^lovdata-fob]';
  const bodyMd = [
    lineHeading,
    '',
    lineTable,
    '',
    lineProse,
    '',
    '[^lovdata-fob]: Forskrift om brannforebygging',
    '[^dibk-no]: dibk.no',
    '[^uncited-dangling]: Dangling Uncited Source',
  ].join('\n');

  const fmPrefix = [
    '---',
    'type: Research Concept',
    'title: "Test UTF-8 Grounding"',
    'status: draft',
    'sources:',
    '  - id: lovdata-fob',
    '    title: "Forskrift om brannforebygging"',
    '    resource: "https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710"',
    '  - id: dibk-no',
    '    title: "dibk.no"',
    '    resource: "https://dibk.no/regelverk/byggteknisk-forskrift-tek17/"',
    '  - id: uncited-fm-source',
    '    title: "Uncited Frontmatter Source"',
    '    resource: "https://example.com/uncited-fm"',
    '---',
    '',
  ].join('\n');
  const rawTestMarkdown = `${fmPrefix}${bodyMd}`;
  const fmBytePrefix = Buffer.byteLength(fmPrefix, 'utf-8');

  const bodyBuf = Buffer.from(bodyMd, 'utf-8');
  // Byte offset inside the heading (should be skipped)
  const headingByteOffset = fmBytePrefix + Buffer.from('## 1. Hovedkrav for sær', 'utf-8').length;
  // Byte offset inside the table row (should be skipped)
  const tableStartByte =
    fmBytePrefix + Buffer.from(lineHeading + '\n\n| Risikoklasse | Krav til røm', 'utf-8').length;
  // Byte offset right after '§' in 'Etter FOB § 4 skal' (should snap past ' 4' and NOT consume 'skal brannvernleder...')
  const sectionSymbolByteOffset =
    fmBytePrefix + Buffer.from(lineHeading + '\n\n' + lineTable + '\n\nEtter FOB §', 'utf-8').length;
  // Byte offset landing mid-word and mid-UTF8 on 'rømningsveier' inside **rømningsveier**
  const prosePrefixBeforeRomning =
    lineHeading + '\n\n' + lineTable + '\n\nEtter FOB § 4 skal brannvernleder påse at **r';
  // +1 byte into 'ø' (0xC3 0xB8) to test mid-codepoint UTF-8 continuation byte safety + snapping past **
  const midUtf8BoldByteOffset =
    fmBytePrefix + Buffer.from(prosePrefixBeforeRomning, 'utf-8').length + 1;
  // Byte offset landing inside (RK 1) right before closing ')'
  const prosePrefixBeforeParen =
    lineHeading + '\n\n' + lineTable + '\n\nEtter FOB § 4 skal brannvernleder påse at **rømningsveier** og (RK 1';
  const insideParenByteOffset = fmBytePrefix + Buffer.from(prosePrefixBeforeParen, 'utf-8').length;
  // Byte offset landing right before '/avvik' in 'overtredelser/avvik'
  const prosePrefixBeforeSlashWord =
    lineHeading +
    '\n\n' +
    lineTable +
    '\n\nEtter FOB § 4 skal brannvernleder påse at **rømningsveier** og (RK 1) er frie og forebygge overtredelser';
  const slashWordByteOffset = fmBytePrefix + Buffer.from(prosePrefixBeforeSlashWord, 'utf-8').length;

  const mockOutputs = [
    // Intermediate draft step (should be ignored because a later model_output exists)
    {
      type: 'model_output',
      content: [
        {
          type: 'text',
          text: 'Draft step text',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://example.com/draft-ignored',
              title: 'Draft Ignored Source',
              start_index: 0,
              end_index: 10,
            },
          ],
        },
      ],
    },
    // Final model_output step
    {
      type: 'model_output',
      content: [
        {
          type: 'text',
          text: rawTestMarkdown,
          annotations: [
            {
              type: 'url_citation',
              url: 'https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710',
              title: 'Forskrift om brannforebygging',
              start_index: fmBytePrefix,
              end_index: headingByteOffset,
            },
            {
              type: 'url_citation',
              url: 'https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710',
              title: 'Forskrift om brannforebygging',
              start_index: headingByteOffset + 5,
              end_index: tableStartByte,
            },
            {
              type: 'url_citation',
              url: 'https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710',
              title: 'Forskrift om brannforebygging',
              start_index: tableStartByte + 5,
              end_index: sectionSymbolByteOffset,
            },
            {
              type: 'url_citation',
              url: 'https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710',
              title: 'Forskrift om brannforebygging',
              start_index: sectionSymbolByteOffset + 5,
              end_index: midUtf8BoldByteOffset,
            },
            {
              type: 'url_citation',
              url: 'https://dibk.no/regelverk/byggteknisk-forskrift-tek17/',
              title: 'dibk.no',
              start_index: midUtf8BoldByteOffset + 5,
              end_index: insideParenByteOffset,
            },
            {
              type: 'url_citation',
              url: 'https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710',
              title: 'Forskrift om brannforebygging',
              start_index: insideParenByteOffset + 5,
              end_index: slashWordByteOffset,
            },
          ],
        },
      ],
    },
  ];

  assert(
    fmBytePrefix + bodyBuf.length > slashWordByteOffset,
    'UTF-8 buffer covers test byte offsets'
  );
  const cleanedMd = await cleanGroundingLinks(rawTestMarkdown, mockOutputs, {
    bundleRoot: './workspace/runs/_selftest_empty_bundle',
  });
  assert(!cleanedMd.includes('\uFFFD'), 'No UTF-8 replacement characters (U+FFFD) after byte-offset injection');
  assert(
    cleanedMd.includes('## 1. Hovedkrav for særskilte brannobjekter (§ 13)'),
    'Heading was not corrupted by byte-offset citation injection'
  );
  assert(
    cleanedMd.includes('| Risikoklasse | Krav til rømningsvei | Kontroll |'),
    'Markdown table row was not corrupted by byte-offset citation injection'
  );
  assert(
    cleanedMd.includes('Etter FOB § 4[^lovdata-fob] skal brannvernleder'),
    `Citation right after § snaps past section number " 4" without consuming subsequent words (got: "${cleanedMd}")`
  );
  assert(
    cleanedMd.includes('**rømningsveier**[^lovdata-fob]'),
    'Citation snapped cleanly past multi-byte ø and closing **bold** markers'
  );
  assert(
    cleanedMd.includes('(RK 1)[^dibk-no]'),
    'Citation snapped cleanly past closing parenthesis of (RK 1)'
  );
  assert(
    cleanedMd.includes('overtredelser/avvik[^lovdata-fob]') &&
      !cleanedMd.includes('overtredelser[^lovdata-fob]/avvik'),
    `Citation inside slash-joined word pair snaps past entire "overtredelser/avvik" token (got: "${cleanedMd}")`
  );
  assert(
    cleanedMd.includes('næringsbygg[^dibk-no] [^lovdata-fob].') && !cleanedMd.includes('..'),
    `Chained .^dibk-no.^lovdata-fob typos normalized to [^dibk-no] [^lovdata-fob]. without double period (got: "${cleanedMd}")`
  );
  assert(
    cleanedMd.includes('Dette er påbudt[^lovdata-fob].'),
    'Trailing .[^lovdata-fob] normalized to [^lovdata-fob].'
  );
  assert(
    !cleanedMd.includes('uncited-dangling') &&
      !cleanedMd.includes('draft-ignored') &&
      !cleanedMd.includes('uncited-fm-source'),
    'Uncited footnote definitions, uncited frontmatter sources, and non-final draft step sources are excluded'
  );
  assert(
    cleanedMd.includes('title: dibk.no — Byggteknisk forskrift tek17') &&
      cleanedMd.includes('[^dibk-no]: dibk.no — Byggteknisk forskrift tek17'),
    `Bare-domain title "dibk.no" enriched from URL slug in both frontmatter and footnote definition (got: "${cleanedMd}")`
  );
  assert(
    enrichBareDomainSourceTitle('dsb.no', 'https://dsb.no/') === 'dsb.no' &&
      enrichBareDomainSourceTitle('example.no', 'https://example.no/12345') === 'example.no',
    'Root-only and numeric-only URL paths fall back to clean bare domain'
  );
  assert(
    enrichBareDomainSourceTitle('snl.no', 'https://snl.no/brannvern_%C3%A6%C3%B8%C3%A5') ===
      'snl.no — Brannvern æøå' &&
      enrichBareDomainSourceTitle(
        'stortinget.no',
        'https://www.stortinget.no/no/Saker-og-publikasjoner/Vedtak/Beslutninger/Odelstinget/2008-2009/beso-200809-118/1'
      ) === 'stortinget.no — Beso 200809-118' &&
      enrichBareDomainSourceTitle(
        'www.ha.no',
        'https://www.ha.no/_f/p1/i71e106c5-9925-4d53-8efc-f5736e3ee5f0/veiledning-tilrettelegging-for-innsats-for-redning-og-slokkemannskaper-ha-kommune-uu.pdf'
      ) ===
        'ha.no — Veiledning tilrettelegging for innsats for redning og slokkemannskaper ha kommune uu' &&
      enrichBareDomainSourceTitle(
        'ilo.org',
        'https://wwwex.ilo.org/dyn/legosh_en/f?p=14100:503:0::NO::P503_REFERENCE_ID:310536'
      ) === 'ilo.org' &&
      enrichBareDomainSourceTitle(
        'ilo.org — Legosh en',
        'https://wwwex.ilo.org/dyn/legosh_en/f?p=14100:503:0::NO::P503_REFERENCE_ID:310536'
      ) === 'ilo.org' &&
      enrichBareDomainSourceTitle(
        'example.org',
        'https://example.org/pls/apex/f?p=100:1'
      ) === 'example.org' &&
      enrichBareDomainSourceTitle('Sommerskolen', 'https://orbrann.no/sommerskolen') ===
        'orbrann.no — Sommerskolen' &&
      enrichBareDomainSourceTitle('Sommerskolen', 'https://en.orbrann.no/sommerskolen') ===
        'en.orbrann.no — Sommerskolen' &&
      enrichBareDomainSourceTitle('dibk.no', 'https://www.dibk.no/regelverk/tek/3/11/iv/11-12') ===
        'dibk.no — Tek 11-12' &&
      enrichBareDomainSourceTitle(
        'lovdata.no',
        'https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710/1'
      ) === 'lovdata.no — Forskrift 2015-12-17-1710' &&
      enrichBareDomainSourceTitle('example.no', 'https://example.no/nyheter/2024/11/12') ===
        'example.no — Nyheter 2024-11-12' &&
      enrichBareDomainSourceTitle(
        'dibk.no',
        'https://www.dibk.no/contentassets/c50f3c7dcbaa47a3bf4221ee88196aa5/-12-13.-dor-port-og-lignende-01.10.2030.09.21.pdf'
      ) === 'dibk.no — 12-13. Dor port og lignende 01.10.2030.09.21' &&
      enrichBareDomainSourceTitle(
        'regjeringen.no',
        'https://www.regjeringen.no/no/dokumenter/brann--og-eksplosjonsvernloven/id87138/'
      ) === 'regjeringen.no — Brann og eksplosjonsvernloven' &&
      enrichBareDomainSourceTitle(
        'regjeringen.no — Id87138',
        'https://www.regjeringen.no/no/dokumenter/brann--og-eksplosjonsvernloven/id87138/'
      ) === 'regjeringen.no — Brann og eksplosjonsvernloven' &&
      enrichBareDomainSourceTitle(
        'kniftrygghet.no',
        'https://www.kniftrygghet.no/ResourceServlet/af1f7f4264e0453ea33e7e2d0dd8680e'
      ) === 'kniftrygghet.no' &&
      enrichBareDomainSourceTitle(
        'kniftrygghet.no — ResourceServlet',
        'https://www.kniftrygghet.no/ResourceServlet/af1f7f4264e0453ea33e7e2d0dd8680e'
      ) === 'kniftrygghet.no',
    'enrichBareDomainSourceTitle decodes UTF-8, skips 1-char/APEX servlet (f?p=..., legosh_en, /pls/apex/f), Episerver /id<digits>/, and *Servlet paths, prefixes domain on 1-word titles ("Sommerskolen" -> "orbrann.no — Sommerskolen", including subdomains), and self-heals polluted titles'
  );
  assert(
    shouldUpgradeSourceTitle(
      'Regelverk med veiledning',
      'Veiledning til forskrift om brannforebygging (§ 11 og § 12) — Direktoratet for samfunnssikkerhet og beredskap'
    ) === true &&
      shouldUpgradeSourceTitle(
        'Veiledning til forskrift om brannforebygging (§ 11 og § 12) — Direktoratet for samfunnssikkerhet og beredskap',
        'Regelverk med veiledning'
      ) === false &&
      shouldUpgradeSourceTitle(
        'orbrann.no — Sommerskolen',
        'Sommerskolen',
        'https://orbrann.no/sommerskolen'
      ) === false,
    'shouldUpgradeSourceTitle upgrades short generic <4-word titles (<32 chars) when candidate is >=2x longer and >=45 chars, and never downgrades domain-prefixed 1-word titles'
  );

  // 2b. Duplicate-URL footnote alias rewriting & orphan footnote healing (cleanGroundingLinks + healOrphanOkfFootnotes)
  const dupAliasRawMd = [
    '---',
    'type: Research Concept',
    'title: "Test Duplicate URL Alias & Orphan Footnote Healing"',
    'status: draft',
    'sources:',
    '  - id: dsb-veiledning-brannforebygging',
    '    title: "Veiledning til forskrift om brannforebygging"',
    '    resource: "https://www.dsb.no/lover/brannvern-brannvesen-nodnett/veiledning-til-forskrift-om-brannforebygging/"',
    '  - id: dsb-veiledning-kap3-4',
    '    title: "Veiledning til forskrift om brannforebygging (§§ 13–15)"',
    '    resource: "https://www.dsb.no/lover/brannvern-brannvesen-nodnett/veiledning-til-forskrift-om-brannforebygging/"',
    '  - id: dsb-faq-brannforebygging',
    '    title: "Ofte stilte spørsmål til forskrift om brannforebygging - DSB"',
    '    resource: "https://www.dsb.no/lover/brannvern-brannvesen-nodnett/artikler/ofte-stilte-sporsmal-til-forskrift-om-brannforebygging/"',
    '  - id: snl-no',
    '    title: "snl.no — Internkontrollforskriften"',
    '    resource: "https://snl.no/internkontrollforskriften"',
    '  - id: regjeringen-no',
    '    title: "regjeringen.no — Id87138"',
    '    resource: "https://www.regjeringen.no/no/dokumenter/brann--og-eksplosjonsvernloven/id87138/"',
    '  - id: kniftrygghet-no',
    '    title: "kniftrygghet.no — ResourceServlet"',
    '    resource: "https://www.kniftrygghet.no/ResourceServlet/af1f7f4264e0453ea33e7e2d0dd8680e"',
    '---',
    '',
    'Eier har ansvar etter veiledningen^[^dsb-veiledning-brannforebygging] og kapittel 3–4:[^dsb-veiledning-kap3-4]',
    'Slokkeutstyr kontrolleres jevnlig.[^dsb-faq-slokkeutstyr] I tråd med internkontroll;[^snl-internkontrollforskriften]',
    'Brannloven[^regjeringen-no]:[^kniftrygghet-no] gjelder også[^hallucinated-nonexistent-999]. Samlet krav:[^dsb-veiledning-brannforebygging];[^regjeringen-no].[^kniftrygghet-no]',
    '',
    '[^dsb-veiledning-brannforebygging]: Veiledning til forskrift om brannforebygging',
    '[^dsb-veiledning-kap3-4]: Veiledning til forskrift om brannforebygging (§§ 13–15) - DSB',
    '[^dsb-faq-slokkeutstyr]: Ofte stilte spørsmål til forskrift om brannforebygging (slokkeutstyr og NS 3910) - DSB',
    '[^snl-internkontrollforskriften]: snl-internkontrollforskriften',
    '[^regjeringen-no]: regjeringen.no — Id87138',
    '[^kniftrygghet-no]: kniftrygghet.no — ResourceServlet',
    '',
  ].join('\n');

  const cleanedDupMd = await cleanGroundingLinks(dupAliasRawMd, [], {
    bundleRoot: './workspace/runs/_selftest_empty_bundle',
  });
  const parsedCleanedDup = parseOkfDocument(cleanedDupMd);
  assert(
    !parsedCleanedDup.body.includes('[^dsb-veiledning-kap3-4]') &&
      !parsedCleanedDup.body.includes('[^dsb-faq-slokkeutstyr]') &&
      !parsedCleanedDup.body.includes('[^snl-internkontrollforskriften]') &&
      !parsedCleanedDup.body.includes('[^hallucinated-nonexistent-999]') &&
      !parsedCleanedDup.body.includes('^[^'),
    `cleanGroundingLinks rewrites duplicate-URL alias and orphan footnotes, strips redundant ^[^id] carets, and strips ungrounded footnotes (got body: "${parsedCleanedDup.body}")`
  );
  assert(
    parsedCleanedDup.body.includes('veiledningen[^dsb-veiledning-brannforebygging]') &&
      parsedCleanedDup.body.includes('kapittel 3–4[^dsb-veiledning-brannforebygging]:') &&
      parsedCleanedDup.body.includes('jevnlig[^dsb-faq-brannforebygging].') &&
      parsedCleanedDup.body.includes('internkontroll[^snl-no];') &&
      parsedCleanedDup.body.includes('Brannloven[^regjeringen-no] [^kniftrygghet-no]:') &&
      parsedCleanedDup.body.includes('Samlet krav[^dsb-veiledning-brannforebygging] [^regjeringen-no] [^kniftrygghet-no].'),
    `cleanGroundingLinks normalizes sentence and clause punctuation ([.?!:;], including 3+ footnote chains) after footnote brackets and maps [^dsb-faq-slokkeutstyr] -> [^dsb-faq-brannforebygging] and [^snl-internkontrollforskriften] -> [^snl-no] (got body: "${parsedCleanedDup.body}")`
  );
  const cleanedDupDefMatches = Array.from(parsedCleanedDup.body.matchAll(/^\[\^([^\]]+)\]:/gm));
  assert(
    Array.isArray(parsedCleanedDup.frontmatter.sources) &&
      parsedCleanedDup.frontmatter.sources.length === 5 &&
      cleanedDupDefMatches.length === 5,
    `cleanGroundingLinks produces exact 1:1 parity between frontmatter sources (5) and footnote definitions (got sources=${parsedCleanedDup.frontmatter.sources?.length}, defs=${cleanedDupDefMatches.length})`
  );

  // Also test healOrphanOkfFootnotes() directly on an already-saved OKF document with 26-style sources and 3 orphan footnotes
  const savedOrphanDoc = parseOkfDocument(
    dupAliasRawMd.replace(
      '  - id: dsb-veiledning-kap3-4\n    title: "Veiledning til forskrift om brannforebygging (§§ 13–15)"\n    resource: "https://www.dsb.no/lover/brannvern-brannvesen-nodnett/veiledning-til-forskrift-om-brannforebygging/"\n',
      ''
    )
  );
  const healedChanged = healOrphanOkfFootnotes(savedOrphanDoc);
  const healedDefMatches = Array.from(savedOrphanDoc.body.matchAll(/^\[\^([^\]]+)\]:/gm));
  const healedRegjeringen = savedOrphanDoc.frontmatter.sources?.find((s) => s.id === 'regjeringen-no');
  const healedKnif = savedOrphanDoc.frontmatter.sources?.find((s) => s.id === 'kniftrygghet-no');
  assert(
    healedChanged === true &&
      healedDefMatches.length === 5 &&
      !savedOrphanDoc.body.includes('[^dsb-veiledning-kap3-4]') &&
      !savedOrphanDoc.body.includes('[^dsb-faq-slokkeutstyr]') &&
      !savedOrphanDoc.body.includes('[^snl-internkontrollforskriften]') &&
      !savedOrphanDoc.body.includes('^[^') &&
      savedOrphanDoc.body.includes('veiledningen[^dsb-veiledning-brannforebygging]') &&
      savedOrphanDoc.body.includes('kapittel 3–4[^dsb-veiledning-brannforebygging]:') &&
      savedOrphanDoc.body.includes('jevnlig[^dsb-faq-brannforebygging].') &&
      savedOrphanDoc.body.includes('internkontroll[^snl-no];') &&
      savedOrphanDoc.body.includes('Brannloven[^regjeringen-no] [^kniftrygghet-no]:') &&
      savedOrphanDoc.body.includes('Samlet krav[^dsb-veiledning-brannforebygging] [^regjeringen-no] [^kniftrygghet-no].') &&
      healedRegjeringen?.title === 'regjeringen.no — Brann og eksplosjonsvernloven' &&
      healedKnif?.title === 'kniftrygghet.no',
    `healOrphanOkfFootnotes self-heals orphan footnotes, strips ^[^id], normalizes [.?!:;] punctuation before footnotes (including 3+ footnote chains), and heals polluted Episerver/Servlet titles (defs=${healedDefMatches.length}, reg="${healedRegjeringen?.title}", knif="${healedKnif?.title}")`
  );

  // Test duplicate-URL title upgrade (bare-domain/short generic title -> rich descriptive title),
  // 1-token `.^alias` typo rewriting before alias cleanup, and trailing empty `## Kildehenvisninger` removal
  const shortTitleAndDotAliasMd = [
    '---',
    'type: Research Concept',
    'title: "Test Duplicate URL Title Upgrade & Dot-Caret Alias"',
    'status: draft',
    'sources:',
    '  - id: dsb-short',
    '    title: "DSB"',
    '    resource: "https://www.dsb.no/brannsikkerhet/veiledning-til-forskrift-om-brannforebygging/"',
    '  - id: dup1',
    '    title: "Veiledning til forskrift om brannforebygging (§§ 13–15) - DSB"',
    '    resource: "https://www.dsb.no/brannsikkerhet/veiledning-til-forskrift-om-brannforebygging/"',
    '---',
    '',
    'Første krav[^dsb-short] og andre krav.^dup1',
    '',
    '---',
    '',
    '## Kildehenvisninger',
    '',
    '[^dsb-short]: DSB',
    '[^dup1]: Veiledning til forskrift om brannforebygging (§§ 13–15) - DSB',
    '',
  ].join('\n');
  const cleanedShortAliasMd = await cleanGroundingLinks(shortTitleAndDotAliasMd, [], {
    bundleRoot: './workspace/runs/_selftest_empty_bundle',
  });
  const parsedShortAlias = parseOkfDocument(cleanedShortAliasMd);
  assert(
    parsedShortAlias.frontmatter.sources?.length === 1 &&
      parsedShortAlias.frontmatter.sources[0]?.id === 'dsb-short' &&
      parsedShortAlias.frontmatter.sources[0]?.title ===
        'Veiledning til forskrift om brannforebygging (§§ 13–15) - DSB' &&
      !parsedShortAlias.body.includes('dup1') &&
      !parsedShortAlias.body.includes('## Kildehenvisninger'),
    `cleanGroundingLinks upgrades short generic duplicate-URL title, rewrites 1-token .^dup1 typo via sourceIdAliases, and strips trailing empty ## Kildehenvisninger (got: "${cleanedShortAliasMd}")`
  );
  assert(
    transliterateNordicAscii('Brannvern i Østfold: æøå ÆØÅ, arbeidsmiljøet og førstehjelp') ===
      'Brannvern i Ostfold: aeoa AeOA, arbeidsmiljoet og forstehjelp' &&
      generateSourceSlugId(
        'Østfold brann — Førstehjelp i arbeidsmiljøet',
        'https://ostfold-brann.no/forebyggende',
        new Set()
      ) === 'ostfold-brann-forstehjelp-i',
    'transliterateNordicAscii transliterates æ/ø/å/Æ/Ø/Å to ae/o/a/Ae/O/A before NFD normalization'
  );
  assert(
    truncateSlugAtWordBoundary(
      'systematisk-brannvern-ansvarsfordeling-og-krav-til-romningsveier-i-naeringsbygg',
      48
    ) === 'systematisk-brannvern-ansvarsfordeling-og-krav' &&
      truncateSlugAtWordBoundary(
        'systematisk-brannvern-ansvarsfordeling-og-krav-til-romningsveier-i-naeringsbygg',
        32
      ) === 'systematisk-brannvern' &&
      truncateSlugAtWordBoundary('brannsikker-bruk-av-elsparkesykkel', 32) ===
        'brannsikker-bruk-av',
    'truncateSlugAtWordBoundary snaps 48-char and 32-char slugs (including 34-char 4-word slugs like brannsikker-bruk-av-elsparkesykkel -> brannsikker-bruk-av) to the last word boundary dash'
  );

  // 3. A2UI v0.9.1 validation, checklist label cleaning, checklist group hierarchy/ordering, totalEstimatedMinutes, synthesized highlights, and CaseSimulator synthesis
  const cleanedChkLabel = cleanChecklistLabel(
    '***Viktig*** **Brannvernleder** skal kontrollere *varme arbeider* (*FOB § 4*), måle 2 * 3 * 4 meter og `internkontroll` [^lovdata-fob]'
  );
  assert(
    cleanedChkLabel ===
      'Viktig Brannvernleder skal kontrollere varme arbeider (FOB § 4), måle 2 * 3 * 4 meter og internkontroll',
    `cleanChecklistLabel strips ***bold-italic***, **bold**, *italic*, \`code\`, and [^id] while preserving "2 * 3 * 4" (got: "${cleanedChkLabel}")`
  );

  const sampleChecklistMd = [
    '### 4.1 Daglig og ukentlig kontroll',
    '- [ ] **Frie rømningsveier**: Kontroller korridorer.',
    '### 4.2 Månedlig og kvartalsvis kontroll',
    '- [ ] **Nødbelysning**: Sjekk grønn LED.',
    '- [ ] **Manuelt slokkeutstyr**:',
    '  - [ ] Kontroller manometer på håndslokkere.',
    '- [ ] **Tekniske rom og tavlerom**: Kontroller at elektro- og ventilasjonsrom ikke brukes som lager.',
    '- [ ] **Beredskapssekk**: Sjekk lommelykt og varmetepper.',
    '### 4.3 Halvårlig og årlig kontroll',
    '- [ ] **Brannøvelse (`FOB § 12`)**:',
    '  - [ ] Er årlig evakueringsøvelse gjennomført?',
    '- [ ] **Tekniske anlegg**:',
    '  - [ ] **Brannalarmanlegg** (`NS 3960`)',
    '    1. [ ] Foreligger årsrapport uten åpne avvik?',
  ].join('\n');
  const chkGroups = extractChecklistGroupsFromMarkdown(sampleChecklistMd);
  assert(
    chkGroups.length === 5 &&
      chkGroups[0].title === 'Daglig og ukentlig kontroll' &&
      chkGroups[1].title === 'Månedlig og kvartalsvis kontroll' &&
      chkGroups[1].items.length === 3 &&
      chkGroups[1].items[0]?.id === 'chk_item_2' &&
      chkGroups[1].items[1]?.id === 'chk_item_4' &&
      chkGroups[1].items[1]?.label.startsWith('Tekniske rom og tavlerom:') &&
      chkGroups[1].items[2]?.id === 'chk_item_5' &&
      chkGroups[1].items[2]?.label.startsWith('Beredskapssekk:') &&
      chkGroups[2].title === 'Månedlig og kvartalsvis kontroll — Manuelt slokkeutstyr' &&
      chkGroups[2].items.length === 1 &&
      chkGroups[2].items[0]?.id === 'chk_item_3' &&
      chkGroups[3].title === 'Halvårlig og årlig kontroll — Brannøvelse (FOB § 12)' &&
      chkGroups[4].title ===
        'Halvårlig og årlig kontroll — Tekniske anlegg — Brannalarmanlegg (NS 3960)' &&
      chkGroups[4].items[0]?.label === 'Foreligger årsrapport uten åpne avvik?',
    `extractChecklistGroupsFromMarkdown reunites post-subgroup top-level bullets into their parent section group without 1-item fragmentation and preserves 3-level hierarchy (got: ${chkGroups.map((g) => `${g.title}[${g.items.length}]`).join(' | ')})`
  );

  const stage2Norm = normalizeStage2ForA2ui(
    {
      courseTitle: 'Testkurs i Brannvern',
      totalEstimatedMinutes: 55,
      executiveSummary: 'Kort sammendrag.',
      trainingModules: [
        {
          moduleNumber: 1,
          moduleTitle: 'Brannvernleders rolle',
          durationMinutes: 15,
          regulatoryBasis: 'FOB § 4–10',
          spokenNarration:
            'Første avsnitt beskriver den konkrete utfordringen i bygget.\n\nAndre avsnitt er lang forelesningstekst.\n\nTredje avsnitt er mer bakgrunn.\n\nFjerde avsnitt oppsummerer.',
          slideCues: ['Kontroller rømningsveier', 'Dokumenter avvik'],
          boardActionItem: 'Vedta årshjul for brannvern og utpek stedfortreder.',
          quizQuestion: 'Hva må eier gjøre dersom leietaker blokkerer rømningsvei?',
          quizOptions: ['Ingenting', 'Stanse bruken eller utbedre umiddelbart', 'Vente til neste år'],
          correctOptionIndex: 1,
          quizExplanation: 'Eier har det overordnede ansvaret etter FOB § 6.',
        },
        {
          moduleNumber: 2,
          moduleTitle: 'Bruksendring i kombinasjonsbygg',
          durationMinutes: 12,
          regulatoryBasis: 'TEK17 § 11-2',
          spokenNarration: 'Kort fortelling.',
          caseScenario: 'Leietaker vil bygge om kontor i 1. etasje til treningssenter for 180 personer.',
          caseResolution: '   ',
          caseSolution: 'Stans ombyggingen og krev revidert brannkonsept for RKL 5.',
          boardActionItem: 'Generisk handlingspunkt for styret.',
          quizQuestion: 'Hvilken brannklasse gjelder for 4 etasjer?',
          quizOptions: ['BKL 1', 'BKL 2'],
          correctOptionIndex: 1,
          quizExplanation: '4 etasjer ligger normalt i BKL 2.',
        },
      ],
    },
    'Fallback'
  );
  assert(stage2Norm.title === 'Testkurs i Brannvern', 'courseTitle extracted as normalized title');
  assert(
    stage2Norm.estimatedDuration === '55 min',
    `totalEstimatedMinutes formatted with " min" unit (got: "${stage2Norm.estimatedDuration}")`
  );
  assert(
    stage2Norm.highlights.length === 2 && stage2Norm.highlights[0].includes('Brannvernleders rolle'),
    'When top-level keyTakeaways is omitted, highlights are synthesized from trainingModules'
  );
  assert(stage2Norm.modules[0]?.durationOrMeta === '15 min', 'Module durationMinutes preserved as durationOrMeta');
  assert(stage2Norm.quiz[0]?.correctValue === '1', 'correctOptionIndex extracted as quiz correctValue');
  assert(stage2Norm.cases.length === 2, 'Extracted 2 cases from trainingModules');
  assert(
    stage2Norm.cases[0].scenario.includes('Første avsnitt beskriver den konkrete utfordringen i bygget.') &&
      stage2Norm.cases[0].scenario.includes(
        'Utfordring / Spørsmål: Hva må eier gjøre dersom leietaker blokkerer rømningsvei?'
      ) &&
      stage2Norm.cases[0].scenario.includes('Sentrale kontrollpunkter'),
    `Synthesized case scenario includes firstPara context + Utfordring/Spørsmål + Sentrale kontrollpunkter (got: "${stage2Norm.cases[0].scenario}")`
  );
  assert(
    !stage2Norm.cases[0].scenario.includes('Andre avsnitt er lang forelesningstekst'),
    'Synthesized case scenario does NOT dump the entire multi-paragraph lecture narration'
  );
  assert(
    stage2Norm.cases[0].recommendedAction.includes('📌 Faglig begrunnelse:'),
    'Synthesized case recommendedAction includes quizExplanation rationale'
  );
  assert(
    stage2Norm.cases[1].scenario ===
      'Leietaker vil bygge om kontor i 1. etasje til treningssenter for 180 personer.' &&
      stage2Norm.cases[1].recommendedAction ===
        'Stans ombyggingen og krev revidert brannkonsept for RKL 5.' &&
      !stage2Norm.cases[1].recommendedAction.includes('📌 Faglig begrunnelse:'),
    'Explicit caseScenario uses non-empty caseSolution fallback and does NOT append unrelated quizExplanation'
  );

  // Verify estimatedDuration minute inference when modules have durationMinutes vs short script in seconds
  const estDur100 = normalizeStage2ForA2ui(
    {
      title: 'Kurs 100 min',
      estimatedDuration: 100,
      trainingModules: [
        { moduleNumber: 1, title: 'M1', durationMinutes: 50 },
        { moduleNumber: 2, title: 'M2', durationMinutes: 50 },
      ],
    },
    'Fallback'
  );
  assert(
    estDur100.estimatedDuration === '100 min',
    `estimatedDuration: 100 with module durationMinutes (totalModMinutes = 100) formats as "100 min" (got: "${estDur100.estimatedDuration}")`
  );

  const estDur105 = normalizeStage2ForA2ui(
    {
      title: 'Kurs 105 min (med intro/outro)',
      estimatedDuration: 105,
      sections: [
        { moduleNumber: 1, title: 'S1', durationMinutes: 50, legalBasis: 'FOB § 4', narration: 'Tekst', keyPoints: ['P1'], practicalTask: 'Oppgave', dilemma: 'Dilemma', recommendedAction: 'Tiltak' },
        { moduleNumber: 2, title: 'S2', durationMinutes: 50, statute: 'FOB § 11', summary: 'Oppsummering', solution: 'Løsning' },
      ],
      overview: 'Kursoversikt',
      checklistGroups: [{ category: 'Daglig kontroll', items: ['Sjekk rømningsveier'] }],
    },
    'Fallback'
  );
  assert(
    estDur105.estimatedDuration === '105 min' &&
      estDur105.scriptBody === 'Kursoversikt' &&
      estDur105.modules.length === 2 &&
      estDur105.modules[0].subtitleOrBasis === 'FOB § 4' &&
      estDur105.modules[0].bullets[0] === 'P1' &&
      estDur105.modules[0].actionItem === 'Oppgave' &&
      estDur105.cases[0].scenario === 'Dilemma' &&
      estDur105.cases[0].recommendedAction === 'Tiltak' &&
      estDur105.checklistGroups.length === 1 &&
      estDur105.checklistGroups[0].title === 'Daglig kontroll',
    `estimatedDuration: 105 with module durationMinutes (totalModMinutes = 100) formats as "105 min" and maps documented Stage 2 A2UI schema keys cleanly (got: "${estDur105.estimatedDuration}")`
  );

  const estDur90s = normalizeStage2ForA2ui(
    {
      title: 'Kort videomanus',
      estimatedDuration: 90,
      scriptBody: 'Kort fortellertekst på 90 sekunder.',
    },
    'Fallback'
  );
  assert(
    estDur90s.estimatedDuration === '90s',
    `estimatedDuration: 90 without module durationMinutes (totalModMinutes = 0) formats as "90s" (got: "${estDur90s.estimatedDuration}")`
  );

  const estDurInvalidFallback = normalizeStage2ForA2ui(
    {
      title: 'Kurs med ugyldig estimatedDuration-streng',
      estimatedDuration: '-10',
      modules: [
        { moduleNumber: 1, title: 'M1', durationMinutes: '50 min', quizQuestion: 'Q1?', quizOptions: ['A', 'B', 'C'], quizCorrectIndex: '2' },
        { moduleNumber: 2, title: 'M2', durationMinutes: 50 },
      ],
    },
    'Fallback'
  );
  const estDurAbcFallback = normalizeStage2ForA2ui(
    {
      title: 'Kurs med ikke-numerisk estimatedDuration',
      estimatedDuration: 'abc',
      modules: [{ moduleNumber: 1, title: 'M1', durationMinutes: 60 }],
    },
    'Fallback'
  );
  const estDurUnitPreserved = normalizeStage2ForA2ui(
    {
      title: 'Kurs med eksplisitt tidsenhet',
      estimatedDuration: '2 timer',
      modules: [{ moduleNumber: 1, title: 'M1', durationMinutes: 60 }],
    },
    'Fallback'
  );
  assert(
    estDurInvalidFallback.estimatedDuration === '100 min' &&
      estDurInvalidFallback.modules[0].durationOrMeta === '50 min' &&
      estDurInvalidFallback.quiz[0].correctValue === '2' &&
      estDurAbcFallback.estimatedDuration === '60 min' &&
      estDurUnitPreserved.estimatedDuration === '2 timer',
    `Invalid/negative estimatedDuration ("-10", "abc") falls back to totalModMinutes while preserving valid unit strings ("2 timer") and string quizCorrectIndex ("2")`
  );

  const validMessages: A2uiEnvelopeMessage[] = [
    {
      version: 'v0.9.1',
      createSurface: {
        surfaceId: 'test_surface',
        catalogId: A2UI_ICM_CATALOG_ID,
      },
    },
    {
      version: 'v0.9.1',
      updateComponents: {
        surfaceId: 'test_surface',
        components: [
          { id: 'root', component: 'Column', children: ['title_txt'] },
          { id: 'title_txt', component: 'Text', text: 'Hei A2UI', variant: 'h1' },
        ],
      },
    },
    {
      version: 'v0.9.1',
      updateDataModel: {
        surfaceId: 'test_surface',
        path: '/',
        value: { okf: { title: 'Test' } },
      },
    },
  ];
  const validationRes = validateA2uiSurfaceMessages(validMessages);
  assert(validationRes.valid === true, `Valid A2UI v0.9.1 messages pass validation (${validationRes.errors.join('; ')})`);

  const invalidRes = validateA2uiSurfaceMessages([
    {
      version: 'v0.9.1',
      updateComponents: {
        surfaceId: 'broken',
        components: [{ id: 'not_root', component: 'Text', text: 'Missing root' }],
      },
    },
  ]);
  assert(invalidRes.valid === false && invalidRes.errors.length > 0, 'Missing root component is rejected by validator');

  // Verify Tier 2 ICM/OKF catalog JSON Schema on disk (`specification/v0_9_1/catalogs/icm-okf-v0.2/catalog.json`) and catalog property validation
  const icmCatalogDiskPath = path.resolve(
    process.cwd(),
    'specification',
    'v0_9_1',
    'catalogs',
    'icm-okf-v0.2',
    'catalog.json'
  );
  const icmCatalogDiskJson = JSON.parse(fs.readFileSync(icmCatalogDiskPath, 'utf-8'));
  const invalidSchemaRes = validateA2uiSurfaceMessages([
    {
      version: 'v0.9.1',
      createSurface: { surfaceId: 'schema_test', catalogId: A2UI_ICM_CATALOG_ID },
    },
    {
      version: 'v0.9.1',
      updateComponents: {
        surfaceId: 'schema_test',
        components: [
          { id: 'root', component: 'Column', children: ['bad_widget', 'missing_prop_chk'] },
          { id: 'bad_widget', component: 'NonExistentWidget' },
          { id: 'missing_prop_chk', component: 'InteractiveChecklist', title: 'Missing groupsPath' },
        ],
      },
    },
  ]);
  assert(
    icmCatalogDiskJson.catalogId === A2UI_ICM_CATALOG_ID &&
      icmCatalogDiskJson.extendsCatalogId === A2UI_BASIC_CATALOG_ID &&
      Boolean(icmCatalogDiskJson.components?.OkfMarkdown) &&
      Boolean(icmCatalogDiskJson.components?.OkfKnowledgeGraph) &&
      Boolean(icmCatalogDiskJson.components?.InteractiveChecklist) &&
      Boolean(icmCatalogDiskJson.components?.ModuleCarousel) &&
      Boolean(icmCatalogDiskJson.components?.QuizRunner) &&
      Boolean(icmCatalogDiskJson.components?.CaseSimulator) &&
      Boolean(icmCatalogDiskJson.components?.Badge) &&
      invalidSchemaRes.valid === false &&
      invalidSchemaRes.errors.some((e) => e.includes('NonExistentWidget')) &&
      invalidSchemaRes.errors.some((e) => e.includes('missing required catalog property "groupsPath"')),
    `specification/v0_9_1/catalogs/icm-okf-v0.2/catalog.json defines all Tier 2 components and validateA2uiSurfaceMessages enforces component types and required schema properties`
  );

  // Verify embedded A2UI_STUDIO_JS and OKF_VIZ_JS have zero JavaScript syntax errors and test their runtime formatting hooks
  let studioJsSyntaxValid = false;
  const studioHooks: Record<string, any> = {};
  const vizHooks: Record<string, any> = {};
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', A2UI_STUDIO_JS)({ __ICM_TEST_HOOKS__: studioHooks });
    // eslint-disable-next-line no-new-func
    new Function('window', OKF_VIZ_JS)({ __ICM_TEST_HOOKS__: vizHooks });
    studioJsSyntaxValid = true;
  } catch (err: any) {
    throw new Error(`[ICM Self-Test FAILED] Embedded JS syntax error: ${err?.message || String(err)}`);
  }
  assert(
    studioJsSyntaxValid &&
      A2UI_STUDIO_JS.includes('okf-md-back-primary-btn') &&
      A2UI_STUDIO_JS.includes('okf-graph-back-btn') &&
      OKF_VIZ_JS.includes('viz-stub-back-btn') &&
      typeof studioHooks.formatInlineLatexAndFootnotes === 'function' &&
      typeof studioHooks.cleanClientChecklistLabel === 'function' &&
      typeof vizHooks.renderMarkdownWithOkfFootnotes === 'function',
    'A2UI_STUDIO_JS and OKF_VIZ_JS parse with zero syntax errors and expose runtime test hooks'
  );

  // Verify compound trailing citation-section headings (## Kilder og fotnoter, ## Referanser og fotnoter, ## Sources and Footnotes, bold headings, trailing ---, etc.)
  assert(
    stripTrailingEmptyCitationSection('Brødtekst her.\n\n---\n\n## Kilder og fotnoter\n') === 'Brødtekst her.' &&
      stripTrailingEmptyCitationSection('Brødtekst her.\n\n## Referanser og fotnoter') === 'Brødtekst her.' &&
      stripTrailingEmptyCitationSection('Brødtekst her.\n\n## Kildehenvisninger og fotnoter') === 'Brødtekst her.' &&
      stripTrailingEmptyCitationSection('Brødtekst her.\n\n### 6. Sources and Footnotes:') === 'Brødtekst her.' &&
      stripTrailingEmptyCitationSection('Brødtekst her.\n\n#### **Kildeliste / fotnoter**\n\n---\n') === 'Brødtekst her.',
    'stripTrailingEmptyCitationSection strips compound Norwegian and English trailing citation/footnote headings (including bolded headings and trailing ---)'
  );

  // Verify LaTeX superscripts/subscripts in cleanChecklistLabel and cleanClientChecklistLabel
  const latexChecklistInput =
    'Kontroller brannceller over $800\\text{ m}^2$, volum $100\\text{ m}^{3}$, temperatur $20^\\circ\\text{C}$, $\\text{H}_2\\text{O}$ og $\\text{CO}_2$-slokkere i sone_2 [^dibk-tek17]';
  const expectedCleanChecklist =
    'Kontroller brannceller over 800 m², volum 100 m³, temperatur 20°C, H₂O og CO₂-slokkere i sone_2';
  const serverCleanedLatexChk = cleanChecklistLabel(latexChecklistInput);
  const clientCleanedLatexChk = studioHooks.cleanClientChecklistLabel(latexChecklistInput);
  assert(
    serverCleanedLatexChk === expectedCleanChecklist &&
      clientCleanedLatexChk === expectedCleanChecklist,
    `cleanChecklistLabel and cleanClientChecklistLabel convert $800\\text{ m}^2$ -> 800 m², $100\\text{ m}^{3}$ -> 100 m³, $20^\\circ\\text{C}$ -> 20°C, $\\text{H}_2\\text{O}$ -> H₂O, and $\\text{CO}_2$ -> CO₂ while preserving sone_2 (got server="${serverCleanedLatexChk}", client="${clientCleanedLatexChk}")`
  );

  // Verify edge-case LaTeX patterns: leading/trailing space inside \text{...}, nested braces inside \text{...}, signed exponents, escaped spaces, and alphabetic subscripts
  const edgeLatexChecklistInput =
    'Kontroller $\\text{ EI 60}$ og $800\\text{ m }$, lekkasje $10^{-3}$, luftveksling $2\\text{ h}^{-1}$, areal $800\\ \\text{m}^2$, temp $20^{\\circ\\text{C}}$, $\\text{areal > 800 m^{2} i bygg}$, utslipp $\\text{NO}_x$ og sone $x_i$';
  const expectedEdgeCleanChecklist =
    'Kontroller EI 60 og 800 m, lekkasje 10⁻³, luftveksling 2 h⁻¹, areal 800 m², temp 20°C, areal > 800 m² i bygg, utslipp NOₓ og sone xᵢ';
  const serverEdgeChk = cleanChecklistLabel(edgeLatexChecklistInput);
  const clientEdgeChk = studioHooks.cleanClientChecklistLabel(edgeLatexChecklistInput);
  assert(
    serverEdgeChk === expectedEdgeCleanChecklist && clientEdgeChk === expectedEdgeCleanChecklist,
    `cleanChecklistLabel and cleanClientChecklistLabel handle leading/trailing spaces inside \\text{...}, nested braces, signed exponents, escaped spaces, and alphabetic subscripts (got server="${serverEdgeChk}", client="${clientEdgeChk}")`
  );

  // Verify formatInlineLatexAndFootnotes (a2ui.html) and renderMarkdownWithOkfFootnotes (viz.html):
  // 1) Strip redundant leading `# <Title>` heading while keeping `## 1. Deloverskrift`
  // 2) Convert inline `$800\text{ m}^2$` -> `800 m²`, `$\text{CO}_2$` -> `CO₂`, `$10^{-3}$` -> `10⁻³`, `$800\ \text{m}^2$` -> `800 m²`, `$\text{NO}_x$` -> `NOₓ` without raw `$` or `<code>`
  // 3) Strip trailing `---\n\n## **Kilder og fotnoter**\n\n---\n\n[^id]: ...`
  const samplePreviewMd = [
    '# Systematisk brannforebyggende arbeid i næringsbygg',
    '',
    'Brannceller over $800\\text{ m}^2$, $800\\ \\text{m}^2$ og $\\text{CO}_2$-slokkere ved el-tavler[^dibk-tek17].',
    '',
    '## 1. Tekniske krav',
    '',
    'Krav til $\\text{H}_2\\text{O}$, $100\\text{ m}^3$, luftveksling $2\\text{ h}^{-1}$, temperatur $20^{\\circ\\text{C}}$, $\\text{areal > 800 m^{2} i bygg}$ og $\\text{NO}_x$.',
    '',
    '---',
    '',
    '## **Kilder og fotnoter**',
    '',
    '---',
    '',
    '[^dibk-tek17]: Byggteknisk forskrift (TEK17)',
  ].join('\n');
  const formattedA2uiPreview = String(studioHooks.formatInlineLatexAndFootnotes(samplePreviewMd, []));
  const renderedVizPreview = String(
    vizHooks.renderMarkdownWithOkfFootnotes(samplePreviewMd, [
      { id: 'dibk-tek17', title: 'Byggteknisk forskrift (TEK17)', resource: 'https://www.dibk.no/tek17' },
    ])
  );
  assert(
    !formattedA2uiPreview.includes('# Systematisk brannforebyggende arbeid') &&
      formattedA2uiPreview.includes('## 1. Tekniske krav') &&
      formattedA2uiPreview.includes('800 m²') &&
      formattedA2uiPreview.includes('CO₂-slokkere') &&
      formattedA2uiPreview.includes('H₂O') &&
      formattedA2uiPreview.includes('100 m³') &&
      formattedA2uiPreview.includes('2 h⁻¹') &&
      formattedA2uiPreview.includes('20°C') &&
      formattedA2uiPreview.includes('areal > 800 m² i bygg') &&
      formattedA2uiPreview.includes('NOₓ') &&
      !formattedA2uiPreview.includes('$800') &&
      !formattedA2uiPreview.includes('<code>') &&
      !formattedA2uiPreview.includes('Kilder og fotnoter'),
    `formatInlineLatexAndFootnotes strips leading H1 and trailing "## **Kilder og fotnoter**" and formats 800 m² / CO₂ / 2 h⁻¹ / 20°C / NOₓ cleanly (got: "${formattedA2uiPreview}")`
  );
  assert(
    !renderedVizPreview.includes('# Systematisk brannforebyggende arbeid') &&
      !renderedVizPreview.includes('Systematisk brannforebyggende arbeid</h1>') &&
      renderedVizPreview.includes('<h2>1. Tekniske krav</h2>') &&
      renderedVizPreview.includes('800 m²') &&
      renderedVizPreview.includes('CO₂-slokkere') &&
      renderedVizPreview.includes('H₂O') &&
      renderedVizPreview.includes('100 m³') &&
      renderedVizPreview.includes('2 h⁻¹') &&
      renderedVizPreview.includes('20°C') &&
      renderedVizPreview.includes('areal &gt; 800 m² i bygg') &&
      renderedVizPreview.includes('NOₓ') &&
      !renderedVizPreview.includes('$800') &&
      !renderedVizPreview.includes('<code>800') &&
      !renderedVizPreview.includes('<code>2') &&
      !renderedVizPreview.includes('<code>NO') &&
      !renderedVizPreview.includes('<code>areal') &&
      !renderedVizPreview.includes('Kilder og fotnoter'),
    `renderMarkdownWithOkfFootnotes strips leading H1 and trailing "## **Kilder og fotnoter**" and formats 800 m² / CO₂ / 2 h⁻¹ / 20°C / NOₓ cleanly (got: "${renderedVizPreview}")`
  );

  // Verify package.json cli* scripts use --env-file-if-exists=.env.local (never bare --env-file=.env.local)
  const pkgJsonPath = path.resolve('./package.json');
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  const cliScriptKeys = ['cli', 'cli:stage1', 'cli:stage2', 'cli:verify', 'cli:viz', 'cli:a2ui'];
  for (const scriptKey of cliScriptKeys) {
    const scriptCmd = String(pkgJson?.scripts?.[scriptKey] || '');
    assert(
      scriptCmd.includes('--env-file-if-exists=.env.local') &&
        !scriptCmd.includes('--env-file=.env.local'),
      `package.json script "${scriptKey}" uses --env-file-if-exists=.env.local instead of bare --env-file=.env.local`
    );
  }

  // Verify loadDotEnvIfExists() precedence (.env.local > .env, existing env preserved, quotes/comments/multi-line/UTF-16LE BOM handled)
  const tmpDotEnvDir = path.resolve(`./workspace/runs/_dotenv_test_${Date.now()}`);
  fs.mkdirSync(tmpDotEnvDir, { recursive: true });
  try {
    fs.writeFileSync(
      path.join(tmpDotEnvDir, '.env.local'),
      [
        '# Comment line',
        'GEMINI_API_KEY="from-dotenv-local" # trailing comment after double quotes',
        'export PRESERVED_KEY="should-not-overwrite"',
        'INLINE_KEY=unquoted-val # inline comment',
        'HASH_INSIDE_QUOTES="val # not a comment" # trailing comment',
        'ESCAPED_QUOTES="hello \\"world\\"" # trailing comment',
        'MULTI_LINE="line 1',
        'line 2" # multi-line comment',
        'EMPTY_OVERRIDE=""',
        'COMMENT_ONLY=# comment at start of unquoted value',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(tmpDotEnvDir, '.env'),
      [
        'GEMINI_API_KEY="from-dotenv-fallback"',
        "FALLBACK_ONLY='single-quoted' # trailing comment after single quotes",
        'EMPTY_OVERRIDE="should-not-override-empty-env-local"',
      ].join('\n'),
      'utf-8'
    );
    const mockEnv: Record<string, string | undefined> = {
      PRESERVED_KEY: 'already-set-in-shell',
    };
    const loadedVars = loadDotEnvIfExists(tmpDotEnvDir, mockEnv);
    assert(
      mockEnv.GEMINI_API_KEY === 'from-dotenv-local' &&
        mockEnv.PRESERVED_KEY === 'already-set-in-shell' &&
        mockEnv.INLINE_KEY === 'unquoted-val' &&
        mockEnv.HASH_INSIDE_QUOTES === 'val # not a comment' &&
        mockEnv.ESCAPED_QUOTES === 'hello "world"' &&
        mockEnv.MULTI_LINE === 'line 1\nline 2' &&
        mockEnv.EMPTY_OVERRIDE === '' &&
        mockEnv.COMMENT_ONLY === '' &&
        mockEnv.FALLBACK_ONLY === 'single-quoted' &&
        loadedVars.GEMINI_API_KEY === 'from-dotenv-local' &&
        loadedVars.PRESERVED_KEY === undefined,
      `loadDotEnvIfExists loads .env.local and .env while preserving existing process.env keys and handling quoted inline comments, escapes, and multi-line values (got: ${JSON.stringify(mockEnv)})`
    );

    // Also test UTF-16LE BOM (Windows PowerShell 5.1 ">" redirection)
    const utf16Content = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('GEMINI_API_KEY="utf16le-key"\r\n', 'utf16le'),
    ]);
    fs.writeFileSync(path.join(tmpDotEnvDir, '.env.local'), utf16Content);
    const mockUtf16Env: Record<string, string | undefined> = {};
    loadDotEnvIfExists(tmpDotEnvDir, mockUtf16Env);
    assert(
      mockUtf16Env.GEMINI_API_KEY === 'utf16le-key',
      `loadDotEnvIfExists decodes UTF-16LE BOM .env.local cleanly (got: "${mockUtf16Env.GEMINI_API_KEY}")`
    );
  } finally {
    fs.rmSync(tmpDotEnvDir, { recursive: true, force: true });
  }

  // Issue 1 Self-Test: Analytical / decision pipeline Stage 2 schema normalization (no quiz fields) + domainMode detection
  const analyticalStage2Payload = {
    reportTitle: 'SpaceX Institutional Equity Valuation',
    verdict: 'Buy / Accumulate',
    readingTimeMinutes: 35,
    investmentThesis: 'Core SOTP valuation thesis driven by Starlink cash flows and Starship cadence.',
    thesisPoints: [
      'Starlink EBITDA inflection exceeds $10B annualized run-rate.',
      'Starship v3 lowers marginal payload cost per kg by >70%.',
    ],
    pillars: [
      {
        pillarNumber: 1,
        pillarTitle: 'Starlink Unit Economics',
        analyticalFramework: 'DCF & Subscriber Cohort Model',
        durationMinutes: 15,
        analysis: 'Detailed analysis of ROIC and terminal bandwidth capacity.',
        keyPoints: ['Residential ARPU stability', 'Aviation & Maritime enterprise attach rate'],
        recommendation: 'Monitor ARPU expansion and Direct-to-Cell spectrum ramp.',
        caseScenario: 'Bear-case LEO congestion cap in high-density cells.',
        mitigation: 'Deploy v3 satellites with 1 Tbps laser backhaul.',
      },
    ],
    stressTests: [
      {
        title: 'Starship FAA Launch Cadence Delay',
        scenario: '12-month environmental review delay at Starbase.',
        recommendedAction: 'Shift commercial manifest to Falcon 9 pads LC-39A and SLC-40.',
        legalRef: 'FAA Part 450',
      },
    ],
  };
  const analyticalNorm = normalizeStage2ForA2ui(analyticalStage2Payload, 'Fallback');
  const detectedAnalyticalMode = detectIcmDomainMode(
    analyticalStage2Payload,
    analyticalNorm.quiz.length,
    `${analyticalNorm.title} ${analyticalNorm.scriptBody}`
  );
  const detectedCourseMode = detectIcmDomainMode(
    { trainingModules: [{ title: 'M1' }] },
    2,
    'Kurs i brannvern og opplæring'
  );
  assert(
    analyticalNorm.title === 'SpaceX Institutional Equity Valuation' &&
      analyticalNorm.targetAudience === 'Buy / Accumulate' &&
      analyticalNorm.estimatedDuration === '35 min' &&
      analyticalNorm.scriptBody.includes('Core SOTP valuation thesis') &&
      analyticalNorm.highlights.length === 2 &&
      analyticalNorm.modules.length === 1 &&
      analyticalNorm.modules[0].title === 'Starlink Unit Economics' &&
      analyticalNorm.modules[0].subtitleOrBasis === 'DCF & Subscriber Cohort Model' &&
      analyticalNorm.modules[0].narration.includes('Detailed analysis of ROIC') &&
      analyticalNorm.modules[0].actionItem.includes('Monitor ARPU expansion') &&
      analyticalNorm.cases.length === 2 &&
      analyticalNorm.cases[0].title === 'Starlink Unit Economics' &&
      analyticalNorm.cases[0].recommendedAction === 'Deploy v3 satellites with 1 Tbps laser backhaul.' &&
      analyticalNorm.cases[1].title === 'Starship FAA Launch Cadence Delay' &&
      analyticalNorm.cases[1].basisOrContext === 'FAA Part 450' &&
      analyticalNorm.quiz.length === 0 &&
      detectedAnalyticalMode === 'analysis' &&
      detectedCourseMode === 'course',
    `normalizeStage2ForA2ui maps analytical/decision schema aliases (including legalRef) cleanly with 0 quizzes and detectIcmDomainMode distinguishes 'analysis' vs 'course'`
  );

  // Issue 2 Self-Test: Guard inline LaTeX $...$ against currency $ pairs ($800.0B ... ~$420.00) and Markdown table pipes (|)
  const currencyChecklistLine =
    'Verify December 2025 tender at $800.0B valuation (~$420.00/sh pre-split) and $150 billion to $180 billion Starlink SOTP [^ebc-valuation-800b-2025]';
  const expectedCurrencyChecklist =
    'Verify December 2025 tender at $800.0B valuation (~$420.00/sh pre-split) and $150 billion to $180 billion Starlink SOTP';
  const serverCurrencyChk = cleanChecklistLabel(currencyChecklistLine);
  const clientCurrencyChk = studioHooks.cleanClientChecklistLabel(currencyChecklistLine);
  assert(
    serverCurrencyChk === expectedCurrencyChecklist &&
      clientCurrencyChk === expectedCurrencyChecklist,
    `cleanChecklistLabel and cleanClientChecklistLabel preserve currency $ figures ($800.0B, ~$420.00/sh, $150 billion to $180 billion) without stripping $ or ~ (got server="${serverCurrencyChk}", client="${clientCurrencyChk}")`
  );

  const mixedCurrencyAndMathLine =
    'At $65.00–$75.00 per share (tier_1 ~$70.00), verify area > $800 m^2$, DCF $\\left(1+r\\right)^{-t}$, and ARPU $\\ge \\$68$/month';
  const expectedMixedChecklist =
    'At $65.00–$75.00 per share (tier_1 ~$70.00), verify area > 800 m², DCF (1+r)⁻ᵗ, and ARPU ≥ $68/month';
  const serverMixedChk = cleanChecklistLabel(mixedCurrencyAndMathLine);
  const clientMixedChk = studioHooks.cleanClientChecklistLabel(mixedCurrencyAndMathLine);
  assert(
    serverMixedChk === expectedMixedChecklist && clientMixedChk === expectedMixedChecklist,
    `cleanChecklistLabel and cleanClientChecklistLabel preserve currency $ earlier on a line while converting valid inline math ($800 m^2$ -> 800 m², $\\left(1+r\\right)^{-t}$ -> (1+r)⁻ᵗ, $\\ge \\$68$ -> ≥ $68) later on the same line (got server="${serverMixedChk}", client="${clientMixedChk}")`
  );

  const currencyTableMd = [
    '# SpaceX Institutional Valuation',
    '',
    '| Transaction Date | Implied Valuation | Share Price | Multiple |',
    '| :--- | :--- | :--- | :--- |',
    '| **Dec 2025 Tender** | **$800.0B**[^ebc-valuation-800b-2025] | ~$420.00 (Pre-Split)[^ebc-valuation-800b-2025] | 31.7x |',
    '| **Starlink SOTP** | $150 billion to $180 billion | $185/sh to $212/sh | $65.00–$75.00 |',
    '',
    'At $65.00 per share, area is $800\\text{ m}^2$ ($800 m^2$), discount factor $\\left(1+r\\right)^{-t}$, and ARPU $\\ge$ $68/month.',
  ].join('\n');
  const formattedTableA2ui = String(studioHooks.formatInlineLatexAndFootnotes(currencyTableMd, []));
  const renderedTableViz = String(
    vizHooks.renderMarkdownWithOkfFootnotes(currencyTableMd, [
      { id: 'ebc-valuation-800b-2025', title: 'SpaceX Tender Offer 2025', resource: 'https://example.com/spacex' },
    ])
  );
  assert(
    formattedTableA2ui.includes('**$800.0B**') &&
      formattedTableA2ui.includes('~$420.00 (Pre-Split)') &&
      formattedTableA2ui.includes('$150 billion to $180 billion') &&
      formattedTableA2ui.includes('$185/sh to $212/sh') &&
      formattedTableA2ui.includes('$65.00–$75.00') &&
      formattedTableA2ui.includes('$65.00 per share') &&
      formattedTableA2ui.includes('800 m² (800 m²)') &&
      formattedTableA2ui.includes('(1+r)⁻ᵗ') &&
      formattedTableA2ui.includes('≥ $68/month') &&
      !formattedTableA2ui.includes('<code>') &&
      renderedTableViz.includes('<table>') &&
      renderedTableViz.includes('<strong>$800.0B</strong>') &&
      renderedTableViz.includes('~$420.00 (Pre-Split)') &&
      renderedTableViz.includes('$150 billion to $180 billion') &&
      renderedTableViz.includes('$185/sh to $212/sh') &&
      renderedTableViz.includes('$65.00–$75.00') &&
      renderedTableViz.includes('800 m² (800 m²)') &&
      renderedTableViz.includes('(1+r)⁻ᵗ') &&
      renderedTableViz.includes('≥ $68/month') &&
      !renderedTableViz.includes('<code>800') &&
      !renderedTableViz.includes('<code>|') &&
      !renderedTableViz.includes('<code>[^'),
    `formatInlineLatexAndFootnotes and renderMarkdownWithOkfFootnotes preserve currency $ and ~$ across Markdown table pipes (|) without injecting <code> while converting valid inline math`
  );

  // Issue 3 & Issue 4 Self-Test: TTS language detection ("for", "SOM", "LOV", "FRA", and mixed-language immunity), English/Analytical vs Norwegian/Course A2UI localization, and Verified Source graph nodes in standalone viz.html
  assert(
    typeof studioHooks.detectSpeechLang === 'function' &&
      studioHooks.detectSpeechLang(
        'The valuation for SpaceX is $800B for institutional investors with strong free cash flow for 2026.'
      ) === 'en-US' &&
      studioHooks.detectSpeechLang(
        'TAM, SAM, and SOM analysis shows SOM reaches $10B under NASA LOV and FRA safety thresholds.'
      ) === 'en-US' &&
      studioHooks.detectSpeechLang(
        'The offshore wind benchmark from Ørsted and Ångström unit economics show strong returns that will compound through 2028.'
      ) === 'en-US' &&
      studioHooks.detectSpeechLang(
        'Styret og brannvernleder har ansvar for systematisk sikkerhetsarbeid i virksomheten.'
      ) === 'nb-NO' &&
      detectIcmLanguage('SpaceX institutional equity valuation for 2026 IPO readiness.') === 'en' &&
      detectIcmLanguage(
        'TAM, SAM, and SOM analysis shows SOM reaches $10B, capturing 15% of SOM under NASA LOV and FRA rules.'
      ) === 'en' &&
      detectIcmLanguage(
        'The valuation for SpaceX and Ørsted is $800B with strong free cash flow that will grow through 2026.'
      ) === 'en' &&
      detectIcmLanguage('Systematisk brannforebyggende arbeid og kontroll i næringsbygg.') === 'no',
    'detectSpeechLang and detectIcmLanguage accurately classify English text containing "for", "SOM"/"LOV"/"FRA" acronyms, or single foreign names as en-US/en and Norwegian text as nb-NO/no'
  );

  const tmpAuditDir = path.resolve(`./workspace/runs/_audit_i18n_viz_test_${Date.now()}`);
  fs.mkdirSync(tmpAuditDir, { recursive: true });
  try {
    const enBundleRoot = path.join(tmpAuditDir, 'bundle');
    const enResearchDir = path.join(enBundleRoot, 'research');
    const enRunId = 'spacex-test-run';
    const enStage1OutDir = path.join(tmpAuditDir, 'runs', enRunId, 'stages', '01_research', 'output');
    const enStage2OutDir = path.join(tmpAuditDir, 'runs', enRunId, 'stages', '02_script', 'output');
    fs.mkdirSync(enResearchDir, { recursive: true });
    fs.mkdirSync(enStage1OutDir, { recursive: true });
    fs.mkdirSync(enStage2OutDir, { recursive: true });

    const enOkfMarkdown = [
      '---',
      'type: Equity Research Report',
      'title: SpaceX Institutional Equity Valuation',
      'description: Institutional sum-of-the-parts valuation for SpaceX.',
      'status: stable',
      'generated:',
      '  model: gemini-4-argon',
      '  timestamp: 2026-11-01T10:00:00Z',
      'verified:',
      '  - by: human:analyst',
      '    timestamp: 2026-11-01T11:00:00Z',
      'stale_after: 2027-11-01T00:00:00Z',
      'links_to:',
      '  - research/starlink-sotp',
      '  - research/starship-economics',
      'sources:',
      '  - id: ebc-valuation-800b-2025',
      '    title: SpaceX Secondary Tender Offer Valuation ($800B)',
      '    url: https://example.com/spacex-800b',
      '    retrieved_at: 2026-11-01T10:00:00Z',
      '  - id: fcc-gen2-starlink',
      '    title: FCC Gen2 Starlink Orbital Modification Order',
      '    url: https://example.com/fcc-gen2',
      '    retrieved_at: 2026-11-01T10:00:00Z',
      '---',
      '# SpaceX Institutional Equity Valuation',
      '',
      'Valuation cleared at **$800.0B** (~$420.00/sh)[^ebc-valuation-800b-2025] with FCC Gen2 authorization[^fcc-gen2-starlink].',
      '',
      'See related concepts [Starlink SOTP](/research/starlink-sotp.md) and [Starship Economics](/research/starship-economics.md).',
      '',
      '## Due Diligence Verification Checklist',
      '- [ ] Verify secondary tender offer valuation at $800.0B (~$420.00/sh)[^ebc-valuation-800b-2025]',
    ].join('\n');

    fs.writeFileSync(path.join(enResearchDir, `${enRunId}.md`), enOkfMarkdown, 'utf-8');
    fs.writeFileSync(path.join(enStage1OutDir, 'research_summary.md'), enOkfMarkdown, 'utf-8');
    fs.writeFileSync(
      path.join(enStage2OutDir, 'script_draft.json'),
      JSON.stringify(analyticalStage2Payload, null, 2),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(tmpAuditDir, 'runs', enRunId, 'meta.json'),
      JSON.stringify({ runId: enRunId, model: GEMINI_4_ARGON_MODEL }, null, 2),
      'utf-8'
    );

    const enVizResult = generateBundleVisualization(enBundleRoot);
    const enVizHtml = fs.readFileSync(enVizResult.outputPath, 'utf-8');
    assert(
      enVizResult.concepts === 1 &&
        enVizResult.nodes === 3 &&
        enVizResult.edges === 2 &&
        enVizHtml.includes('"group":"source"') &&
        enVizHtml.includes('"type":"Verified Source"') &&
        enVizHtml.includes('"color":"#10b981"') &&
        enVizHtml.includes('"label":"cites"') &&
        enVizHtml.includes('viz-source-back-btn'),
      `generateBundleVisualization expands c.sources into Verified Source nodes (#10b981) and cites edges (expected 3 nodes / 2 edges, got ${enVizResult.nodes} nodes / ${enVizResult.edges} edges)`
    );

    const enA2uiResult = generateA2uiSurface({
      workspaceRoot: tmpAuditDir,
      runId: enRunId,
    });
    const fallbackA2uiResult = generateA2uiSurface({
      workspaceRoot: tmpAuditDir,
      runId: 'non-existent-ghost-run-id',
    });
    const enA2uiHtml = fs.readFileSync(enA2uiResult.htmlOutputPath, 'utf-8');
    assert(
      enA2uiResult.quizCount === 0 &&
        enA2uiResult.tabCount === 6 &&
        fallbackA2uiResult.runId === enRunId &&
        fallbackA2uiResult.moduleCount === 1 &&
        !fs.existsSync(path.join(tmpAuditDir, 'runs', 'non-existent-ghost-run-id')) &&
        enA2uiHtml.includes('<html lang="en">') &&
        enA2uiHtml.includes('📋 Executive Summary') &&
        enA2uiHtml.includes('📊 Deep-Dive Pillars (1)') &&
        enA2uiHtml.includes('⚖️ Scenario Simulator (2)') &&
        enA2uiHtml.includes('📚 OKF v0.2 Knowledge Base') &&
        enA2uiHtml.includes('🕸️ OKF Knowledge Graph (5)') &&
        enA2uiHtml.includes('2 verified sources') &&
        enA2uiHtml.includes('Target Audience: Buy / Accumulate') &&
        enA2uiHtml.includes('⬇ Export A2UI State (.json)') &&
        !enA2uiHtml.includes('🧪') &&
        !enA2uiHtml.includes('Oversikt & Sammendrag') &&
        !enA2uiHtml.includes('verifiserte kilder') &&
        !enA2uiHtml.includes('Målgruppe:') &&
        !enA2uiHtml.includes('Eksporter A2UI Tilstand'),
      `generateA2uiSurface renders 100% English analytical UI chrome with 6 tabs (no Quiz tab), 0 leaked Norwegian labels, and falls back to the latest valid run when a non-existent runId is supplied`
    );
  } finally {
    fs.rmSync(tmpAuditDir, { recursive: true, force: true });
  }

  // Fix 1 Self-Test: Deep-clone protection in setJsonPointer and client A2UI setPointer (no reference aliasing)
  const rawInitialModel = {
    modules: { currentIndex: 0, total: 5 },
    checklist: { completedCount: 0, groups: [{ id: 'g1', items: [{ id: 'i1', checked: false }] }] },
  };
  const serverModelRoot: Record<string, unknown> = {};
  setJsonPointer(serverModelRoot, '/', rawInitialModel);
  (serverModelRoot.modules as Record<string, unknown>).currentIndex = 4;
  ((serverModelRoot.checklist as Record<string, unknown>).groups as Array<{ items: Array<{ checked: boolean }> }>)[0].items[0].checked = true;
  assert(
    rawInitialModel.modules.currentIndex === 0 &&
      rawInitialModel.checklist.groups[0].items[0].checked === false,
    'setJsonPointer deep-clones assigned objects so mutating the target dataModel never mutates the source message value'
  );

  const clientModelRoot: Record<string, unknown> = {};
  studioHooks.setPointer(clientModelRoot, '/', rawInitialModel);
  (clientModelRoot.modules as Record<string, unknown>).currentIndex = 3;
  ((clientModelRoot.checklist as Record<string, unknown>).groups as Array<{ items: Array<{ checked: boolean }> }>)[0].items[0].checked = true;
  assert(
    rawInitialModel.modules.currentIndex === 0 &&
      rawInitialModel.checklist.groups[0].items[0].checked === false,
    'A2UI_STUDIO_JS setPointer deep-clones assigned objects so UI interactions never mutate historical messages[2].updateDataModel.value'
  );

  // Fix 2 Self-Test: LaTeX-to-Unicode macro ordering (6\text{ }\mu\text{g} -> 6 μg), acronym ratios ($SC/OC$), leading-digit math ($8,450+\text{ t}$), nested \frac, $$...$$ display math, and word-boundary footnote stripping
  const asteroidLatexChecklist =
    'Verify $6\\text{ }\\mu\\text{g}$ sample, ($a$) = 2.81 AU, $e = 0.5818$, $SC/OC$ = $0.3600$, $\\frac{1}{r^{2}}$ flux, $\\frac{v_{\\text{esc}}}{c}$ ratio, $8,450+\\text{ t}$ mass, $\\Delta v = 4.630\\text{ km/s}$, $\\mathcal{R}$, and $\\text{Ni(CO)}_4 \\xrightleftharpoons[50^\\circ\\text{C}]{180^\\circ\\text{C}} \\text{Ni} + 4\\text{CO}$ across Boulder[^src-1]Armoring and orbital[^src-2]TRL 6 while keeping $62M–$70M and $1,438/oz';
  const expectedAsteroidChecklist =
    'Verify 6 μg sample, (a) = 2.81 AU, e = 0.5818, SC/OC = 0.3600, 1/r² flux, v_esc/c ratio, 8,450+ t mass, Δv = 4.630 km/s, ℛ, and Ni(CO)₄ ⇌ Ni + 4CO across Boulder Armoring and orbital TRL 6 while keeping $62M–$70M and $1,438/oz';
  const serverAsteroidChk = cleanChecklistLabel(asteroidLatexChecklist);
  const clientAsteroidChk = studioHooks.cleanClientChecklistLabel(asteroidLatexChecklist);
  assert(
    serverAsteroidChk === expectedAsteroidChecklist &&
      clientAsteroidChk === expectedAsteroidChecklist,
    `cleanChecklistLabel and cleanClientChecklistLabel convert $6\\text{ }\\mu\\text{g}$ -> 6 μg, $SC/OC$ -> SC/OC, nested \\frac{v_{\\text{esc}}}{c} -> v_esc/c, $8,450+\\text{ t}$ -> 8,450+ t, \\mathcal{R} -> ℛ, \\xrightleftharpoons -> ⇌, and preserve word boundaries around footnotes (got server="${serverAsteroidChk}", client="${clientAsteroidChk}")`
  );

  const displayAndComplexMathMd = [
    '$$NPV_8 = \\sum_{t=1}^{15} \\frac{FCF_t}{(1+r)^t} - CAPEX_0$$',
    '',
    'Sample mass is $6\\text{ }\\mu\\text{g}$, polarization ratio $SC/OC$ = $0.3600$, flux $\\frac{1}{r^{2}}$, escape ratio $\\frac{v_{\\text{esc}}}{c}$, payload $100,000+\\text{ kg}$, reflectance $\\mathcal{R}$, $\\Delta v$, and $NPV_{8,\\text{base}}$ at $62M–$70M ($1,438/oz).',
  ].join('\n');
  const formattedComplexA2ui = String(studioHooks.formatInlineLatexAndFootnotes(displayAndComplexMathMd, []));
  const renderedComplexViz = String(vizHooks.renderMarkdownWithOkfFootnotes(displayAndComplexMathMd, []));
  assert(
    formattedComplexA2ui.includes('6 μg') &&
      formattedComplexA2ui.includes('SC/OC = 0.3600') &&
      formattedComplexA2ui.includes('1/r²') &&
      formattedComplexA2ui.includes('v<sub>esc</sub>/c') &&
      formattedComplexA2ui.includes('100,000+ kg') &&
      formattedComplexA2ui.includes('ℛ') &&
      formattedComplexA2ui.includes('Δv') &&
      formattedComplexA2ui.includes('<sub>8,base</sub>') &&
      formattedComplexA2ui.includes('$62M–$70M ($1,438/oz)') &&
      !formattedComplexA2ui.includes('6\\mug') &&
      !formattedComplexA2ui.includes('<code>') &&
      renderedComplexViz.includes('6 μg') &&
      renderedComplexViz.includes('SC/OC = 0.3600') &&
      renderedComplexViz.includes('1/r²') &&
      renderedComplexViz.includes('v<sub>esc</sub>/c') &&
      renderedComplexViz.includes('100,000+ kg') &&
      renderedComplexViz.includes('ℛ') &&
      renderedComplexViz.includes('Δv') &&
      renderedComplexViz.includes('<sub>8,base</sub>') &&
      renderedComplexViz.includes('$62M–$70M ($1,438/oz)') &&
      !renderedComplexViz.includes('6\\mug') &&
      !renderedComplexViz.includes('<code>'),
    `formatInlineLatexAndFootnotes and renderMarkdownWithOkfFootnotes render $$...$$ display math, nested \\frac{v_{\\text{esc}}}{c}, 6 μg, SC/OC, 100,000+ kg, ℛ, Δv, and multi-char subscripts via <sub> without <code> fallbacks (got A2UI="${formattedComplexA2ui}")`
  );

  // Fix 3 Self-Test: Dual-register TTS normalizer & automatic multi-paragraph splitting for wall-of-text Stage 2 fields
  const ttsSampleEn =
    'NPV_8 of -$1,795.7M at 3.88 ± 0.25 g/cm³, Iₛₚ of 380 s, 6 μg sample, §§ 4–10 and § 12 at -10 °C, and Δv of 4.630 km/s with $10,000/kg cap, $1.77T–$1.98T range, and ~$800.0B valuation.';
  const normalizedTtsEn = String(studioHooks.normalizeTextForTts(ttsSampleEn, 'en-US'));
  const normalizedTtsNo = String(
    studioHooks.normalizeTextForTts(
      '3,88 ± 0,25 g/cm³, Iₛₚ på 380 s, §§ 4–10, TEK17 §§ 11-13 og 11-14 samt § 11-2 ved -10 °C',
      'nb-NO'
    )
  );
  assert(
    normalizedTtsEn.includes('NPV 8 of negative 1,795.7 million dollars') &&
      normalizedTtsEn.includes('3.88 plus or minus 0.25 grams per cubic centimeter') &&
      normalizedTtsEn.includes('specific impulse of 380 s') &&
      normalizedTtsEn.includes('6 micro-g sample') &&
      normalizedTtsEn.includes('sections 4 to 10 and section 12 at minus 10 degrees Celsius') &&
      normalizedTtsEn.includes('delta-v of 4.630 kilometers per second') &&
      normalizedTtsEn.includes('10,000 dollars per kilogram cap') &&
      normalizedTtsEn.includes('1.77 trillion dollars to 1.98 trillion dollars range') &&
      normalizedTtsEn.includes('approximately 800.0 billion dollars valuation') &&
      normalizedTtsNo.includes('3,88 pluss eller minus 0,25 gram per kubikkcentimeter') &&
      normalizedTtsNo.includes('spesifikk impuls på 380 s') &&
      normalizedTtsNo.includes('paragrafene 4 til 10') &&
      normalizedTtsNo.includes('TEK17 paragrafene 11-13 og 11-14') &&
      normalizedTtsNo.includes('paragraf 11-2 ved minus 10 grader celsius'),
    `normalizeTextForTts expands symbolic financial/scientific/legal notation into natural spoken English and Norwegian for Web Speech API (got EN="${normalizedTtsEn}", NO="${normalizedTtsNo}")`
  );

  const wallOfTextThesis = [
    'Sentence one establishes the macro thesis for orbital resource extraction across near-Earth C-type and M-type targets.',
    'Sentence two quantifies the launch cost threshold at $500/kg required for positive net present value.',
    'Sentence three evaluates the astrobiological sample return constraints and cohesive boulder armoring.',
    'Sentence four models the 15-year discounted cash flow trajectory under 25% annual supply shock decay.',
    'Sentence five stress-tests platinum group metal market elasticity and refining capital intensity.',
    'Sentence six concludes with a disciplined capital allocation recommendation for institutional portfolios.',
  ].join(' ');
  const wallNorm = normalizeStage2ForA2ui(
    {
      reportTitle: 'Wall of Text Test',
      visualSummary: wallOfTextThesis,
      spokenScript: 'Spoken narration version without symbols.',
      pillars: [
        {
          pillarNumber: 1,
          pillarTitle: 'Pillar 1',
          analysis: wallOfTextThesis,
          spokenNarration: 'Spoken pillar narration.',
        },
      ],
    },
    'Fallback'
  );
  assert(
    wallNorm.scriptBody.includes('\n\n') &&
      wallNorm.spokenScript === 'Spoken narration version without symbols.' &&
      wallNorm.modules[0].narration.includes('\n\n') &&
      wallNorm.modules[0].spokenNarration === 'Spoken pillar narration.',
    'normalizeStage2ForA2ui automatically splits dense single-paragraph Stage 2 prose (> 420 chars, 5+ sentences) into readable multi-paragraph blocks and preserves separate visualSummary vs spokenScript fields'
  );

  // Fix 4 Self-Test: Low-signal grounding domain filter, HTML <title> extraction (including 302 redirects), and bare-domain source title enrichment
  assert(
    isLowSignalGroundingUrl('https://www.facebook.com/groups/space/posts/12345') &&
      isLowSignalGroundingUrl('https://old.reddit.com/r/SpaceXLounge/comments/abc') &&
      isLowSignalGroundingUrl('https://www.quora.com/What-is-asteroid-mining') &&
      isLowSignalGroundingUrl('https://gradesfixer.com/free-essay-examples/asteroid-mining/') &&
      !isLowSignalGroundingUrl('https://ntrs.nasa.gov/api/citations/20240001/downloads/report.pdf') &&
      !isLowSignalGroundingUrl('https://arxiv.org/pdf/2401.12345.pdf') &&
      !isLowSignalGroundingUrl('https://www.sec.gov/Archives/edgar/data/0001/filing.htm'),
    'isLowSignalGroundingUrl filters social media, forum, and essay-mill domains while preserving institutional, academic, and regulatory sources'
  );

  assert(
    extractHtmlTitleFromSnippet(
      '<html><head><meta property="og:title" content="JPL Small-Body Database &#8212; 1986 DA"><title>Fallback</title></head></html>'
    ) === 'JPL Small-Body Database — 1986 DA' &&
      extractHtmlTitleFromSnippet('<html><head><title>NASA Technical Reports Server - Psyche Mission</title></head></html>') ===
        'NASA Technical Reports Server - Psyche Mission',
    'extractHtmlTitleFromSnippet extracts and decodes og:title and <title> from HTML snippets'
  );

  assert(
    extractHtmlModifiedFromSnippet(
      '<html><head><meta property="article:modified_time" content="2023-11-04T14:22:10+01:00"></head></html>'
    ) === '2023-11-04T13:22:10Z' &&
      extractHtmlModifiedFromSnippet(
        '<html><head><script type="application/ld+json">{"@type":"WebPage","dateModified":"2025-02-18T08:00:00Z"}</script></head></html>'
      ) === '2025-02-18T08:00:00Z' &&
      extractHtmlModifiedFromSnippet(
        '<html><head><meta name="dcterms.issued" content="2019-06-01"></head></html>'
      ) === '2019-06-01T00:00:00Z' &&
      parsePdfDateToIso("D:20170830125340Z00'00'") === '2017-08-30T12:53:40Z' &&
      parsePdfDateToIso("D:20170701120000+02'00'") === '2017-07-01T10:00:00Z' &&
      extractPdfModifiedFromLatin1(
        "%PDF-1.3\n422 0 obj\n(D:20170830125340Z00'00')\nendobj\n1 0 obj\n<< /CreationDate 422 0 R /ModDate 422 0 R >>\nendobj"
      ) === '2017-08-30T12:53:40Z' &&
      extractPdfModifiedFromLatin1(
        '%PDF-1.7\n<x:xmpmeta><rdf:Description><xmp:ModifyDate>2022-09-15T16:45:00+02:00</xmp:ModifyDate></rdf:Description></x:xmpmeta>'
      ) === '2022-09-15T14:45:00Z',
    'extractHtmlModifiedFromSnippet, parsePdfDateToIso, and extractPdfModifiedFromLatin1 parse W3C/OpenGraph/JSON-LD/DublinCore and ISO 32000 direct/indirect PDF + Adobe XMP timestamps'
  );

  const originalFetch = globalThis.fetch;
  try {
    const mockPdfTrailer =
      "\n422 0 obj\n(D:20170830125340Z00'00')\nendobj\n1 0 obj\n<< /CreationDate 422 0 R /ModDate 422 0 R >>\nendobj\n%%EOF";
    const mockPdfBody90k = '%PDF-1.3\n' + 'A'.repeat(90000) + mockPdfTrailer;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const reqUrl = String(input);
      const rangeHdr =
        (init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)
          ? (init.headers as Record<string, string>)['Range'] ||
            (init.headers as Record<string, string>)['range']
          : '') || '';
      if (reqUrl.includes('vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ_pdf206')) {
        return new Response('', {
          status: 302,
          headers: { location: 'https://example.gov/archive/2017_edition_206.pdf' },
        });
      }
      if (reqUrl === 'https://example.gov/archive/2017_edition_206.pdf') {
        const total = mockPdfBody90k.length;
        if (rangeHdr.startsWith('bytes=0-')) {
          return new Response(Buffer.from(mockPdfBody90k.slice(0, 16384), 'latin1'), {
            status: 206,
            headers: {
              'content-type': 'application/pdf',
              'content-range': `bytes 0-16383/${total}`,
            },
          });
        }
        const tailMatch = rangeHdr.match(/^bytes=(\d+)-(\d+)$/);
        if (tailMatch) {
          const s = Number(tailMatch[1]);
          const e = Number(tailMatch[2]) + 1;
          return new Response(Buffer.from(mockPdfBody90k.slice(s, e), 'latin1'), {
            status: 206,
            headers: {
              'content-type': 'application/pdf',
              'content-range': `bytes ${s}-${e - 1}/${total}`,
            },
          });
        }
      }
      if (reqUrl === 'https://example.gov/archive/2017_edition_varnish200.pdf') {
        return new Response(Buffer.from(mockPdfBody90k, 'latin1'), {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(mockPdfBody90k.length),
          },
        });
      }
      if (reqUrl === 'https://example.gov/rules/html_meta_only') {
        return new Response(
          '<html><head><title>Current Regulation &#8211; § 11-12</title><meta property="article:modified_time" content="2026-01-10T09:00:00Z"></head></html>',
          {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }
        );
      }
      if (reqUrl.includes('vertexaisearch.cloud.google.com/grounding-api-redirect/')) {
        return new Response('', {
          status: 302,
          headers: { location: 'https://ntrs.nasa.gov/citations/20240001' },
        });
      }
      return new Response(
        '<html><head><title>NASA Technical Reports Server &#x2014; Psyche Mission</title></head></html>',
        {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'last-modified': 'Wed, 15 May 2024 12:00:00 GMT',
          },
        }
      );
    }) as typeof fetch;
    const redirectResult = await resolveRedirect(
      'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ_mock'
    );
    const pdf206Result = await resolveRedirect(
      'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ_pdf206'
    );
    const pdf200Result = await resolveRedirect(
      'https://example.gov/archive/2017_edition_varnish200.pdf'
    );
    const htmlMetaResult = await resolveRedirect('https://example.gov/rules/html_meta_only');
    assert(
      redirectResult.url === 'https://ntrs.nasa.gov/citations/20240001' &&
        redirectResult.pageTitle === 'NASA Technical Reports Server — Psyche Mission' &&
        redirectResult.lastModified === '2024-05-15T12:00:00Z' &&
        pdf206Result.url === 'https://example.gov/archive/2017_edition_206.pdf' &&
        pdf206Result.lastModified === '2017-08-30T12:53:40Z' &&
        pdf200Result.lastModified === '2017-08-30T12:53:40Z' &&
        htmlMetaResult.pageTitle === 'Current Regulation – § 11-12' &&
        htmlMetaResult.lastModified === '2026-01-10T09:00:00Z',
      `resolveRedirect extracts HTTP Last-Modified, HTML <meta> modified timestamps, and ISO 32000 PDF trailer timestamps across both 206 Range and 200 full-stream responses`
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert(
    enrichBareDomainSourceTitle('arxiv.org', 'https://arxiv.org/pdf/2305.09876.pdf') ===
      'arxiv.org — arXiv:2305.09876' &&
      enrichBareDomainSourceTitle('arxiv.org — 1810.03706V2', 'https://arxiv.org/pdf/1810.03706v2.pdf') ===
        'arxiv.org — arXiv:1810.03706v2' &&
      enrichBareDomainSourceTitle('instagram.com — Dc4kfsNgXId', 'https://www.instagram.com/p/Dc4kfsNgXId/') ===
        'instagram.com' &&
      enrichBareDomainSourceTitle(
        'downloads',
        'https://ntrs.nasa.gov/api/citations/20190002745/downloads/20190002745.pdf'
      ) === 'ntrs.nasa.gov — Citations 20190002745' &&
      enrichBareDomainSourceTitle(
        'scirp.org — paperinformation',
        'https://www.scirp.org/journal/paperinformation?paperid=112233'
      ) === 'scirp.org — Paper 112233',
    'enrichBareDomainSourceTitle enriches bare domain, arXiv ID ("arxiv.org — 1810.03706V2" -> "arxiv.org — arXiv:1810.03706v2"), opaque short-code ("instagram.com — Dc4kfsNgXId" -> "instagram.com"), and path-segment titles ("downloads", "paperinformation")'
  );

  const lowSignalOkfDoc = parseOkfDocument(
    [
      '---',
      'type: Research Report',
      'title: Low Signal Pruning Test',
      'description: Test pruning of auto-generated low-signal sources.',
      'status: draft',
      'generated:',
      '  model: gemini-4-argon',
      '  timestamp: 2026-11-01T10:00:00Z',
      'sources:',
      '  - id: nasa-ntrs-2026',
      '    title: NASA Technical Reports Server (NTRS)',
      '    url: https://ntrs.nasa.gov/citations/20260001',
      '    retrieved_at: 2026-11-01T10:00:00Z',
      '  - id: src-4',
      '    title: facebook.com',
      '    url: https://www.facebook.com/groups/space/posts/999',
      '    retrieved_at: 2026-11-01T10:00:00Z',
      '---',
      'Verified Boulder[^src-4]Armoring and orbital[^nasa-ntrs-2026]TRL 6.',
    ].join('\n')
  );
  const healedLowSignalChanged = healOrphanOkfFootnotes(lowSignalOkfDoc);
  assert(
    healedLowSignalChanged === true &&
      lowSignalOkfDoc.frontmatter.sources?.length === 1 &&
      lowSignalOkfDoc.frontmatter.sources[0].id === 'nasa-ntrs-2026' &&
      lowSignalOkfDoc.body.includes('Boulder Armoring') &&
      !lowSignalOkfDoc.body.includes('[^src-4]') &&
      lowSignalOkfDoc.body.includes('[^nasa-ntrs-2026]'),
    `healOrphanOkfFootnotes prunes auto-generated low-signal sources (src-4 facebook.com) and preserves word boundaries ("Boulder Armoring")`
  );

  // Fixes A–F Self-Test: Multi-Run A2UI Switcher, Cross-Run Source Deduplication, Bidirectional Bundle Links, Relative .md Link Resolution, and HTML Entity / Webflow Hex Prefix Cleaning
  assert(
    decodeHtmlEntities(
      'Forskrift om brannforebygging &sect; 11 &ndash; Brann&oslash;velser i barnehage &aelig;&aring; &#x00F8; &#248;'
    ) === 'Forskrift om brannforebygging § 11 – Brannøvelser i barnehage æå ø ø',
    'decodeHtmlEntities decodes Nordic (&oslash;, &aelig;, &aring;), typographic (&sect;, &ndash;), and hex/decimal numeric HTML entities'
  );

  assert(
    enrichBareDomainSourceTitle(
      'assets.website-files.com',
      'https://assets.website-files.com/61a9b/6a9e9cef4a0a559c1c162d3e_6d.%20Den%20lille%20brannvern%20boka.pdf'
    ) === 'website-files.com — 6d. Den lille brannvern boka' &&
      enrichBareDomainSourceTitle(
        'Brann&oslash;velser &ndash; Sikker Hverdag',
        'https://www.sikkerhverdag.no/brann/brannovelser/'
      ) === 'Brannøvelser – Sikker Hverdag',
    'enrichBareDomainSourceTitle strips 24-hex Webflow CDN ObjectId prefixes while preserving list numbering ("6d. Den lille brannvern boka") and decodes HTML entities in existing titles'
  );

  assert(
    normalizeCanonicalSourceUrl('https://www.lovdata.no/dokument/SF/forskrift/2015-12-17-1710/?utm_source=test#KAPITTEL_3') ===
      'https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710',
    'normalizeCanonicalSourceUrl normalizes protocol, strips www., trailing slashes, hash fragments, and UTM params'
  );

  const tmpMultiRunDir = path.resolve(`./workspace/runs/_multirun_test_${Date.now()}`);
  fs.mkdirSync(tmpMultiRunDir, { recursive: true });
  try {
    const mrBundleDir = path.join(tmpMultiRunDir, 'bundle');
    const mrResearchDir = path.join(mrBundleDir, 'research');
    const mrRunsDir = path.join(tmpMultiRunDir, 'runs');
    fs.mkdirSync(mrResearchDir, { recursive: true });
    fs.mkdirSync(mrRunsDir, { recursive: true });

    const mod1Md = [
      '---',
      'type: Research Concept',
      'title: "Modul 1: Lovverk og ansvar"',
      'description: "Lovkrav for brannvern i barnehager."',
      'status: stable',
      'generated:',
      '  model: gemini-4-argon',
      '  timestamp: 2026-11-01T10:00:00Z',
      'verified:',
      '  - by: human:styrer',
      '    timestamp: 2026-11-01T11:00:00Z',
      'sources:',
      '  - id: lovdata-brannforebygging',
      '    title: "Forskrift om brannforebygging — Lovdata"',
      '    url: https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710',
      '    retrieved_at: 2026-11-01T10:00:00Z',
      '---',
      '# Modul 1: Lovverk og ansvar',
      '',
      'Barnehagen skal ha dokumentert internkontroll [^lovdata-brannforebygging].',
      '',
      '## Sjekkliste Modul 1',
      '- [x] Kontroller lovpålagt dokumentasjon [^lovdata-brannforebygging]',
      '',
      '[^lovdata-brannforebygging]: [Forskrift om brannforebygging — Lovdata](https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710)',
    ].join('\n');

    fs.writeFileSync(path.join(mrResearchDir, 'modul-1-lovverk.md'), mod1Md, 'utf-8');

    // Test Fix C: cleanGroundingLinks reuses canonical source ID & human title from existing bundle
    const cleanedRun2Md = await cleanGroundingLinks(
      [
        '---',
        'type: Research Concept',
        'title: "Modul 2"',
        'description: "Test"',
        'status: draft',
        'sources:',
        '  - id: lovdata-brannforebygging-2015',
        '    title: "lovdata.no"',
        '    url: https://www.lovdata.no/dokument/SF/forskrift/2015-12-17-1710/#KAPITTEL_3',
        '---',
        'Praktiske rutiner bygger på forskriften [^lovdata-brannforebygging-2015].',
      ].join('\n'),
      [],
      {
        generatedAt: '2026-11-01T12:00:00Z',
        workspaceRoot: tmpMultiRunDir,
      }
    );
    const cleanedRun2Doc = parseOkfDocument(cleanedRun2Md);
    assert(
      cleanedRun2Doc.frontmatter.sources?.length === 1 &&
        cleanedRun2Doc.frontmatter.sources[0].id === 'lovdata-brannforebygging' &&
        cleanedRun2Doc.frontmatter.sources[0].title === 'Forskrift om brannforebygging — Lovdata' &&
        cleanedRun2Doc.body.includes('[^lovdata-brannforebygging]') &&
        !cleanedRun2Doc.body.includes('[^lovdata-brannforebygging-2015]'),
      `cleanGroundingLinks reuses existing bundle canonical source ID ("lovdata-brannforebygging") and human title across runs and rewrites body alias footnotes (got ${JSON.stringify(cleanedRun2Doc.frontmatter.sources)})`
    );

    const mod2Md = [
      '---',
      'type: Research Concept',
      'title: "Modul 2: Praktiske brannvernrutiner"',
      'description: "Praktiske sjekklister og øvelser."',
      'status: draft',
      'generated:',
      '  model: gemini-4-argon',
      '  timestamp: 2026-11-01T12:00:00Z',
      'sources:',
      '  - id: lovdata-brannforebygging-2015',
      '    title: "Forskrift om brannforebygging — Lovdata"',
      '    url: https://www.lovdata.no/dokument/SF/forskrift/2015-12-17-1710/',
      '    retrieved_at: 2026-11-01T12:00:00Z',
      '  - id: brannvern-boka',
      '    title: "Brann&oslash;velse &ndash; Veileder"',
      '    url: https://assets.website-files.com/61a/6a9e9cef4a0a559c1c162d3e_6d.%20Den%20lille%20brannvern%20boka.pdf',
      '    retrieved_at: 2026-11-01T12:00:00Z',
      '---',
      '# Modul 2: Praktiske brannvernrutiner',
      '',
      'Dette bygger på [Modul 1: Lovverk og ansvar](/research/modul-1-lovverk.md) [^lovdata-brannforebygging-2015] og veilederen [^brannvern-boka].',
      '',
      '## Sjekkliste Modul 2',
      '- [ ] Gjennomfør månedlig brannøvelse [^brannvern-boka]',
      '- [ ] Sjekk rømningsveier mot snø og is [^lovdata-brannforebygging-2015]',
      '',
      '[^lovdata-brannforebygging-2015]: [Forskrift om brannforebygging — Lovdata](https://www.lovdata.no/dokument/SF/forskrift/2015-12-17-1710/)',
      '[^brannvern-boka]: [Brann&oslash;velse &ndash; Veileder](https://assets.website-files.com/61a/6a9e9cef4a0a559c1c162d3e_6d.%20Den%20lille%20brannvern%20boka.pdf)',
    ].join('\n');

    fs.writeFileSync(path.join(mrResearchDir, 'modul-2-praktiske-rutiner.md'), mod2Md, 'utf-8');

    const run1Id = 'run-modul-1-1776670029755';
    const run2Id = 'run-modul-2-1776677941391';
    const run1Dir = path.join(mrRunsDir, run1Id);
    const run2Dir = path.join(mrRunsDir, run2Id);
    fs.mkdirSync(path.join(run1Dir, 'stages', '01_research', 'output'), { recursive: true });
    fs.mkdirSync(path.join(run1Dir, 'stages', '02_script', 'output'), { recursive: true });
    fs.mkdirSync(path.join(run2Dir, 'stages', '01_research', 'output'), { recursive: true });
    fs.mkdirSync(path.join(run2Dir, 'stages', '02_script', 'output'), { recursive: true });

    fs.writeFileSync(
      path.join(run1Dir, 'meta.json'),
      JSON.stringify({ runId: run1Id, okf: { bundleConceptId: 'research/modul-1-lovverk' } }, null, 2),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(run1Dir, 'stages', '01_research', 'output', 'research_summary.md'),
      mod1Md,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(run1Dir, 'stages', '02_script', 'output', 'script_draft.json'),
      JSON.stringify({
        courseTitle: 'Modul 1: Lovverk og ansvar',
        visualSummary: 'Oversikt for Modul 1.',
        spokenScript: 'Lydmanus for Modul 1.',
        trainingModules: [{ moduleNumber: 1, title: 'Lovkrav', narration: 'Innhold M1', keyPoints: ['P1'] }],
        quiz: [{ question: 'Spørsmål M1?', options: ['A', 'B'], correctIndex: 0, explanation: 'Fordi A.' }],
      }),
      'utf-8'
    );

    fs.writeFileSync(
      path.join(run2Dir, 'meta.json'),
      JSON.stringify({ runId: run2Id, okf: { bundleConceptId: 'research/modul-2-praktiske-rutiner' } }, null, 2),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(run2Dir, 'stages', '01_research', 'output', 'research_summary.md'),
      mod2Md,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(run2Dir, 'stages', '02_script', 'output', 'script_draft.json'),
      JSON.stringify({
        courseTitle: 'Modul 2: Praktiske brannvernrutiner',
        visualSummary: 'Oversikt for Modul 2.',
        spokenScript: 'Lydmanus for Modul 2.',
        trainingModules: [
          { moduleNumber: 1, title: 'Rømningsveier', narration: 'Innhold M2-1', keyPoints: ['P1'] },
          { moduleNumber: 2, title: 'Brannøvelser', narration: 'Innhold M2-2', keyPoints: ['P2'] },
        ],
        quiz: [
          { question: 'Spørsmål M2-1?', options: ['A', 'B'], correctIndex: 0, explanation: 'Fordi A.' },
          { question: 'Spørsmål M2-2?', options: ['A', 'B'], correctIndex: 1, explanation: 'Fordi B.' },
        ],
      }),
      'utf-8'
    );

    // Test Fix D: injectBidirectionalBundleLinks updates both bundle/research/modul-1-lovverk.md and run1's research_summary.md
    const updatedBidirectional = injectBidirectionalBundleLinks(
      tmpMultiRunDir,
      'research/modul-2-praktiske-rutiner'
    );
    const updatedMod1Bundle = fs.readFileSync(path.join(mrResearchDir, 'modul-1-lovverk.md'), 'utf-8');
    const updatedMod1Run = fs.readFileSync(
      path.join(run1Dir, 'stages', '01_research', 'output', 'research_summary.md'),
      'utf-8'
    );
    const relHeadingIdx = updatedMod1Bundle.indexOf('## Relaterte konsepter i kunnskapsbasen');
    const fnDefIdx = updatedMod1Bundle.indexOf('[^lovdata-brannforebygging]:');
    assert(
      updatedBidirectional.some((p) => p.replace(/\\/g, '/').includes('research/modul-1-lovverk')) &&
        updatedMod1Bundle.includes('[Modul 2: Praktiske brannvernrutiner](/research/modul-2-praktiske-rutiner.md)') &&
        updatedMod1Run.includes('[Modul 2: Praktiske brannvernrutiner](/research/modul-2-praktiske-rutiner.md)') &&
        relHeadingIdx !== -1 &&
        fnDefIdx !== -1 &&
        relHeadingIdx < fnDefIdx,
      'injectBidirectionalBundleLinks injects reciprocal concept links before footnote definitions in bundle/research/*.md and syncs them back to workspace/runs/*/stages/01_research/output/research_summary.md'
    );

    // Test Fix B & Fix E: generateBundleVisualization deduplicates shared URL sources into a single hub node and OKF_VIZ_JS resolves relative links
    const mrVizResult = generateBundleVisualization(mrBundleDir);
    const mrVizHtml = fs.readFileSync(mrVizResult.outputPath, 'utf-8');
    assert(
      mrVizResult.nodes === 4 &&
        mrVizResult.edges === 5 &&
        mrVizHtml.includes('[/research/modul-1-lovverk.md](/research/modul-1-lovverk.md)') &&
        mrVizHtml.includes('[/research/modul-2-praktiske-rutiner.md](/research/modul-2-praktiske-rutiner.md)') &&
        mrVizHtml.includes('Brannøvelse – Veileder') &&
        !mrVizHtml.includes('&oslash;'),
      `generateBundleVisualization merges sources sharing the same canonical URL into a single hub node with clickable links to both concepts and decodes HTML entities (expected 4 nodes / 5 edges, got ${mrVizResult.nodes} nodes / ${mrVizResult.edges} edges)`
    );

    assert(
      vizHooks.resolveInternalConceptId('./modul-1-lovverk.md', 'research/modul-2-praktiske-rutiner') ===
        'research/modul-1-lovverk' &&
        vizHooks.resolveInternalConceptId('../research/modul-2-praktiske-rutiner.md', 'research/modul-2-praktiske-rutiner') ===
          'research/modul-2-praktiske-rutiner' &&
        vizHooks.resolveInternalConceptId('https://lovdata.no/test.md', 'research/modul-2-praktiske-rutiner') === null,
      'OKF_VIZ_JS resolveInternalConceptId resolves relative ./ and ../ .md links to canonical concept IDs while ignoring external https://*.md links'
    );

    // Test Fix A: Multi-run A2UI generation, bundleRuns switcher, and OkfMarkdown cross-concept navigation without corrupting active run checklist
    const mrA2uiResult = generateA2uiSurface({
      workspaceRoot: tmpMultiRunDir,
      runId: run2Id,
    });
    const mrA2uiHtml = fs.readFileSync(mrA2uiResult.htmlOutputPath, 'utf-8');
    assert(
      Array.isArray(mrA2uiResult.bundleRuns) &&
        mrA2uiResult.bundleRuns.length === 2 &&
        mrA2uiResult.bundleRuns[0].runId === run1Id &&
        mrA2uiResult.bundleRuns[0].conceptId === 'research/modul-1-lovverk' &&
        mrA2uiResult.bundleRuns[0].status === 'stable' &&
        mrA2uiResult.bundleRuns[0].trustTier === 'human-reviewed' &&
        mrA2uiResult.bundleRuns[0].sourcesCount === 1 &&
        mrA2uiResult.bundleRuns[0].checklistCount === 1 &&
        Boolean(mrA2uiResult.bundleRuns[0].shortLabel) &&
        mrA2uiResult.bundleRuns[1].runId === run2Id &&
        mrA2uiResult.bundleRuns[1].conceptId === 'research/modul-2-praktiske-rutiner' &&
        mrA2uiResult.bundleRuns[1].status === 'draft' &&
        mrA2uiResult.bundleRuns[1].trustTier === 'unverified' &&
        mrA2uiResult.bundleRuns[1].sourcesCount === 2 &&
        mrA2uiResult.bundleRuns[1].checklistCount === 2 &&
        mrA2uiResult.conceptCount === 4 &&
        mrA2uiHtml.includes('a2ui-run-switcher') &&
        mrA2uiHtml.includes('Brannøvelse – Veileder') &&
        !mrA2uiHtml.includes('&oslash;'),
      `generateA2uiSurface embeds chronological bundleRuns with complete A2uiBundleRunEntry metadata for multi-module run switching and deduplicates shared graph source nodes`
    );

    const run1SiblingA2uiPath = path.join(run1Dir, 'a2ui.html');
    const run1SiblingHtml = fs.existsSync(run1SiblingA2uiPath)
      ? fs.readFileSync(run1SiblingA2uiPath, 'utf-8')
      : '';
    assert(
      fs.existsSync(run1SiblingA2uiPath) &&
        run1SiblingHtml.includes('a2ui-run-switcher') &&
        run1SiblingHtml.includes(`"surfaceId":"icm_${run1Id.replace(/[^a-zA-Z0-9_-]/g, '_')}"`),
      'generateA2uiSurface auto-refreshes sibling completed runs a2ui.html files with their own surfaceId and the unified multi-run switcher'
    );

    assert(
      studioHooks.resolveClientConceptId('./modul-1-lovverk.md', 'research/modul-2-praktiske-rutiner') ===
        'research/modul-1-lovverk' &&
        studioHooks.resolveClientConceptId('../research/modul-1-lovverk.md', 'research/modul-2-praktiske-rutiner') ===
          'research/modul-1-lovverk' &&
        studioHooks.resolveClientConceptId('https://lovdata.no/foo.md', 'research/modul-2-praktiske-rutiner') === null,
      'A2UI_STUDIO_JS resolveClientConceptId resolves root and relative .md links while rejecting external URLs'
    );

    // Verify navigateOkfMarkdownConcept updates sources/badges/title, preserves checkbox toggles made while viewing a cross-referenced concept, and switchActiveRun switches runs cleanly
    const payloadMatch = mrA2uiHtml.match(/window\.A2UI_SURFACE_PAYLOAD\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    assert(Boolean(payloadMatch), 'A2UI HTML contains window.A2UI_SURFACE_PAYLOAD JSON');
    const parsedPayload = JSON.parse(payloadMatch![1]);
    const sharedSourceNode = (parsedPayload.bundleGraph?.nodes || []).find(
      (n: any) => n?.data?.id === 'source:lovdata-brannforebygging'
    );
    assert(
      Boolean(sharedSourceNode) &&
        Array.isArray(sharedSourceNode.data.citedByConcepts) &&
        sharedSourceNode.data.citedByConcepts.includes('research/modul-1-lovverk') &&
        sharedSourceNode.data.citedByConcepts.includes('research/modul-2-praktiske-rutiner'),
      'generateA2uiSurface records all citing concepts in citedByConcepts on shared source hub nodes'
    );

    const simDataModel = JSON.parse(JSON.stringify(mrA2uiResult.bundleRuns![1].dataModel));
    const simSurface: Record<string, any> = {
      surfaceId: mrA2uiResult.surfaceId,
      activeRunId: run2Id,
      components: {
        badge_status: { id: 'badge_status', component: 'Badge', tone: 'warn' },
        badge_trust: { id: 'badge_trust', component: 'Badge', tone: 'primary' },
        badge_freshness: { id: 'badge_freshness', component: 'Badge', tone: 'success' },
        main_tabs: {
          id: 'main_tabs',
          component: 'Tabs',
          tabs: [
            { child: 'tab_checklist', title: '✅ Interaktiv Sjekkliste (2)' },
            { child: 'tab_modules', title: '🎓 Moduler (2)' },
            { child: 'tab_quiz', title: '🧪 Quiz (2)' },
          ],
        },
      },
      dataModel: simDataModel,
    };
    const origChecklistCount = simSurface.dataModel.checklist.totalCount;
    const activeHooks: Record<string, any> = {};
    // eslint-disable-next-line no-new-func
    new Function('window', A2UI_STUDIO_JS)({
      A2UI_SURFACE_PAYLOAD: parsedPayload,
      __ICM_TEST_HOOKS__: activeHooks,
    });

    activeHooks.navigateOkfMarkdownConcept(simSurface, 'research/modul-1-lovverk', 'Modul 1');
    assert(
      simSurface.dataModel.okf.activeConceptId === 'research/modul-1-lovverk' &&
        simSurface.dataModel.okf.viewingStubConcept === true &&
        simSurface.dataModel.okf.trustTier === 'human-reviewed' &&
        simSurface.components.badge_status.tone === 'success' &&
        simSurface.components.badge_trust.tone === 'accent' &&
        simSurface.dataModel.okf.sources.length === 1 &&
        simSurface.dataModel.okf.sources[0].id === 'lovdata-brannforebygging' &&
        simSurface.dataModel.checklist.totalCount === origChecklistCount &&
        origChecklistCount === 2,
      `navigateOkfMarkdownConcept updates /okf/title, /okf/sources, /okf/trustTier, and badge tones to the linked concept while preserving the active run checklist (got ${JSON.stringify({ activeCid: simSurface.dataModel.okf.activeConceptId, viewingStub: simSurface.dataModel.okf.viewingStubConcept, trustTier: simSurface.dataModel.okf.trustTier, sources: simSurface.dataModel.okf.sources, origChecklistCount, afterChecklistCount: simSurface.dataModel.checklist.totalCount })})`
    );

    // Toggle a checkbox in Tab 2 while viewing a cross-referenced concept in Tab 6, then return to primaryConceptId
    simSurface.dataModel.checklist.groups[0].items[0].checked = true;
    activeHooks.syncChecklistToOkfBody(simSurface);

    activeHooks.navigateOkfMarkdownConcept(simSurface, 'research/modul-2-praktiske-rutiner');
    assert(
      simSurface.dataModel.okf.activeConceptId === 'research/modul-2-praktiske-rutiner' &&
        simSurface.dataModel.okf.viewingStubConcept === false &&
        simSurface.dataModel.okf.trustTier === 'unverified' &&
        simSurface.components.badge_status.tone === 'warn' &&
        simSurface.components.badge_trust.tone === 'primary' &&
        simSurface.dataModel.okf.sources.length === 2 &&
        simSurface.dataModel.checklist.groups[0].items[0].checked === true,
      `navigateOkfMarkdownConcept restores primary concept sources, badges, and viewingStubConcept=false while preserving checkbox toggles made while viewing a cross-referenced concept`
    );

    // Switch active run from Run 2 to Run 1 and back
    const switchedToRun1 = activeHooks.switchActiveRun(simSurface, run1Id);
    assert(
      switchedToRun1 === true &&
        simSurface.activeRunId === run1Id &&
        simSurface.dataModel.meta.runId === run1Id &&
        simSurface.components.badge_status.tone === 'success' &&
        simSurface.components.badge_trust.tone === 'accent' &&
        simSurface.components.main_tabs.tabs[0].title === '✅ Interaktiv Sjekkliste (1)' &&
        simSurface.components.main_tabs.tabs[1].title === '🎓 Moduler (1)' &&
        simSurface.components.main_tabs.tabs[2].title === '🧪 Quiz (1)',
      'switchActiveRun switches surface state, badge tones, and main_tabs counts to Run 1 while caching Run 2 state'
    );
    const switchedBackToRun2 = activeHooks.switchActiveRun(simSurface, run2Id);
    assert(
      switchedBackToRun2 === true &&
        simSurface.activeRunId === run2Id &&
        simSurface.dataModel.checklist.groups[0].items[0].checked === true &&
        simSurface.components.main_tabs.tabs[0].title === '✅ Interaktiv Sjekkliste (2)',
      'switchActiveRun restores cached Run 2 state including in-session checklist progress'
    );

    // Test Item 4: Navigating to a cross-referenced concept (viewingStubConcept = true) and immediately switching runs resets viewingStubConcept before snapshotting the outgoing run
    activeHooks.navigateOkfMarkdownConcept(simSurface, 'research/modul-1-lovverk', 'Modul 1');
    assert(
      simSurface.viewingStubConcept === true &&
        simSurface.dataModel.okf.viewingStubConcept === true &&
        simSurface.dataModel.okf.activeConceptId === 'research/modul-1-lovverk',
      'Precondition: viewingStubConcept is true on Run 2 before switching runs'
    );
    activeHooks.switchActiveRun(simSurface, run1Id);
    activeHooks.switchActiveRun(simSurface, run2Id);
    assert(
      simSurface.viewingStubConcept === false &&
        simSurface.dataModel.okf.viewingStubConcept === false &&
        simSurface.dataModel.okf.activeConceptId === 'research/modul-2-praktiske-rutiner' &&
        simSurface.dataModel.okf.title === 'Modul 2: Praktiske brannvernrutiner' &&
        simSurface.components.badge_status.tone === 'warn' &&
        simSurface.components.badge_trust.tone === 'primary',
      'switchActiveRun restores the outgoing run primary concept before snapshotting runStates[curRunId] so switching back never leaves the run stuck on a foreign stub concept'
    );
    simSurface.viewingStubConcept = true;
    simSurface.dataModel.okf.viewingStubConcept = false;
    simSurface.dataModel.okf.title = 'Foreign Stub Title';
    simSurface.dataModel.okf.body = 'Foreign Stub Body';
    activeHooks.switchActiveRun(simSurface, run1Id);
    activeHooks.switchActiveRun(simSurface, run2Id);
    assert(
      simSurface.viewingStubConcept === false &&
        simSurface.dataModel.okf.title === 'Modul 2: Praktiske brannvernrutiner',
      'switchActiveRun restores primaryTitle even when only surface.viewingStubConcept is true without overwriting primaryTitle'
    );

    // Test Item 8: Disambiguated --2 source node visual label & URL path slug parenthetical in generateBundleVisualization() and generateA2uiSurface()
    const mod1WithDsb = `${mod1Md.replace(
      'sources:\n',
      [
        'sources:',
        '  - id: dsb-veiledning-brannforebygging',
        '    title: "Veiledning til forskrift om brannforebygging — DSB"',
        '    url: https://www.dsb.no/brannsikkerhet/tema/forskrift-om-brannforebygging/',
        '    retrieved_at: 2026-11-01T10:00:00Z',
      ].join('\n') + '\n'
    )}\nVeiledning [^dsb-veiledning-brannforebygging].\n[^dsb-veiledning-brannforebygging]: Veiledning til forskrift om brannforebygging — DSB\n`;
    const mod2WithDsb = `${mod2Md.replace(
      'sources:\n',
      [
        'sources:',
        '  - id: dsb-veiledning-brannforebygging',
        '    title: "Veiledning til forskrift om brannforebygging — DSB"',
        '    url: https://www.dsb.no/lover/brannvern-brannvesen-nodnett/veiledning-til-forskrift-om-brannforebygging/',
        '    retrieved_at: 2026-11-01T12:00:00Z',
      ].join('\n') + '\n'
    )}\nVeiledning [^dsb-veiledning-brannforebygging].\n[^dsb-veiledning-brannforebygging]: Veiledning til forskrift om brannforebygging — DSB\n`;
    fs.writeFileSync(path.join(mrResearchDir, 'modul-1-lovverk.md'), mod1WithDsb, 'utf-8');
    fs.writeFileSync(path.join(mrResearchDir, 'modul-2-praktiske-rutiner.md'), mod2WithDsb, 'utf-8');
    const disambigViz = generateBundleVisualization(mrBundleDir);
    const disambigVizHtml = fs.readFileSync(disambigViz.outputPath, 'utf-8');
    const disambigA2ui = generateA2uiSurface({ workspaceRoot: tmpMultiRunDir, runId: run2Id });
    const disambigA2uiHtml = fs.readFileSync(disambigA2ui.htmlOutputPath, 'utf-8');
    const disambigA2uiPayloadMatch = disambigA2uiHtml.match(
      /window\.A2UI_SURFACE_PAYLOAD\s*=\s*(\{[\s\S]*?\});\s*<\/script>/
    );
    const disambigA2uiPayload = disambigA2uiPayloadMatch
      ? JSON.parse(disambigA2uiPayloadMatch[1])
      : null;
    const disambigA2uiNode2 = disambigA2uiPayload?.bundleGraph?.nodes?.find(
      (n: any) => n?.data?.id === 'source:dsb-veiledning-brannforebygging--2'
    )?.data;
    assert(
      disambigVizHtml.includes('"id":"source:dsb-veiledning-brannforebygging--2"') &&
        disambigVizHtml.includes('[^dsb-veiledning-brannforebygging--2]') &&
        disambigVizHtml.includes('(veiledning-til-forskrift-om-brannforebygging)') &&
        disambigA2uiNode2 &&
        String(disambigA2uiNode2.label).includes('[^dsb-veiledning-brannforebygging--2]') &&
        String(disambigA2uiNode2.label).includes('(veiledning-til-forskrift-om-brannforebygging)') &&
        String(disambigA2uiNode2.fullTitle).includes('[^dsb-veiledning-brannforebygging--2]') &&
        String(disambigA2uiNode2.fullTitle).includes('(veiledning-til-forskrift-om-brannforebygging)'),
      'generateBundleVisualization and generateA2uiSurface disambiguate --2 source node visual labels (both label and fullTitle) and append the last URL path slug in parentheses when titles match'
    );
  } finally {
    fs.rmSync(tmpMultiRunDir, { recursive: true, force: true });
  }

  // Stage-1 Intermission A2UI Review Mode & Interactive Source Curation Suite Self-Tests
  const tmpStage1ReviewDir = path.resolve(`./workspace/runs/_stage1_curation_test_${Date.now()}`);
  fs.mkdirSync(tmpStage1ReviewDir, { recursive: true });
  try {
    const s1RunId = 'brannvern-stage1-review-1775500000000';
    const s1RunDir = path.join(tmpStage1ReviewDir, 'runs', s1RunId);
    const s1OutDir = path.join(s1RunDir, 'stages', '01_research', 'output');
    const s1BundleDir = path.join(tmpStage1ReviewDir, 'bundle');
    const s1BundleResearchDir = path.join(s1BundleDir, 'research');
    fs.mkdirSync(s1OutDir, { recursive: true });
    fs.mkdirSync(s1BundleResearchDir, { recursive: true });

    const s1InitialMd = [
      '---',
      'type: Research Concept',
      'title: "Brannvern i barnehager — Modul 1"',
      'description: "Stage 1 kunnskapsgrunnlag for brannvern i barnehager."',
      'tags:',
      '  - brannvern',
      '  - barnehage',
      'status: draft',
      'generated:',
      '  at: 2026-11-02T10:00:00Z',
      `  by: model:${GEMINI_4_ARGON_MODEL}`,
      'stale_after: 2027-05-02T00:00:00Z',
      'sources:',
      '  - id: lovdata-internkontroll',
      '    title: "Internkontrollforskriften § 5 — Lovdata"',
      '    url: https://lovdata.no/dokument/SF/forskrift/1996-12-06-1127',
      '    retrieved_at: 2026-11-02T10:00:00Z',
      '  - id: svak-blogg-kilde',
      '    title: "Uoffisiell blogg om brannvern"',
      '    url: https://example.com/blogg/brannvern-tips',
      '    retrieved_at: 2026-11-02T10:00:00Z',
      '---',
      '# Brannvern i barnehager — Modul 1',
      '',
      'Styrer skal dokumentere systematisk HMS-arbeid og brannvern i barnehagen[^lovdata-internkontroll].',
      '',
      'Uverifisert påstand om at brannøvelse kun trengs hvert tredje år[^svak-blogg-kilde].',
      '',
      '## Sjekkliste',
      '- [ ] Gjennomfør risikovurdering for barnehagen[^lovdata-internkontroll]',
      '',
      '[^lovdata-internkontroll]: Internkontrollforskriften § 5 — Lovdata',
      '[^svak-blogg-kilde]: Uoffisiell blogg om brannvern',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(s1OutDir, 'research_summary.md'), s1InitialMd, 'utf-8');
    fs.writeFileSync(
      path.join(s1BundleResearchDir, 'brannvern-i-barnehager-modul-1.md'),
      s1InitialMd,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(s1OutDir, 'thinking_trace.md'),
      [
        '# Stage 1 Thinking & Search Trace',
        '',
        `- **Model:** \`${GEMINI_4_ARGON_MODEL}\``,
        '- **Thinking Level:** `HIGH`',
        '- **Duration:** 14.2s',
        '- **Input Tokens:** 1200',
        '- **Thinking Tokens:** 800',
        '- **Output Tokens:** 950',
        '- **Total Tokens:** 2950',
        '',
        '## Executed Google Search Queries',
        '1. `forskrift om brannforebygging barnehage lovdata`',
        '2. `internkontrollforskriften styrer ansvar barnehage`',
        '',
        '## Reasoning Steps',
        'Verified statutory obligations for kindergarten fire safety.',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(s1RunDir, 'meta.json'),
      JSON.stringify(
        {
          runId: s1RunId,
          topic: 'Brannvern i barnehager — Modul 1',
          model: GEMINI_4_ARGON_MODEL,
          status: 'stage1_completed',
          stage1Telemetry: {
            thinkingLevel: 'HIGH',
            thoughtSteps: 4,
            searchQueries: [
              'forskrift om brannforebygging barnehage lovdata',
              'internkontrollforskriften styrer ansvar barnehage',
            ],
            inputTokens: 1200,
            thoughtsTokens: 800,
            outputTokens: 950,
            totalTokens: 2950,
            durationMs: 14200,
          },
          okf: {
            bundleConceptId: 'research/brannvern-i-barnehager-modul-1',
            trustTier: 'auto',
            isStale: false,
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    // 1. Verify generateA2uiSurface() in Stage-1 Intermission Review Mode (`isStage1Only === true`)
    const s1A2uiRes = generateA2uiSurface({
      workspaceRoot: tmpStage1ReviewDir,
      runId: s1RunId,
    });
    const s1Html = fs.readFileSync(s1A2uiRes.htmlOutputPath, 'utf-8');
    const s1UpdateCompsMsg = s1A2uiRes.messages.find(
      (m): m is A2uiUpdateComponentsMessage => 'updateComponents' in m
    );
    const s1MainTabsComp = s1UpdateCompsMsg?.updateComponents.components.find(
      (c) => c.id === 'main_tabs'
    );
    const s1UpdateDataMsg = s1A2uiRes.messages.find(
      (m): m is A2uiUpdateDataModelMessage => 'updateDataModel' in m
    );
    const s1DataModel = (s1UpdateDataMsg?.updateDataModel.value || {}) as Record<string, any>;
    assert(
      s1A2uiRes.isStage1Only === true &&
        s1A2uiRes.tabCount === 4 &&
        Array.isArray(s1MainTabsComp?.tabs) &&
        s1MainTabsComp!.tabs[0].child === 'tab_okf_markdown' &&
        s1MainTabsComp!.tabs[0].title.includes('(2)') &&
        s1MainTabsComp!.tabs[1].child === 'tab_overview' &&
        s1MainTabsComp!.tabs[1].title.includes('2 søk') &&
        s1MainTabsComp!.tabs[2].child === 'tab_okf_graph' &&
        s1MainTabsComp!.tabs[3].child === 'tab_checklist' &&
        s1A2uiRes.surfaceJsonPath.replace(/\\/g, '/').includes('stages/01_research/output/a2ui_surface.json') &&
        !fs.existsSync(path.join(s1RunDir, 'stages', '02_script', 'output')) &&
        Array.isArray(s1DataModel?.okf?.stage1Trace?.searchQueries) &&
        s1DataModel.okf.stage1Trace.searchQueries.length === 2 &&
        s1Html.includes('okf-curation-banner') &&
        s1Html.includes('toggleRejectSourceInStudio') &&
        s1Html.includes('addSourceInStudio'),
      `generateA2uiSurface in Stage-1 Intermission Review Mode places tab_okf_markdown first, populates stage1Trace, and writes a2ui_surface.json to stages/01_research/output/ without creating stages/02_script/output`
    );

    const s1TraceBody = String(s1DataModel?.stage2?.scriptBody || '');
    assert(
      s1TraceBody.includes('### 📊 Stage 1 Telemetri & Grounding-statistikk') &&
        s1TraceBody.includes('### 🔎 Utførte Google-søk (2)') &&
        !s1TraceBody.includes('- **Total Tokens:**') &&
        !s1TraceBody.includes('## Executed Google Search Queries') &&
        s1TraceBody.includes('## Reasoning Steps'),
      `formatStage1TraceOverviewBody deduplicates top telemetry bullets and Executed Google Search Queries header from thinking_trace.md while preserving ## Reasoning Steps (got: ${JSON.stringify(s1TraceBody)})`
    );

    // 2. Verify A2UI_STUDIO_JS interactive source curation hooks (inspectSourceCitationsInBody, toggleRejectSourceInStudio, addSourceInStudio, buildCurationPrompts)
    const s1PayloadMatch = s1Html.match(
      /window\.A2UI_SURFACE_PAYLOAD\s*=\s*(\{[\s\S]*?\});\s*<\/script>/
    );
    const s1ParsedPayload = s1PayloadMatch ? JSON.parse(s1PayloadMatch[1]) : {};
    const s1Hooks: Record<string, any> = {};
    // eslint-disable-next-line no-new-func
    new Function('window', A2UI_STUDIO_JS)({
      A2UI_SURFACE_PAYLOAD: s1ParsedPayload,
      __ICM_TEST_HOOKS__: s1Hooks,
    });
    const clientChkGroups = s1Hooks.extractChecklistGroupsClient(sampleChecklistMd);
    const chkSyncSim: Record<string, any> = {
      surfaceId: 'chk-sync-test',
      components: {},
      dataModel: {
        okf: { body: sampleChecklistMd, primaryBody: sampleChecklistMd, viewingStubConcept: false },
        checklist: { fromStage2: false, groups: JSON.parse(JSON.stringify(clientChkGroups)) },
      },
    };
    chkSyncSim.dataModel.checklist.groups[1].items[1].checked = true; // chk_item_4 (post-subgroup top-level item)
    s1Hooks.syncChecklistToOkfBody(chkSyncSim);
    assert(
      clientChkGroups.length === 5 &&
        clientChkGroups[1].items.length === 3 &&
        clientChkGroups[1].items[1].id === 'chk_item_4' &&
        chkSyncSim.dataModel.okf.body.includes('- [x] **Tekniske rom og tavlerom**:') &&
        chkSyncSim.dataModel.okf.body.includes('  - [ ] Kontroller manometer på håndslokkere.'),
      `extractChecklistGroupsClient matches server subgroup reunion and syncChecklistToOkfBody maps chk_item_<N> to exact leaf line in okf/body`
    );

    const s1SimSurface: Record<string, any> = {
      surfaceId: s1A2uiRes.surfaceId,
      activeRunId: s1RunId,
      components: {},
      dataModel: JSON.parse(JSON.stringify(s1DataModel)),
    };

    const initialPrompts = s1Hooks.buildCurationPrompts(s1SimSurface);
    assert(
      initialPrompts.agyText.includes('godkjenner alle kildene') &&
        initialPrompts.cliText === `npm run cli:verify -- ${s1RunId} --by human:styrer`,
      `buildCurationPrompts generates clean sign-off prompt when 0 sources are rejected or added (got: ${JSON.stringify(initialPrompts)})`
    );

    const afterReject = s1Hooks.toggleRejectSourceInStudio(s1SimSurface, 'svak-blogg-kilde');
    const rejStats = s1SimSurface.dataModel.okf.sourceCitationStats?.['svak-blogg-kilde'];
    const formattedWithRejected = s1Hooks.formatInlineLatexAndFootnotes(
      s1SimSurface.dataModel.okf.body,
      s1SimSurface.dataModel.okf.sources,
      s1SimSurface.dataModel.okf.rejectedSources
    );
    assert(
      Array.isArray(afterReject) &&
        afterReject.includes('svak-blogg-kilde') &&
        s1SimSurface.dataModel.okf.sourcesBadge === '1 verifiserte kilder' &&
        rejStats &&
        rejStats.mentionCount === 1 &&
        Array.isArray(rejStats.soleClaimLines) &&
        rejStats.soleClaimLines.length === 1 &&
        rejStats.soleClaimLines[0].includes('hvert tredje år') &&
        formattedWithRejected.includes('class="fn-ref fn-rejected"') &&
        String(s1SimSurface.dataModel.okf.curationCliText).includes('--reject-source svak-blogg-kilde'),
      `toggleRejectSourceInStudio marks source rejected, updates active sourcesBadge, computes soleClaimLines, styles inline footnote as fn-rejected, and updates CLI curation command`
    );

    const addedSrcObj = s1Hooks.addSourceInStudio(
      s1SimSurface,
      'https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710',
      'Forskrift om brannforebygging §§ 11–13'
    );
    assert(
      Boolean(addedSrcObj) &&
        addedSrcObj.id.startsWith('forskrift-om-brannforebyggin') &&
        s1SimSurface.dataModel.okf.sources.length === 3 &&
        s1SimSurface.dataModel.okf.addedSources.length === 1 &&
        s1SimSurface.dataModel.okf.sourcesBadge === '2 verifiserte kilder' &&
        String(s1SimSurface.dataModel.okf.body).includes(`[^${addedSrcObj.id}]: Forskrift om brannforebygging §§ 11–13`) &&
        String(s1SimSurface.dataModel.okf.curationAgyText).includes('Avvis kilder: [svak-blogg-kilde].') &&
        String(s1SimSurface.dataModel.okf.curationAgyText).includes('Legg til kilder: [https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710|Forskrift om brannforebygging §§ 11–13].') &&
        String(s1SimSurface.dataModel.okf.curationCliText).includes('--reject-source svak-blogg-kilde') &&
        String(s1SimSurface.dataModel.okf.curationCliText).includes('--add-source "https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710|Forskrift om brannforebygging §§ 11–13"'),
      `addSourceInStudio appends human source to /okf/sources, /okf/addedSources, and /okf/body and generates full AGY + CLI curation commands`
    );

    // 3. Verify curateOkfSources() and verifyOkfConcept() with rejectSourceIds + addSources (3-way footnote parity & auto-refresh of a2ui.html)
    const verifyCuratedRes = verifyOkfConcept(s1RunId, {
      workspaceRoot: tmpStage1ReviewDir,
      by: 'human:styrer',
      rejectSourceIds: ['svak-blogg-kilde'],
      addSources: [
        {
          url: 'https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710',
          title: 'Forskrift om brannforebygging §§ 11–13',
        },
      ],
    });
    const postVerifyRunMd = fs.readFileSync(path.join(s1OutDir, 'research_summary.md'), 'utf-8');
    const postVerifyBundleMd = fs.readFileSync(
      path.join(s1BundleResearchDir, 'brannvern-i-barnehager-modul-1.md'),
      'utf-8'
    );
    const postVerifyDoc = parseOkfDocument(postVerifyRunMd);
    const postVerifySourceIds = (postVerifyDoc.frontmatter.sources || []).map((s) => s.id);
    const postVerifyA2uiHtml = fs.readFileSync(path.join(s1RunDir, 'a2ui.html'), 'utf-8');
    assert(
      verifyCuratedRes.status === 'stable' &&
        verifyCuratedRes.trust_tier === 'human-reviewed' &&
        Array.isArray(verifyCuratedRes.rejectedIds) &&
        verifyCuratedRes.rejectedIds.includes('svak-blogg-kilde') &&
        Array.isArray(verifyCuratedRes.addedSources) &&
        verifyCuratedRes.addedSources.length === 1 &&
        Array.isArray(verifyCuratedRes.orphanClaimLines) &&
        verifyCuratedRes.orphanClaimLines.length === 1 &&
        verifyCuratedRes.orphanClaimLines[0].includes('hvert tredje år') &&
        !postVerifySourceIds.includes('svak-blogg-kilde') &&
        !postVerifyRunMd.includes('svak-blogg-kilde') &&
        !postVerifyBundleMd.includes('svak-blogg-kilde') &&
        postVerifyRunMd.includes('Forskrift om brannforebygging §§ 11–13') &&
        postVerifyBundleMd.includes('Forskrift om brannforebygging §§ 11–13') &&
        postVerifyRunMd.includes(`[^${verifyCuratedRes.addedSources[0].id}]`) &&
        postVerifyRunMd.includes(`[^${verifyCuratedRes.addedSources[0].id}]:`) &&
        postVerifyA2uiHtml.includes('trust: human-reviewed') &&
        !postVerifyA2uiHtml.includes('svak-blogg-kilde'),
      `verifyOkfConcept with rejectSourceIds and addSources enforces 3-way OKF v0.2 footnote parity, reports orphanClaimLines, syncs bundle without re-merging rejected sources, and refreshes a2ui.html`
    );

    // 4. Edge cases: un-reject toggle in Studio, rejecting a human-added source, prefix-overlapping source IDs (lovdata-2 vs lovdata-20), table cells, multi-sentence orphan claims, and duplicate canonical URLs in curateOkfSources
    const afterUnreject = s1Hooks.toggleRejectSourceInStudio(s1SimSurface, 'svak-blogg-kilde');
    assert(
      Array.isArray(afterUnreject) &&
        !afterUnreject.includes('svak-blogg-kilde') &&
        s1SimSurface.dataModel.okf.sourcesBadge === '3 verifiserte kilder' &&
        !String(s1SimSurface.dataModel.okf.curationCliText).includes('--reject-source'),
      `toggleRejectSourceInStudio un-rejects a previously rejected source and restores active source count`
    );

    // Rejecting a human-added source in Studio should cancel its addition rather than emitting both --reject-source and --add-source
    s1Hooks.toggleRejectSourceInStudio(s1SimSurface, addedSrcObj.id);
    assert(
      !String(s1SimSurface.dataModel.okf.curationCliText).includes('--reject-source') &&
        !String(s1SimSurface.dataModel.okf.curationCliText).includes('--add-source'),
      `Rejecting a human-added source in Studio cancels its pending --add-source without emitting a contradictory --reject-source`
    );
    // Un-reject the human-added source and re-reject svak-blogg-kilde for subsequent checks
    s1Hooks.toggleRejectSourceInStudio(s1SimSurface, addedSrcObj.id);
    s1Hooks.toggleRejectSourceInStudio(s1SimSurface, 'svak-blogg-kilde');

    // 5. Execute OkfMarkdown DOM rendering via renderComponent with a lightweight mock document
    const createMockElement = (tag: string): any => {
      const el: any = {
        tagName: String(tag || 'div').toUpperCase(),
        id: '',
        className: '',
        textContent: '',
        innerHTML: '',
        type: '',
        placeholder: '',
        value: '',
        rows: 0,
        style: {},
        attributes: {} as Record<string, string>,
        children: [] as any[],
        listeners: {} as Record<string, Function[]>,
        appendChild(child: any) {
          if (child) this.children.push(child);
          return child;
        },
        setAttribute(k: string, v: string) {
          this.attributes[k] = String(v);
          if (k === 'id') this.id = String(v);
          if (k === 'class') this.className = String(v);
        },
        getAttribute(k: string) {
          return this.attributes[k] || '';
        },
        addEventListener(ev: string, fn: Function) {
          this.listeners[ev] = this.listeners[ev] || [];
          this.listeners[ev].push(fn);
        },
        querySelector() {
          return null;
        },
        querySelectorAll() {
          return [];
        },
      };
      return el;
    };
    const findInMockDom = (root: any, predicate: (node: any) => boolean): any => {
      if (!root) return null;
      if (predicate(root)) return root;
      for (const ch of root.children || []) {
        const found = findInMockDom(ch, predicate);
        if (found) return found;
      }
      return null;
    };
    const prevGlobalDoc = (globalThis as any).document;
    try {
      (globalThis as any).document = {
        createElement: createMockElement,
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      const okfMdComp = s1UpdateCompsMsg?.updateComponents.components.find(
        (c) => c.id === 'tab_okf_markdown'
      );
      s1Hooks.mountSurface(s1SimSurface);
      const renderedOkfDom = s1Hooks.renderComponent(s1SimSurface, okfMdComp);
      const bannerNode = findInMockDom(renderedOkfDom, (n) => n.id === 'okf-curation-banner');
      const agyTextNode = findInMockDom(renderedOkfDom, (n) => n.id === 'okf-curation-agy-text');
      const cliTextNode = findInMockDom(renderedOkfDom, (n) => n.id === 'okf-curation-cli-text');
      const addUrlNode = findInMockDom(renderedOkfDom, (n) => n.id === 'okf-add-source-url');
      const addBtnNode = findInMockDom(renderedOkfDom, (n) => n.id === 'okf-add-source-btn');
      const rejBtnNode = findInMockDom(
        renderedOkfDom,
        (n) => typeof n.className === 'string' && n.className.includes('okf-reject-btn')
      );
      assert(
        Boolean(bannerNode) &&
          Boolean(agyTextNode) &&
          String(agyTextNode.textContent).includes('Avvis kilder: [svak-blogg-kilde]') &&
          Boolean(cliTextNode) &&
          String(cliTextNode.textContent).includes('--reject-source svak-blogg-kilde') &&
          Boolean(addUrlNode) &&
          Boolean(addBtnNode) &&
          Boolean(rejBtnNode),
        `OkfMarkdown renderComponent builds #okf-curation-banner, #okf-curation-agy-text, #okf-curation-cli-text, #okf-add-source-url, and .okf-reject-btn DOM nodes`
      );
    } finally {
      if (prevGlobalDoc === undefined) {
        delete (globalThis as any).document;
      } else {
        (globalThis as any).document = prevGlobalDoc;
      }
    }

    // 6. Verify curateOkfSources with table cells, multi-sentence orphan claims, stacked footnotes, code fences, and lastModified preservation
    const overlapMd = [
      '---',
      'type: Research Concept',
      'title: "Overlap Test"',
      'description: "Prefix overlap test"',
      'status: draft',
      'sources:',
      '  - id: lovdata-2',
      '    title: "Lovdata Kort ID"',
      '    url: https://lovdata.no/kort',
      '    retrieved_at: 2026-11-02T10:00:00Z',
      '  - id: lovdata-20',
      '    title: "Lovdata Lang ID"',
      '    url: https://lovdata.no/lang',
      '    retrieved_at: 2026-11-02T10:00:00Z',
      '---',
      '# Overlap Test',
      '',
      '```markdown',
      'Kodeblokk som ikke skal få fotnote.',
      '```',
      '',
      'Kort påstand[^lovdata-2] og lang påstand[^lovdata-20].',
      '',
      'Første setning er dokumentert[^lovdata-20]. Andre setning hviler kun på kort kilde[^lovdata-2].',
      '',
      '| Krav | Hjemmel |',
      '| --- | --- |',
      '| Internkontroll | [^lovdata-20] |',
      '| Svakt krav | Hjemmel [^lovdata-2] |',
      '',
      '[^lovdata-2]: Lovdata Kort ID',
      '[^lovdata-20]: Lovdata Lang ID',
      '',
    ].join('\n');
    const overlapCurated = curateOkfSources(overlapMd, {
      rejectSourceIds: ['[^lovdata-2]'],
      addSources: [
        // Duplicate canonical URL (differing only by www. and trailing slash) should be deduplicated
        { url: 'https://www.lovdata.no/lang/#section1', title: 'Duplicate Lang' },
        // New source with lastModified (camelCase) and last_modified (snake_case) support
        {
          url: 'https://www.dsb.no/veiledninger/brannvern',
          title: 'DSB Veiledning om brannvern',
          lastModified: '2026-05-01T00:00:00Z',
        },
      ],
    });
    const overlapDoc = parseOkfDocument(overlapCurated.markdown);
    const dsbSrc = (overlapDoc.frontmatter.sources || []).find((s) =>
      String(s.resource || s.url || '').includes('dsb.no')
    );
    assert(
      overlapCurated.rejectedIds.length === 1 &&
        overlapCurated.rejectedIds[0] === 'lovdata-2' &&
        overlapCurated.addedSources.length === 1 &&
        Boolean(dsbSrc) &&
        dsbSrc?.last_modified === '2026-05-01T00:00:00Z' &&
        overlapCurated.orphanClaimLines.some((l) => l.includes('Andre setning hviler kun på kort kilde')) &&
        overlapCurated.orphanClaimLines.some((l) => l.includes('Svakt krav')) &&
        overlapDoc.frontmatter.sources?.length === 2 &&
        !overlapCurated.markdown.includes('[^lovdata-2]') &&
        overlapCurated.markdown.includes('[^lovdata-20]') &&
        overlapCurated.markdown.includes('| Internkontroll | [^lovdata-20] |') &&
        overlapCurated.markdown.includes('| Svakt krav | Hjemmel |') &&
        !overlapCurated.markdown.includes('Kodeblokk som ikke skal få fotnote[^') &&
        overlapCurated.markdown.includes(`Kort påstand og lang påstand[^lovdata-20] [^${dsbSrc?.id}].`),
      `curateOkfSources strips exact rejected footnote [^lovdata-2], preserves table cell spacing, detects sentence-level and table-row orphan claims, skips code fences when weaving citations, and preserves last_modified`
    );

    // 7. Verify multi-run Stage-1-only + completed Stage 1+2 run coexistence, bullet search query fallback parsing, and one-off edit before cli:verify
    const s2RunId = 'brannvern-modul-2-1775500000100';
    const s2RunDir = path.join(tmpStage1ReviewDir, 'runs', s2RunId);
    const s2Stage1Out = path.join(s2RunDir, 'stages', '01_research', 'output');
    const s2Stage2Out = path.join(s2RunDir, 'stages', '02_script', 'output');
    fs.mkdirSync(s2Stage1Out, { recursive: true });
    fs.mkdirSync(s2Stage2Out, { recursive: true });
    fs.writeFileSync(
      path.join(s2Stage1Out, 'research_summary.md'),
      [
        '---',
        'type: Research Concept',
        'title: "Brannvern Modul 2"',
        'description: "Evakueringsrutiner"',
        'status: stable',
        'verified:',
        '  - by: human:styrer',
        '    at: 2026-11-02T11:00:00Z',
        'sources:',
        '  - id: dsb-evakuering',
        '    title: "DSB Evakueringsveileder"',
        '    url: https://www.dsb.no/evakuering',
        '    retrieved_at: 2026-11-02T10:00:00Z',
        '---',
        '# Brannvern Modul 2',
        '',
        'Evakueringsplan skal øves jevnlig[^dsb-evakuering].',
        '',
        '[^dsb-evakuering]: DSB Evakueringsveileder',
        '',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(s2Stage1Out, 'thinking_trace.md'),
      [
        '# Stage 1 Thinking & Search Trace (`brannvern-modul-2`)',
        '',
        '## Executed Google Search Queries',
        '- `dsb evakueringsplan barnehage`',
        '- `brannøvelse barnehage krav`',
        '',
        '## Model Thinking & Reasoning Process',
        'Checked DSB guidance.',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(s2Stage2Out, 'script_draft.json'),
      JSON.stringify(
        {
          title: 'Brannvern Modul 2 — Kurs',
          targetAudience: 'Ansatte i barnehage',
          estimatedDuration: '10 min',
          scriptBody: 'Dette er hovedmanuset for modul 2.',
          highlights: ['Kjenn rømningsveiene', 'Tell barna på møteplass'],
        },
        null,
        2
      ),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(s2RunDir, 'meta.json'),
      JSON.stringify(
        {
          runId: s2RunId,
          topic: 'Brannvern Modul 2',
          model: GEMINI_4_ARGON_MODEL,
          status: 'completed',
          stage1Telemetry: {
            thinkingLevel: 'HIGH',
            thoughtSteps: 2,
            searchQueries: [], // empty in meta.json to test fallback parsing from `- \`...\`` bullets in thinking_trace.md
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    // Re-generate A2UI surface from a Stage-1-only run while a completed Stage 1+2 sibling run exists
    const s1UnverifiedRunId = 'brannvern-modul-3-1775500000200';
    const s1UnverifiedDir = path.join(tmpStage1ReviewDir, 'runs', s1UnverifiedRunId);
    const s1UnverifiedOut = path.join(s1UnverifiedDir, 'stages', '01_research', 'output');
    fs.mkdirSync(s1UnverifiedOut, { recursive: true });
    fs.writeFileSync(path.join(s1UnverifiedOut, 'research_summary.md'), s1InitialMd, 'utf-8');
    fs.writeFileSync(
      path.join(s1BundleResearchDir, 'brannvern-modul-3.md'),
      s1InitialMd,
      'utf-8'
    );
    fs.writeFileSync(
      path.join(s1UnverifiedDir, 'meta.json'),
      JSON.stringify(
        {
          runId: s1UnverifiedRunId,
          topic: 'Brannvern Modul 3',
          model: GEMINI_4_ARGON_MODEL,
          status: 'stage1_completed',
          okf: { bundleConceptId: 'research/brannvern-modul-3' },
        },
        null,
        2
      ),
      'utf-8'
    );

    const multiRunRes = generateA2uiSurface({
      workspaceRoot: tmpStage1ReviewDir,
      runId: s1UnverifiedRunId,
    });
    const s2SiblingHtml = fs.readFileSync(path.join(s2RunDir, 'a2ui.html'), 'utf-8');
    const s2SiblingMatch = s2SiblingHtml.match(
      /window\.A2UI_SURFACE_PAYLOAD\s*=\s*(\{[\s\S]*?\});\s*<\/script>/
    );
    const s2SiblingPayload = s2SiblingMatch ? JSON.parse(s2SiblingMatch[1]) : {};
    const s2SiblingComps =
      s2SiblingPayload.messages?.find((m: any) => 'updateComponents' in m)?.updateComponents
        ?.components || [];
    const s2SiblingTabsComp = s2SiblingComps.find((c: any) => c.id === 'main_tabs');
    const s2SiblingOverviewCol = s2SiblingComps.find((c: any) => c.id === 'overview_narration_col');
    const s2SiblingBundleEntry = (s2SiblingPayload.bundleRuns || []).find(
      (r: any) => r.runId === s2RunId
    );
    assert(
      multiRunRes.isStage1Only === true &&
        s2SiblingTabsComp?.tabs?.[0]?.child === 'tab_overview' &&
        Array.isArray(s2SiblingOverviewCol?.children) &&
        s2SiblingOverviewCol.children.includes('overview_tts_player') &&
        s2SiblingBundleEntry?.dataModel?.okf?.stage1Trace?.searchQueries?.length === 2 &&
        s2SiblingBundleEntry?.dataModel?.stage2?.overviewHeading?.includes('Stage 2'),
      `generateA2uiSurface preserves Stage 2 overview tabs/TTS/heading on completed sibling runs and parses bullet searchQueries from thinking_trace.md`
    );

    // Verify one-off manual edit to research_summary.md before verifyOkfConcept does NOT resurrect rejected source from bundle draft
    const manuallyEditedMd = curateOkfSources(s1InitialMd, {
      rejectSourceIds: ['svak-blogg-kilde'],
    }).markdown.replace(
      'Uverifisert påstand om at brannøvelse kun trengs hvert tredje år.',
      ''
    );
    fs.writeFileSync(path.join(s1UnverifiedOut, 'research_summary.md'), manuallyEditedMd, 'utf-8');
    const verifyAfterManualEdit = verifyOkfConcept(s1UnverifiedRunId, {
      workspaceRoot: tmpStage1ReviewDir,
      by: 'human:styrer',
      rejectSourceIds: ['svak-blogg-kilde'],
    });
    const bundleAfterManualEdit = fs.readFileSync(
      path.join(s1BundleResearchDir, 'brannvern-modul-3.md'),
      'utf-8'
    );
    assert(
      verifyAfterManualEdit.rejectedIds.includes('svak-blogg-kilde') &&
        !bundleAfterManualEdit.includes('svak-blogg-kilde'),
      `verifyOkfConcept overwrites bundle draft without resurrecting sources that were manually edited out of research_summary.md before cli:verify`
    );

    // Verify named verifier replaces default placeholder (`human:styrer`), deduplicates same-day Verification log entry, and populates `/okf/verifierActor`
    const verifyNamedActor = verifyOkfConcept(s1UnverifiedRunId, {
      workspaceRoot: tmpStage1ReviewDir,
      by: 'Cato Paus Skrede',
    });
    const logAfterTwoVerifies = fs.readFileSync(
      path.join(tmpStage1ReviewDir, 'bundle', 'log.md'),
      'utf-8'
    );
    const mod3VerifyLines = logAfterTwoVerifies
      .split(/\r?\n/)
      .filter((l) => l.includes('* **Verification**:') && l.includes('/research/brannvern-modul-3.md'));
    const s1UpdatedHtml = fs.readFileSync(path.join(s1UnverifiedDir, 'a2ui.html'), 'utf-8');
    assert(
      verifyNamedActor.verified.length === 1 &&
        verifyNamedActor.verified[0].by === 'human:Cato Paus Skrede' &&
        mod3VerifyLines.length === 1 &&
        s1UpdatedHtml.includes('okf-verifier-actor-input') &&
        s1UpdatedHtml.includes('human:Cato Paus Skrede') &&
        s1UpdatedHtml.includes('uten å kjøre Stage 2 på nytt'),
      `verifyOkfConcept replaces default placeholder with named human verifier, deduplicates same-day Verification log bullets, and embeds verifier input + stage-aware curation prompt in a2ui.html`
    );

    // Verify curateOkfSources snaps spaces after bold (`**word** [^id]`) and before colons (`[^id] :`) when stripping rejected footnotes
    const boldColonMd = [
      '---',
      'type: Research Concept',
      'title: Bold & Colon Test',
      'status: draft',
      'sources:',
      '  - id: keep-a',
      '    title: Keep A',
      '    resource: https://example.com/a',
      '  - id: rej-b',
      '    title: Reject B',
      '    resource: https://example.com/b',
      '---',
      'Barnehager i **risikoklasse 3**[^rej-b] [^keep-a] må oppfylle følgende krav[^keep-a] [^rej-b]:',
      '',
      '[^keep-a]: Keep A',
      '[^rej-b]: Reject B',
      '',
    ].join('\n');
    const curatedBoldColon = curateOkfSources(boldColonMd, {
      rejectSourceIds: ['rej-b'],
    });
    assert(
      curatedBoldColon.markdown.includes('**risikoklasse 3**[^keep-a] må oppfylle følgende krav[^keep-a]:') &&
        !curatedBoldColon.markdown.includes('**risikoklasse 3** [^keep-a]') &&
        !curatedBoldColon.markdown.includes('[^keep-a] :'),
      `curateOkfSources snaps spaces after bold markers and before colons when stripping adjacent rejected footnotes`
    );

    // Verify comma/semicolon-separated footnote brackets (`[^id1, ^id2]` and `[^id1,[^id2] 4]`) expand to `[^id1][^id2]` and syncA2uiToArtifactDir mirrors artifacts
    const multiFnDoc = parseOkfDocument(
      [
        '---',
        'type: Research Concept',
        'title: Multi Footnote Test',
        'status: draft',
        'sources:',
        '  - id: dibk-tek17-11-1',
        '    title: TEK17 § 11-1',
        '    resource: https://example.com/11-1',
        '  - id: dibk-tek17-11-2',
        '    title: TEK17 § 11-2',
        '    resource: https://example.com/11-2',
        '  - id: dibk-tek17-11-4',
        '    title: TEK17 § 11-4',
        '    resource: https://example.com/11-4',
        '---',
        'Krav til konstruksjon og bæreevne[^dibk-tek17-11-1, ^dibk-tek17-11-2] samt brannmotstand[^dibk-tek17-11-1,[^dibk-tek17-11-1] 4] gjelder for barnehager.',
        '',
      ].join('\n')
    );
    const multiFnHealed = healOrphanOkfFootnotes(multiFnDoc);
    assert(
      multiFnHealed &&
        multiFnDoc.body.includes('bæreevne[^dibk-tek17-11-1] [^dibk-tek17-11-2]') &&
        multiFnDoc.body.includes('brannmotstand[^dibk-tek17-11-1] [^dibk-tek17-11-4]'),
      `healOrphanOkfFootnotes expands comma-separated [^id1, ^id2] and woven [^id1,[^id1] 4] into separate [^id1] [^id2] footnotes`
    );

    const tmpArtifactDir = path.join(tmpStage1ReviewDir, 'agy_brain_artifacts');
    const syncedArtifacts = generateA2uiSurface(s1UnverifiedRunId, {
      workspaceRoot: tmpStage1ReviewDir,
      artifactDir: tmpArtifactDir,
      enablePingPong: true,
    });
    const htmlWithPingPong = fs.readFileSync(syncedArtifacts.htmlOutputPath, 'utf-8');
    const surfaceWithoutPingPong = generateA2uiSurface(s1UnverifiedRunId, {
      workspaceRoot: tmpStage1ReviewDir,
      enablePingPong: false,
    });
    const htmlWithoutPingPong = fs.readFileSync(surfaceWithoutPingPong.htmlOutputPath, 'utf-8');
    assert(
      Boolean(syncedArtifacts.artifactHtmlPath && fs.existsSync(syncedArtifacts.artifactHtmlPath)) &&
        fs.existsSync(`${syncedArtifacts.artifactHtmlPath}.metadata.json`) &&
        Boolean(syncedArtifacts.artifactVizPath && fs.existsSync(syncedArtifacts.artifactVizPath)) &&
        fs.existsSync(`${syncedArtifacts.artifactVizPath}.metadata.json`) &&
        /"canPingPong":\s*true/.test(htmlWithPingPong) &&
        htmlWithPingPong.includes('okf-pingpong-agy-btn') &&
        /"canPingPong":\s*false/.test(htmlWithoutPingPong),
      `generateA2uiSurface with artifactDir copies a2ui_studio.html + okf_viz_studio.html, writes .metadata.json descriptors, and gates canPingPong on Antigravity 2.0 /browser capability`
    );

    const emptyHomeDir = path.join(tmpStage1ReviewDir, 'empty_home');
    fs.mkdirSync(emptyHomeDir, { recursive: true });
    const mockAgyHomeDir = path.join(tmpStage1ReviewDir, 'mock_agy_home');
    fs.mkdirSync(path.join(mockAgyHomeDir, '.gemini', 'antigravity', 'brain'), { recursive: true });
    fs.mkdirSync(path.join(mockAgyHomeDir, '.gemini', 'antigravity', 'browser_recordings'), {
      recursive: true,
    });
    assert(
      hasAntigravityBrowserCapability({ homeDir: emptyHomeDir }) === false &&
        hasAntigravityBrowserCapability({ homeDir: mockAgyHomeDir }) === true,
      `hasAntigravityBrowserCapability returns true only when Antigravity 2.0 and /browser capabilities are installed`
    );

    // Verify run-root mirror of `a2ui_surface.json` and `a2ui_surface.jsonl` alongside `a2ui.html`
    assert(
      fs.existsSync(path.join(s1UnverifiedDir, 'a2ui_surface.json')) &&
        fs.existsSync(path.join(s1UnverifiedDir, 'a2ui_surface.jsonl')) &&
        fs.existsSync(syncedArtifacts.surfaceJsonPath),
      `generateA2uiSurface writes a2ui_surface.json and a2ui_surface.jsonl at both stages/<stage>/output/ and workspace/runs/<runId>/`
    );

    // Verify domain-neutral `inspectSourceDomainProvenance` & `inspectClientSourceDomainProvenance` across Norwegian, US, and umbrella domains
    const provMirrorPdf = inspectSourceDomainProvenance({
      id: 'barnehageloven-lovdata',
      title: 'Lov om barnehager (barnehageloven) – Lovdata',
      resource: 'https://dyrebo.barnehage.no/Getfile.aspx/123/Lov_om_barnehager.pdf',
    });
    const provS3Bucket = inspectSourceDomainProvenance({
      id: 'forskrift-brannforebygging',
      title: 'Forskrift om brannforebygging – Lovdata',
      resource: 'https://secure.styret.com/s3assets-public/show/67781',
    });
    const provScribdSec = inspectSourceDomainProvenance({
      id: 'form-10k-sec',
      title: 'Annual Form 10-K – SEC',
      resource: 'https://www.scribd.com/document/999/form-10k.pdf',
    });
    const provRealLovdata = inspectSourceDomainProvenance({
      id: 'lovdata-brann',
      title: 'Forskrift om brannforebygging – Lovdata',
      resource: 'https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710',
    });
    const provDsbAcronym = inspectSourceDomainProvenance({
      id: 'dsb-veiledning',
      title: 'Veiledning om brannvern – Direktoratet for samfunnssikkerhet og beredskap (DSB)',
      resource: 'https://www.dsb.no/lover/brannvern/',
    });
    const provUdirAbbrev = inspectSourceDomainProvenance({
      id: 'udir-beredskap',
      title: 'Beredskap i barnehagen – Utdanningsdirektoratet',
      resource: 'https://www.udir.no/sikkerhet-og-beredskap/',
    });
    const provRegjeringenUmbrella = inspectSourceDomainProvenance({
      id: 'kd-veileder',
      title: 'Sikkerhet i barnehager – Kunnskapsdepartementet',
      resource: 'https://www.regjeringen.no/no/dokumenter/id12345/',
    });
    const provRealSecGov = inspectSourceDomainProvenance({
      id: 'sec-10k',
      title: 'Form 10-K – U.S. Securities and Exchange Commission',
      resource: 'https://www.sec.gov/ix?doc=/Archives/edgar/data/10k.htm',
    });
    const provGenericSubtitle = inspectSourceDomainProvenance({
      id: 'brannvern-guide',
      title: 'Brannvern i barnehagen – Praktisk veiledning',
      resource: 'https://brannvernforeningen.no/barnehage',
    });
    const provHostPrefixedTitle = inspectSourceDomainProvenance({
      id: 'dibk-no',
      title: 'dibk.no – Byggteknisk forskrift tek17',
      resource: 'https://dibk.no/regelverk/byggteknisk-forskrift-tek17/',
    });
    const provDibkSyllabic = inspectSourceDomainProvenance({
      id: 'dibk-tek17-11-2',
      title: 'Byggteknisk forskrift (TEK17) § 11-2 Risikoklasser - Direktoratet for byggkvalitet',
      resource: 'https://www.dibk.no/regelverk/byggteknisk-forskrift-tek17/11/i/11-2',
    });
    const provDigdirCompound = inspectSourceDomainProvenance({
      id: 'digdir-veileder',
      title: 'Innebygd personvern - Digitaliseringsdirektoratet',
      resource: 'https://www.digdir.no/informasjonssikkerhet/innebygd-personvern/123',
    });
    const clientProvMirror = s1Hooks.inspectClientSourceDomainProvenance({
      id: 'barnehageloven-lovdata',
      title: 'Lov om barnehager (barnehageloven) – Lovdata (via dyrebo.barnehage.no)',
      url: 'https://dyrebo.barnehage.no/Getfile.aspx/123/Lov_om_barnehager.pdf',
    });
    const clientProvUdir = s1Hooks.inspectClientSourceDomainProvenance({
      id: 'udir-beredskap',
      title: 'Beredskap i barnehagen – Utdanningsdirektoratet',
      url: 'https://www.udir.no/sikkerhet-og-beredskap/',
    });
    const clientProvDibk = s1Hooks.inspectClientSourceDomainProvenance({
      id: 'dibk-tek17-11-2',
      title: 'Byggteknisk forskrift (TEK17) § 11-2 Risikoklasser - Direktoratet for byggkvalitet',
      url: 'https://www.dibk.no/regelverk/byggteknisk-forskrift-tek17/11/i/11-2',
    });
    assert(
      provMirrorPdf.domainMismatch === true &&
        provMirrorPdf.hostname === 'dyrebo.barnehage.no' &&
        provMirrorPdf.isDirectFileAsset === true &&
        provMirrorPdf.claimedPublisher === 'Lovdata' &&
        provS3Bucket.domainMismatch === true &&
        provS3Bucket.hostname === 'secure.styret.com' &&
        provScribdSec.domainMismatch === true &&
        provRealLovdata.domainMismatch === false &&
        provDsbAcronym.domainMismatch === false &&
        provUdirAbbrev.domainMismatch === false &&
        provRegjeringenUmbrella.domainMismatch === false &&
        provRealSecGov.domainMismatch === false &&
        provGenericSubtitle.domainMismatch === false &&
        provHostPrefixedTitle.domainMismatch === false &&
        provDibkSyllabic.domainMismatch === false &&
        provDigdirCompound.domainMismatch === false &&
        clientProvMirror.domainMismatch === true &&
        clientProvMirror.claimedPublisher === 'Lovdata' &&
        clientProvUdir.domainMismatch === false &&
        clientProvDibk.domainMismatch === false,
      `inspectSourceDomainProvenance and inspectClientSourceDomainProvenance flag third-party mirrors masquerading as authorities while allowing true domains, acronyms, compound abbreviations, host-prefixed slugs, and umbrella portals`
    );

    // Verify `cleanGroundingLinks()` annotates `(via <hostname>)` on masquerading mirror titles
    const cleanedMasquerade = await cleanGroundingLinks(
      [
        '---',
        'type: Research Concept',
        'title: Provenance Test',
        'sources:',
        '  - id: barnehageloven-lovdata',
        '    resource: https://dyrebo.barnehage.no/Getfile.aspx/Lov_om_barnehager.pdf',
        '    title: Lov om barnehager (barnehageloven) – Lovdata',
        '---',
        'Barnehagen skal ha internkontroll[^barnehageloven-lovdata].',
        '',
        '[^barnehageloven-lovdata]: Lov om barnehager (barnehageloven) – Lovdata',
      ].join('\n'),
      []
    );
    assert(
      cleanedMasquerade.includes('(via dyrebo.barnehage.no)'),
      `cleanGroundingLinks appends (via <hostname>) when a source title claims a publisher that does not match its resolved host`
    );

    // Verify zero-token `--replace-source` (`replaceSourceMap`) re-anchoring to both existing IDs and newly added URLs
    const replaceInputMd = [
      '---',
      'type: Research Concept',
      'title: Re-Anchor Test',
      'status: draft',
      'sources:',
      '  - id: dsb-veiledning',
      '    title: Veiledning til forskrift om brannforebygging – DSB',
      '    resource: https://www.dsb.no/lover/brannforebygging/',
      '  - id: mirror-forskrift',
      '    title: Forskrift om brannforebygging – Lovdata (via secure.styret.com)',
      '    resource: https://secure.styret.com/s3assets-public/show/67781',
      '  - id: mirror-barnehageloven',
      '    title: Lov om barnehager – Lovdata (via dyrebo.barnehage.no)',
      '    resource: https://dyrebo.barnehage.no/Getfile.aspx/Lov.pdf',
      '---',
      'Innledning med generell kontekst.',
      '',
      'Brannsikkerhet krever systematisk kartlegging[^mirror-forskrift].',
      'Samme krav følger av veiledningen[^dsb-veiledning] [^mirror-forskrift].',
      'Styrer har ansvar for internkontroll etter § 9[^mirror-barnehageloven].',
      '',
      '[^dsb-veiledning]: Veiledning til forskrift om brannforebygging – DSB',
      '[^mirror-forskrift]: Forskrift om brannforebygging – Lovdata (via secure.styret.com)',
      '[^mirror-barnehageloven]: Lov om barnehager – Lovdata (via dyrebo.barnehage.no)',
      '',
    ].join('\n');
    const replacedCurated = curateOkfSources(replaceInputMd, {
      rejectSourceIds: ['mirror-forskrift', 'mirror-barnehageloven'],
      replaceSourceMap: {
        'mirror-forskrift': 'dsb-veiledning',
        'mirror-barnehageloven': 'https://lovdata.no/dokument/NL/lov/2005-06-17-64',
      },
      addSources: [
        {
          url: 'https://lovdata.no/dokument/NL/lov/2005-06-17-64',
          title: 'Lov om barnehager (barnehageloven) – Lovdata',
        },
      ],
    });
    const newBarnehageSlug = replacedCurated.replacedMap['mirror-barnehageloven'];
    assert(
      replacedCurated.orphanClaimLines.length === 0 &&
        replacedCurated.replacedMap['mirror-forskrift'] === 'dsb-veiledning' &&
        Boolean(newBarnehageSlug) &&
        replacedCurated.markdown.includes('kartlegging[^dsb-veiledning].') &&
        replacedCurated.markdown.includes('veiledningen[^dsb-veiledning].') &&
        !replacedCurated.markdown.includes('[^dsb-veiledning] [^dsb-veiledning]') &&
        replacedCurated.markdown.includes(`§ 9[^${newBarnehageSlug}].`) &&
        replacedCurated.markdown.includes('\nInnledning med generell kontekst.\n') &&
        !replacedCurated.markdown.includes('mirror-forskrift') &&
        !replacedCurated.markdown.includes('mirror-barnehageloven'),
      `curateOkfSources replaceSourceMap re-anchors citations to existing IDs and newly added URLs with 0 orphan claims, deduplicated footnotes, and no dummy first-paragraph weave`
    );

    // Verify standalone `replaceSourceMap` URL replacement WITHOUT `addSources` or `rejectSourceIds`
    const standaloneUrlReplaced = curateOkfSources(replaceInputMd, {
      replaceSourceMap: {
        'mirror-forskrift': 'dsb-veiledning',
        'mirror-barnehageloven':
          'https://www.dibk.no/regelverk/byggteknisk-forskrift-tek17/11/iv/11-12|Byggteknisk forskrift (TEK17) § 11-12 – DiBK',
      },
    });
    const standaloneNewSlug = standaloneUrlReplaced.replacedMap['mirror-barnehageloven'];
    assert(
      standaloneUrlReplaced.orphanClaimLines.length === 0 &&
        standaloneUrlReplaced.addedSources.length === 1 &&
        Boolean(standaloneNewSlug) &&
        standaloneUrlReplaced.addedSources[0].resource ===
          'https://www.dibk.no/regelverk/byggteknisk-forskrift-tek17/11/iv/11-12' &&
        standaloneUrlReplaced.markdown.includes(`§ 9[^${standaloneNewSlug}].`) &&
        !standaloneUrlReplaced.markdown.includes('mirror-barnehageloven') &&
        !standaloneUrlReplaced.markdown.includes('mirror-forskrift'),
      `curateOkfSources auto-registers standalone https:// replacement URLs in replaceSourceMap without requiring a separate addSources call`
    );

    // Verify Studio `setReplaceSourceInStudio` + `toggleReplacePanelInStudio` (direct swap without clicking Reject first) + `buildCurationPrompts`
    s1Hooks.setReplaceSourceInStudio(s1SimSurface, 'svak-blogg-kilde', 'https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710');
    const replPrompts = s1Hooks.buildCurationPrompts(s1SimSurface);
    s1Hooks.setReplaceSourceInStudio(
      s1SimSurface,
      'svak-blogg-kilde',
      'www.dibk.no/regelverk/byggteknisk-forskrift-tek17/11/iv/11-12'
    );
    const bareHostPrompts = s1Hooks.buildCurationPrompts(s1SimSurface);

    // Direct swap on an active (non-rejected) source via `🔀 Erstatt kilde`
    const openState1 = s1Hooks.toggleReplacePanelInStudio(s1SimSurface, 'dsb-veiledning');
    s1Hooks.setReplaceSourceInStudio(
      s1SimSurface,
      'dsb-veiledning',
      'https://lovdata.no/dokument/NL/lov/2002-06-14-20'
    );
    const directSwapPrompts = s1Hooks.buildCurationPrompts(s1SimSurface);
    const undoOpenState = s1Hooks.toggleReplacePanelInStudio(s1SimSurface, 'dsb-veiledning');
    const afterUndoSwapPrompts = s1Hooks.buildCurationPrompts(s1SimSurface);

    const formattedBoldList = s1Hooks.formatInlineLatexAndFootnotes(
      '1. **Tellingsansvarlig**: teller barn.\n2. ** gjennomsøkingsansvarlig (søkeleder)**: sjekker toaletter.',
      [],
      []
    );
    const s1HtmlRendered = fs.readFileSync(multiRunRes.htmlOutputPath, 'utf-8');
    assert(
      replPrompts.cliText.includes('--replace-source svak-blogg-kilde=https://lovdata.no/dokument/SF/forskrift/2015-12-17-1710') &&
        replPrompts.agyText.includes('--replace-source') &&
        bareHostPrompts.cliText.includes(
          '--replace-source svak-blogg-kilde=https://www.dibk.no/regelverk/byggteknisk-forskrift-tek17/11/iv/11-12'
        ) &&
        openState1['dsb-veiledning'] === true &&
        directSwapPrompts.cliText.includes(
          '--replace-source dsb-veiledning=https://lovdata.no/dokument/NL/lov/2002-06-14-20'
        ) &&
        !directSwapPrompts.cliText.includes('dsb-veiledning,') &&
        !undoOpenState['dsb-veiledning'] &&
        !afterUndoSwapPrompts.cliText.includes('dsb-veiledning=') &&
        formattedBoldList.includes('2. **gjennomsøkingsansvarlig (søkeleder)**:') &&
        s1HtmlRendered.includes('okf-open-replace-btn') &&
        s1HtmlRendered.includes('okf-jump-sources-btn') &&
        s1HtmlRendered.includes('okf-replace-url-input') &&
        s1HtmlRendered.includes('okf-replace-url-btn') &&
        s1HtmlRendered.includes('color-scheme: light;') &&
        /\.okf-add-source-box input\s*\{[^}]*color:\s*#0f172a;/.test(s1HtmlRendered),
      `toggleReplacePanelInStudio, setReplaceSourceInStudio, and buildCurationPrompts support 1-click direct source swap (without requiring Reject first), 1-step inline URLs, jump-to-sources button, BPE bold-space normalization, and explicit dark-webview input contrast`
    );

    // Verify zero-CDN / sandboxed Auxiliary Pane CSP Markdown rendering (`window.marked === undefined`)
    const cspOverviewRendered = s1Hooks.renderMarkdownBlock(
      '**Trygghet når sekundene teller:** I en barnehage har vi omsorg for samfunnets aller yngste borgere fra 0 til 6 år.\n\n**Ansvarsdeling og systematisk HMS-arbeid:** Norsk lovverk skiller tydelig mellom byggeier og bruker.',
      []
    );
    const cspComplexRendered = s1Hooks.renderMarkdownBlock(
      '## 1. Hovedkrav\n\n1. **Brannvernleder**: utpekes av styrer[^dsb-veiledning].\n2. **Rømningsvei**: holdes fri.\n\n| Krav | Hjemmel |\n| --- | --- |\n| **Risikoklasse 3** | `TEK17 § 11-2` |',
      [{ id: 'dsb-veiledning', title: 'DSB Veiledning', resource: 'https://www.dsb.no/' }]
    );
    const cspInlineRendered = s1Hooks.renderInlineMarkdown(
      '• **Ansvarsdeling (§§ 4–13):** Bruk `brannperm` og se [Lovdata](https://lovdata.no).'
    );
    assert(
      cspOverviewRendered.includes('<p><strong>Trygghet når sekundene teller:</strong> I en barnehage') &&
        cspOverviewRendered.includes('<p><strong>Ansvarsdeling og systematisk HMS-arbeid:</strong> Norsk lovverk') &&
        !cspOverviewRendered.includes('**Trygghet') &&
        cspComplexRendered.includes('<h2>1. Hovedkrav</h2>') &&
        cspComplexRendered.includes('<ol><li><strong>Brannvernleder</strong>:') &&
        cspComplexRendered.includes('data-fn="dsb-veiledning"') &&
        cspComplexRendered.includes('<table><thead><tr><th>Krav</th><th>Hjemmel</th></tr></thead>') &&
        cspComplexRendered.includes('<td><strong>Risikoklasse 3</strong></td><td><code>TEK17 § 11-2</code></td>') &&
        cspInlineRendered.includes('<strong>Ansvarsdeling (§§ 4–13):</strong>') &&
        cspInlineRendered.includes('<code>brannperm</code>'),
      `renderMarkdownBlock and renderInlineMarkdown render bold lead-ins, paragraphs, headings, lists, GFM tables, inline code, and OKF footnotes cleanly when external CDN marked.js is blocked by CSP or offline`
    );

    // Verify primary `updateDataModel` (`dataModel.okf.verifierActor`) parity with `bundleRuns`
    const s1UpdatedSurfaceJson = JSON.parse(
      fs.readFileSync(path.join(s1UnverifiedDir, 'a2ui_surface.json'), 'utf-8')
    );
    const s1PrimaryDataModelMsg = (s1UpdatedSurfaceJson.messages || []).find(
      (m: any) => m && m.updateDataModel
    );
    assert(
      s1PrimaryDataModelMsg?.updateDataModel?.value?.okf?.verifierActor === 'human:Cato Paus Skrede',
      `generateA2uiSurface populates primary dataModel.okf.verifierActor directly in a2ui_surface.json`
    );

    // Verify IDF-weighted lexical line matching in `curateOkfSources` for standalone `--add-source`
    const lexicalWeaveInput = [
      '---',
      'type: Research Concept',
      'title: Brannvern i barnehage',
      'status: draft',
      'sources:',
      '  - id: dsb-veiledning',
      '    title: Veiledning til forskrift om brannforebygging – DSB',
      '    resource: https://www.dsb.no/lover/brannforebygging/',
      '---',
      'Generell innledning om barnehagebygg, rømningsveier og slokkeutstyr i kommunen[^dsb-veiledning].',
      '',
      '1. **Brann- og eksplosjonsvernloven**: Stiller krav til aktsomhet[^dsb-veiledning].',
      '2. **Internkontrollforskriften og arbeidsmiljøloven § 3-1**: Styrer skal dokumentere HMS-arbeidet systematisk.',
      '',
      '[^dsb-veiledning]: Veiledning til forskrift om brannforebygging – DSB',
      '',
    ].join('\n');
    const lexicalWeaved = curateOkfSources(lexicalWeaveInput, {
      addSources: [
        {
          url: 'https://lovdata.no/dokument/NL/lov/2005-06-17-62',
          title: 'Lov om arbeidsmiljø, arbeidstid og stillingsvern mv. (arbeidsmiljøloven)',
        },
      ],
    });
    const amlSlug = lexicalWeaved.addedSources[0]?.id;
    assert(
      Boolean(amlSlug) &&
        lexicalWeaved.markdown.includes(
          `arbeidsmiljøloven § 3-1**: Styrer skal dokumentere HMS-arbeidet systematisk[^${amlSlug}].`
        ) &&
        !lexicalWeaved.markdown.includes(`kommunen[^dsb-veiledning][^${amlSlug}].`),
      `curateOkfSources weaves standalone added sources onto the lexically matching claim line rather than blindly attaching to paragraph 1`
    );
  } finally {
    fs.rmSync(tmpStage1ReviewDir, { recursive: true, force: true });
  }

  console.log(`[ICM Self-Test] ✅ All ${assertions} assertions passed (0 tokens, including tsc --noEmit).`);
  return { passed: assertions };
}

// 4. Headless CLI Entrypoint (Linux / macOS / Windows / SSH / Cron / Terminal execution)
if (
  process.argv.includes('--test') ||
  process.argv.includes('--cli') ||
  process.argv.includes('--stage1') ||
  process.argv.includes('--stage2') ||
  process.argv.includes('--verify') ||
  process.argv.includes('--viz') ||
  process.argv.includes('--a2ui') ||
  process.argv.includes('--ping-pong')
) {
  (async () => {
    if (process.argv.includes('--test')) {
      await runIcmSelfTests();
      return;
    }

    const isStage1Only = process.argv.includes('--stage1');
    const isStage2Only = process.argv.includes('--stage2');
    const isFullCli = process.argv.includes('--cli');
    const hasVerify = process.argv.includes('--verify');
    const hasViz = process.argv.includes('--viz');
    const hasA2ui = process.argv.includes('--a2ui');
    const hasPingPong = process.argv.includes('--ping-pong');
    const isDryRun = process.argv.includes('--dry-run');
    const hasOpen = process.argv.includes('--open');

    const artifactDirFlagIdx = process.argv.indexOf('--artifact-dir');
    if (
      artifactDirFlagIdx !== -1 &&
      process.argv[artifactDirFlagIdx + 1] &&
      !process.argv[artifactDirFlagIdx + 1].startsWith('--')
    ) {
      process.env.AGY_ARTIFACT_DIR = process.argv[artifactDirFlagIdx + 1];
    }

    // Standalone `--ping-pong` listener for Antigravity 2.0 Reactive Wakeup
    if (hasPingPong && !isStage1Only && !isStage2Only && !isFullCli && !hasVerify && !hasA2ui && !hasViz) {
      const ppIdx = process.argv.indexOf('--ping-pong');
      const ppArgs = process.argv
        .slice(ppIdx + 1)
        .filter((a) => !a.startsWith('--'));
      const targetRunId = ppArgs[0];
      await startA2uiPingPongListener({
        workspaceRoot: './workspace',
        runId: targetRunId,
      });
      return;
    }

    const extractCliByTokens = (
      argv: string[],
      byIdx: number
    ): { value?: string; count: number } => {
      if (byIdx === -1 || byIdx + 1 >= argv.length || argv[byIdx + 1].startsWith('--')) {
        return { value: undefined, count: 0 };
      }
      const tokens: string[] = [argv[byIdx + 1]];
      let k = byIdx + 2;
      while (k < argv.length) {
        const tok = argv[k];
        if (tok.startsWith('--')) break;
        if (/\d{10,}$|[\/\\]|\.md$/i.test(tok)) break;
        tokens.push(tok);
        k++;
      }
      return { value: tokens.join(' ').trim(), count: tokens.length };
    };

    const byFlagIdx = process.argv.indexOf('--by');
    const byParsed = extractCliByTokens(process.argv, byFlagIdx);
    const verifierBy = byParsed.value;

    // Standalone `--a2ui` execution
    if (hasA2ui && !isStage1Only && !isStage2Only && !isFullCli && !hasVerify) {
      const a2uiIdx = process.argv.indexOf('--a2ui');
      const rawA2uiTail = process.argv.slice(a2uiIdx + 1);
      const a2uiArgs: string[] = [];
      for (let i = 0; i < rawA2uiTail.length; i++) {
        if (rawA2uiTail[i] === '--artifact-dir') {
          i++;
          continue;
        }
        if (rawA2uiTail[i].startsWith('--')) continue;
        a2uiArgs.push(rawA2uiTail[i]);
      }
      const targetRunOrPath = a2uiArgs[0];
      const customHtmlOut = a2uiArgs[1];
      const a2uiResult = generateA2uiSurface({
        workspaceRoot: './workspace',
        runId: targetRunOrPath,
        outputHtmlPath: customHtmlOut,
        openBrowser: hasOpen,
      });
      console.log('A2UI v0.9.1 Surface & Studio Generated:', {
        runId: a2uiResult.runId,
        surfaceId: a2uiResult.surfaceId,
        componentCount: a2uiResult.componentCount,
        tabCount: a2uiResult.tabCount,
        checklistItemCount: a2uiResult.checklistItemCount,
        moduleCount: a2uiResult.moduleCount,
        quizCount: a2uiResult.quizCount,
        caseCount: a2uiResult.caseCount,
        surfaceJsonPath: a2uiResult.surfaceJsonPath,
        surfaceJsonlPath: a2uiResult.surfaceJsonlPath,
        htmlOutputPath: a2uiResult.htmlOutputPath,
        bundleHtmlPath: a2uiResult.bundleHtmlPath,
        bundleVizPath: a2uiResult.bundleVizPath,
        artifactHtmlPath: a2uiResult.artifactHtmlPath,
        artifactVizPath: a2uiResult.artifactVizPath,
        browserOpened: a2uiResult.browserOpened,
      });
      return;
    }

    // Standalone `--viz` execution
    if (hasViz && !isStage1Only && !isStage2Only && !isFullCli && !hasVerify) {
      const vizIdx = process.argv.indexOf('--viz');
      const rawVizTail = process.argv.slice(vizIdx + 1);
      const vizArgs: string[] = [];
      for (let i = 0; i < rawVizTail.length; i++) {
        if (rawVizTail[i] === '--artifact-dir') {
          i++;
          continue;
        }
        if (rawVizTail[i].startsWith('--')) continue;
        vizArgs.push(rawVizTail[i]);
      }
      const bundleDir = vizArgs[0] || './workspace/bundle';
      const outPath = vizArgs[1] || path.join(bundleDir, 'viz.html');
      const vizResult = generateBundleVisualization(bundleDir, outPath);
      if (hasOpen) {
        openFileInSystemBrowser(vizResult.outputPath);
      }
      console.log('OKF Bundle Visualization Generated:', vizResult);
      return;
    }

    const rejectSourceIdsCli: string[] = [];
    const replaceSourceMapCli: Record<string, string> = {};
    const rawAddSourceSpecsCli: string[] = [];
    for (let i = 0; i < process.argv.length; i++) {
      if (process.argv[i] === '--reject-source' && process.argv[i + 1]) {
        const parts = process.argv[i + 1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        rejectSourceIdsCli.push(...parts);
        i++;
      } else if (process.argv[i] === '--replace-source' && process.argv[i + 1]) {
        const pairs = process.argv[i + 1]
          .split(/,\s*(?=[A-Za-z0-9_\-\[\]\^]+\s*=)/)
          .map((s) => s.trim())
          .filter(Boolean);
        for (const pair of pairs) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx > 0) {
            const oldKey = pair
              .slice(0, eqIdx)
              .trim()
              .replace(/^\[\^/, '')
              .replace(/\]$/, '')
              .trim();
            const newTarget = pair
              .slice(eqIdx + 1)
              .trim()
              .replace(/^\[\^/, '')
              .replace(/\]$/, '')
              .trim();
            if (oldKey && newTarget) {
              replaceSourceMapCli[oldKey] = newTarget;
            }
          }
        }
        i++;
      } else if (process.argv[i] === '--add-source' && process.argv[i + 1]) {
        const specs = process.argv[i + 1]
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean);
        rawAddSourceSpecsCli.push(...specs);
        i++;
      }
    }

    const resolveCliAddedSources = async (
      specs: string[]
    ): Promise<Array<{ url: string; title?: string; id?: string; lastModified?: string; last_modified?: string }>> => {
      const resolvedList: Array<{ url: string; title?: string; id?: string; lastModified?: string; last_modified?: string }> = [];
      for (const rawSpec of specs) {
        let customId: string | undefined;
        let spec = rawSpec.trim();
        const idPrefixMatch = spec.match(/^id=([A-Za-z0-9_\-]+)\|([\s\S]+)$/i);
        if (idPrefixMatch) {
          customId = idPrefixMatch[1].trim();
          spec = idPrefixMatch[2].trim();
        }
        const pipeIdx = spec.indexOf('|');
        const rawUrl = (pipeIdx !== -1 ? spec.slice(0, pipeIdx) : spec).trim();
        const explicitTitle = pipeIdx !== -1 ? spec.slice(pipeIdx + 1).trim() : '';
        if (!rawUrl) continue;
        let finalUrl = rawUrl;
        let lastModified: string | undefined;
        let fetchedTitle: string | undefined;
        if (/^https?:\/\//i.test(rawUrl)) {
          try {
            const info = await resolveRedirect(rawUrl);
            if (info.url) finalUrl = info.url;
            if (info.lastModified) lastModified = info.lastModified;
            if (info.pageTitle) fetchedTitle = info.pageTitle;
          } catch {
            // Non-fatal if offline
          }
        }
        resolvedList.push({
          url: finalUrl,
          title: explicitTitle || fetchedTitle || undefined,
          ...(customId ? { id: customId } : {}),
          ...(lastModified ? { lastModified, last_modified: lastModified } : {}),
        });
      }
      return resolvedList;
    };

    const resolveCliCurationInputs = async (): Promise<{
      addSourcesResolved: Array<{
        url: string;
        title?: string;
        id?: string;
        lastModified?: string;
        last_modified?: string;
      }>;
      normalizedReplaceSourceMap: Record<string, string>;
    }> => {
      const addSourcesResolved = await resolveCliAddedSources(rawAddSourceSpecsCli);
      const seenCanonUrls = new Set<string>(
        addSourcesResolved
          .map((item) => normalizeCanonicalSourceUrl(item.url) || item.url)
          .filter(Boolean)
      );
      const normalizedReplaceSourceMap: Record<string, string> = { ...replaceSourceMapCli };
      for (const [oldKey, rawTarget] of Object.entries(replaceSourceMapCli)) {
        if (/^(?:id=[A-Za-z0-9_\-]+\|)?https?:\/\//i.test(rawTarget)) {
          const [resolvedItem] = await resolveCliAddedSources([rawTarget]);
          if (resolvedItem && resolvedItem.url) {
            const canon = normalizeCanonicalSourceUrl(resolvedItem.url) || resolvedItem.url;
            if (!seenCanonUrls.has(canon)) {
              addSourcesResolved.push(resolvedItem);
              seenCanonUrls.add(canon);
            }
            normalizedReplaceSourceMap[oldKey] = resolvedItem.id || resolvedItem.url;
          }
        }
      }
      return { addSourcesResolved, normalizedReplaceSourceMap };
    };

    // Standalone `--verify` execution
    if (hasVerify && !isStage1Only && !isStage2Only && !isFullCli) {
      const verifyIdx = process.argv.indexOf('--verify');
      const rawArgs = process.argv.slice(verifyIdx + 1);
      const filteredArgs: string[] = [];
      for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] === '--by') {
          i += Math.max(1, extractCliByTokens(rawArgs, i).count);
          continue;
        }
        if (
          rawArgs[i] === '--reject-source' ||
          rawArgs[i] === '--replace-source' ||
          rawArgs[i] === '--add-source' ||
          rawArgs[i] === '--artifact-dir'
        ) {
          i++;
          continue;
        }
        if (rawArgs[i].startsWith('--')) continue;
        filteredArgs.push(rawArgs[i]);
      }
      const target = filteredArgs[0];
      if (!target) {
        console.error(
          'Usage: npm run cli:verify -- <runIdOrConceptPath> [--reject-source id1,id2] [--replace-source oldId=newIdOrUrl] [--add-source "<url>[|<title>]"] [--by human:<reviewer>] [--open] [--artifact-dir <dir>]'
        );
        process.exit(1);
      }
      const { addSourcesResolved, normalizedReplaceSourceMap } = await resolveCliCurationInputs();
      const verifyResult = verifyOkfConcept(target, {
        workspaceRoot: './workspace',
        by: verifierBy,
        rejectSourceIds: rejectSourceIdsCli,
        replaceSourceMap: normalizedReplaceSourceMap,
        addSources: addSourcesResolved,
      });
      if (hasViz) {
        const vizResult = generateBundleVisualization('./workspace/bundle');
        console.log('OKF Bundle Visualization Generated:', vizResult);
      }
      if (hasA2ui) {
        const a2uiResult = generateA2uiSurface({ workspaceRoot: './workspace', runId: target });
        console.log('A2UI v0.9.1 Surface Generated:', a2uiResult.htmlOutputPath);
      }
      console.log('OKF Verification Complete:', verifyResult);
      return;
    }

    const flag = isStage2Only ? '--stage2' : isStage1Only ? '--stage1' : '--cli';
    const flagIndex = process.argv.indexOf(flag);
    const tailArgs = process.argv.slice(flagIndex + 1);
    const cleanedPositional: string[] = [];
    for (let i = 0; i < tailArgs.length; i++) {
      const token = tailArgs[i];
      if (token === '--by') {
        i += Math.max(1, extractCliByTokens(tailArgs, i).count);
        continue;
      }
      if (
        token === '--reject-source' ||
        token === '--replace-source' ||
        token === '--add-source' ||
        token === '--artifact-dir'
      ) {
        i++;
        continue;
      }
      if (
        token === '--dry-run' ||
        token === '--verify' ||
        token === '--viz' ||
        token === '--a2ui' ||
        token === '--open'
      ) {
        continue;
      }
      cleanedPositional.push(token);
    }
    const argValue = cleanedPositional.join(' ').trim();

    if (!argValue) {
      console.error(
        isStage2Only
          ? 'Usage: npm run cli:stage2 -- [--dry-run] [--verify] [--by human:<id>] [--a2ui] [--open] [--artifact-dir <dir>] <runId>'
          : isStage1Only
            ? 'Usage: npm run cli:stage1 -- [--dry-run] [--viz] [--a2ui] [--open] [--artifact-dir <dir>] "<Research Topic>"'
            : 'Usage: npm run cli -- [--dry-run] [--verify] [--viz] [--a2ui] [--open] [--artifact-dir <dir>] "<Research Topic>"'
      );
      process.exit(1);
    }

    if (isStage2Only) {
      if (hasVerify) {
        const { addSourcesResolved, normalizedReplaceSourceMap } = await resolveCliCurationInputs();
        verifyOkfConcept(argValue, {
          workspaceRoot: './workspace',
          by: verifierBy,
          rejectSourceIds: rejectSourceIdsCli,
          replaceSourceMap: normalizedReplaceSourceMap,
          addSources: addSourcesResolved,
        });
      }
      const runDir = path.resolve('./workspace/runs', argValue);
      const result = await runStage2Flow({
        workspaceRoot: './workspace',
        runId: argValue,
        thinkingLevel: 'MEDIUM',
        dryRun: isDryRun,
      });
      if (!isDryRun) {
        const metaPath = path.join(runDir, 'meta.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          meta.status = 'completed';
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        }
      }
      if (hasViz) {
        const vizResult = generateBundleVisualization('./workspace/bundle');
        console.log('OKF Bundle Visualization Generated:', vizResult);
      }
      if (hasA2ui && !isDryRun) {
        const a2uiResult = generateA2uiSurface({ workspaceRoot: './workspace', runId: argValue });
        console.log('A2UI v0.9.1 Surface Generated:', a2uiResult.htmlOutputPath);
      }
      console.log('Stage 2 CLI Run Complete:', result);
    } else {
      const slug = truncateSlugAtWordBoundary(
        transliterateNordicAscii(argValue)
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, ''),
        32
      );
      const runId = isDryRun ? '_dry_run' : `${slug || 'run'}-${Date.now()}`;
      const runDir = path.resolve('./workspace/runs', runId);
      fs.mkdirSync(runDir, { recursive: true });
      if (!isDryRun) {
        fs.writeFileSync(
          path.join(runDir, 'meta.json'),
          JSON.stringify(
            {
              runId,
              topic: argValue,
              model: GEMINI_4_ARGON_MODEL,
              researchThinkingLevel: 'HIGH',
              scriptThinkingLevel: 'MEDIUM',
              createdAt: new Date().toISOString(),
              status: 'running',
            },
            null,
            2
          ),
          'utf-8'
        );
      }

      if (isStage1Only || isDryRun) {
        console.log(
          `Starting headless ${isDryRun ? 'DRY-RUN ' : ''}Stage 1 ICM run: ${runId}`
        );
        const result = await runStage1Flow({
          workspaceRoot: './workspace',
          runId,
          topic: argValue,
          thinkingLevel: 'HIGH',
          dryRun: isDryRun,
        });
        if (!isDryRun) {
          const metaPath = path.join(runDir, 'meta.json');
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            meta.status = 'stage1_completed';
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
          }
          if (hasVerify) {
            const addSourcesResolved = await resolveCliAddedSources(rawAddSourceSpecsCli);
            verifyOkfConcept(runId, {
              workspaceRoot: './workspace',
              by: verifierBy,
              rejectSourceIds: rejectSourceIdsCli,
              replaceSourceMap: replaceSourceMapCli,
              addSources: addSourcesResolved,
            });
          }
        }
        if (hasViz) {
          const vizResult = generateBundleVisualization('./workspace/bundle');
          console.log('OKF Bundle Visualization Generated:', vizResult);
        }
        if (hasA2ui && !isDryRun) {
          const a2uiResult = generateA2uiSurface({ workspaceRoot: './workspace', runId });
          console.log('A2UI v0.9.1 Surface Generated:', a2uiResult.htmlOutputPath);
        }
        console.log(
          `Stage 1 CLI ${isDryRun ? 'Dry-Run ' : 'Run '}Complete (${runId}):`,
          result
        );
      } else {
        console.log(`Starting headless full ICM run: ${runId}`);
        await runStage1Flow({
          workspaceRoot: './workspace',
          runId,
          topic: argValue,
          thinkingLevel: 'HIGH',
        });
        if (hasVerify) {
          const addSourcesResolved = await resolveCliAddedSources(rawAddSourceSpecsCli);
          verifyOkfConcept(runId, {
            workspaceRoot: './workspace',
            by: verifierBy,
            rejectSourceIds: rejectSourceIdsCli,
            replaceSourceMap: replaceSourceMapCli,
            addSources: addSourcesResolved,
          });
        }
        const stage2Result = await runStage2Flow({
          workspaceRoot: './workspace',
          runId,
          thinkingLevel: 'MEDIUM',
        });
        const metaPath = path.join(runDir, 'meta.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          meta.status = 'completed';
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        }
        if (hasViz) {
          const vizResult = generateBundleVisualization('./workspace/bundle');
          console.log('OKF Bundle Visualization Generated:', vizResult);
        }
        if (hasA2ui) {
          const a2uiResult = generateA2uiSurface({ workspaceRoot: './workspace', runId });
          console.log('A2UI v0.9.1 Surface Generated:', a2uiResult.htmlOutputPath);
        }
        console.log(`Headless ICM Run Complete (${runId}):`, {
          status: 'Pipeline executed successfully',
          outputPath: stage2Result.outputPath,
          trust_tier: stage2Result.trust_tier,
          is_stale: stage2Result.is_stale,
        });
      }
    }
  })().catch((err) => {
    console.error('Headless CLI execution failed:', err);
    process.exit(1);
  });
}


