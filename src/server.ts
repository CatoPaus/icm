import express from 'express';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import {
  icmOrchestratorFlow,
  runStage2Flow,
  handleInteractiveDeployment,
  approveAndResume,
  rejectAndResume,
  GEMINI_4_ARGON_MODEL,
  normalizeThinkingLevel,
} from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mirror terminal stdout/stderr to .icm/terminal.log (gitignored) so the agent can always inspect
// live terminal output whenever asked without requiring an @terminal mention pill.
const terminalLogPath = path.resolve('.icm/terminal.log');
try {
  fs.mkdirSync(path.dirname(terminalLogPath), { recursive: true });
  fs.writeFileSync(
    terminalLogPath,
    `--- Server session started at ${new Date().toISOString()} ---\n`,
    'utf-8'
  );
  const appendLog = (chunk: any) => {
    try {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      const clean = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
      fs.appendFileSync(terminalLogPath, clean, 'utf-8');
    } catch {
      // Ignore logging errors
    }
  };
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    appendLog(chunk);
    return origStdoutWrite(chunk, ...args);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    appendLog(chunk);
    return origStderrWrite(chunk, ...args);
  }) as typeof process.stderr.write;
} catch {
  // Ignore log setup errors
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend assets from 'public' directory (with SSR initial-state injection for index.html)
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir, { index: false }));

// Mark any runs left in "running" state from a previous interrupted server process as "failed"
function recoverInterruptedRuns() {
  const runsDir = path.resolve('./workspace/runs');
  if (!fs.existsSync(runsDir)) return;
  try {
    const folders = fs.readdirSync(runsDir);
    for (const folder of folders) {
      const metaPath = path.join(runsDir, folder, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (meta.status === 'running') {
            meta.status = 'failed';
            meta.error = 'Run was interrupted because the server process restarted mid-execution.';
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
            console.log(`Recovered interrupted run ${folder}: marked as failed.`);
          }
        } catch (e) {
          console.error(`Failed to inspect meta.json for ${folder}:`, e);
        }
      }
    }
  } catch (e) {
    console.error('Error sweeping interrupted runs:', e);
  }
}

recoverInterruptedRuns();

function slugify(text: string) {
  const slug = text
    .toString()
    .toLowerCase()
    .trim()
    // Transliterate Norwegian characters
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[^\w\-]+/g, '') // Remove all non-word chars
    .replace(/\-\-+/g, '-') // Replace multiple - with single -
    .replace(/^-+/, '') // Trim - from start
    .replace(/-+$/, ''); // Trim - from end

  if (slug.length <= 40) {
    return slug;
  }

  // Safe truncation to avoid breaking MAX_PATH limits on Windows
  let truncated = slug.substring(0, 40);
  const lastHyphen = truncated.lastIndexOf('-');
  if (lastHyphen > 10) {
    truncated = truncated.substring(0, lastHyphen);
  }
  return truncated.replace(/-+$/, '');
}

// Endpoint for client health checks
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    model: GEMINI_4_ARGON_MODEL,
    thinkingLevels: {
      research: 'HIGH',
      script: 'MEDIUM',
      interactive: 'LOW',
    },
  });
});

// Endpoint to run the sequential orchestrator flow
app.post('/api/run', async (req, res) => {
  const { topic, researchThinkingLevel, scriptThinkingLevel } = req.body;
  if (!topic) {
    return res.status(400).json({ error: 'Topic is required' });
  }

  const resolvedResearchLevel = normalizeThinkingLevel(researchThinkingLevel, 'HIGH');
  const resolvedScriptLevel = normalizeThinkingLevel(scriptThinkingLevel, 'MEDIUM');

  // Generate a unique runId
  const runId = `${slugify(topic)}-${Date.now()}`;

  // Write run metadata first to preserve original topic casing/characters
  const runDir = path.resolve('./workspace/runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'meta.json'),
    JSON.stringify(
      {
        runId,
        topic,
        model: GEMINI_4_ARGON_MODEL,
        researchThinkingLevel: resolvedResearchLevel,
        scriptThinkingLevel: resolvedScriptLevel,
        status: 'running',
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf-8'
  );

  console.log(
    `Starting orchestrator flow for topic: ${topic} (Run: ${runId}, Research Thinking: ${resolvedResearchLevel}, Script Thinking: ${resolvedScriptLevel}) in background...`
  );

  // Execute the flow asynchronously in the background
  icmOrchestratorFlow({
    workspaceRoot: './workspace',
    runId: runId,
    topic: topic,
    researchThinkingLevel: resolvedResearchLevel,
    scriptThinkingLevel: resolvedScriptLevel,
  })
    .then(() => {
      console.log(`Orchestrator flow completed successfully for Run: ${runId}`);
      const metaPath = path.join(runDir, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          meta.status = 'completed';
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        } catch (e) {
          console.error('Failed to update meta status:', e);
        }
      }
    })
    .catch((error) => {
      console.error(`Error running flow in background for Run ${runId}:`, error);
      const metaPath = path.join(runDir, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          meta.status = 'failed';
          meta.error = error.message || 'Failed to execute orchestrator flow';
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        } catch (e) {
          console.error('Failed to update meta status on error:', e);
        }
      }
    });

  // Respond immediately with success and status
  res.json({
    success: true,
    runId,
    status: 'running',
    model: GEMINI_4_ARGON_MODEL,
    researchThinkingLevel: resolvedResearchLevel,
    scriptThinkingLevel: resolvedScriptLevel,
  });
});

// Endpoint to run standalone Stage 2 scriptwriting flow
app.post('/api/run-stage2', async (req, res) => {
  const { runId, thinkingLevel } = req.body;
  if (!runId) {
    return res.status(400).json({ error: 'RunId is required' });
  }

  const workspacePath = path.resolve('./workspace');
  const researchPath = path.join(
    workspacePath,
    'runs',
    runId,
    'stages/01_research/output/research_summary.md'
  );
  if (!fs.existsSync(researchPath)) {
    return res.status(409).json({
      error:
        'Stage 1 Research is not ready yet. Please wait for Stage 1 to finish before generating the Stage 2 script.',
    });
  }

  const resolvedThinkingLevel = normalizeThinkingLevel(thinkingLevel, 'MEDIUM');

  try {
    console.log(
      `Starting Stage 2 standalone scriptwriting flow for Run: ${runId} (Thinking: ${resolvedThinkingLevel})`
    );
    const result = await runStage2Flow({
      workspaceRoot: './workspace',
      runId: runId,
      thinkingLevel: resolvedThinkingLevel,
    });
    res.json({ success: true, result, thinkingLevel: resolvedThinkingLevel });
  } catch (error: any) {
    console.error('Error running Stage 2:', error);
    res.status(500).json({ error: error.message || 'Failed to run Stage 2' });
  }
});

// Helper to read all historical runs synchronously from disk (used by both /api/runs and SSR initial hydration)
function listRunsFromDisk() {
  const runsDir = path.resolve('./workspace/runs');
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }
  const folders = fs.readdirSync(runsDir);
  return folders
    .map((folder) => {
      if (folder.startsWith('_')) return null;
      const folderPath = path.join(runsDir, folder);
      const stats = fs.statSync(folderPath);
      if (!stats.isDirectory()) return null;

      const metaPath = path.join(folderPath, 'meta.json');
      let topic = '';
      let createdAt = stats.birthtime;

      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          topic = meta.topic;
          if (meta.createdAt) {
            createdAt = new Date(meta.createdAt);
          }
        } catch (e) {
          console.error(`Error reading meta.json for run ${folder}:`, e);
        }
      }

      // Fallback to slug-based reconstruction if meta.json doesn't exist
      if (!topic) {
        const reconstructed = folder.replace(/-[0-9]+$/, '').replace(/-/g, ' ');
        topic = reconstructed
          .split(' ')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
      }

      return {
        runId: folder,
        createdAt: createdAt,
        topic: topic,
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime());
}

// Helper to read stage handoff files for a run synchronously (used by /api/stages/files and SSR initial hydration)
function readStageFilesFromDisk(runId?: string) {
  const workspacePath = path.resolve('./workspace');
  const baseDir = runId ? path.join(workspacePath, 'runs', runId) : workspacePath;
  const researchPath = path.join(baseDir, 'stages/01_research/output/research_summary.md');
  const researchStreamPath = path.join(baseDir, 'stages/01_research/output/research_stream.md');
  const scriptPath = path.join(baseDir, 'stages/02_script/output/script_draft.json');
  const metaPath = path.join(baseDir, 'meta.json');

  const researchContent = fs.existsSync(researchPath) ? fs.readFileSync(researchPath, 'utf-8') : '';
  const researchStreamContent = fs.existsSync(researchStreamPath)
    ? fs.readFileSync(researchStreamPath, 'utf-8')
    : '';
  const scriptContent = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf-8') : '';

  let meta = null;
  if (fs.existsSync(metaPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch (e) {
      console.error('Failed to parse meta.json in files query:', e);
    }
  }

  return {
    research: researchContent,
    researchStream: researchStreamContent,
    script: scriptContent,
    researchExists: fs.existsSync(researchPath),
    scriptExists: fs.existsSync(scriptPath),
    meta: meta,
  };
}

// Endpoint to list all historical runs
app.get('/api/runs', (req, res) => {
  try {
    const runs = listRunsFromDisk();
    res.json({ success: true, runs });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to list runs' });
  }
});

// Endpoint to delete a specific run's files and directory
app.delete('/api/run/:runId', (req, res) => {
  const { runId } = req.params;
  const runDir = path.resolve('./workspace/runs', runId);

  try {
    if (fs.existsSync(runDir)) {
      fs.rmSync(runDir, { recursive: true, force: true });
      console.log(`Permanently deleted run directory: ${runDir}`);
      res.json({ success: true, message: `Successfully deleted run ${runId}` });
    } else {
      res.status(404).json({ error: 'Run directory not found' });
    }
  } catch (error: any) {
    console.error('Error deleting run:', error);
    res.status(500).json({ error: error.message || 'Failed to delete run' });
  }
});

// Endpoint to open a specific run's folder in the native desktop file manager (Windows 11, Ubuntu/Linux Desktop, WSL, macOS)
app.post('/api/run/:runId/open', (req, res) => {
  const { runId } = req.params;
  const runDir = path.resolve('./workspace/runs', runId);

  try {
    if (!fs.existsSync(runDir)) {
      return res.status(404).json({ error: 'Run directory not found' });
    }

    console.log(`Opening folder in desktop file manager (${process.platform}): ${runDir}`);

    if (process.platform === 'linux') {
      // Check if running inside WSL on Windows first
      let isWsl = false;
      try {
        const procVersion = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
        isWsl = procVersion.includes('microsoft') || procVersion.includes('wsl');
      } catch {
        // Ignore if /proc/version is unreadable
      }

      if (isWsl) {
        execFile('wslpath', ['-w', runDir], (err, winPath) => {
          const targetPath = !err && winPath ? winPath.trim() : runDir;
          execFile('explorer.exe', [targetPath], () => {});
        });
      } else {
        // Ubuntu / Linux Desktop (GNOME Nautilus, KDE Dolphin, XFCE Thunar via xdg-open -> gio open -> nautilus)
        execFile('xdg-open', [runDir], (xdgErr) => {
          if (xdgErr) {
            execFile('gio', ['open', runDir], (gioErr) => {
              if (gioErr) {
                execFile('nautilus', [runDir], (nautErr) => {
                  if (nautErr) {
                    console.error('Error launching Linux desktop file manager:', nautErr);
                  }
                });
              }
            });
          }
        });
      }

      return res.json({ success: true });
    }

    if (process.platform === 'darwin') {
      execFile('open', [runDir], (err) => {
        if (err) {
          console.error('Error launching macOS Finder:', err);
        }
      });
      return res.json({ success: true });
    }

    const psQuote = (val: string) => `'${val.replace(/'/g, "''")}'`;

    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$runId = ${psQuote(runId)}
$runDir = ${psQuote(runDir)}

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win11ExplorerHelper {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr OpenDesktopW(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll")] public static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool PostMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessW(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation
    );

    private static void SendSameSizeWmSize(IntPtr hWnd) {
        RECT rc;
        if (GetClientRect(hWnd, out rc)) {
            int cw = rc.Right - rc.Left;
            int ch = rc.Bottom - rc.Top;
            if (cw > 0 && ch > 0) {
                IntPtr lParam = (IntPtr)((ch << 16) | (cw & 0xFFFF));
                PostMessageW(hWnd, 0x0005, IntPtr.Zero, lParam); // WM_SIZE (SIZE_RESTORED) without changing outer window rect
            }
        }
    }

    public static bool FocusOnDefaultDesktop(string folderName, bool syncClientLayout) {
        IntPtr hDesk = OpenDesktopW("Default", 0, false, 0x01FF);
        if (hDesk == IntPtr.Zero) return false;
        SetThreadDesktop(hDesk);
        IntPtr found = IntPtr.Zero;
        EnumDesktopWindows(hDesk, (hWnd, lp) => {
            if (!IsWindowVisible(hWnd) && !IsIconic(hWnd)) return true;
            var sbClass = new StringBuilder(256);
            GetClassNameW(hWnd, sbClass, 256);
            if (sbClass.ToString() == "CabinetWClass") {
                var sbTitle = new StringBuilder(512);
                GetWindowTextW(hWnd, sbTitle, 512);
                if (sbTitle.ToString().IndexOf(folderName, StringComparison.OrdinalIgnoreCase) >= 0) {
                    found = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        if (found != IntPtr.Zero) {
            if (IsIconic(found)) {
                ShowWindow(found, 9); // SW_RESTORE only when minimized
            }

            // Activate cleanly via AttachThreadInput instead of toggling HWND_TOPMOST/NOTOPMOST (eliminates DWM shadow flash)
            IntPtr fgWnd = GetForegroundWindow();
            uint dummyPid = 0;
            uint fgThread = fgWnd != IntPtr.Zero ? GetWindowThreadProcessId(fgWnd, out dummyPid) : 0;
            uint curThread = GetCurrentThreadId();
            if (fgThread != 0 && fgThread != curThread) {
                AttachThreadInput(curThread, fgThread, true);
                BringWindowToTop(found);
                SetForegroundWindow(found);
                AttachThreadInput(curThread, fgThread, false);
            } else {
                BringWindowToTop(found);
                SetForegroundWindow(found);
            }

            if (syncClientLayout && !IsIconic(found)) {
                SendSameSizeWmSize(found);
            }
            return true;
        }
        return false;
    }

    public static void LaunchOnDefaultDesktop(string cmdLine) {
        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.lpDesktop = @"WinSta0\\Default";
        PROCESS_INFORMATION pi;
        CreateProcessW(null, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
    }
}
"@

# 1. If the window is already open on WinSta0\\Default, bring it to the front immediately
if ([Win11ExplorerHelper]::FocusOnDefaultDesktop($runId, $false)) {
    exit 0
}

# 2. Otherwise launch Explorer on WinSta0\\Default and focus as soon as visible
$cmd = 'C:\\Windows\\explorer.exe "' + $runDir + '"'
[Win11ExplorerHelper]::LaunchOnDefaultDesktop($cmd)

for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 80
    if ([Win11ExplorerHelper]::FocusOnDefaultDesktop($runId, $true)) {
        break
    }
}
`;

    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
      (err) => {
        if (err) {
          console.error('Error launching Explorer via PowerShell helper:', err);
        }
      }
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error opening folder:', error);
    res.status(500).json({ error: error.message || 'Failed to open directory' });
  }
});

// Endpoint to start an interactive stateful run
app.post('/api/run-interactive', async (req, res) => {
  const { promptText, thinkingLevel } = req.body;
  const sessionId = `session-${Date.now()}`;
  const resolvedThinkingLevel = normalizeThinkingLevel(thinkingLevel, 'LOW');

  try {
    console.log(
      `Starting interactive deployment run. Session: ${sessionId} (Thinking: ${resolvedThinkingLevel})`
    );
    const state = await handleInteractiveDeployment(
      sessionId,
      promptText || 'Deploy script draft to media systems',
      resolvedThinkingLevel
    );
    res.json({ sessionId, ...state });
  } catch (error: any) {
    console.error('Error starting interactive run:', error);
    res.status(500).json({ error: error.message || 'Failed to run interactive deployment' });
  }
});

// Endpoint to query session state
app.get('/api/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const sessionPath = path.resolve('.sessions', `${sessionId}.json`);

  if (fs.existsSync(sessionPath)) {
    try {
      const raw = fs.readFileSync(sessionPath, 'utf-8');
      const sessionData = JSON.parse(raw);
      res.json(sessionData);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to read session data' });
    }
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Endpoint to resume session with approval or rejection
app.post('/api/session/:sessionId/resume', async (req, res) => {
  const { sessionId } = req.params;
  const { interrupt, approved, thinkingLevel } = req.body;
  const resolvedThinkingLevel = normalizeThinkingLevel(thinkingLevel, 'LOW');

  if (!interrupt) {
    return res.status(400).json({ error: 'Interrupt payload is required to resume' });
  }

  try {
    console.log(
      `Resuming session ${sessionId} with approval status: ${approved} (Thinking: ${resolvedThinkingLevel})`
    );

    if (approved) {
      const result = await approveAndResume(sessionId, interrupt, resolvedThinkingLevel);
      res.json(result);
    } else {
      const result = await rejectAndResume(sessionId, interrupt, resolvedThinkingLevel);
      res.json(result);
    }
  } catch (error: any) {
    console.error('Error resuming session:', error);
    res.status(500).json({ error: error.message || 'Failed to resume session' });
  }
});

// Endpoint to read stage handoff files
app.get('/api/stages/files', (req, res) => {
  const { runId } = req.query;
  res.json(readStageFilesFromDisk(runId as string | undefined));
});

// Endpoint to write (manually edit) stage handoff files
app.post('/api/stages/files', (req, res) => {
  const { type, content, runId } = req.body;
  if (!type || content === undefined) {
    return res.status(400).json({ error: 'Type and content are required' });
  }

  const workspacePath = path.resolve('./workspace');
  const baseDir = runId ? path.join(workspacePath, 'runs', runId as string) : workspacePath;
  try {
    if (type === 'research') {
      const researchPath = path.join(baseDir, 'stages/01_research/output/research_summary.md');
      fs.mkdirSync(path.dirname(researchPath), { recursive: true });
      fs.writeFileSync(researchPath, content, 'utf-8');
      console.log(`Updated Stage 1 research summary manually for Run ${runId}.`);
      res.json({ success: true, message: 'Research summary updated successfully' });
    } else if (type === 'script') {
      const scriptPath = path.join(baseDir, 'stages/02_script/output/script_draft.json');
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      // Validate JSON if content is script
      let formattedContent = content;
      try {
        formattedContent = JSON.stringify(JSON.parse(content), null, 2);
      } catch (e) {
        // use raw content if it's not valid JSON
      }
      fs.writeFileSync(scriptPath, formattedContent, 'utf-8');
      console.log(`Updated Stage 2 script draft manually for Run ${runId}.`);
      res.json({ success: true, message: 'Script draft updated successfully' });
    } else {
      res.status(400).json({ error: 'Invalid file type. Must be "research" or "script"' });
    }
  } catch (error: any) {
    console.error('Error saving file:', error);
    res.status(500).json({ error: 'Failed to write file to workspace' });
  }
});

// Next.js-style SSR initial payload hydration for Express:
// Embeds initial runs list and active run files directly into index.html so the first browser paint
// already has all data without a client-side fetch waterfall or empty-to-loaded screen flicker.
function serveHydratedIndexHtml(res: express.Response) {
  try {
    const htmlPath = path.join(publicDir, 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');
    const runs = listRunsFromDisk();
    const initialRunId = runs.length > 0 && runs[0] ? runs[0].runId : null;
    const initialFiles = initialRunId ? readStageFilesFromDisk(initialRunId) : null;
    const initialStateJson = JSON.stringify({
      runs,
      initialRunId,
      initialFiles,
    }).replace(/</g, '\\u003c');

    html = html.replace(
      '<script src="app.js"></script>',
      `<script>window.__INITIAL_STATE__ = ${initialStateJson};</script>\n  <script src="app.js"></script>`
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    res.sendFile(path.join(publicDir, 'index.html'));
  }
}

// Catch-all middleware to serve the SPA frontend with SSR initial state
app.use((req, res) => {
  serveHydratedIndexHtml(res);
});

app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(` ICM Web Dashboard running at http://localhost:${PORT}`);
  console.log(` Active Model: ${GEMINI_4_ARGON_MODEL}`);
  console.log(`==================================================`);
});
