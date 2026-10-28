# ICM Reference Demo Web Dashboard (`src/server.ts` & `public/`)

This directory (`public/`) together with `src/server.ts` implements the **Reference Demo Web Dashboard** for the Interpretable Context Methodology (ICM) repository.

Because the core **ICM Engine** (`src/index.ts`, `prompts/`, `workspace/`) is strictly decoupled from the presentation layer, this Express + Vanilla JS Single-Page Application (SPA) serves as an out-of-the-box visual workbench that downstream projects can either use directly or replace with a framework like **Next.js** or headless CLI automation.

---

## Architecture & UI Capabilities

### 1. Zero-Flicker Server-Side State Hydration (`window.__INITIAL_STATE__`)
* On `GET /`, `src/server.ts` reads the latest run metadata and active run artifacts from `workspace/runs/` and injects them directly into `public/index.html` as `window.__INITIAL_STATE__`.
* The dashboard renders immediately on initial page load with zero layout shift, empty-state flash, or waterfall fetch latency.

### 2. Live DOM Reconciliation (`reconcilePreviewHtml` in `public/app.js`)
* While Stage 1 or Stage 2 is actively streaming (`research_stream.md`), `public/app.js` polls `/api/run/:runId` every 3 seconds.
* Instead of overwriting `innerHTML` on each poll (which resets scroll position and flashes headings/links), `reconcilePreviewHtml` diffs child DOM nodes in place so only newly streamed paragraphs update smoothly.

### 3. Cross-Platform Desktop File Manager Integration (`POST /api/run/:runId/open`)
Clicking **Open Folder** in the Web Dashboard opens the active run directory (`workspace/runs/<runId>/`) directly in your operating system's native desktop file manager:

* **Linux Desktop (Ubuntu / GNOME / KDE / XFCE — `process.platform === 'linux'`):**
  * Launches the native desktop file manager in the foreground using `xdg-open` with automatic fallbacks to `gio open` and `nautilus` (Ubuntu's default GNOME Files manager).
  * **WSL (Windows Subsystem for Linux) Detection:** If running inside WSL on Windows (`WSL_DISTRO_NAME` or `/proc/version` matching `microsoft`), automatically converts the Linux path via `wslpath -w` and opens Windows File Explorer (`explorer.exe`).
* **macOS (`process.platform === 'darwin'`):**
  * Opens the run folder in macOS **Finder** via `open "<runDir>"`.
* **Windows 11 (`process.platform === 'win32'`):**
  * Uses `Win11ExplorerHelper` (`CreateProcessW` pinned to the interactive `WinSta0\Default` desktop) to reuse an existing File Explorer tab or launch a fresh window, and sends a `WM_SIZE` nudge so Windows 11's `DesktopChildSiteBridge` XAML islands paint immediately without blank tabs.

### 4. Live Terminal Mirror (`.genkit/terminal.log`)
* When `src/server.ts` starts (`npm run server` or `npm run dev:all`), it automatically tees all `stdout` and `stderr` output (stripped of ANSI escape codes) to `.genkit/terminal.log`.
* Both human developers and the Antigravity 2.0 ICM Co-Architect agent can inspect `.genkit/terminal.log` to diagnose runtime or API errors without copying and pasting terminal output.

---

## API Endpoints (`src/server.ts`)

| Method & Endpoint | Description |
| :--- | :--- |
| `GET /` | Serves `public/index.html` hydrated with `window.__INITIAL_STATE__`. |
| `GET /api/runs` | Lists all runs in `workspace/runs/` sorted newest-first (`meta.json` + stage completion flags). |
| `GET /api/run/:runId` | Returns full artifacts for a single run (`research_summary.md`, live `research_stream.md`, `script_draft.json`, and `voice_guide.md`). |
| `PUT /api/run/:runId/research` | Saves human-in-the-loop edits to `stages/01_research/output/research_summary.md`. |
| `PUT /api/config/voice` | Saves updates to Layer 3 (`workspace/_config/voice_guide.md`). |
| `POST /api/run/start` | Starts a full pipeline run (`icmOrchestratorFlow`) asynchronously in the background. |
| `POST /api/run/:runId/stage2` | Re-runs Stage 2 (`runStage2Flow`) standalone using the existing (or human-edited) Stage 1 artifact on disk. |
| `POST /api/run/:runId/open` | Opens `workspace/runs/<runId>` in the native desktop file manager (Ubuntu/Linux Desktop, WSL, macOS Finder, or Windows 11 Explorer). |

---

## Web Dashboard Walkthrough

1. **Start the Dashboard:**
   ```bash
   npm run genkit:dev
   ```
   *(Or run `npm run server` to start only the Web Dashboard on `http://localhost:3000`.)*
2. **Trigger a Pipeline Run:**
   * Open `http://localhost:3000`.
   * Enter a topic, select your desired Thinking Levels (`HIGH` for Stage 1 Research, `MEDIUM` for Stage 2 Scriptwriting), and click **Run Full Pipeline**.
3. **Inspect Live Streaming & Grounded Citations:**
   * Watch Stage 1 stream real-time reasoning thoughts and partial Markdown via `research_stream.md`, followed by resolved inline citations in `research_summary.md`.
4. **Human-in-the-Loop Editing & Stage 2 Regeneration:**
   * Click **Edit Markdown** in the dashboard (or click **Open Folder** to edit `research_summary.md` in your local editor on Ubuntu, macOS, or Windows) and save your changes.
   * Click **Regenerate Script** to re-run Stage 2 (`MEDIUM` thinking) standalone against your curated Stage 1 research artifact.
