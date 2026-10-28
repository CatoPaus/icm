import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const mode = process.argv[2];

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf-8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

if (mode === 'session-start') {
  readStdinJson();

  const runsDir = path.join(repoRoot, 'workspace', 'runs');

  let latestRunInfo = 'No runs executed yet in workspace/runs/.';
  if (fs.existsSync(runsDir)) {
    const runFolders = fs
      .readdirSync(runsDir)
      .map((name) => {
        const full = path.join(runsDir, name);
        try {
          const stat = fs.statSync(full);
          return stat.isDirectory() ? { name, mtimeMs: stat.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (runFolders.length > 0) {
      const latest = runFolders[0].name;
      const metaPath = path.join(runsDir, latest, 'meta.json');
      let status = 'unknown';
      let topic = '';
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          status = meta.status || 'unknown';
          topic = meta.topic || '';
        } catch {
          // ignore
        }
      }
      latestRunInfo = `Latest run: "${latest}" (status: ${status}${topic ? `, topic: "${topic}"` : ''}). Total runs: ${runFolders.length}.`;
    }
  }

  const projectFolderName = path.basename(repoRoot);
  const msg = [
    '[ICM Co-Architect Session Context]',
    `- Workspace Root: ${repoRoot}`,
    `- Project Folder Name (Domain Signal): "${projectFolderName}" (use this folder name to infer the user's likely project domain and pre-populate tailored "(Recommended)" options when asking Question 1 via ask_question).`,
    `- ${latestRunInfo}`,
    '- Pure ICM Filesystem Traces: Every stage writes input/prompt_assembled.md, output/thinking_trace.md, and token telemetry in workspace/runs/<runId>/meta.json.',
    '- Reminder: Follow the root GEMINI.md one-question / one-stage-at-a-time workflow. Never dump multi-step plans before testing Stage 1 via npm run cli:stage1.'
  ].join('\n');

  process.stdout.write(
    JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: msg
          }
        }
      ]
    })
  );
  process.exit(0);
}

if (mode === 'pre-tool-use') {
  const payload = readStdinJson();
  const args = payload?.toolCall?.args || {};
  const targetPath = String(args.Path || '');
  const contentToWrite = String(args.Content || args.Replacement || '');

  const normalizedPath = targetPath.replace(/\\/g, '/');
  const isPromptOrSource =
    normalizedPath.includes('/prompts/') ||
    normalizedPath.includes('/src/');

  if (isPromptOrSource && contentToWrite) {
    const forbiddenModelMatch = contentToWrite.match(/gemini-(1\.5|2\.0|2\.5|3\.0|3\.5)/i);
    if (forbiddenModelMatch) {
      process.stdout.write(
        JSON.stringify({
          decision: 'deny',
          reason: `Blocked by ICM Argon Guard: Legacy model "${forbiddenModelMatch[0]}" is forbidden. Use only "gemini-4-argon".`
        })
      );
      process.exit(0);
    }

    const isPromptFile = normalizedPath.includes('/prompts/');
    const forbiddenSamplingMatch = contentToWrite.match(/\b(temperature|topP|topK)\s*:/);
    if (isPromptFile && forbiddenSamplingMatch) {
      process.stdout.write(
        JSON.stringify({
          decision: 'deny',
          reason: `Blocked by ICM Argon Guard: Sampling parameter "${forbiddenSamplingMatch[1]}" is forbidden on Gemini 4 Argon. Use thinkingConfig.thinkingLevel (LOW | MEDIUM | HIGH) instead.`
        })
      );
      process.exit(0);
    }
  }

  process.stdout.write(JSON.stringify({ decision: 'allow' }));
  process.exit(0);
}

process.stdout.write(JSON.stringify({}));
