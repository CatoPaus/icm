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
      const schemaSectionMatch = outputBlockMatch[1].match(/schema:\s*[\r\n]+([\s\S]*)$/);
      if (schemaSectionMatch) {
        const properties: Record<string, any> = {};
        const required: string[] = [];
        const lines = schemaSectionMatch[1].split(/\r?\n/);
        for (const line of lines) {
          if (!line.trim() || /^\S/.test(line)) break;
          const propMatch = line.match(/^\s+([a-zA-Z0-9_]+)(\?)?:\s*(string|integer|number|boolean)/i);
          if (propMatch) {
            const [, propName, isOptional, propType] = propMatch;
            properties[propName] = { type: propType.toLowerCase() };
            if (!isOptional) {
              required.push(propName);
            }
          }
        }
        if (Object.keys(properties).length > 0) {
          outputJsonSchema = {
            type: 'object',
            properties,
            required,
          };
        }
      }
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
      if (Array.isArray(steps) && steps.length > 0 && (!interaction.steps || interaction.steps.length === 0)) {
        interaction.steps = steps;
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

// Helper function to extract the destination URL from Vertex AI Search grounding 302 redirects
// Uses `redirect: 'manual'` first so we read Google's `Location` header directly in ~100ms without
// failing or timing out when a third-party destination server is unreachable.
async function resolveRedirect(url: string): Promise<string> {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  try {
    const manualRes = await globalThis.fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers,
    });
    await manualRes.body?.cancel().catch(() => {});
    const location = manualRes.headers.get('location');
    if (location && /^https?:\/\//i.test(location)) {
      return location;
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
    return followRes.url || url;
  } catch {
    return url;
  }
}

/**
 * Parses markdown text and Interactions API grounding steps, resolves Vertex redirect URLs,
 * weaves inline `url_citation` annotations at their UTF-8 byte offsets, and formats reference links.
 */
export async function cleanGroundingLinks(text: string, steps?: any[]): Promise<string> {
  const redirectRegex =
    /https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[a-zA-Z0-9_\-\+=]+/g;
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
        .filter((u) => u.includes('vertexaisearch.cloud.google.com/grounding-api-redirect/')),
    ])
  );

  const urlMap = new Map<string, string>();
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
      urlMap.set(original, resolved || original);
    }
  }

  // 1. Weave inline url_citation annotations into the UTF-8 buffer before byte offsets change
  let workingText = text;
  if (inlineAnnotations.length > 0) {
    const buf = Buffer.from(workingText, 'utf8');
    const byEndIndex = new Map<number, Array<{ title: string; url: string }>>();
    for (const ann of inlineAnnotations) {
      if (ann.end_index > buf.length) continue;
      const resolvedUrl = urlMap.get(ann.url) || ann.url;
      let label = ann.title?.trim() || '';
      if (!label) {
        try {
          label = new URL(resolvedUrl).hostname.replace(/^www\./, '');
        } catch {
          label = 'source';
        }
      }
      if (!byEndIndex.has(ann.end_index)) {
        byEndIndex.set(ann.end_index, []);
      }
      const group = byEndIndex.get(ann.end_index)!;
      if (!group.some((item) => item.url === resolvedUrl)) {
        group.push({ title: label, url: resolvedUrl });
      }
    }

    const sortedEnds = Array.from(byEndIndex.keys()).sort((a, b) => b - a);
    const chunks: Buffer[] = [];
    let cursor = buf.length;

    for (const endIdx of sortedEnds) {
      const links = byEndIndex.get(endIdx)!;
      const citationMarkdown = ` (${links.map((l) => `[${l.title}](${l.url})`).join(', ')})`;
      chunks.unshift(buf.subarray(endIdx, cursor));
      chunks.unshift(Buffer.from(citationMarkdown, 'utf8'));
      cursor = endIdx;
    }
    chunks.unshift(buf.subarray(0, cursor));
    workingText = Buffer.concat(chunks).toString('utf8');
  }

  // 2. Replace any remaining raw redirect URLs in the text
  let cleanedText = workingText;
  for (const [original, resolved] of urlMap.entries()) {
    if (resolved && resolved !== original) {
      console.log(`Resolved: ${original.substring(0, 60)}... -> ${resolved}`);
      cleanedText = cleanedText.replaceAll(original, resolved);
    }
  }

  // 3. Convert bare "* **Title**: https://..." lines in Sources & Citations into clickable markdown links and deduplicate
  const seenSourceUrls = new Set<string>();
  const lines = cleanedText.split('\n');
  const formattedLines: string[] = [];
  const bareSourceLineRegex = /^(\s*[\*\-]\s+)\*\*(.+?)\*\*:\s+(https?:\/\/\S+)\s*$/;

  for (const line of lines) {
    const match = line.match(bareSourceLineRegex);
    if (match) {
      const [, prefix, rawTitle, url] = match;
      if (seenSourceUrls.has(url)) {
        continue;
      }
      seenSourceUrls.add(url);
      const cleanTitle = rawTitle.replace(/\s*\(Alternativ indeks\)\s*$/i, '').trim();
      formattedLines.push(`${prefix}[**${cleanTitle}**](${url})`);
    } else {
      formattedLines.push(line);
    }
  }
  cleanedText = formattedLines.join('\n');

  // 4. Ensure any grounded sources from the Interactions API that were not cited are appended
  const missingSources: Array<{ title: string; url: string }> = [];
  const seenUrls = new Set<string>();
  for (const src of groundedSources) {
    const finalUrl = urlMap.get(src.url) || src.url;
    if (finalUrl && !seenUrls.has(finalUrl) && !cleanedText.includes(finalUrl)) {
      seenUrls.add(finalUrl);
      missingSources.push({
        title: src.title || finalUrl,
        url: finalUrl,
      });
    }
  }

  if (missingSources.length > 0) {
    const appendix =
      '\n\n### Grounded Search References\n' +
      missingSources.map((s) => `- [**${s.title}**](${s.url})`).join('\n');
    cleanedText += appendix;
  }

  return cleanedText;
}

// Helper to load ICM Layer 0 (GEMINI.md), Layer 1 (CONTEXT.md), and Layer 3 (_config/voice_guide.md) from disk
function loadWorkspaceLayers(workspacePath: string) {
  const geminiGuidePath = path.join(workspacePath, 'GEMINI.md');
  const contextGuidePath = path.join(workspacePath, 'CONTEXT.md');
  const toneGuidePath = path.join(workspacePath, '_config/voice_guide.md');

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
}): Promise<{
  success: boolean;
  runId: string;
  outputPath: string;
}> {
  const workspacePath = path.resolve(input.workspaceRoot);
  const runDir = path.join(workspacePath, 'runs', input.runId);
  const { globalIdentity, workspaceContext } = loadWorkspaceLayers(workspacePath);

  const contract = loadStagePromptContract('01_research');
  const stage1ThinkingLevel = normalizeThinkingLevel(input.thinkingLevel, contract.thinkingLevel);
  const stage1FallbackThinkingLevel: ThinkingLevel =
    stage1ThinkingLevel === 'HIGH' ? 'MEDIUM' : 'LOW';

  console.log(
    `--- Executing Stage 1: Research [model: ${GEMINI_4_ARGON_MODEL}, thinkingLevel: ${stage1ThinkingLevel}] ---`
  );

  const stage1Dir = path.join(runDir, 'stages/01_research');
  const researchFileTarget = path.join(stage1Dir, 'output/research_summary.md');
  const researchStreamTarget = path.join(stage1Dir, 'output/research_stream.md');
  fs.mkdirSync(path.dirname(researchFileTarget), { recursive: true });

  // Assemble Layer 0 + Layer 1 + Layer 2 prompt and persist to stages/01_research/input/prompt_assembled.md
  const assembledPrompt = renderPromptTemplate(contract.template, {
    topic: input.topic,
    globalIdentity,
    workspaceContext,
  });

  writeStageAssembledInput(
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

  const cleanedText = await cleanGroundingLinks(stage1Response.text, stage1Response.steps);
  fs.writeFileSync(researchFileTarget, cleanedText, 'utf-8');
  if (fs.existsSync(researchStreamTarget)) {
    try {
      fs.unlinkSync(researchStreamTarget);
    } catch {
      // Ignore cleanup errors
    }
  }

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

  const metaPath = path.join(runDir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      meta.stage1Telemetry = {
        thinkingLevel: usedThinkingLevel,
        thoughtSteps: stage1Response.thoughts.length,
        searchQueries: stage1Response.searchQueries,
        inputTokens: usage.inputTokens,
        thoughtsTokens: usage.thoughtsTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        durationMs,
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch {
      // Ignore metadata update errors
    }
  }

  return {
    success: true,
    runId: input.runId,
    outputPath: researchFileTarget,
  };
}

// 2. Standalone Stage 2 Scriptwriting Runner (Reads Verified Stage 1 Artifact from Disk)
export async function runStage2Flow(input: {
  workspaceRoot: string;
  runId: string;
  thinkingLevel?: ThinkingLevel | string;
}): Promise<{
  success: boolean;
  outputPath: string;
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

  console.log(
    `--- Executing Stage 2: Scriptwriting for Run: ${input.runId} [model: ${GEMINI_4_ARGON_MODEL}, thinkingLevel: ${stage2ThinkingLevel}] ---`
  );

  const startTimeMs = Date.now();
  const activeResearchData = fs.readFileSync(researchFileTarget, 'utf-8');

  // Assemble Layer 0 + Layer 1 + Layer 2 + Layer 3 + Layer 4 prompt and persist to stages/02_script/input/prompt_assembled.md
  const assembledPrompt = renderPromptTemplate(contract.template, {
    researchFile: activeResearchData,
    toneRules: toneGuide,
    globalIdentity,
    workspaceContext,
  });

  writeStageAssembledInput(
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
    const parsedJson = JSON.parse(stage2Response.text);
    fs.writeFileSync(scriptOutputTarget, JSON.stringify(parsedJson, null, 2), 'utf-8');
  } else {
    fs.writeFileSync(scriptOutputTarget, stage2Response.text, 'utf-8');
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

  const metaPath = path.join(runDir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      meta.stage2Telemetry = {
        thinkingLevel: usedThinkingLevel,
        thoughtSteps: stage2Response.thoughts.length,
        inputTokens: usage.inputTokens,
        thoughtsTokens: usage.thoughtsTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        durationMs,
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch {
      // Ignore metadata update errors
    }
  }

  return {
    success: true,
    outputPath: scriptOutputTarget,
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
  // Between Stage 1 and Stage 2, the reviewer can inspect/edit `research_summary.md`
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

// 4. Optional Interactive Approval Gate (for Demo Web Dashboard Step 3 compatibility)
export interface StoredSessionData<S = any> {
  id: string;
  state?: S;
  steps?: any[];
}

export class LocalDiskSessionStore<S = any> {
  private storageDir: string;

  constructor(storageDir: string = './.sessions') {
    this.storageDir = path.resolve(storageDir);
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private getFilePath(sessionId: string): string {
    return path.join(this.storageDir, `${sessionId}.json`);
  }

  async get(sessionId: string): Promise<StoredSessionData<S> | undefined> {
    const filepath = this.getFilePath(sessionId);
    if (!fs.existsSync(filepath)) return undefined;
    const raw = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as StoredSessionData<S>;
  }

  async save(sessionId: string, data: StoredSessionData<S>): Promise<void> {
    const filepath = this.getFilePath(sessionId);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  }
}

const DEPLOY_SCRIPT_TOOL_DECLARATION = {
  type: 'function',
  name: 'deployScriptDraftTool',
  description: 'Deploys the generated script to production media systems.',
  parameters: {
    type: 'object',
    properties: {
      scriptId: { type: 'string' },
      approvedText: { type: 'string' },
    },
    required: ['scriptId', 'approvedText'],
  },
};

export async function handleInteractiveDeployment(
  sessionId: string,
  promptText: string,
  thinkingLevel?: string
) {
  const store = new LocalDiskSessionStore();
  const resolvedThinkingLevel = normalizeThinkingLevel(thinkingLevel, 'LOW');
  const userStep = {
    type: 'user_input',
    content: [{ type: 'text', text: promptText }],
  };

  const response = await streamGemini4ArgonInteraction({
    steps: [userStep],
    tools: [DEPLOY_SCRIPT_TOOL_DECLARATION],
    thinkingLevel: resolvedThinkingLevel,
    maxOutputTokens: 32768,
  });

  const allSteps = [userStep, ...response.steps];
  await store.save(sessionId, { id: sessionId, steps: allSteps });

  const funcCallStep = response.steps.find((s: any) => s?.type === 'function_call');
  if (funcCallStep) {
    const interrupt = {
      toolRequest: {
        name: funcCallStep.name || 'deployScriptDraftTool',
        ref: funcCallStep.id || `call-${Date.now()}`,
        input: funcCallStep.arguments || {
          scriptId: 'draft-01',
          approvedText: promptText,
        },
      },
      metadata: {
        reason: 'human_review_required',
        message: 'Please review and approve the draft before deployment.',
        draftText: funcCallStep.arguments?.approvedText || promptText,
      },
    };
    return {
      status: 'AWAITING_APPROVAL',
      sessionId,
      interrupt,
      thinkingLevel: resolvedThinkingLevel,
    };
  }

  return { status: 'COMPLETED', text: response.text, thinkingLevel: resolvedThinkingLevel };
}

export async function approveAndResume(
  sessionId: string,
  interruptObj: any,
  thinkingLevel?: string
) {
  const store = new LocalDiskSessionStore();
  const resolvedThinkingLevel = normalizeThinkingLevel(thinkingLevel, 'LOW');
  const session = await store.get(sessionId);
  const priorSteps = session?.steps || [];
  const callId = interruptObj?.toolRequest?.ref || '';
  const scriptId = interruptObj?.toolRequest?.input?.scriptId || 'draft-01';

  const resultStep = {
    type: 'function_result',
    name: 'deployScriptDraftTool',
    call_id: callId,
    result: {
      deploymentStatus: `Successfully deployed script ${scriptId}`,
    },
  };

  const response = await streamGemini4ArgonInteraction({
    steps: [...priorSteps, resultStep],
    tools: [DEPLOY_SCRIPT_TOOL_DECLARATION],
    thinkingLevel: resolvedThinkingLevel,
    maxOutputTokens: 32768,
  });

  await store.save(sessionId, {
    id: sessionId,
    steps: [...priorSteps, resultStep, ...response.steps],
  });

  return { status: 'COMPLETED', text: response.text, thinkingLevel: resolvedThinkingLevel };
}

export async function rejectAndResume(
  sessionId: string,
  interruptObj: any,
  thinkingLevel?: string
) {
  const store = new LocalDiskSessionStore();
  const resolvedThinkingLevel = normalizeThinkingLevel(thinkingLevel, 'LOW');
  const session = await store.get(sessionId);
  const priorSteps = session?.steps || [];
  const callId = interruptObj?.toolRequest?.ref || '';

  const resultStep = {
    type: 'function_result',
    name: 'deployScriptDraftTool',
    call_id: callId,
    result: {
      deploymentStatus: 'Deployment rejected by human reviewer.',
    },
  };

  const response = await streamGemini4ArgonInteraction({
    steps: [...priorSteps, resultStep],
    tools: [DEPLOY_SCRIPT_TOOL_DECLARATION],
    thinkingLevel: resolvedThinkingLevel,
    maxOutputTokens: 32768,
  });

  await store.save(sessionId, {
    id: sessionId,
    steps: [...priorSteps, resultStep, ...response.steps],
  });

  return { status: 'COMPLETED', text: response.text, thinkingLevel: resolvedThinkingLevel };
}

// Headless CLI Entrypoint (for Linux / SSH / Cron / Terminal execution without the Web UI)
if (
  process.argv.includes('--cli') ||
  process.argv.includes('--stage1') ||
  process.argv.includes('--stage2')
) {
  (async () => {
    const isStage1Only = process.argv.includes('--stage1');
    const isStage2Only = process.argv.includes('--stage2');
    const flag = isStage2Only ? '--stage2' : isStage1Only ? '--stage1' : '--cli';
    const flagIndex = process.argv.indexOf(flag);
    const argValue = process.argv.slice(flagIndex + 1).join(' ').trim();

    if (!argValue) {
      console.error(
        isStage2Only
          ? 'Usage: npm run cli:stage2 -- <runId>'
          : isStage1Only
            ? 'Usage: npm run cli:stage1 -- "<Research Topic>"'
            : 'Usage: npm run cli -- "<Research Topic>"'
      );
      process.exit(1);
    }

    if (isStage2Only) {
      const runDir = path.resolve('./workspace/runs', argValue);
      const result = await runStage2Flow({
        workspaceRoot: './workspace',
        runId: argValue,
        thinkingLevel: 'MEDIUM',
      });
      const metaPath = path.join(runDir, 'meta.json');
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        meta.status = 'completed';
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
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
      const runId = `${slug || 'run'}-${Date.now()}`;
      const runDir = path.resolve('./workspace/runs', runId);
      fs.mkdirSync(runDir, { recursive: true });
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

      if (isStage1Only) {
        console.log(`Starting headless Stage 1-only ICM run: ${runId}`);
        const result = await runStage1Flow({
          workspaceRoot: './workspace',
          runId,
          topic: argValue,
          thinkingLevel: 'HIGH',
        });
        const metaPath = path.join(runDir, 'meta.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          meta.status = 'stage1_completed';
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        }
        console.log(
          `Stage 1 CLI Run Complete (${runId}). Paused at Human-in-the-Loop Intermission Gate:`,
          result
        );
      } else {
        console.log(`Starting headless full ICM run: ${runId}`);
        const result = await icmOrchestratorFlow({
          workspaceRoot: './workspace',
          runId,
          topic: argValue,
          researchThinkingLevel: 'HIGH',
          scriptThinkingLevel: 'MEDIUM',
        });
        const metaPath = path.join(runDir, 'meta.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          meta.status = 'completed';
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        }
        console.log(`Headless ICM Run Complete (${runId}):`, result);
      }
    }
  })().catch((err) => {
    console.error('Headless CLI execution failed:', err);
    process.exit(1);
  });
}
