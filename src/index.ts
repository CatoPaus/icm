import { genkit, GenkitError, z, MessageData } from 'genkit';
import { genkitPluginV2, ResolvableAction } from 'genkit/plugin';
import { googleAI } from '@genkit-ai/google-genai';
import { retry, fallback } from '@genkit-ai/middleware';
import * as fs from 'fs';
import * as path from 'path';

export const GEMINI_4_ARGON_MODEL = 'gemini-4-argon' as const;

/**
 * Gemini 4 Argon Thinking Level (`low`, `medium`, `high`).
 * Note: `minimal` is not supported by Gemini 4 Argon, and legacy sampling parameters
 * (`topP`, `topK`, etc.) are deprecated and omitted.
 *
 * - HIGH: Maximizes reasoning depth. Best for Stage 1 in-depth multi-source research.
 * - MEDIUM: Balanced reasoning effort, latency, and token usage (default). Best for Stage 2 structured JSON scriptwriting.
 * - LOW: Minimizes latency and token usage. Best for fast tool routing & interactive approval gates.
 */
export const ThinkingLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

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

// Wrap googleAI() so ONLY googleai/gemini-4-argon is registered and exposed in Genkit & Dev UI
const baseGoogleAI = googleAI();
const gemini4ArgonOnlyPlugin = genkitPluginV2({
  name: 'googleai',
  init: async () => {
    const argonModel = await baseGoogleAI.resolve?.('model', GEMINI_4_ARGON_MODEL);
    return argonModel ? [argonModel as ResolvableAction] : [];
  },
  resolve: async (actionType, actionName) => {
    if (
      actionType === 'model' &&
      (actionName === GEMINI_4_ARGON_MODEL || actionName === `googleai/${GEMINI_4_ARGON_MODEL}`)
    ) {
      return await baseGoogleAI.resolve?.(actionType, GEMINI_4_ARGON_MODEL);
    }
    return undefined;
  },
  list: async () => {
    const actions = (await baseGoogleAI.list?.()) || [];
    return actions.filter(
      (action) =>
        action.name === GEMINI_4_ARGON_MODEL ||
        action.name === `googleai/${GEMINI_4_ARGON_MODEL}`
    );
  },
});

// 1. Initialize Genkit with only Gemini 4 Argon and specify the dynamic prompt directory
export const ai = genkit({
  plugins: [gemini4ArgonOnlyPlugin],
  model: googleAI.model(GEMINI_4_ARGON_MODEL),
  promptDir: './prompts',
});

// Define schemas for our orchestrator inputs/outputs
const ICMWorkflowSchema = z.object({
  workspaceRoot: z.string().describe('Path to the target workspace folder'),
  runId: z.string().describe('The unique identifier for this run'),
  topic: z.string().describe('The primary topic for the pipeline'),
  researchThinkingLevel: ThinkingLevelSchema.optional().describe(
    'Gemini 4 Argon thinking level for Stage 1 Research (LOW | MEDIUM | HIGH, defaults to HIGH)'
  ),
  scriptThinkingLevel: ThinkingLevelSchema.optional().describe(
    'Gemini 4 Argon thinking level for Stage 2 Scriptwriting (LOW | MEDIUM | HIGH, defaults to MEDIUM)'
  ),
});

// Helper function to extract the destination URL from Vertex AI Search grounding 302 redirects
// Uses `redirect: 'manual'` first so we read Google's `Location` header directly in ~100ms without
// failing or timing out when a third-party destination server (e.g. a staging host or firewall) is unreachable.
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

// Parse markdown text and Interactions API grounding metadata, resolve Vertex redirect URLs,
// weave inline url_citation annotations at their UTF-8 byte offsets, and format reference links.
export async function cleanGroundingLinks(text: string, contentParts?: any[]): Promise<string> {
  const redirectRegex = /https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[a-zA-Z0-9_\-\+=]+/g;
  const textMatches = text.match(redirectRegex) || [];

  // Collect URLs and inline byte-offset annotations from Gemini 4 Argon Interactions API
  const groundedSources: Array<{ title?: string; url: string }> = [];
  const inlineAnnotations: Array<{ start_index?: number; end_index: number; title?: string; url: string }> = [];

  if (Array.isArray(contentParts)) {
    for (const part of contentParts) {
      const searchResults = part?.custom?.googleSearchResult?.result;
      if (Array.isArray(searchResults)) {
        for (const item of searchResults) {
          if (item?.url && typeof item.url === 'string') {
            groundedSources.push({ title: item.title, url: item.url });
          }
        }
      }
      const annotations = part?.metadata?.annotations;
      if (Array.isArray(annotations)) {
        for (const ann of annotations) {
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
    console.log(`Found ${allRedirectUrls.length} Vertex grounding redirects. Resolving to raw URLs...`);
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
    // Group annotations by end_index
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
      // Deduplicate by resolved URL within the same citation position
      if (!group.some((item) => item.url === resolvedUrl)) {
        group.push({ title: label, url: resolvedUrl });
      }
    }

    // Splice into buffer from highest end_index to lowest so earlier byte offsets remain valid
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
        continue; // Skip duplicate redirect entries that resolved to the same URL
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

// 2. Define Standalone Stage 1 Research Flow (Stops at the Human-in-the-Loop Intermission Gate)
export const runStage1Flow = ai.defineFlow(
  {
    name: 'runStage1Flow',
    inputSchema: z.object({
      workspaceRoot: z.string().describe('Path to the target workspace folder'),
      runId: z.string().describe('The unique identifier for this run'),
      topic: z.string().describe('The research topic or question'),
      thinkingLevel: ThinkingLevelSchema.optional().describe(
        'Gemini 4 Argon thinking level for Stage 1 Research (LOW | MEDIUM | HIGH, defaults to HIGH)'
      ),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      runId: z.string(),
      outputPath: z.string(),
    }),
  },
  async (input) => {
    const workspacePath = path.resolve(input.workspaceRoot);
    const runDir = path.join(workspacePath, 'runs', input.runId);
    const { globalIdentity, workspaceContext } = loadWorkspaceLayers(workspacePath);
    const stage1ThinkingLevel = normalizeThinkingLevel(input.thinkingLevel, 'HIGH');
    const stage1FallbackThinkingLevel: ThinkingLevel =
      stage1ThinkingLevel === 'HIGH' ? 'MEDIUM' : 'LOW';

    console.log(
      `--- Executing Stage 1: Research [model: ${GEMINI_4_ARGON_MODEL}, thinkingLevel: ${stage1ThinkingLevel}] ---`
    );
    const stage1Dir = path.join(runDir, 'stages/01_research');
    const researchFileTarget = path.join(stage1Dir, 'output/research_summary.md');
    const researchStreamTarget = path.join(stage1Dir, 'output/research_stream.md');
    fs.mkdirSync(path.dirname(researchFileTarget), { recursive: true });

    let stage1ThoughtSummaries: string[] = [];
    const startTimeMs = Date.now();

    // Load the Layer 2 Stage Contract dynamically from prompts/01_research.prompt
    // Note: Passing `onChunk` enables SSE streaming (`stream: true`) on `/v1beta/interactions`,
    // which prevents Node/Undici's 300-second `headersTimeout` (`TypeError: fetch failed`) during
    // long HIGH-thinking + Google Search grounding runs and lets the UI display live progress.
    const researchPrompt = ai.prompt('01_research');
    const stage1Response = await researchPrompt(
      {
        topic: input.topic,
        globalIdentity,
        workspaceContext,
      },
      {
        onChunk: (chunk) => {
          if (chunk.reasoning && chunk.reasoning.trim()) {
            stage1ThoughtSummaries.push(chunk.reasoning.trim());
            const previewSnippet = chunk.reasoning.trim().replace(/\s+/g, ' ').slice(0, 120);
            console.log(`[Stage 1 Thought]: ${previewSnippet}...`);
          }
          const latestThought =
            stage1ThoughtSummaries.length > 0
              ? `> **Gemini 4 Argon Thinking (${stage1ThoughtSummaries.length} steps):**\n> ${stage1ThoughtSummaries[stage1ThoughtSummaries.length - 1].replace(/\n/g, '\n> ')}\n\n---\n\n`
              : `> **Gemini 4 Argon is researching and verifying sources via Google Search...**\n\n---\n\n`;
          const liveBody =
            chunk.accumulatedText || '_Synthesizing findings from grounded search results..._';
          try {
            fs.writeFileSync(researchStreamTarget, `${latestThought}${liveBody}`, 'utf-8');
          } catch {
            // Ignore transient file write errors during live stream preview
          }
        },
        config: {
          maxOutputTokens: 65536,
          thinkingConfig: {
            thinkingLevel: stage1ThinkingLevel,
            includeThoughts: true,
          },
          tools: [{ googleSearch: {} }],
        },
        use: [
          // Resilience optimization: if primary thinking level fails after 1 retry, fall back to a lower thinking level on Gemini 4 Argon.
          // Note: `fallback` is placed outside `retry` and `normalizeFetchErrorMiddleware` converts plain fetch/stream Errors into
          // `GenkitError({ status: 'UNAVAILABLE' })` so `fallback` never skips network/timeout errors.
          fallback({
            isolateConfig: true,
            models: [
              googleAI.model(GEMINI_4_ARGON_MODEL, {
                maxOutputTokens: 65536,
                thinkingConfig: {
                  thinkingLevel: stage1FallbackThinkingLevel,
                  includeThoughts: true,
                },
                tools: [{ googleSearch: {} }],
              }),
            ],
            statuses: [
              'UNAVAILABLE',
              'DEADLINE_EXCEEDED',
              'RESOURCE_EXHAUSTED',
              'ABORTED',
              'INTERNAL',
            ],
          }),
          retry({ maxRetries: 1 }),
          async (req: any, next: any) => {
            try {
              return await next(req);
            } catch (err: any) {
              if (err instanceof GenkitError) {
                throw err;
              }
              throw new GenkitError({
                status: 'UNAVAILABLE',
                message: err?.message || String(err),
              });
            }
          },
        ],
      }
    );

    if (!stage1Response.text || stage1Response.text.trim() === '') {
      throw new Error(
        'Research summary output was empty. This is typically caused by safety/privacy filters blocking search queries about private individuals, or Google Grounding returning no results.'
      );
    }

    const cleanedText = await cleanGroundingLinks(
      stage1Response.text,
      stage1Response.message?.content
    );
    fs.writeFileSync(researchFileTarget, cleanedText);
    if (fs.existsSync(researchStreamTarget)) {
      try {
        fs.unlinkSync(researchStreamTarget);
      } catch {
        // Ignore cleanup errors
      }
    }

    const usage = stage1Response.usage || {};
    const durationMs = Date.now() - startTimeMs;
    console.log(
      `[Stage 1 Telemetry]: input=${usage.inputTokens ?? 0}, thoughts=${usage.thoughtsTokens ?? 0}, output=${usage.outputTokens ?? 0}, total=${usage.totalTokens ?? 0} tokens (${(durationMs / 1000).toFixed(1)}s)`
    );
    console.log(`Stage 1 complete. Output written to: ${researchFileTarget}`);

    const metaPath = path.join(runDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        meta.stage1Telemetry = {
          thinkingLevel: stage1ThinkingLevel,
          thoughtSteps: stage1ThoughtSummaries.length,
          inputTokens: usage.inputTokens ?? 0,
          thoughtsTokens: usage.thoughtsTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
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
);

// 3. Define Standalone Stage 2 Scriptwriting Flow (Human-in-the-Loop Intermission Gate)
export const runStage2Flow = ai.defineFlow(
  {
    name: 'runStage2Flow',
    inputSchema: z.object({
      workspaceRoot: z.string().describe('Path to the target workspace folder'),
      runId: z.string().describe('The unique identifier for this run'),
      thinkingLevel: ThinkingLevelSchema.optional().describe(
        'Gemini 4 Argon thinking level for Stage 2 Scriptwriting (LOW | MEDIUM | HIGH, defaults to MEDIUM)'
      ),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      outputPath: z.string(),
    }),
  },
  async (input) => {
    const workspacePath = path.resolve(input.workspaceRoot);
    const runDir = path.join(workspacePath, 'runs', input.runId);
    const researchFileTarget = path.join(runDir, 'stages/01_research/output/research_summary.md');
    const stage2Dir = path.join(runDir, 'stages/02_script');
    const scriptOutputTarget = path.join(stage2Dir, 'output/script_draft.json');
    const stage2ThinkingLevel = normalizeThinkingLevel(input.thinkingLevel, 'MEDIUM');
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
    const scriptPrompt = ai.prompt('02_script');

    const stage2Response = await scriptPrompt(
      {
        researchFile: activeResearchData,
        toneRules: toneGuide,
        globalIdentity,
        workspaceContext,
      },
      {
        onChunk: (chunk) => {
          if (chunk.reasoning && chunk.reasoning.trim()) {
            const previewSnippet = chunk.reasoning.trim().replace(/\s+/g, ' ').slice(0, 120);
            console.log(`[Stage 2 Thought]: ${previewSnippet}...`);
          }
        },
        config: {
          maxOutputTokens: 32768,
          thinkingConfig: {
            thinkingLevel: stage2ThinkingLevel,
            includeThoughts: true,
          },
        },
        use: [retry({ maxRetries: 2 })],
      }
    );

    const scriptJson = stage2Response.output;
    fs.writeFileSync(scriptOutputTarget, JSON.stringify(scriptJson, null, 2));

    const usage = stage2Response.usage || {};
    const durationMs = Date.now() - startTimeMs;
    console.log(
      `[Stage 2 Telemetry]: input=${usage.inputTokens ?? 0}, thoughts=${usage.thoughtsTokens ?? 0}, output=${usage.outputTokens ?? 0}, total=${usage.totalTokens ?? 0} tokens (${(durationMs / 1000).toFixed(1)}s)`
    );
    console.log(`Stage 2 complete. Output written to: ${scriptOutputTarget}`);

    const metaPath = path.join(runDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        meta.stage2Telemetry = {
          thinkingLevel: stage2ThinkingLevel,
          inputTokens: usage.inputTokens ?? 0,
          thoughtsTokens: usage.thoughtsTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
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
);

// 4. Define the Central Orchestration Flow (Layer 1 Task Router: Stage 1 -> Stage 2)
export const icmOrchestratorFlow = ai.defineFlow(
  {
    name: 'icmOrchestratorFlow',
    inputSchema: ICMWorkflowSchema,
    outputSchema: z.object({
      status: z.string(),
      outputPath: z.string(),
    }),
  },
  async (input) => {
    await runStage1Flow({
      workspaceRoot: input.workspaceRoot,
      runId: input.runId,
      topic: input.topic,
      thinkingLevel: input.researchThinkingLevel,
    });

    // --- INTERMISSION: HUMAN-IN-THE-LOOP INTERRUPT GATE ---
    // Between Stage 1 and Stage 2, the reviewer can inspect/edit `research_summary.md`
    // and re-run Stage 2 standalone at any time via `runStage2Flow`.

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
);

export interface StoredSessionData<S = any> {
  id: string;
  state?: S;
  threads?: Record<string, MessageData[]>;
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
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  }

  async getMessages(sessionId: string, thread: string = 'main'): Promise<MessageData[]> {
    const session = await this.get(sessionId);
    return session?.threads?.[thread] || [];
  }

  async updateMessages(
    sessionId: string,
    thread: string,
    messages: MessageData[]
  ): Promise<void> {
    const existing = (await this.get(sessionId)) || { id: sessionId, threads: {} };
    existing.threads = existing.threads || {};
    existing.threads[thread] = messages;
    await this.save(sessionId, existing);
  }
}

export const deployScriptDraftTool = ai.defineTool(
  {
    name: 'deployScriptDraftTool',
    description: 'Deploys the generated script to production media systems.',
    inputSchema: z.object({
      scriptId: z.string(),
      approvedText: z.string(),
    }),
    outputSchema: z.object({
      deploymentStatus: z.string(),
    }),
  },
  async (input, { interrupt, resumed }) => {
    const resumedObj = resumed as Record<string, any> | undefined;
    // 1. If we have resumed and the user explicitly rejected the action
    if (resumedObj?.status === 'REJECTED') {
      return { deploymentStatus: 'Deployment rejected by human reviewer.' };
    }

    // 2. If the user has not approved it yet, trigger an Interrupt
    if (resumedObj?.status !== 'APPROVED') {
      interrupt({
        reason: 'human_review_required',
        message: 'Please review and approve the draft before deployment.',
        draftText: input.approvedText,
      });
    }

    // 3. Perform the actual action once approved
    return {
      deploymentStatus: `Successfully deployed script ${input.scriptId}`,
    };
  }
);

export async function handleInteractiveDeployment(
  sessionId: string,
  promptText: string,
  thinkingLevel?: string
) {
  const store = new LocalDiskSessionStore();
  const resolvedThinkingLevel = normalizeThinkingLevel(thinkingLevel, 'LOW');

  const response = await ai.generate({
    model: googleAI.model(GEMINI_4_ARGON_MODEL),
    prompt: promptText,
    tools: [deployScriptDraftTool],
    config: {
      store: true,
      maxOutputTokens: 32768,
      thinkingConfig: {
        thinkingLevel: resolvedThinkingLevel,
      },
    },
  });

  // Save the messages back to the session store
  if (response.messages) {
    await store.updateMessages(sessionId, 'main', response.messages);
  }

  // Handle the Interrupted Exception gracefully
  if (response.finishReason === 'interrupted' && response.interrupts && response.interrupts.length > 0) {
    const interrupt = response.interrupts[0];
    console.log(`Execution paused. Interrupt ID: ${interrupt.toolRequest.ref}`);
    console.log(`Review Payload: ${JSON.stringify(interrupt.toolRequest.input)}`);

    // Execution stops here, returning state to the client for human approval
    return {
      status: 'AWAITING_APPROVAL',
      sessionId,
      interrupt,
      thinkingLevel: resolvedThinkingLevel,
    };
  }

  return { status: 'COMPLETED', text: response.text, thinkingLevel: resolvedThinkingLevel };
}

// Function triggered when human hits "Approve" button on Client UI
export async function approveAndResume(
  sessionId: string,
  interruptObj: any,
  thinkingLevel?: string
) {
  const store = new LocalDiskSessionStore();
  const resolvedThinkingLevel = normalizeThinkingLevel(thinkingLevel, 'LOW');

  // Use the `.restart` helper on the tool to bind confirmation metadata
  const approvedPart = deployScriptDraftTool.restart(interruptObj, {
    status: 'APPROVED',
  });

  const messages = await store.getMessages(sessionId, 'main');

  // Resume processing, injecting conversation history and approval variables
  const response = await ai.generate({
    model: googleAI.model(GEMINI_4_ARGON_MODEL),
    tools: [deployScriptDraftTool],
    messages: messages, // Carry over conversational turn context
    resume: {
      restart: [approvedPart],
    },
    config: {
      store: true,
      maxOutputTokens: 32768,
      thinkingConfig: {
        thinkingLevel: resolvedThinkingLevel,
      },
    },
  });

  // Save the resumed messages back to the session store
  if (response.messages) {
    await store.updateMessages(sessionId, 'main', [...messages, ...response.messages]);
  }

  return { status: 'COMPLETED', text: response.text, thinkingLevel: resolvedThinkingLevel };
}

// Function triggered when human hits "Reject" button on Client UI
export async function rejectAndResume(
  sessionId: string,
  interruptObj: any,
  thinkingLevel?: string
) {
  const store = new LocalDiskSessionStore();
  const resolvedThinkingLevel = normalizeThinkingLevel(thinkingLevel, 'LOW');

  const rejectedPart = deployScriptDraftTool.restart(interruptObj, {
    status: 'REJECTED',
  });

  const messages = await store.getMessages(sessionId, 'main');

  const response = await ai.generate({
    model: googleAI.model(GEMINI_4_ARGON_MODEL),
    tools: [deployScriptDraftTool],
    messages: messages,
    resume: {
      restart: [rejectedPart],
    },
    config: {
      store: true,
      maxOutputTokens: 32768,
      thinkingConfig: {
        thinkingLevel: resolvedThinkingLevel,
      },
    },
  });

  if (response.messages) {
    await store.updateMessages(sessionId, 'main', [...messages, ...response.messages]);
  }

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
