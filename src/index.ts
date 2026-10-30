import * as fs from 'fs';
import * as path from 'path';

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
  base = words.join('-').slice(0, 32).replace(/-+$/g, '') || 'source';

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
    for (const step of steps) {
      if (step?.type === 'google_search_result' && Array.isArray(step.result)) {
        for (const resItem of step.result) {
          if (resItem?.url && typeof resItem.url === 'string') {
            groundedSources.push({ title: resItem.title, url: resItem.url });
          }
        }
      }

      if (step?.type === 'model_output' && Array.isArray(step.content)) {
        for (const contentPart of step.content) {
          if (Array.isArray(contentPart?.annotations)) {
            for (const ann of contentPart.annotations) {
              if (ann?.url && typeof ann.url === 'string') {
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
      if (cleanTitle && (!existingById.title || existingById.title === existingById.resource)) {
        existingById.title = cleanTitle;
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
      if (cleanTitle && (!existing.title || existing.title === existing.resource)) {
        existing.title = cleanTitle;
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
            if (cleanTitle && (!existing.title || existing.title === existing.resource)) {
              existing.title = cleanTitle;
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
    const entry: OKFSource = {
      id,
      resource: resolvedUrl,
      title: cleanTitle || fallbackLabel,
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
    const byEndIndex = new Map<number, OKFSource[]>();
    for (const ann of inlineAnnotations) {
      if (ann.end_index > buf.length || ann.end_index <= frontmatterEndByteOffset) continue;
      const srcEntry = registerSource(ann.url, ann.title, undefined, undefined, true);
      if (!byEndIndex.has(ann.end_index)) {
        byEndIndex.set(ann.end_index, []);
      }
      const group = byEndIndex.get(ann.end_index)!;
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
            !precedingSlice.endsWith(`[^${s.id}]`) && !followingSlice.startsWith(`[^${s.id}]`)
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
    const existingCanonical = canonicalByResource.get(entry.resource);
    if (existingCanonical && existingCanonical !== entry) {
      if (entry.title && (!existingCanonical.title || existingCanonical.title === existingCanonical.resource)) {
        existingCanonical.title = entry.title;
      }
      if (entry.retrieved_at === nowIso || !existingCanonical.retrieved_at) {
        existingCanonical.retrieved_at = entry.retrieved_at || nowIso;
      }
      if (entry.last_modified && !existingCanonical.last_modified) {
        existingCanonical.last_modified = entry.last_modified;
      }
      if (entry.id && existingCanonical.id && entry.id !== existingCanonical.id) {
        bodyText = bodyText.replaceAll(`[^${entry.id}]`, `[^${existingCanonical.id}]`);
        existingFootnoteDefs.delete(entry.id);
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
  bodyText = bodyText.replace(/(\[\^[A-Za-z0-9_\-]+\])\1+/g, '$1');

  // 7. Append OKF v0.2 footnote definitions (`[^id]: Title`) at the bottom of the body (SPEC.md §5.1)
  const citedFootnoteIds = Array.from(
    new Set(Array.from(bodyText.matchAll(/\[\^([A-Za-z0-9_\-]+)\]/g)).map((m) => m[1]))
  );
  const allFootnoteIds = Array.from(
    new Set([...citedFootnoteIds, ...existingFootnoteDefs.keys()])
  );

  const footnoteLines: string[] = [];
  for (const fnId of allFootnoteIds) {
    const src = sourcesById.get(fnId);
    const label = src?.title || existingFootnoteDefs.get(fnId) || src?.resource || fnId;
    footnoteLines.push(`[^${fnId}]: ${label}`);
  }

  bodyText = bodyText.trim();
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

  for (const s of orderedSources) {
    s.retrieved_at = parseValidIsoTimestamp(s.retrieved_at) || finalGenAt;
    const validLm = parseValidIsoTimestamp(s.last_modified);
    if (validLm) {
      s.last_modified = validLm;
    } else {
      delete s.last_modified;
    }
  }
  fm.sources = orderedSources;

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

  const mergedFootnotes = new Map<string, string>(oldParsed.footnotes);
  for (const [fnId, fnLine] of newParsed.footnotes.entries()) {
    mergedFootnotes.set(fnId, fnLine);
  }
  const allFootnotes = Array.from(mergedFootnotes.values());
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
      if (!combinedVerified.some((c) => c.by === v.by && c.at === v.at)) {
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

  let slug = options?.conceptSlug || '';
  if (!slug) {
    const metaPath = path.join(runDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const existingCid = String(meta?.okf?.bundleConceptId || '').trim();
        if (existingCid.startsWith('research/')) {
          slug = existingCid.slice('research/'.length);
        }
      } catch {
        // Ignore unreadable meta.json
      }
    }
  }
  if (!slug) {
    const baseSource = String(doc.frontmatter.title || runId)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/-\d{10,}$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '');
    slug = baseSource || 'research-concept';
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
  existingVerified.push({ by: actor, at: atIso });
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
    const sources: OKFSource[] = rawSourcesList.map((s) => {
      const validRetrieved = parseValidIsoTimestamp(s.retrieved_at) || genAtFallback;
      const validLm = parseValidIsoTimestamp(s.last_modified);
      const nextSrc: OKFSource = {
        ...s,
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
      body: doc.body || '',
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

  const cy = cytoscape({
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
  });

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
    const joinedBody = bodyLines.join("\\n");
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
    const bodyWithSup = joinedBody.replace(
      /\\[\\^([A-Za-z0-9_\\-]+)\\]/g,
      '<sup class="fn-ref"><a href="#fn-$1">[$1]</a></sup>'
    );
    let html = marked.parse(bodyWithSup, { breaks: false, gfm: true });
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

// 4. Headless CLI Entrypoint (Linux / macOS / Windows / SSH / Cron / Terminal execution)
if (
  process.argv.includes('--cli') ||
  process.argv.includes('--stage1') ||
  process.argv.includes('--stage2') ||
  process.argv.includes('--verify') ||
  process.argv.includes('--viz')
) {
  (async () => {
    const isStage1Only = process.argv.includes('--stage1');
    const isStage2Only = process.argv.includes('--stage2');
    const isFullCli = process.argv.includes('--cli');
    const hasVerify = process.argv.includes('--verify');
    const hasViz = process.argv.includes('--viz');
    const isDryRun = process.argv.includes('--dry-run');

    const byFlagIdx = process.argv.indexOf('--by');
    const verifierBy =
      byFlagIdx !== -1 && process.argv[byFlagIdx + 1] && !process.argv[byFlagIdx + 1].startsWith('--')
        ? process.argv[byFlagIdx + 1]
        : undefined;

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
      if (token === '--dry-run' || token === '--verify' || token === '--viz') {
        continue;
      }
      cleanedPositional.push(token);
    }
    const argValue = cleanedPositional.join(' ').trim();

    if (!argValue) {
      console.error(
        isStage2Only
          ? 'Usage: npm run cli:stage2 -- [--dry-run] [--verify] [--by human:<id>] <runId>'
          : isStage1Only
            ? 'Usage: npm run cli:stage1 -- [--dry-run] [--viz] "<Research Topic>"'
            : 'Usage: npm run cli -- [--dry-run] [--verify] [--viz] "<Research Topic>"'
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
      console.log('Stage 2 CLI Run Complete:', result);
    } else {
      const slug = argValue
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
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
