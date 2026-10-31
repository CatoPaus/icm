import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

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

    if (event.event_type === 'interaction.created' || event.event_type === 'interaction.completed') {
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

// Helper function to extract the destination URL (and opportunistic Last-Modified header) from Vertex AI Search grounding 302 redirects.
// Uses `redirect: 'manual'` first so we read Google's `Location` header directly in ~100ms without
// failing or timing out when a third-party destination server is unreachable.
async function resolveRedirect(
  url: string
): Promise<{ url: string; lastModified?: string }> {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  const isNonErrorStatus = (res: any): boolean =>
    res?.status === undefined || (typeof res.status === 'number' && res.status >= 200 && res.status < 400);

  try {
    const manualRes = await globalThis.fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers,
    });
    await manualRes.body?.cancel().catch(() => {});
    let lastModified = isNonErrorStatus(manualRes)
      ? parseHttpLastModified(manualRes.headers?.get?.('last-modified'))
      : undefined;
    const location = manualRes.headers?.get?.('location');
    if (location && /^https?:\/\//i.test(location)) {
      if (!lastModified) {
        try {
          const headRes = await globalThis.fetch(location, {
            method: 'HEAD',
            redirect: 'follow',
            signal: AbortSignal.timeout(1500),
            headers,
          });
          await headRes?.body?.cancel().catch(() => {});
          if (isNonErrorStatus(headRes)) {
            lastModified = parseHttpLastModified(headRes?.headers?.get?.('last-modified'));
          }
        } catch {
          // Ignore unreachable third-party servers or unsupported HEAD checks
        }
      }
      return { url: location, lastModified };
    }
    if (lastModified) {
      return { url: manualRes.url || url, lastModified };
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
    await followRes.body?.cancel().catch(() => {});
    const lastModified = isNonErrorStatus(followRes)
      ? parseHttpLastModified(followRes.headers?.get?.('last-modified'))
      : undefined;
    return { url: followRes.url || url, lastModified };
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

export function truncateSlugAtWordBoundary(
  rawSlug: string,
  maxLen: number,
  minSnapPos = 20
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
  let base = titleOrUrl
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

function normalizeSourceMatchKey(input?: string): string {
  return String(input || '')
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
      entries = fs.readdirSync(dir, { withFileTypes: true });
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
              if (
                s &&
                typeof s === 'object' &&
                typeof s.resource === 'string' &&
                /^https?:\/\//i.test(s.resource) &&
                !isVertexRedirectUrl(s.resource)
              ) {
                out.push({
                  id: s.id ? String(s.id) : undefined,
                  resource: s.resource.trim(),
                  title: s.title ? String(s.title) : undefined,
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

function isBareDomainTitle(title?: string): boolean {
  const t = String(title || '').trim();
  if (!t) return true;
  if (/^(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}\/?$/i.test(t)) {
    return true;
  }
  if (/\s+[—–-]\s+(?:id\d+|\w*servlet)$/i.test(t)) {
    return true;
  }
  const autoSlugMatch = t.match(/^[a-z0-9.-]+\.[a-z]{2,}\s+—\s+(.+)$/i);
  if (autoSlugMatch) {
    const slugPart = autoSlugMatch[1].trim();
    if (
      slugPart.length <= 1 ||
      /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)\s+\d/i.test(slugPart) ||
      /^[^\p{L}]+[\p{Ll}]/u.test(slugPart) ||
      /^(?:id\d+|\w*servlet)$/i.test(slugPart)
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
  const cleanTitle = String(rawTitle || '').trim();
  const cleanUrl = String(resourceUrl || '').trim();
  if (!isBareDomainTitle(cleanTitle) && cleanTitle !== cleanUrl) {
    return cleanTitle;
  }
  if (!/^https?:\/\//i.test(cleanUrl) || isVertexRedirectUrl(cleanUrl)) {
    return cleanTitle || cleanUrl;
  }
  try {
    const parsed = new URL(cleanUrl);
    const domainPrefixMatch = cleanTitle.match(/^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/i);
    const domain = domainPrefixMatch
      ? domainPrefixMatch[1].replace(/^www\./i, '')
      : parsed.hostname.replace(/^www\./i, '');
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

    const isOpaqueOrBucket = (seg: string): boolean => {
      const noExt = seg.replace(/\.(?:pdf|html?|aspx?|php|md|docx?)$/i, '');
      if (
        /^(?:_f|p\d+|no|nb|nn|en|wiki|globalassets|contentassets|wp-content|uploads|dyn)$/i.test(
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
      if (/^i?[0-9a-f]{8,}(?:-[0-9a-f]{4,})*$/i.test(noExt) && /\d/.test(noExt)) {
        return true;
      }
      return false;
    };

    const meaningful = rawSegments.filter((s) => !isOpaqueOrBucket(s));
    if (meaningful.length === 0) {
      return domain || cleanTitle;
    }

    if (
      meaningful.length >= 2 &&
      meaningful[meaningful.length - 1].replace(/\.(?:pdf|html?|aspx?|php|md|docx?)$/i, '') === '1' &&
      /\d/.test(meaningful[meaningful.length - 2])
    ) {
      meaningful.pop();
    }

    const stripExt = (seg: string): string =>
      seg.replace(/\.(?:pdf|html?|aspx?|php|md|docx?)$/i, '');

    const lastSeg = stripExt(meaningful[meaningful.length - 1]);
    const prevSeg = meaningful.length >= 2 ? stripExt(meaningful[meaningful.length - 2]) : '';

    let chosenSlug = lastSeg;
    if (prevSeg && /^[0-9-]+$/.test(lastSeg)) {
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

    let humanized = chosenSlug
      .replace(/[+_]+/g, ' ')
      .replace(/(?<!\d)-|-(?!\d)|--+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!humanized || !/[\p{L}]/u.test(humanized)) {
      return domain || cleanTitle;
    }
    humanized = humanized.replace(/[\p{L}]/u, (ch) => ch.toUpperCase());
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
  return String(raw || '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
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

function shouldUpgradeSourceTitle(
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
  if (isAutoDomainSlugTitle(cur) && !isAutoDomainSlugTitle(cand)) {
    return true;
  }
  if (cur.length < 18 && !isAutoDomainSlugTitle(cand) && cand.length >= cur.length + 10) {
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
 * 1. Enriching any bare-domain or CMS-polluted (`Id87138`, `ResourceServlet`) source titles in `doc.frontmatter.sources`.
 * 2. Deduplicating `doc.frontmatter.sources` that share an identical `resource` URL and rewriting alias `[^id]` citations.
 * 3. Resolving any orphan `[^id]` citations in `doc.body` against `doc.frontmatter.sources` (or stripping ungrounded orphans).
 * 4. Synchronizing the bottom `[^id]: Title` footnote definitions so `citedFootnoteIds.size === doc.frontmatter.sources.length`.
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
    const rawCandidateTitle = s.title;
    const enrichedTitle = s.resource
      ? enrichBareDomainSourceTitle(s.title, String(s.resource))
      : s.title;
    if (enrichedTitle && enrichedTitle !== s.title) {
      s.title = enrichedTitle;
      modified = true;
    }
    const resKey = String(s.resource || '').trim();
    if (resKey && canonicalByUrl.has(resKey)) {
      const existing = canonicalByUrl.get(resKey)!;
      if (s.id && existing.id && s.id !== existing.id) {
        aliasMap.set(s.id, existing.id);
      }
      const candidateForUpgrade =
        rawCandidateTitle && !isBareDomainTitle(rawCandidateTitle) ? rawCandidateTitle : s.title;
      if (shouldUpgradeSourceTitle(existing.title, candidateForUpgrade, resKey)) {
        existing.title = enrichBareDomainSourceTitle(candidateForUpgrade, resKey);
      }
      modified = true;
    } else {
      if (resKey) canonicalByUrl.set(resKey, s);
      dedupedSources.push(s);
    }
  }

  // 2. Separate body prose from bottom `[^id]: label` definitions
  const rawBody = String(doc.body || '');
  const existingDefs = new Map<string, string>();
  const proseLines: string[] = [];
  for (const line of rawBody.split(/\r?\n/)) {
    const m = line.trim().match(/^\[\^([A-Za-z0-9_\-]+)\]:\s*(.+)$/);
    if (m) {
      existingDefs.set(m[1], m[2].trim());
    } else {
      proseLines.push(line);
    }
  }

  let proseText = proseLines.join('\n');

  // Snap footnotes out of slash-joined words (`overtredelser[^id]/avvik` -> `overtredelser/avvik[^id]`)
  proseText = proseText.replace(
    /([\p{L}\p{N}_\-]+)(\[\^[A-Za-z0-9_\-]+\](?:[ \t]*\[\^[A-Za-z0-9_\-]+\])*)((?:\/[\p{L}\p{N}_\-]+)+)/gu,
    '$1$3$2'
  );

  // Convert bare `.^id` typos to `.[^id]` before rewriting aliases
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
      const matched = matchOrphanFootnoteToSource(fnId, existingDefs.get(fnId), dedupedSources);
      if (matched && matched.id) {
        proseText = proseText.replaceAll(`[^${fnId}]`, `[^${matched.id}]`);
      } else {
        proseText = proseText.replaceAll(`[^${fnId}]`, '');
        proseText = proseText.replace(
          /[ \t]+(\[\^[A-Za-z0-9_\-]+\])/g,
          (_m, fn: string, offset: number, str: string) =>
            /\][ \t]*$/.test(str.slice(0, offset)) ? ` ${fn}` : fn
        );
        proseText = proseText.replace(/[ \t]+([.,;!?])/g, '$1');
      }
      modified = true;
    }
  }

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
    const label = src?.title || existingDefs.get(fnId) || src?.resource || fnId;
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
  for (const bs of collectExistingBundleSources(bundleRootDir)) {
    addHealingCandidate(bs.resource, bs.title, bs.id);
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

    const cleanTitle = (rawTitle || '')
      .replace(/\s*\(Alternativ indeks\)\s*$/i, '')
      .replace(/^\*\*|\*\*$/g, '')
      .trim();

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

    if (sourcesByUrl.has(resolvedUrl)) {
      const existing = sourcesByUrl.get(resolvedUrl)!;
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

    let id = preferredId?.trim() || '';
    if (id) {
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
    sourcesById.set(id, entry);
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
          if (s && typeof s === 'object' && s.resource) {
            const { id, resource, title, ...rest } = s;
            registerSource(String(resource), title ? String(title) : undefined, id ? String(id) : undefined, rest);
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
      }

      return idx;
    };

    const byEndIndex = new Map<number, OKFSource[]>();
    for (const ann of inlineAnnotations) {
      if (ann.end_index > buf.length || ann.end_index <= frontmatterEndByteOffset) continue;
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
        .filter(
          (s) =>
            !precedingSlice.endsWith(`[^${s.id}]`) &&
            !followingSlice.startsWith(`[^${s.id}]`) &&
            !followingSlice.startsWith(`.^${s.id}`) &&
            !followingSlice.startsWith(`?^${s.id}`)
        )
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
      if (s && typeof s === 'object' && s.resource) {
        const { id, resource, title, ...rest } = s;
        registerSource(String(resource), title ? String(title) : undefined, id ? String(id) : undefined, rest);
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
        existingFootnoteDefs.set(fnId, fnRest.trim());
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

  // 6. Register any remaining groundedSources from the Interactions API steps
  for (const src of groundedSources) {
    const candidateResolved = (urlMap.get(src.url) || src.url).trim();
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
    const rawEntryTitle = entry.title;
    entry.title = enrichBareDomainSourceTitle(entry.title, entry.resource);
    const existingCanonical = canonicalByResource.get(entry.resource);
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
      canonicalByResource.set(entry.resource, entry);
      sourcesByUrl.set(entry.resource, entry);
      dedupedSources.push(entry);
    }
  }
  orderedSources.length = 0;
  orderedSources.push(...dedupedSources);

  // Convert bare `.^id` typos (`/\.\^([a-z0-9]+(?:-[a-z0-9]+)+)/g`) to `.[^$1]` before alias rewriting
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
        bodyText = bodyText.replaceAll(`[^${fnId}]`, '');
      }
      existingFootnoteDefs.delete(fnId);
    }
  }

  // Normalize trailing sentence punctuation (`word.[^id]` -> `word[^id].` and `[^a].[^b]` -> `[^a] [^b].`)
  let prevBodyText = '';
  while (prevBodyText !== bodyText) {
    prevBodyText = bodyText;
    bodyText = bodyText.replace(
      /((?:\[\^[A-Za-z0-9_\-]+\][ \t]*)+)([.?!:;])[.?!:;]*((?:[ \t]*\[\^[A-Za-z0-9_\-]+\])+)/g,
      '$1 $3$2'
    );
  }
  bodyText = bodyText.replace(
    /([^\s.?!:;])([.?!])((?:[ \t]*\[\^[A-Za-z0-9_\-]+\])+)([.?!]+)?/g,
    (_m, before: string, punct: string, fns: string, trailingPunct?: string) =>
      `${before}${fns.trimStart()}${(trailingPunct || punct)[0]}`
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
      const topicWords = String(options?.topic || fm.title || 'research')
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

/**
 * Promotes/synchronizes a Stage 1 `research_summary.md` artifact into `workspace/bundle/research/<slug>.md`,
 * regenerates deterministic `index.md` files, and logs the update in `workspace/bundle/log.md`.
 */
export function syncRunToBundle(
  workspacePath: string,
  runId: string,
  options?: {
    conceptSlug?: string;
    actionOverride?: 'Creation' | 'Update' | 'Verification';
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

  const rawTitleSlug = String(doc.frontmatter.title || runId)
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
  const writeResult = writeBundleConcept(bundleRoot, conceptId, doc, { mergeExisting: true });
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
 * (by `<runId>`) or a bundle concept `.md` file, updates `meta.json`, and syncs to `workspace/bundle/`.
 */
export function verifyOkfConcept(
  runIdOrPath: string,
  options?: {
    workspaceRoot?: string;
    by?: string;
    at?: string;
  }
): {
  filePath: string;
  runId?: string;
  bundleConceptId?: string;
  status: string;
  trust_tier: TrustTier;
  is_stale: boolean;
  verified: OKFActorEvent[];
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

  const raw = fs.readFileSync(targetFilePath, 'utf-8');
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

  const existingVerified = normalizeVerified(doc.frontmatter);
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
    });
    bundleConceptId = synced?.conceptId;

    const metaPath = path.join(candidateRunDir, 'meta.json');
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
      }
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch {
      // Ignore meta update errors
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
    }
  }

  console.log(
    `[OKF Verification Gate]: Verified ${targetFilePath} (by: ${actor}, status: stable, trust_tier: ${trustTier}, is_stale: ${stale})`
  );

  return {
    filePath: targetFilePath,
    runId: detectedRunId,
    bundleConceptId,
    status: String(doc.frontmatter.status),
    trust_tier: trustTier,
    is_stale: stale,
    verified: existingVerified,
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
}
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

const OKF_VIZ_JS = `
(function () {
  if (typeof window !== "undefined" && window.__ICM_TEST_HOOKS__) {
    window.__ICM_TEST_HOOKS__.renderMarkdownWithOkfFootnotes = renderMarkdownWithOkfFootnotes;
    return;
  }
  const bundle = window.BUNDLE;
  const bundleName = window.BUNDLE_NAME;
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

  const nodeIndex = {};
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
      : {
          on: () => {},
          layout: () => ({ run: () => {} }),
          fit: () => {},
          elements: () => noopCollection,
          nodes: () => noopCollection,
          edges: () => noopCollection,
          getElementById: () => noopCollection,
          animate: () => {},
          zoom: () => 1,
        };

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
    if (nodeIndex[relResolved]) return relResolved;
    const rootCandidate = cleanHref.slice(0, -3);
    if (!cleanHref.startsWith("./") && !cleanHref.startsWith("../") && nodeIndex[rootCandidate]) {
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
    const supMap = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻" };
    const subMap = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "⁷", "8": "₈", "9": "₉", "+": "₊", "-": "₋", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ" };
    const bodyWithMath = joinedBody.replace(/\\$(?!\\s)([^$\\n]*?\\S)\\$/g, function (_, inner) {
      const cleaned = String(inner)
        .replace(/\\\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\\{([^{}]*)\\}/g, "$1")
        .replace(/\\\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\\{([^{}]*)\\}/g, "$1")
        .replace(/\\\\frac\\{\\s*([^{}]+?)\\s*\\}\\{\\s*([^{}]+?)\\s*\\}/g, "$1/$2")
        .replace(/\\\\(?:[,;:]|\\s+|quad\\b|qquad\\b)/g, " ")
        .replace(/~/g, " ")
        .replace(/\\\\!/g, "")
        .replace(/\\\\sim\\b/g, "~")
        .replace(/\\\\leftrightarrow/g, "↔")
        .replace(/\\\\Leftrightarrow/g, "⇔")
        .replace(/\\\\rightarrow|\\\\to\\b/g, "→")
        .replace(/\\\\Rightarrow/g, "⇒")
        .replace(/\\\\leftarrow/g, "←")
        .replace(/\\\\Leftarrow/g, "⇐")
        .replace(/\\\\(?:ge|geq)\\b/g, "≥")
        .replace(/\\\\(?:le|leq)\\b/g, "≤")
        .replace(/\\\\(?:neq|ne)\\b/g, "≠")
        .replace(/\\\\approx\\b/g, "≈")
        .replace(/\\\\times\\b/g, "×")
        .replace(/\\\\div\\b/g, "÷")
        .replace(/\\\\pm\\b/g, "±")
        .replace(/\\\\cdot\\b/g, "·")
        .replace(/\\\\(?:dots|ldots|cdots)\\b/g, "…")
        .replace(/\\\\infty\\b/g, "∞")
        .replace(/\\\\Delta\\b/g, "Δ")
        .replace(/\\\\delta\\b/g, "δ")
        .replace(/\\\\mu\\b/g, "μ")
        .replace(/\\\\Omega\\b/g, "Ω")
        .replace(/\\\\omega\\b/g, "ω")
        .replace(/\\\\alpha\\b/g, "α")
        .replace(/\\\\beta\\b/g, "β")
        .replace(/\\\\gamma\\b/g, "γ")
        .replace(/\\\\lambda\\b/g, "λ")
        .replace(/\\\\pi\\b/g, "π")
        .replace(/\\\\sigma\\b/g, "σ")
        .replace(/\\\\(?:circ|degree)(?![a-z])/g, "°")
        .replace(/\\%/g, "%")
        .replace(/\\^\\{\\s*(?:°|o)\\s*([CFK])?\\s*\\}|\\^°/g, "°$1")
        .replace(/\\^\\{\\s*([+-]?[0-9]+|[+-])\\s*\\}|\\^([+-]?[0-9]|[+-])(?![0-9])/g, function (_m, b, s) {
          return String(b || s).replace(/[0-9+-]/g, function (d) {
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
        .replace(/\\\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\\{([^{}]*)\\}/g, "$1")
        .replace(/\\s+/g, " ")
        .trim();
      if (!/[\\\\{}^_]/.test(cleaned)) {
        return cleaned;
      }
      return "<code>" + escapeHtmlAttr(cleaned) + "</code>";
    });
    const bodyWithSup = bodyWithMath.replace(
      /\\[\\^([A-Za-z0-9_\\-]+)\\]/g,
      '<sup class="fn-ref"><a href="#fn-$1">[$1]</a></sup>'
    );
    let html =
      typeof marked !== "undefined" && marked && typeof marked.parse === "function"
        ? marked.parse(bodyWithSup, { breaks: false, gfm: true })
        : bodyWithSup
            .replace(/\\x60(\\/[A-Za-z0-9_\\-\\/]+\\.md)\\x60/g, '<a href="$1"><code>$1</code></a>')
            .replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2">$1</a>');
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

  function showDetail(conceptId) {
    const data = nodeIndex[conceptId];
    if (!data) return;
    cy.elements().unselect();
    const node = cy.getElementById(conceptId);
    if (node) node.select();

    document.getElementById("detail-empty").hidden = true;
    const content = document.getElementById("detail-content");
    content.hidden = false;

    const chip = document.getElementById("detail-type");
    chip.textContent = data.type;
    chip.style.background = data.color || getTypeColor(data.type);

    document.getElementById("detail-title").textContent = data.label;
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
    bodyEl.innerHTML = html;
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
            '<button type="button" id="viz-stub-back-btn" style="cursor:pointer;padding:4px 10px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;font-size:12px;font-weight:600">← Tilbake til konsept</button>' +
            "</div>" +
            "<h2 style='margin:6px 0'>" +
            escapeHtmlAttr(linkLabel) +
            "</h2>" +
            "<p class='muted' style='margin:4px 0'>Konsept-ID: <code>/" +
            escapeHtmlAttr(target) +
            ".md</code></p>" +
            "<p style='margin:8px 0 0'>Dette OKF-konseptet er kryssreferert fra <code>" +
            escapeHtmlAttr(currentConceptId) +
            '</code>. Kjør <code>npm run cli:stage1 -- "' +
            escapeHtmlAttr(linkLabel) +
            '"</code> for å generere og verifisere dette konseptet i kunnskapsbunten.</p>' +
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
    bundle.nodes.find((n) => n.data.type === "Research Concept") ||
    bundle.nodes.find((n) => n.data.type === "BigQuery Dataset") ||
    bundle.nodes[0];
  if (initial) showDetail(initial.data.id);
})();
`.trim();

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

  const types = Array.from(new Set(concepts.map((c) => c.type))).sort((a, b) =>
    a.localeCompare(b)
  );
  const resolvedPalette: Record<string, string> = { ...OKF_TYPE_PALETTE };
  for (const t of types) {
    resolvedPalette[t] = getOkfTypeColor(t);
  }

  const nodes = concepts.map((c) => {
    const color = getOkfTypeColor(c.type);
    return {
      data: {
        id: c.id,
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

  const edges: Array<{ data: { id: string; source: string; target: string } }> = [];
  const seenEdges = new Set<string>();
  for (const c of concepts) {
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
  }

  const bodies: Record<string, string> = {};
  for (const c of concepts) {
    bodies[c.id] = c.body;
  }
  const graphData = {
    nodes,
    edges,
    bodies,
    types,
    palette: resolvedPalette,
  };

  const bundleName = options?.bundleName || path.basename(resolvedRoot);

  const html = `<!DOCTYPE html>
<html lang="en">
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
}

export interface A2uiSurfaceGenerationResult {
  runId: string;
  surfaceId: string;
  catalogId: string;
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
  messages: A2uiEnvelopeMessage[];
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
  };
  const subMap: Record<string, string> = {
    '0': '₀',
    '1': '₁',
    '2': '₂',
    '3': '₃',
    '4': '₄',
    '5': '₅',
    '6': '₆',
    '7': '⁷',
    '8': '₈',
    '9': '₉',
    '+': '₊',
    '-': '₋',
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
      .replace(/\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\{([^{}]*)\}/g, '$1')
      .replace(/\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\{([^{}]*)\}/g, '$1')
      .replace(/\\frac\{\s*([^{}]+?)\s*\}\{\s*([^{}]+?)\s*\}/g, '$1/$2')
      .replace(/\\(?:[,;:]|\s+|quad\b|qquad\b)/g, ' ')
      .replace(/\\!/g, '')
      .replace(/\\sim\b/g, '~')
      .replace(/\\leftrightarrow/g, '↔')
      .replace(/\\Leftrightarrow/g, '⇔')
      .replace(/\\rightarrow|\\to\b/g, '→')
      .replace(/\\Rightarrow/g, '⇒')
      .replace(/\\leftarrow/g, '←')
      .replace(/\\Leftarrow/g, '⇐')
      .replace(/\\(?:ge|geq)\b/g, '≥')
      .replace(/\\(?:le|leq)\b/g, '≤')
      .replace(/\\(?:neq|ne)\b/g, '≠')
      .replace(/\\approx\b/g, '≈')
      .replace(/\\times\b/g, '×')
      .replace(/\\div\b/g, '÷')
      .replace(/\\pm\b/g, '±')
      .replace(/\\cdot\b/g, '·')
      .replace(/\\(?:dots|ldots|cdots)\b/g, '…')
      .replace(/\\infty\b/g, '∞')
      .replace(/\\Delta\b/g, 'Δ')
      .replace(/\\delta\b/g, 'δ')
      .replace(/\\mu\b/g, 'μ')
      .replace(/\\Omega\b/g, 'Ω')
      .replace(/\\omega\b/g, 'ω')
      .replace(/\\alpha\b/g, 'α')
      .replace(/\\beta\b/g, 'β')
      .replace(/\\gamma\b/g, 'γ')
      .replace(/\\lambda\b/g, 'λ')
      .replace(/\\pi\b/g, 'π')
      .replace(/\\sigma\b/g, 'σ')
      .replace(/\\(?:circ|degree)(?![a-z])/g, '°')
      .replace(/\\%/g, '%')
      .replace(/\^\{\s*(?:°|o)\s*([CFK])?\s*\}|\^°/g, '°$1')
      .replace(
        /\^\{\s*([+-]?[0-9]+|[+-])\s*\}|\^([+-]?[0-9]|[+-])(?![0-9])/g,
        (_m, b: string, s: string) =>
          String(b || s).replace(/[0-9+-]/g, (d) => supMap[d] || d)
      )
      .replace(/_\{\s*([+-]?[0-9]+|[+-])\s*\}/g, (_m, b: string) =>
        String(b).replace(/[0-9+-]/g, (d) => subMap[d] || d)
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
        );
    }
    return out.replace(
      /\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\{([^{}]*)\}/g,
      '$1'
    );
  };

  let text = String(rawText || '').trim();
  // Remove footnote references like [^lovdata-brann], [^1]
  text = text.replace(/\[\^[^\]]+\]/g, '');
  // Process inline TeX math spans $...$ first (before unwrapping outer \text{...} so leading/trailing spaces inside \text{...} don't break $...$ matching)
  text = text.replace(/\$(?!\s)([^$\n]*?\S)\$/g, (_m, inner: string) =>
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
  const lines = String(rawMarkdown || '').split(/\r?\n/);
  const groups: A2uiChecklistGroup[] = [];
  let currentHeading = 'Sjekkliste / Action Items';
  const categoryStack: Array<{ indent: number; title: string }> = [];
  let sectionHasSubgroups = false;
  let itemCounter = 0;

  const getOrCreateGroup = (title: string): A2uiChecklistGroup => {
    const cleanTitle =
      cleanChecklistLabel(title.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/:+\s*$/, '')) || 'Generelt';
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.title === cleanTitle) {
      return lastGroup;
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
      sectionHasSubgroups = false;
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

    const contentWithoutFootnotes = rawContent.replace(/\[\^[^\]]+\]/g, '').trim();
    const isBoldColonHeader = /^\*\*[^*]+\*\*:?\s*$/.test(contentWithoutFootnotes);

    if (isBoldColonHeader || hasIndentedSubItems) {
      const headerTitle = cleanChecklistLabel(
        contentWithoutFootnotes.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/:+\s*$/, '').trim()
      );
      if (headerTitle) {
        categoryStack.push({ indent, title: headerTitle });
        sectionHasSubgroups = true;
      }
      continue;
    }

    let groupTitle = currentHeading;
    let rawItemText = rawContent;

    if (categoryStack.length > 0) {
      const stackTitle = categoryStack.map((c) => c.title).join(' — ');
      groupTitle =
        currentHeading &&
        currentHeading !== 'Sjekkliste / Action Items' &&
        !stackTitle.startsWith(currentHeading)
          ? `${currentHeading} — ${stackTitle}`
          : stackTitle;
    } else if (sectionHasSubgroups) {
      const leadBoldMatch = rawContent.match(/^\*\*([^*]+)\*\*:\s*(.+)$/);
      if (leadBoldMatch) {
        const subCategory = cleanChecklistLabel(leadBoldMatch[1]);
        groupTitle =
          currentHeading && currentHeading !== 'Sjekkliste / Action Items'
            ? `${currentHeading} — ${subCategory}`
            : subCategory;
        rawItemText = leadBoldMatch[2];
      }
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
 * Normalizes any Stage 2 `script_draft.json` payload into A2UI data model structures.
 * Works seamlessly across:
 * - Generic Stage 2 output (`{ title, scriptBody, estimatedDuration }`)
 * - Domain compliance studios (`trainingModules`, `keyTakeaways`, `boardActionItem`)
 * - Course studios (`lessons`, `learningObjectives`, `slideCues`, `quizQuestion`/`quizOptions`)
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
      highlights: [],
      modules: [],
      quiz: [],
      cases: [],
      checklistGroups: [],
    };
  }

  const title = String(
    scriptDraft.title || scriptDraft.courseTitle || fallbackTitle || 'ICM Run Studio'
  );
  const subtitle = String(scriptDraft.subtitle || scriptDraft.description || '');
  const targetAudience = String(scriptDraft.targetAudience || scriptDraft.audience || '');

  const rawMinField =
    scriptDraft.totalEstimatedMinutes ??
    scriptDraft.totalDurationMinutes ??
    scriptDraft.durationMinutes;
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

  const scriptBody = String(
    scriptDraft.scriptBody ||
      scriptDraft.executiveSummary ||
      scriptDraft.overview ||
      scriptDraft.narration ||
      ''
  );

  // Extract highlights (`keyTakeaways` or `learningObjectives`)
  const rawHighlights = Array.isArray(scriptDraft.keyTakeaways)
    ? scriptDraft.keyTakeaways
    : Array.isArray(scriptDraft.learningObjectives)
      ? scriptDraft.learningObjectives
      : Array.isArray(scriptDraft.highlights)
        ? scriptDraft.highlights
        : [];
  const highlights = rawHighlights.map((h) => String(h || '').trim()).filter(Boolean);

  // Extract modules from `trainingModules`, `modules`, `lessons`, `sections`, or `slides`
  const rawModules = Array.isArray(scriptDraft.trainingModules)
    ? scriptDraft.trainingModules
    : Array.isArray(scriptDraft.modules)
      ? scriptDraft.modules
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
        rawMod.lessonNumber ??
        rawMod.sectionNumber ??
        rawMod.slideNumber ??
        idx + 1
    );
    const modTitle = String(
      rawMod.moduleTitle ||
        rawMod.lessonTitle ||
        rawMod.sectionTitle ||
        rawMod.title ||
        `Module ${modNum}`
    );
    const subtitleOrBasis = String(
      rawMod.regulatoryBasis ||
        rawMod.legalBasis ||
        rawMod.legalReference ||
        rawMod.lawReference ||
        rawMod.statute ||
        rawMod.coreConcept ||
        rawMod.subtitle ||
        ''
    );
    const rawModDurMin =
      rawMod.durationMinutes !== undefined && rawMod.durationMinutes !== null
        ? String(rawMod.durationMinutes).trim()
        : '';
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
    const narration = String(
      rawMod.spokenNarration ||
        rawMod.narrationScript ||
        rawMod.narration ||
        rawMod.scriptBody ||
        rawMod.content ||
        rawMod.summary ||
        ''
    );
    const actionItem = String(
      rawMod.boardActionItem ||
        rawMod.actionItem ||
        rawMod.practicalTask ||
        rawMod.exercise ||
        rawMod.caseActionItem ||
        rawMod.caseResolution ||
        rawMod.recommendedAction ||
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
      actionItem,
      bullets,
    });

    // If module has an embedded quizQuestion (like icm-course-studio)
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

    // If module has a boardActionItem (or explicit caseScenario / dilemma), populate a concise situational scenario case
    const explicitCaseScenario = String(
      rawMod.caseScenario || rawMod.dilemma || rawMod.scenario || ''
    ).trim();
    const explicitCaseResolution =
      String(rawMod.caseResolution ?? '').trim() ||
      String(rawMod.recommendedAction ?? '').trim() ||
      String(rawMod.caseSolution ?? '').trim() ||
      String(rawMod.solution ?? '').trim() ||
      String(rawMod.caseActionItem ?? '').trim();
    const caseActionText = explicitCaseResolution || actionItem;
    if (caseActionText || explicitCaseScenario) {
      let synthesizedScenario = explicitCaseScenario;
      if (!synthesizedScenario) {
        const scenarioParts: string[] = [];
        const paragraphs = narration
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
          scenarioParts.push(`Utfordring / Spørsmål: ${quizQ}`);
        }
        if (bullets.length > 0) {
          const contextHeader = subtitleOrBasis
            ? `Sentrale kontrollpunkter (${subtitleOrBasis}):`
            : 'Sentrale kontrollpunkter:';
          scenarioParts.push(
            `${contextHeader}\n${bullets.slice(0, 4).map((b: string) => `• ${b}`).join('\n')}`
          );
        }
        synthesizedScenario = scenarioParts.join('\n\n') || firstPara || narration;
      }

      const quizExpl =
        typeof rawMod.quizExplanation === 'string' ? rawMod.quizExplanation.trim() : '';
      const enrichedRecommendation =
        !explicitCaseScenario && caseActionText && quizExpl
          ? `${caseActionText}\n\n📌 Faglig begrunnelse: ${quizExpl}`
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
      const rawDm = rm?.durationMinutes;
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

  // Synthesize highlights from modules if top-level keyTakeaways / learningObjectives / highlights is empty
  if (highlights.length === 0 && modules.length > 0) {
    for (let idx = 0; idx < modules.length; idx++) {
      const m = modules[idx];
      const basisPart = m.subtitleOrBasis ? ` (${m.subtitleOrBasis})` : '';
      const actionPart = m.actionItem ? ` — ${m.actionItem}` : '';
      highlights.push(`Modul ${idx + 1}: ${m.title}${basisPart}${actionPart}`);
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

  // Top-level `cases` or `scenarios` array
  const rawCasesList = Array.isArray(scriptDraft.cases)
    ? scriptDraft.cases
    : Array.isArray(scriptDraft.scenarios)
      ? scriptDraft.scenarios
      : [];
  rawCasesList.forEach((c: any, idx: number) => {
    if (!c || typeof c !== 'object') return;
    cases.push({
      id: `case_${idx + 1}`,
      title: String(c.title || c.caseTitle || `Scenario ${idx + 1}`),
      basisOrContext: String(
        c.regulatoryBasis || c.legalBasis || c.legalReference || c.statute || c.context || c.category || ''
      ),
      scenario: String(c.scenario || c.caseScenario || c.dilemma || c.description || c.prompt || ''),
      recommendedAction: String(
        c.recommendedAction || c.caseResolution || c.resolution || c.solution || c.boardActionItem || ''
      ),
    });
  });

  // Top-level `checklistGroups` (`{ category, items: string[] }[]`)
  const checklistGroups: A2uiChecklistGroup[] = [];
  if (Array.isArray(scriptDraft.checklistGroups)) {
    let chkCounter = 0;
    scriptDraft.checklistGroups.forEach((rawGrp: any, gIdx: number) => {
      if (!rawGrp || typeof rawGrp !== 'object') return;
      const grpTitle =
        cleanChecklistLabel(
          String(rawGrp.category || rawGrp.title || rawGrp.groupTitle || `Gruppe ${gIdx + 1}`)
        ) || `Gruppe ${gIdx + 1}`;
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

/**
 * Updates an RFC 6901 JSON Pointer path (`/a/b/0`) on a root data model object in-place.
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
      Object.assign(rootModel, value);
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
    current[lastSeg] = value;
  }
}

/**
 * Validates an array of A2UI v0.9.1 server-to-client messages for protocol structural integrity:
 * - Envelope version === 'v0.9.1'
 * - Exactly one of `createSurface`, `updateComponents`, `updateDataModel`, or `deleteSurface` per message
 * - `createSurface` precedes `updateComponents`, `updateDataModel`, and `deleteSurface` for the same `surfaceId`,
 *   and duplicate `createSurface` without an intervening `deleteSurface` is rejected
 * - Component adjacency list contains a `root` component (`id: "root"`), no duplicate IDs,
 *   all child component ID references exist, and there are no circular parent-child references.
 */
export function validateA2uiSurfaceMessages(messages: A2uiEnvelopeMessage[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const createdSurfaces = new Set<string>();

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
  if (typeof window !== "undefined" && window.__ICM_TEST_HOOKS__) {
    window.__ICM_TEST_HOOKS__.formatInlineLatexAndFootnotes = formatInlineLatexAndFootnotes;
    window.__ICM_TEST_HOOKS__.cleanClientChecklistLabel = cleanClientChecklistLabel;
    window.__ICM_TEST_HOOKS__.extractChecklistGroupsClient = extractChecklistGroupsClient;
    return;
  }
  const payload = window.A2UI_SURFACE_PAYLOAD;
  const messages = payload.messages || [];
  const bundleGraph = payload.bundleGraph || { nodes: [], edges: [], bodies: {}, types: [], palette: {} };

  // A2UI Client Surface State (Adjacency List + RFC 6901 JSON Pointer Data Model)
  const surfaces = {};
  const actionLog = [];
  let activeSurfaceId = payload.surfaceId || "icm_run_studio";

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
    if (!fullPointer || fullPointer === "/") {
      for (const k of Object.keys(root)) {
        delete root[k];
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(root, value);
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
    if (value === undefined) {
      if (Array.isArray(cur) && /^\\d+$/.test(lastPart)) {
        cur[Number(lastPart)] = undefined;
      } else if (cur && typeof cur === "object") {
        delete cur[lastPart];
      }
    } else {
      cur[lastPart] = value;
    }
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
        theme: s.theme || {},
        sendDataModel: !!s.sendDataModel,
        components: {},
        dataModel: {},
        uiState: { activeTabs: {} },
      };
      activeSurfaceId = s.surfaceId;
    } else if (msg.updateComponents) {
      const s = surfaces[msg.updateComponents.surfaceId];
      if (!s) return;
      for (const c of msg.updateComponents.components || []) {
        s.components[c.id] = c;
      }
    } else if (msg.updateDataModel) {
      const s = surfaces[msg.updateDataModel.surfaceId];
      if (!s) return;
      const p = msg.updateDataModel.path || "/";
      setPointer(s.dataModel, p, msg.updateDataModel.value);
    } else if (msg.deleteSurface) {
      delete surfaces[msg.deleteSurface.surfaceId];
    }
  }

  for (const m of messages) {
    processMessage(m);
  }

  function stopActiveSpeech() {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }

  function cleanClientChecklistLabel(rawText) {
    const supMap = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻" };
    const subMap = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "⁷", "8": "₈", "9": "₉", "+": "₊", "-": "₋", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ" };
    function cleanLatexFrag(frag, isInsideMathSpan) {
      let out = String(frag || "")
        .replace(/\\\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\\{([^{}]*)\\}/g, "$1")
        .replace(/\\\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\\{([^{}]*)\\}/g, "$1")
        .replace(/\\\\frac\\{\\s*([^{}]+?)\\s*\\}\\{\\s*([^{}]+?)\\s*\\}/g, "$1/$2")
        .replace(/\\\\(?:[,;:]|\\s+|quad\\b|qquad\\b)/g, " ")
        .replace(/\\\\!/g, "")
        .replace(/\\\\sim\\b/g, "~")
        .replace(/\\\\leftrightarrow/g, "↔")
        .replace(/\\\\Leftrightarrow/g, "⇔")
        .replace(/\\\\rightarrow|\\\\to\\b/g, "→")
        .replace(/\\\\Rightarrow/g, "⇒")
        .replace(/\\\\leftarrow/g, "←")
        .replace(/\\\\Leftarrow/g, "⇐")
        .replace(/\\\\(?:ge|geq)\\b/g, "≥")
        .replace(/\\\\(?:le|leq)\\b/g, "≤")
        .replace(/\\\\(?:neq|ne)\\b/g, "≠")
        .replace(/\\\\approx\\b/g, "≈")
        .replace(/\\\\times\\b/g, "×")
        .replace(/\\\\div\\b/g, "÷")
        .replace(/\\\\pm\\b/g, "±")
        .replace(/\\\\cdot\\b/g, "·")
        .replace(/\\\\(?:dots|ldots|cdots)\\b/g, "…")
        .replace(/\\\\infty\\b/g, "∞")
        .replace(/\\\\Delta\\b/g, "Δ")
        .replace(/\\\\delta\\b/g, "δ")
        .replace(/\\\\mu\\b/g, "μ")
        .replace(/\\\\Omega\\b/g, "Ω")
        .replace(/\\\\omega\\b/g, "ω")
        .replace(/\\\\alpha\\b/g, "α")
        .replace(/\\\\beta\\b/g, "β")
        .replace(/\\\\gamma\\b/g, "γ")
        .replace(/\\\\lambda\\b/g, "λ")
        .replace(/\\\\pi\\b/g, "π")
        .replace(/\\\\sigma\\b/g, "σ")
        .replace(/\\\\(?:circ|degree)(?![a-z])/g, "°")
        .replace(/\\%/g, "%")
        .replace(/\\^\\{\\s*(?:°|o)\\s*([CFK])?\\s*\\}|\\^°/g, "°$1")
        .replace(/\\^\\{\\s*([+-]?[0-9]+|[+-])\\s*\\}|\\^([+-]?[0-9]|[+-])(?![0-9])/g, function (_m, b, s) {
          return String(b || s).replace(/[0-9+-]/g, function (d) {
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
          });
      }
      return out.replace(/\\\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\\{([^{}]*)\\}/g, "$1");
    }

    let text = String(rawText || "").trim();
    text = text.replace(/\\[\\^[^\\]]+\\]/g, "");
    text = text.replace(/\\$(?!\\s)([^$\\n]*?\\S)\\$/g, function (_m, inner) {
      return cleanLatexFrag(inner, true).trim();
    });
    text = cleanLatexFrag(text, false);
    text = text.replace(/\\b(CO|H|O|N|SO|NO|CH|A|B|R|EI|REI)_([0-9]|x)(?![a-zA-Z0-9])/g, function (_m, prefix, s) {
      return prefix + (subMap[s] || s);
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
    const lines = String(rawMarkdown || "").split(/\\r?\\n/);
    const groups = [];
    let currentHeading = "Sjekkliste / Action Items";
    const categoryStack = [];
    let sectionHasSubgroups = false;
    let itemCounter = 0;

    function getOrCreateGroup(title) {
      const cleanTitle =
        cleanClientChecklistLabel(title.replace(/\\*\\*([^*]+)\\*\\*/g, "$1").replace(/:+\\s*$/, "")) || "Generelt";
      const lastGroup = groups[groups.length - 1];
      if (lastGroup && lastGroup.title === cleanTitle) {
        return lastGroup;
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
        sectionHasSubgroups = false;
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

      const contentWithoutFootnotes = rawContent.replace(/\\[\\^[^\\]]+\\]/g, "").trim();
      const isBoldColonHeader = /^\\*\\*[^*]+\\*\\*:?\\s*$/.test(contentWithoutFootnotes);

      if (isBoldColonHeader || hasIndentedSubItems) {
        const headerTitle = cleanClientChecklistLabel(
          contentWithoutFootnotes.replace(/\\*\\*([^*]+)\\*\\*/g, "$1").replace(/:+\\s*$/, "").trim()
        );
        if (headerTitle) {
          categoryStack.push({ indent: indent, title: headerTitle });
          sectionHasSubgroups = true;
        }
        continue;
      }

      let groupTitle = currentHeading;
      let rawItemText = rawContent;

      if (categoryStack.length > 0) {
        const stackTitle = categoryStack.map((c) => c.title).join(" — ");
        groupTitle =
          currentHeading &&
          currentHeading !== "Sjekkliste / Action Items" &&
          !stackTitle.startsWith(currentHeading)
            ? currentHeading + " — " + stackTitle
            : stackTitle;
      } else if (sectionHasSubgroups) {
        const leadBoldMatch = rawContent.match(/^\\*\\*([^*]+)\\*\\*:\\s*(.+)$/);
        if (leadBoldMatch) {
          const subCategory = cleanClientChecklistLabel(leadBoldMatch[1]);
          groupTitle =
            currentHeading && currentHeading !== "Sjekkliste / Action Items"
              ? currentHeading + " — " + subCategory
              : subCategory;
          rawItemText = leadBoldMatch[2];
        }
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
    if (
      resolvePointer(surface.dataModel, "/checklist/fromStage2") &&
      !resolvePointer(surface.dataModel, "/okf/viewingStubConcept")
    ) {
      return;
    }
    const targetBodyPath = resolvePointer(surface.dataModel, "/okf/viewingStubConcept")
      ? "/okf/primaryBody"
      : "/okf/body";
    const body = resolvePointer(surface.dataModel, targetBodyPath);
    if (typeof body !== "string" || !body) return;
    const groups = resolvePointer(surface.dataModel, "/checklist/groups") || [];
    const flatChecked = [];
    for (const g of groups) {
      for (const it of g.items || []) {
        flatChecked.push(Boolean(it.checked));
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
      const contentWithoutFootnotes = rawContent.replace(/\\[\\^[^\\]]+\\]/g, "").trim();
      const isBoldColonHeader = /^\\*\\*[^*]+\\*\\*:?\\s*$/.test(contentWithoutFootnotes);
      if (isBoldColonHeader || hasIndentedSubItems) {
        continue;
      }
      if (leafIdx < flatChecked.length) {
        lines[i] = m[1] + (flatChecked[leafIdx] ? "x" : " ") + m[3] + m[4];
        leafIdx++;
      }
    }
    setPointer(surface.dataModel, targetBodyPath, lines.join("\\n"));
  }

  function syncOkfBodyToChecklist(surface) {
    if (
      resolvePointer(surface.dataModel, "/checklist/fromStage2") &&
      !resolvePointer(surface.dataModel, "/okf/viewingStubConcept")
    ) {
      return;
    }
    const body = resolvePointer(surface.dataModel, "/okf/body");
    if (typeof body !== "string") return;
    const newGroups = extractChecklistGroupsClient(body);
    if (newGroups.length > 0) {
      setPointer(surface.dataModel, "/checklist/groups", newGroups);
      recomputeChecklistSummary(surface);
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
    setPointer(surface.dataModel, "/checklist/completedCount", completed);
    setPointer(surface.dataModel, "/checklist/totalCount", total);
    setPointer(surface.dataModel, "/checklist/percent", pct);
    setPointer(
      surface.dataModel,
      "/checklist/summaryText",
      completed + " / " + total + " fullført (" + pct + "%)"
    );
  }

  function speakNarration(text) {
    if (!window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(String(text));
    const hasNorwegianChars = /[æøåÆØÅ]/.test(text) || /\\b(og|det|som|for|med|styret|brann)\\b/i.test(text);
    utter.lang = hasNorwegianChars ? "nb-NO" : "en-US";
    window.speechSynthesis.speak(utter);
  }

  function downloadJson(filename, content) {
    const blob = new Blob([content], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }

  function formatInlineLatexAndFootnotes(md, sources) {
    const supMap = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻" };
    const subMap = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "⁷", "8": "₈", "9": "₉", "+": "₊", "-": "₋", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ" };
    let out = String(md || "");
    // Strip redundant leading H1 heading (# <Title>) since the concept title is already rendered in the card/panel header
    out = out.replace(/^\\s*#\\s+[^\\r\\n]+(?:\\r?\\n+---(?=\\r?\\n|$))?\\r?\\n*/, "");
    // Strip standalone bottom footnote definitions ([^id]: Title) so they don't render as raw lines below prose
    out = out.replace(/^\\s*\\[\\^([A-Za-z0-9_\\-]+)\\]:\\s*(.+)$/gm, "");
    out = out.replace(/\\r?\\n+---\\s*$/g, "");
    out = out.replace(/(?:\\r?\\n+---)?\\r?\\n+#{1,4}\\s+(?:\\*\\*|__)?(?:\\d+(?:\\.\\d+)*\\.?\\s+)?(?:Sources?(?:\\s*(?:&|and|\\/)\\s*(?:Citations?|Footnotes?|References?))?|References?(?:\\s*(?:&|and|\\/)\\s*(?:Footnotes?|Citations?|Sources?))?|Citations?(?:\\s*(?:&|and|\\/)\\s*(?:Footnotes?|References?))?|Footnotes?(?:\\s*(?:&|and|\\/)\\s*(?:References?|Sources?))?|Grounded\\s+Search\\s+References|Kildehenvisninger(?:\\s*(?:og|&|\\/)\\s*(?:referanser|fotnoter))?|Kilder(?:\\s*(?:og|&|\\/)\\s*(?:referanser|fotnoter|kildehenvisninger))?|Kildeliste(?:\\s*(?:og|&|\\/)\\s*fotnoter)?|Referanser(?:\\s*(?:og|&|\\/)\\s*(?:fotnoter|kilder))?|Referanseliste(?:\\s*(?:og|&|\\/)\\s*fotnoter)?|Fotnoter(?:\\s*(?:og|&|\\/)\\s*(?:kilder|referanser))?):?(?:\\*\\*|__)?(?:\\r?\\n+---)?\\s*$/i, "");
    out = out.replace(/\\r?\\n+---\\s*$/g, "").trim();
    // Format inline TeX math spans ($...$)
    out = out.replace(/\\$(?!\\s)([^$\\n]*?\\S)\\$/g, function (_, inner) {
      const cleaned = String(inner)
        .replace(/\\\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\\{([^{}]*)\\}/g, "$1")
        .replace(/\\\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\\{([^{}]*)\\}/g, "$1")
        .replace(/\\\\frac\\{\\s*([^{}]+?)\\s*\\}\\{\\s*([^{}]+?)\\s*\\}/g, "$1/$2")
        .replace(/\\\\(?:[,;:]|\\s+|quad\\b|qquad\\b)/g, " ")
        .replace(/~/g, " ")
        .replace(/\\\\!/g, "")
        .replace(/\\\\sim\\b/g, "~")
        .replace(/\\\\leftrightarrow/g, "↔")
        .replace(/\\\\Leftrightarrow/g, "⇔")
        .replace(/\\\\rightarrow|\\\\to\\b/g, "→")
        .replace(/\\\\Rightarrow/g, "⇒")
        .replace(/\\\\leftarrow/g, "←")
        .replace(/\\\\Leftarrow/g, "⇐")
        .replace(/\\\\(?:ge|geq)\\b/g, "≥")
        .replace(/\\\\(?:le|leq)\\b/g, "≤")
        .replace(/\\\\(?:neq|ne)\\b/g, "≠")
        .replace(/\\\\approx\\b/g, "≈")
        .replace(/\\\\times\\b/g, "×")
        .replace(/\\\\div\\b/g, "÷")
        .replace(/\\\\pm\\b/g, "±")
        .replace(/\\\\cdot\\b/g, "·")
        .replace(/\\\\(?:dots|ldots|cdots)\\b/g, "…")
        .replace(/\\\\infty\\b/g, "∞")
        .replace(/\\\\Delta\\b/g, "Δ")
        .replace(/\\\\delta\\b/g, "δ")
        .replace(/\\\\mu\\b/g, "μ")
        .replace(/\\\\Omega\\b/g, "Ω")
        .replace(/\\\\omega\\b/g, "ω")
        .replace(/\\\\alpha\\b/g, "α")
        .replace(/\\\\beta\\b/g, "β")
        .replace(/\\\\gamma\\b/g, "γ")
        .replace(/\\\\lambda\\b/g, "λ")
        .replace(/\\\\pi\\b/g, "π")
        .replace(/\\\\sigma\\b/g, "σ")
        .replace(/\\\\(?:circ|degree)(?![a-z])/g, "°")
        .replace(/\\%/g, "%")
        .replace(/\\^\\{\\s*(?:°|o)\\s*([CFK])?\\s*\\}|\\^°/g, "°$1")
        .replace(/\\^\\{\\s*([+-]?[0-9]+|[+-])\\s*\\}|\\^([+-]?[0-9]|[+-])(?![0-9])/g, function (_m, b, s) {
          return String(b || s).replace(/[0-9+-]/g, function (d) {
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
        .replace(/\\\\(?:text|mathrm|textbf|textit|mathit|mathsf|emph|operatorname)\\{([^{}]*)\\}/g, "$1")
        .replace(/\\s+/g, " ")
        .trim();
      if (!/[\\\\{}^_]/.test(cleaned)) {
        return cleaned;
      }
      return "<code>" + escapeHtml(cleaned) + "</code>";
    });
    out = out.replace(/\\x60(\\/[A-Za-z0-9_\\-\\/]+\\.md)\\x60/g, '<a href="$1"><code>$1</code></a>');
    out = out.replace(/\\[\\^([^\\]]+)\\]/g, function (_, id) {
      const safeId = escapeHtml(id);
      return '<sup class="fn-ref"><a href="#okf-src-' + safeId + '" data-fn="' + safeId + '">[' + safeId + "]</a></sup>";
    });
    if (!window.marked) {
      out = out.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2">$1</a>');
      out = out.replace(/^(\\s*[-*+]\\s+)\\[([ xX])\\]\\s+(.+)$/gm, function (_, prefix, mark, text) {
        const isChecked = mark.toLowerCase() === "x" ? " checked" : "";
        return prefix + '<input type="checkbox" disabled' + isChecked + "> " + text;
      });
    }
    return out;
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
      if (comp.markdown && window.marked) {
        el.innerHTML = window.marked.parse(formatInlineLatexAndFootnotes(rawText, []));
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
        playBtn.textContent = "🔊 Spill av opplesning (" + desc + ")";
        playBtn.addEventListener("click", () => speakNarration(textToSpeak));
        const stopBtn = document.createElement("button");
        stopBtn.className = "a2ui-btn";
        stopBtn.textContent = "⏹ Stopp";
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
        closeBtn.textContent = "Lukk";
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
      titleEl.textContent = String(resolveDynamic(comp.title, surface, scopeData) || "Interaktiv Sjekkliste");
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
      checkAllBtn.textContent = "✓ Marker alle";
      checkAllBtn.addEventListener("click", () => dispatchClientAction(surface, comp.id, "checkAllChecklist", {}));
      const resetBtn = document.createElement("button");
      resetBtn.className = "a2ui-btn";
      resetBtn.textContent = "↺ Nullstill sjekkliste";
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
      const wrap = document.createElement("div");
      wrap.className = "a2ui-col";
      const modules = resolvePointer(surface.dataModel, comp.modulesPath || "/stage2/modules") || [];
      const activeIdxPath = comp.activeIndexPath || "/stage2/activeModuleIndex";
      let idx = Number(resolvePointer(surface.dataModel, activeIdxPath) || 0);
      if (idx < 0 || idx >= modules.length) idx = 0;

      if (modules.length === 0) {
        const empty = document.createElement("div");
        empty.className = "a2ui-card a2ui-caption";
        empty.textContent = "Ingen moduler funnet i Stage 2-artefaktet.";
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
      h2.textContent = "Modul " + (mod.number || idx + 1) + ": " + mod.title;
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
        narBox.className = "a2ui-body";
        narBox.style.padding = "14px 16px";
        narBox.style.background = "var(--bg)";
        narBox.style.borderRadius = "8px";
        narBox.style.borderLeft = "4px solid var(--primary)";
        narBox.textContent = mod.narration;
        card.appendChild(narBox);

        const ttsPlayer = renderComponent(surface, {
          id: comp.id + "_tts_" + idx,
          component: "AudioPlayer",
          url: "tts://web-speech/module/" + (idx + 1),
          description: mod.title,
          ttsText: mod.narration,
        });
        card.appendChild(ttsPlayer);
      }

      if (Array.isArray(mod.bullets) && mod.bullets.length > 0) {
        const ulWrap = document.createElement("div");
        ulWrap.className = "a2ui-col";
        const h4 = document.createElement("h4");
        h4.className = "a2ui-h4";
        h4.textContent = "Nøkkelpunkter / Lysbilder";
        ulWrap.appendChild(h4);
        const ul = document.createElement("ul");
        ul.style.margin = "0";
        mod.bullets.forEach((bText) => {
          const li = document.createElement("li");
          li.textContent = bText;
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
        actBox.innerHTML =
          "<strong>⚡ Praktisk tiltak / Handlingspunkt:</strong><div style='margin-top:4px'>" +
          escapeHtml(mod.actionItem) +
          "</div>";
        card.appendChild(actBox);
      }

      const pager = document.createElement("div");
      pager.className = "a2ui-row justify-between";
      const prevBtn = document.createElement("button");
      prevBtn.className = "a2ui-btn";
      prevBtn.disabled = idx === 0;
      prevBtn.textContent = "← Forrige modul";
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
      nextBtn.textContent = "Neste modul →";
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
      scoreTitle.textContent = String(resolveDynamic(comp.title, surface, scopeData) || "Kunnskapssjekk");
      const scoreBadge = document.createElement("span");
      scoreBadge.className = "a2ui-badge " + (correctCount === questions.length && questions.length > 0 ? "success" : "primary");
      scoreBadge.textContent = "Resultat: " + correctCount + " / " + questions.length + " riktige (" + answeredCount + " besvart)";
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
        qHead.textContent = (qIdx + 1) + ". " + q.question;
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
            (isRight ? "✓ Riktig svar!" : "✗ Ikke helt.") +
            "</strong> " +
            escapeHtml(q.explanation || "");
          qCard.appendChild(fb);
        }
        wrap.appendChild(qCard);
      });
      return wrap;
    }

    if (type === "CaseSimulator") {
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
        h3.textContent = "Case " + (cIdx + 1) + ": " + c.title;
        top.appendChild(h3);
        if (c.basisOrContext) {
          const b = document.createElement("span");
          b.className = "a2ui-badge accent";
          b.textContent = c.basisOrContext;
          top.appendChild(b);
        }
        card.appendChild(top);

        const scen = document.createElement("div");
        scen.className = "a2ui-body";
        scen.textContent = c.scenario;
        card.appendChild(scen);

        const tf = renderComponent(surface, {
          id: comp.id + "_input_" + c.id,
          component: "TextField",
          variant: "longText",
          label: "Ditt løsningsforslag / handlingsplan (lagres i A2UI Data Model):",
          placeholder: "Beskriv din vurdering og foreslåtte tiltak her...",
          value: { path: responsesPath + "/" + c.id },
        });
        card.appendChild(tf);

        if (c.recommendedAction) {
          const toggleBtn = document.createElement("button");
          toggleBtn.className = "a2ui-btn";
          const isRev = Boolean(revealed[c.id]);
          toggleBtn.textContent = isRev ? "Skjul anbefalt tiltak" : "Vis anbefalt tiltak (Fasit)";
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
            rec.innerHTML =
              "<strong>⚡ Anbefalt tiltak & Løsning:</strong><div style='margin-top:6px;white-space:pre-wrap'>" +
              escapeHtml(c.recommendedAction) +
              "</div>";
            card.appendChild(rec);
          }
        }
        wrap.appendChild(card);
      });
      return wrap;
    }

    if (type === "OkfMarkdown") {
      const wrap = document.createElement("div");
      wrap.className = "okf-md-container";
      const bodyMd = String(resolveDynamic(comp.body, surface, scopeData) || "");
      const sources = resolveDynamic(comp.sources, surface, scopeData) || [];
      const trustTier = String(resolveDynamic(comp.trustTier, surface, scopeData) || "unverified");
      const isStale = Boolean(resolveDynamic(comp.isStale, surface, scopeData));
      const editModePath = "/okf/editMode";
      const isEditing = Boolean(resolvePointer(surface.dataModel, editModePath));
      const viewingStub = Boolean(resolvePointer(surface.dataModel, "/okf/viewingStubConcept"));

      const mainCard = document.createElement("div");
      mainCard.className = "a2ui-card a2ui-col";
      const toolbar = document.createElement("div");
      toolbar.className = "a2ui-row justify-between";
      const leftHead = document.createElement("div");
      leftHead.className = "a2ui-row";
      const tTitle = document.createElement("h3");
      tTitle.className = "a2ui-h3";
      tTitle.textContent = String(resolveDynamic(comp.title, surface, scopeData) || "Stage 1 OKF v0.2 Kunnskapsgrunnlag");
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
        const backPrimaryBtn = document.createElement("button");
        backPrimaryBtn.className = "a2ui-btn primary";
        backPrimaryBtn.id = "okf-md-back-primary-btn";
        backPrimaryBtn.textContent = "← Tilbake til hovedkonsept";
        backPrimaryBtn.addEventListener("click", () => {
          const origBody = resolvePointer(surface.dataModel, "/okf/primaryBody");
          const origTitle = resolvePointer(surface.dataModel, "/okf/primaryTitle");
          if (origBody !== undefined) {
            setPointer(surface.dataModel, "/okf/body", origBody);
          }
          if (origTitle !== undefined) {
            setPointer(surface.dataModel, "/okf/title", origTitle);
          }
          setPointer(surface.dataModel, "/okf/viewingStubConcept", false);
          syncOkfBodyToChecklist(surface);
          renderSurface();
        });
        rightActions.appendChild(backPrimaryBtn);
      }

      const editBtn = document.createElement("button");
      editBtn.className = "a2ui-btn";
      editBtn.textContent = isEditing ? "👁 Forhåndsvis OKF Markdown" : "✏️ Rediger Layer 4 Markdown";
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
          label: "Redigerbar OKF v0.2 Markdown (oppdaterer A2UI Data Model og Sjekkliste direkte):",
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
        const formatted = formatInlineLatexAndFootnotes(bodyMd, sources);
        mdBody.innerHTML = window.marked ? window.marked.parse(formatted) : formatted;
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
          if (href.startsWith("/") || href.endsWith(".md")) {
            const conceptId = href.replace(/^\\/+/, "").replace(/\\.md$/i, "");
            a.style.color = "var(--accent)";
            a.style.fontWeight = "600";
            a.addEventListener("click", (e) => {
              e.preventDefault();
              if (!resolvePointer(surface.dataModel, "/okf/viewingStubConcept")) {
                setPointer(surface.dataModel, "/okf/primaryBody", resolvePointer(surface.dataModel, "/okf/body") || "");
                setPointer(surface.dataModel, "/okf/primaryTitle", resolvePointer(surface.dataModel, "/okf/title") || "");
              }
              const targetBody =
                (bundleGraph.bodies && bundleGraph.bodies[conceptId]) ||
                "# " +
                  (a.textContent || conceptId).trim() +
                  "\\n\\n*Dette OKF-konseptet (\\x60/" +
                  conceptId +
                  ".md\\x60) er kryssreferert fra hovedkonseptet.*";
              const primaryBody = resolvePointer(surface.dataModel, "/okf/primaryBody");
              if (primaryBody && targetBody === primaryBody) {
                setPointer(surface.dataModel, "/okf/body", primaryBody);
                setPointer(
                  surface.dataModel,
                  "/okf/title",
                  resolvePointer(surface.dataModel, "/okf/primaryTitle") || conceptId
                );
                setPointer(surface.dataModel, "/okf/viewingStubConcept", false);
              } else {
                setPointer(surface.dataModel, "/okf/body", targetBody);
                setPointer(surface.dataModel, "/okf/title", conceptId);
                setPointer(surface.dataModel, "/okf/viewingStubConcept", true);
              }
              syncOkfBodyToChecklist(surface);
              renderSurface();
            });
          }
        });
        mainCard.appendChild(mdBody);
      }

      const sideCard = document.createElement("div");
      sideCard.className = "a2ui-card a2ui-col";
      const sHead = document.createElement("h3");
      sHead.className = "a2ui-h3";
      sHead.textContent = "Kilder & Sporbarhet (" + sources.length + ")";
      sideCard.appendChild(sHead);

      const srcList = document.createElement("div");
      sources.forEach((src) => {
        const sc = document.createElement("div");
        sc.className = "okf-source-card";
        const safeId = escapeHtml(src.id || "src");
        const rawUrl = src.url || src.resource || "";
        const safeTitle = escapeHtml(src.title || rawUrl || "");
        const safeUrl = rawUrl ? escapeHtml(rawUrl) : "";
        const strippedUrl = rawUrl ? rawUrl.replace(/^https?:[/][/](www[.])?/i, "") : "";
        const shortUrl = strippedUrl
          ? escapeHtml(strippedUrl.slice(0, 68) + (strippedUrl.length > 68 ? "…" : ""))
          : "";
        sc.id = "okf-src-" + (src.id || "src");
        sc.innerHTML =
          "<div><strong>[^" +
          safeId +
          "]</strong> " +
          (safeUrl
            ? '<a href="' +
              safeUrl +
              '" target="_blank" rel="noopener noreferrer" style="color:var(--primary);font-weight:600;text-decoration:none">' +
              safeTitle +
              " ↗</a>"
            : safeTitle) +
          "</div>" +
          (safeUrl
            ? '<div style="margin-top:2px;font-size:11px;word-break:break-all"><a href="' +
              safeUrl +
              '" target="_blank" rel="noopener noreferrer" style="color:var(--text-muted)">' +
              shortUrl +
              "</a></div>"
            : "") +
          "<div>" +
          (src.retrieved_at ? '<span class="src-chip retrieved">retrieved: ' + escapeHtml(src.retrieved_at) + "</span>" : "") +
          (src.last_modified ? '<span class="src-chip modified">modified: ' + escapeHtml(src.last_modified) + "</span>" : "") +
          "</div>";
        srcList.appendChild(sc);
      });
      sideCard.appendChild(srcList);

      wrap.appendChild(mainCard);
      wrap.appendChild(sideCard);
      return wrap;
    }

    if (type === "OkfKnowledgeGraph") {
      const wrap = document.createElement("div");
      wrap.className = "a2ui-col";
      const split = document.createElement("div");
      split.className = "okf-graph-split";
      const canvas = document.createElement("div");
      canvas.className = "okf-graph-canvas";
      const detail = document.createElement("div");
      detail.className = "okf-graph-detail";
      detail.id = "okf-graph-detail-view";
      detail.innerHTML = '<div class="a2ui-caption">Klikk på en OKF-node i grafen for å inspisere konseptet og relasjoner.</div>';
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
        const formattedBody = formatInlineLatexAndFootnotes(rawBody, []);
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
            '<button type="button" class="a2ui-btn" id="okf-graph-back-btn" style="padding:4px 10px;font-size:12px">← Tilbake til konsept</button>' +
            "</div>" +
            '<h3 class="a2ui-h3" style="margin-top:6px">' +
            escapeHtml(displayTitle) +
            "</h3>" +
            (d.description
              ? '<p class="a2ui-caption" style="margin-top:4px;word-break:break-all"><a href="' +
                escapeHtml(d.description) +
                '" target="_blank" rel="noopener noreferrer" style="color:var(--primary);font-weight:600">' +
                escapeHtml(d.description) +
                " ↗</a></p>"
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
          headerHtml =
            (isSubNode
              ? '<div class="a2ui-row justify-between" style="margin-bottom:6px">' +
                badgesHtml +
                '<button type="button" class="a2ui-btn" id="okf-graph-back-btn" style="padding:4px 10px;font-size:12px">← Tilbake til konsept</button>' +
                "</div>"
              : '<div style="margin-bottom:6px">' + badgesHtml + "</div>") +
            '<h3 class="a2ui-h3" style="margin-top:8px">' +
            escapeHtml(displayTitle) +
            "</h3>" +
            '<p class="a2ui-caption" style="margin-top:4px">' +
            escapeHtml(d.description || "") +
            "</p>";
        }

        detail.innerHTML =
          headerHtml +
          "<hr class='a2ui-divider'>" +
          '<div class="okf-md-body">' +
          (window.marked ? window.marked.parse(formattedBody) : formattedBody) +
          "</div>";

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
            const srcNodeId = "source:" + fnId;
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
          if (href.startsWith("/") || href.endsWith(".md")) {
            a.style.color = "var(--accent)";
            a.style.fontWeight = "600";
            a.addEventListener("click", (ev) => {
              ev.preventDefault();
              const conceptId = href.replace(/^\\/+/, "").replace(/\\.md$/i, "");
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
      const initialNodeWrapper =
        nodesList.find((n) => n.group === "concept" || (n.data && n.data.group === "concept")) || nodesList[0];
      if (initialNodeWrapper && initialNodeWrapper.data) {
        renderGraphNodeDetail(initialNodeWrapper.data);
      }

      setTimeout(() => {
        if (!window.cytoscape) {
          canvas.innerHTML = '<div style="padding:20px" class="a2ui-caption">Cytoscape.js ikke lastet (offline). Antall noder i bundle: ' + (bundleGraph.nodes || []).length + "</div>";
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

  // Resolve target run directory
  let resolvedRunDir = '';
  let resolvedRunId = options.runId || '';

  if (resolvedRunId && fs.existsSync(resolvedRunId) && fs.statSync(resolvedRunId).isDirectory()) {
    resolvedRunDir = path.resolve(resolvedRunId);
    resolvedRunId = path.basename(resolvedRunDir);
  } else if (resolvedRunId) {
    resolvedRunDir = path.join(runsRoot, resolvedRunId);
  } else if (fs.existsSync(runsRoot)) {
    const candidates = fs
      .readdirSync(runsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== '_dry_run')
      .map((d) => ({
        name: d.name,
        mtime: fs.statSync(path.join(runsRoot, d.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    if (candidates.length > 0) {
      resolvedRunId = candidates[0].name;
      resolvedRunDir = path.join(runsRoot, resolvedRunId);
    }
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
    const rawTitleSlug = String(okfDoc.frontmatter.title || resolvedRunId)
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

  const fallbackTitle = String(
    okfDoc.frontmatter.title || meta.topic || resolvedRunId || 'ICM Studio Surface'
  );
  const stage2Norm = normalizeStage2ForA2ui(rawStage2, fallbackTitle);
  const mdChecklistGroups = extractChecklistGroupsFromMarkdown(okfDoc.body);
  const checklistFromStage2 = stage2Norm.checklistGroups.length > 0;
  const checklistGroups = checklistFromStage2
    ? stage2Norm.checklistGroups
    : mdChecklistGroups;

  let totalChecklistItems = 0;
  for (const g of checklistGroups) {
    totalChecklistItems += g.items.length;
  }

  // Collect OKF Bundle Graph Data for OkfKnowledgeGraph
  const concepts = fs.existsSync(bundleRoot) ? walkBundleConcepts(bundleRoot) : [];
  if (concepts.length === 0 && okfDoc.body) {
    const synthId = `research/${resolvedRunId || 'current'}`;
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
      color: getOkfTypeColor(c.type),
      size: 32 + Math.min(48, Math.floor(c.body.length / 250)),
    },
  }));
  const graphBodies: Record<string, string> = {};
  for (const c of concepts) {
    graphBodies[c.id] = c.body;
  }
  const graphEdges: Array<{ data: { id: string; source: string; target: string } }> = [];
  const seenEdgeKeys = new Set<string>();
  for (const c of concepts) {
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
            description: `Referert OKF-konsept fra ${c.id}`,
            status: 'draft',
            trust_tier: 'unverified',
            stale: false,
            color: '#64748b',
            size: 28,
          },
        });
        graphBodies[target] =
          `# ${shortLabel}\n\n*Dette OKF-konseptet (\`/${target}.md\`) er referert fra **${c.title || c.id}**.*\n\nKjør \`npm run cli:stage1 -- "${shortLabel}"\` for å generere og verifisere dette konseptet i kunnskapsbunten.`;
      }
      const key = `${c.id}__${target}`;
      if (seenEdgeKeys.has(key)) continue;
      seenEdgeKeys.add(key);
      graphEdges.push({ data: { id: key, source: c.id, target } });
    }
    for (const src of c.sources || []) {
      const srcNodeId = `source:${src.id || src.title || 'ref'}`;
      const refLine = `- **Referert i konsept:** \`${c.id}\` (*${c.title || c.id}*)`;
      if (!conceptIds.has(srcNodeId)) {
        conceptIds.add(srcNodeId);
        const srcUrl = (src as any).url || (src as any).resource || '';
        const fullTitleText = String(src.title || srcUrl).trim();
        const shortTitleText =
          fullTitleText.length > 42
            ? `${fullTitleText.slice(0, 42).trimEnd()}…`
            : fullTitleText;
        graphNodes.push({
          data: {
            id: srcNodeId,
            group: 'source',
            label: `[^${src.id}] ${shortTitleText}`,
            fullTitle: `[^${src.id}] ${fullTitleText}`,
            parentConceptId: c.id,
            type: 'Verified Source',
            description: srcUrl,
            status: 'stable',
            trust_tier: c.trust_tier,
            stale: false,
            color: '#10b981',
            size: 24,
          },
        });
        graphBodies[srcNodeId] = [
          src.retrieved_at ? `- **Hentet (\`retrieved_at\`):** \`${src.retrieved_at}\`` : '',
          src.last_modified ? `- **Sist endret (\`last_modified\`):** \`${src.last_modified}\`` : '',
          refLine,
        ]
          .filter(Boolean)
          .join('\n');
      } else if (graphBodies[srcNodeId] && !graphBodies[srcNodeId].includes(refLine)) {
        graphBodies[srcNodeId] = `${graphBodies[srcNodeId]}\n${refLine}`;
      }
      const edgeKey = `${c.id}__${srcNodeId}`;
      if (!seenEdgeKeys.has(edgeKey)) {
        seenEdgeKeys.add(edgeKey);
        graphEdges.push({ data: { id: edgeKey, source: c.id, target: srcNodeId } });
      }
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

  // Tab 1: Oversikt & Sammendrag (Overview, TTS Narration, Highlights)
  tabs.push({ title: '📋 Oversikt & Sammendrag', child: 'tab_overview' });
  const overviewChildren = ['overview_narration_card'];
  if (stage2Norm.highlights.length > 0) {
    overviewChildren.push('overview_highlights_card');
  }
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
      children: ['overview_narration_heading', 'overview_tts_player', 'overview_narration_body'],
    },
    {
      id: 'overview_narration_heading',
      component: 'Text',
      variant: 'h2',
      text: 'Stage 2 Syntese & Hovedbudskap',
    },
    {
      id: 'overview_tts_player',
      component: 'AudioPlayer',
      url: 'tts://web-speech/stage2/scriptBody',
      description: { path: '/meta/title' },
      ttsText: { path: '/stage2/scriptBody' },
    },
    {
      id: 'overview_narration_body',
      component: 'Text',
      variant: 'body',
      markdown: true,
      text: { path: '/stage2/scriptBody' },
    }
  );

  if (stage2Norm.highlights.length > 0) {
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
        text: 'Hovedpunkter & Læringsmål',
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

  // Tab 2 (Conditional): Interactive Checklist if `- [ ]` items exist in OKF Markdown
  if (totalChecklistItems > 0) {
    tabs.push({
      title: `✅ Interaktiv Sjekkliste (${totalChecklistItems})`,
      child: 'tab_checklist',
    });
    components.push({
      id: 'tab_checklist',
      component: 'InteractiveChecklist',
      title: 'Interaktiv Sjekkliste (OKF v0.2 Kontrollpunkter)',
      groupsPath: '/checklist/groups',
    });
  }

  // Tab 3 (Conditional): ModuleCarousel if Stage 2 has trainingModules / lessons / modules / slides
  if (stage2Norm.modules.length > 0) {
    tabs.push({
      title: `🎓 Moduler (${stage2Norm.modules.length})`,
      child: 'tab_modules',
    });
    components.push({
      id: 'tab_modules',
      component: 'ModuleCarousel',
      title: 'Opplæringsmoduler & Leksjoner',
      modulesPath: '/stage2/modules',
      activeIndexPath: '/stage2/activeModuleIndex',
    });
  }

  // Tab 4 (Conditional): CaseSimulator if Stage 2 has cases or boardActionItems
  if (stage2Norm.cases.length > 0) {
    tabs.push({
      title: `⚖️ Case & Tiltak (${stage2Norm.cases.length})`,
      child: 'tab_cases',
    });
    components.push({
      id: 'tab_cases',
      component: 'CaseSimulator',
      title: 'Scenario- og vedtakssimulator',
      casesPath: '/stage2/cases',
      responsesPath: '/stage2/caseResponses',
    });
  }

  // Tab 5 (Conditional): QuizRunner if Stage 2 has quiz questions
  if (stage2Norm.quiz.length > 0) {
    tabs.push({
      title: `🧪 Quiz (${stage2Norm.quiz.length})`,
      child: 'tab_quiz',
    });
    components.push({
      id: 'tab_quiz',
      component: 'QuizRunner',
      title: 'Interaktiv Kunnskapssjekk',
      questionsPath: '/stage2/quiz',
      answersPath: '/stage2/quizAnswers',
    });
  }

  // Tab 6: OKF v0.2 Kunnskapsgrunnlag (`OkfMarkdown`)
  tabs.push({
    title: '📚 OKF v0.2 Kunnskapsgrunnlag',
    child: 'tab_okf_markdown',
  });
  components.push({
    id: 'tab_okf_markdown',
    component: 'OkfMarkdown',
    title: { path: '/okf/title' },
    body: { path: '/okf/body' },
    sources: { path: '/okf/sources' },
    trustTier: { path: '/okf/trustTier' },
    isStale: { path: '/okf/isStale' },
  });

  // Tab 7: OKF Knowledge Graph (`OkfKnowledgeGraph`)
  tabs.push({
    title: `🕸️ OKF Kunnskapsgraf (${graphNodes.length})`,
    child: 'tab_okf_graph',
  });
  components.push({
    id: 'tab_okf_graph',
    component: 'OkfKnowledgeGraph',
    title: 'OKF v0.2 Kunnskapsgraf',
  });

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

  const dataModel = {
    meta: {
      runId: resolvedRunId || 'workspace',
      title: stage2Norm.title,
      subtitle: stage2Norm.subtitle,
      targetAudience: stage2Norm.targetAudience,
      estimatedDuration: stage2Norm.estimatedDuration,
      model: meta.model || GEMINI_4_ARGON_MODEL,
      subtitleLine: [
        stage2Norm.targetAudience ? `Målgruppe: ${stage2Norm.targetAudience}` : '',
        formattedDuration ? `Varighet: ${formattedDuration}` : '',
        `Modell: ${meta.model || GEMINI_4_ARGON_MODEL}`,
        `Run: ${resolvedRunId || 'workspace'}`,
      ]
        .filter(Boolean)
        .join('  •  '),
    },
    okf: {
      title: String(okfDoc.frontmatter.title || stage2Norm.title),
      type: String(okfDoc.frontmatter.type || 'Research Concept'),
      status: String(okfDoc.frontmatter.status || 'draft'),
      trustTier: okfTrustTier,
      isStale: okfStale,
      statusBadge: `status: ${okfDoc.frontmatter.status || 'draft'}`,
      trustBadge: `trust: ${okfTrustTier}`,
      freshnessBadge: okfStale ? 'stale' : 'fresh',
      sourcesBadge: `${okfSources.length} verifiserte kilder`,
      sources: okfSources,
      body: okfDoc.body || '*Ingen Stage 1 OKF-kropp funnet.*',
      editMode: false,
    },
    checklist: {
      groups: checklistGroups,
      fromStage2: checklistFromStage2,
      completedCount: completedChecklistCount,
      totalCount: totalChecklistItems,
      percent: checklistPct,
      summaryText: `${completedChecklistCount} / ${totalChecklistItems} fullført (${checklistPct}%)`,
    },
    stage2: {
      scriptBody:
        stage2Norm.scriptBody ||
        okfDoc.frontmatter.description ||
        'Ingen Stage 2-manustekst generert ennå.',
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
  const stage2OutDir = options.outputDir
    ? path.join(baseOutDir, 'stages', '02_script', 'output')
    : resolvedRunDir
      ? path.join(resolvedRunDir, 'stages', '02_script', 'output')
      : path.join(workspaceRoot, 'bundle');

  fs.mkdirSync(stage2OutDir, { recursive: true });

  const surfaceJsonPath = path.join(stage2OutDir, 'a2ui_surface.json');
  const surfaceJsonlPath = path.join(stage2OutDir, 'a2ui_surface.jsonl');
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

  fs.writeFileSync(surfaceJsonPath, JSON.stringify(surfaceJsonDoc, null, 2), 'utf-8');
  fs.writeFileSync(
    surfaceJsonlPath,
    messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    'utf-8'
  );

  const clientPayload = {
    surfaceId,
    catalogId: A2UI_ICM_CATALOG_ID,
    messages,
    bundleGraph: {
      nodes: graphNodes,
      edges: graphEdges,
      bodies: graphBodies,
    },
  };

  const html = `<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeA2uiHtml(stage2Norm.title)} — A2UI v0.9.1 Studio</title>
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
    <span class="a2ui-topbar-title">${escapeA2uiHtml(stage2Norm.title)}</span>
  </div>
  <div class="a2ui-topbar-actions">
    <button class="a2ui-top-btn" id="a2ui-open-inspector">🔍 A2UI Surface &amp; Data Model Inspector</button>
    <button class="a2ui-top-btn" id="a2ui-export-json">⬇ Eksporter A2UI Tilstand (.json)</button>
  </div>
</header>

<main class="a2ui-root-Mount" id="a2ui-surface-root"></main>

<div class="a2ui-modal-backdrop" id="a2ui-inspector-modal" hidden>
  <div class="a2ui-modal-dialog">
    <div class="a2ui-modal-header">
      <strong>A2UI v0.9.1 Deklarativ Surface, Data Model &amp; Action Log</strong>
      <button class="a2ui-btn" id="a2ui-close-inspector">Lukk</button>
    </div>
    <div class="a2ui-modal-body">
      <pre id="a2ui-inspector-content" style="background:#0f172a;color:#e2e8f0;padding:14px;border-radius:8px;font-size:12px;overflow-x:auto;margin:0"></pre>
    </div>
  </div>
</div>

<script>
window.A2UI_SURFACE_PAYLOAD = ${JSON.stringify(clientPayload).replace(/<\//g, '<\\/')};
</script>
<script>
${A2UI_STUDIO_JS}
</script>
</body>
</html>
`;

  fs.mkdirSync(path.dirname(htmlOutputPath), { recursive: true });
  fs.writeFileSync(htmlOutputPath, html, 'utf-8');

  let bundleHtmlPath: string | undefined;
  let bundleVizPath: string | undefined;
  const shouldMirrorBundle =
    options.mirrorBundleHtml !== undefined ? options.mirrorBundleHtml : !options.outputDir;
  if (shouldMirrorBundle && fs.existsSync(bundleRoot)) {
    bundleHtmlPath = path.join(bundleRoot, 'a2ui.html');
    fs.writeFileSync(bundleHtmlPath, html, 'utf-8');
    try {
      const vizResult = generateBundleVisualization(bundleRoot);
      bundleVizPath = vizResult.outputPath;
    } catch {
      // Non-fatal if bundle has no concepts yet
    }
  }

  return {
    runId: resolvedRunId || 'workspace',
    surfaceId,
    catalogId: A2UI_ICM_CATALOG_ID,
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
    messages,
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
  const cleanedMd = await cleanGroundingLinks(rawTestMarkdown, mockOutputs);
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
      ) === 'ilo.org — Legosh en' &&
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
    'enrichBareDomainSourceTitle decodes UTF-8, skips 1-char servlet, Episerver /id<digits>/, and *Servlet paths, pairs /1 and YYYY/MM/DD paths, uppercases first alphabetic char, and self-heals polluted Id87138/ResourceServlet titles'
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
    'Eier har ansvar etter veiledningen[^dsb-veiledning-brannforebygging] og kapittel 3–4[^dsb-veiledning-kap3-4].',
    'Slokkeutstyr kontrolleres jevnlig[^dsb-faq-slokkeutstyr] i tråd med internkontroll[^snl-internkontrollforskriften].',
    'Brannloven[^regjeringen-no] og forsikringskrav[^kniftrygghet-no] gjelder også[^hallucinated-nonexistent-999].',
    '',
    '[^dsb-veiledning-brannforebygging]: Veiledning til forskrift om brannforebygging',
    '[^dsb-veiledning-kap3-4]: Veiledning til forskrift om brannforebygging (§§ 13–15) - DSB',
    '[^dsb-faq-slokkeutstyr]: Ofte stilte spørsmål til forskrift om brannforebygging (slokkeutstyr og NS 3910) - DSB',
    '[^snl-internkontrollforskriften]: snl-internkontrollforskriften',
    '[^regjeringen-no]: regjeringen.no — Id87138',
    '[^kniftrygghet-no]: kniftrygghet.no — ResourceServlet',
    '',
  ].join('\n');

  const cleanedDupMd = await cleanGroundingLinks(dupAliasRawMd, []);
  const parsedCleanedDup = parseOkfDocument(cleanedDupMd);
  assert(
    !parsedCleanedDup.body.includes('[^dsb-veiledning-kap3-4]') &&
      !parsedCleanedDup.body.includes('[^dsb-faq-slokkeutstyr]') &&
      !parsedCleanedDup.body.includes('[^snl-internkontrollforskriften]') &&
      !parsedCleanedDup.body.includes('[^hallucinated-nonexistent-999]'),
    `cleanGroundingLinks rewrites duplicate-URL alias and orphan footnotes and strips ungrounded footnotes (got body: "${parsedCleanedDup.body}")`
  );
  assert(
    parsedCleanedDup.body.includes('[^dsb-faq-brannforebygging]') &&
      parsedCleanedDup.body.includes('[^snl-no]'),
    'cleanGroundingLinks maps [^dsb-faq-slokkeutstyr] -> [^dsb-faq-brannforebygging] and [^snl-internkontrollforskriften] -> [^snl-no]'
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
      healedRegjeringen?.title === 'regjeringen.no — Brann og eksplosjonsvernloven' &&
      healedKnif?.title === 'kniftrygghet.no',
    `healOrphanOkfFootnotes self-heals orphan footnotes and polluted Episerver/Servlet titles on existing OKF documents (defs=${healedDefMatches.length}, reg="${healedRegjeringen?.title}", knif="${healedKnif?.title}")`
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
  const cleanedShortAliasMd = await cleanGroundingLinks(shortTitleAndDotAliasMd, []);
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
    truncateSlugAtWordBoundary(
      'systematisk-brannvern-ansvarsfordeling-og-krav-til-romningsveier-i-naeringsbygg',
      48
    ) === 'systematisk-brannvern-ansvarsfordeling-og-krav' &&
      truncateSlugAtWordBoundary(
        'systematisk-brannvern-ansvarsfordeling-og-krav-til-romningsveier-i-naeringsbygg',
        32
      ) === 'systematisk-brannvern',
    'truncateSlugAtWordBoundary snaps 48-char and 32-char slugs to the last word boundary dash'
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
    '### 4.3 Halvårlig og årlig kontroll',
    '- [ ] **Brannøvelse (`FOB § 12`)**:',
    '  - [ ] Er årlig evakueringsøvelse gjennomført?',
    '- [ ] **Tekniske anlegg**:',
    '  - [ ] **Brannalarmanlegg** (`NS 3960`)',
    '    1. [ ] Foreligger årsrapport uten åpne avvik?',
  ].join('\n');
  const chkGroups = extractChecklistGroupsFromMarkdown(sampleChecklistMd);
  assert(
    chkGroups.length === 6 &&
      chkGroups[0].title === 'Daglig og ukentlig kontroll' &&
      chkGroups[1].title === 'Månedlig og kvartalsvis kontroll' &&
      chkGroups[2].title === 'Månedlig og kvartalsvis kontroll — Manuelt slokkeutstyr' &&
      chkGroups[3].title === 'Månedlig og kvartalsvis kontroll — Tekniske rom og tavlerom' &&
      chkGroups[4].title === 'Halvårlig og årlig kontroll — Brannøvelse (FOB § 12)' &&
      chkGroups[5].title ===
        'Halvårlig og årlig kontroll — Tekniske anlegg — Brannalarmanlegg (NS 3960)' &&
      chkGroups[5].items[0]?.label === 'Foreligger årsrapport uten åpne avvik?',
    `extractChecklistGroupsFromMarkdown preserves currentHeading prefix, 3-level hierarchy, and exact document order (got: ${chkGroups.map((g) => g.title).join(' | ')})`
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
      renderedVizPreview.includes('## 1. Tekniske krav') &&
      renderedVizPreview.includes('800 m²') &&
      renderedVizPreview.includes('CO₂-slokkere') &&
      renderedVizPreview.includes('H₂O') &&
      renderedVizPreview.includes('100 m³') &&
      renderedVizPreview.includes('2 h⁻¹') &&
      renderedVizPreview.includes('20°C') &&
      renderedVizPreview.includes('areal > 800 m² i bygg') &&
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
  process.argv.includes('--a2ui')
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
    const isDryRun = process.argv.includes('--dry-run');

    const byFlagIdx = process.argv.indexOf('--by');
    const verifierBy =
      byFlagIdx !== -1 && process.argv[byFlagIdx + 1] && !process.argv[byFlagIdx + 1].startsWith('--')
        ? process.argv[byFlagIdx + 1]
        : undefined;

    // Standalone `--a2ui` execution
    if (hasA2ui && !isStage1Only && !isStage2Only && !isFullCli && !hasVerify) {
      const a2uiIdx = process.argv.indexOf('--a2ui');
      const a2uiArgs = process.argv
        .slice(a2uiIdx + 1)
        .filter((a) => !a.startsWith('--'));
      const targetRunOrPath = a2uiArgs[0];
      const customHtmlOut = a2uiArgs[1];
      const a2uiResult = generateA2uiSurface({
        workspaceRoot: './workspace',
        runId: targetRunOrPath,
        outputHtmlPath: customHtmlOut,
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
      });
      return;
    }

    // Standalone `--viz` execution
    if (hasViz && !isStage1Only && !isStage2Only && !isFullCli && !hasVerify) {
      const vizIdx = process.argv.indexOf('--viz');
      const vizArgs = process.argv
        .slice(vizIdx + 1)
        .filter((a) => !a.startsWith('--'));
      const bundleDir = vizArgs[0] || './workspace/bundle';
      const outPath = vizArgs[1] || path.join(bundleDir, 'viz.html');
      const vizResult = generateBundleVisualization(bundleDir, outPath);
      console.log('OKF Bundle Visualization Generated:', vizResult);
      return;
    }

    // Standalone `--verify` execution
    if (hasVerify && !isStage1Only && !isStage2Only && !isFullCli) {
      const verifyIdx = process.argv.indexOf('--verify');
      const rawArgs = process.argv.slice(verifyIdx + 1);
      const filteredArgs: string[] = [];
      for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] === '--by') {
          i++;
          continue;
        }
        if (rawArgs[i].startsWith('--')) continue;
        filteredArgs.push(rawArgs[i]);
      }
      const target = filteredArgs[0];
      if (!target) {
        console.error('Usage: npm run cli:verify -- <runIdOrConceptPath> [--by human:<reviewer>]');
        process.exit(1);
      }
      const verifyResult = verifyOkfConcept(target, {
        workspaceRoot: './workspace',
        by: verifierBy,
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
        i++;
        continue;
      }
      if (
        token === '--dry-run' ||
        token === '--verify' ||
        token === '--viz' ||
        token === '--a2ui'
      ) {
        continue;
      }
      cleanedPositional.push(token);
    }
    const argValue = cleanedPositional.join(' ').trim();

    if (!argValue) {
      console.error(
        isStage2Only
          ? 'Usage: npm run cli:stage2 -- [--dry-run] [--verify] [--by human:<id>] [--a2ui] <runId>'
          : isStage1Only
            ? 'Usage: npm run cli:stage1 -- [--dry-run] [--viz] [--a2ui] "<Research Topic>"'
            : 'Usage: npm run cli -- [--dry-run] [--verify] [--viz] [--a2ui] "<Research Topic>"'
      );
      process.exit(1);
    }

    if (isStage2Only) {
      if (hasVerify) {
        verifyOkfConcept(argValue, {
          workspaceRoot: './workspace',
          by: verifierBy,
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
        argValue
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
            verifyOkfConcept(runId, {
              workspaceRoot: './workspace',
              by: verifierBy,
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
          verifyOkfConcept(runId, {
            workspaceRoot: './workspace',
            by: verifierBy,
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


