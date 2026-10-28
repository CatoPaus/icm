# Interpretable Context Methodology (ICM) with Gemini 4 Argon

This repository contains a **100% Pure Interpretable Context Methodology (ICM)** reference implementation built in TypeScript and Node.js, powered directly by the **Google AI Interactions API (`/v1beta/interactions`)** and **Gemini 4 Argon (`gemini-4-argon`)** with zero external AI orchestration framework bloat.

ICM is a declarative, filesystem-centric context management architecture that replaces opaque framework state machines with numbered stage directories, Markdown-based stage contracts, and explicit sandboxing boundaries on disk.

---

## Core Philosophy & Vision

This setup is a **filesystem-first, human-in-the-loop intelligence and production workbench** built on the **Interpretable Context Methodology (ICM)** rather than a black-box multi-agent framework:

### 1. The Filesystem *Is* the State Machine & Trace Log (ICM Layers 0–4)
Instead of trapping intermediate agent state inside in-memory framework closures or external telemetry daemons, every boundary in the pipeline is a **numbered folder and an inspectable file on disk** under `workspace/runs/<runId>/`:
* **Layer 0 & 1 (`workspace/GEMINI.md` + `workspace/CONTEXT.md`):** Global epistemic rules (strict fact-grounding, automatic Norwegian/English language matching) and pipeline awareness injected into every stage.
* **Layer 2 (`prompts/01_research.md`, `prompts/02_script.md`):** Strict stage contracts and schemas parsed directly from Markdown files on disk.
* **Layer 3 (`workspace/_config/voice_guide.md`):** Reusable domain/style rules decoupled from the prompt logic.
* **Layer 4 (`research_summary.md`, `script_draft.json`):** Concrete artifacts that act as the *only* handoff between stages, paired with the exact assembled input prompt (`input/prompt_assembled.md`) and reasoning trace (`output/thinking_trace.md`) in every stage folder.

### 2. Asymmetric Cognitive Allocation on a Single Frontier Model (`gemini-4-argon`)
By locking the entire runtime to **Gemini 4 Argon** (`src/index.ts`) and tuning `thinkingLevel` + capabilities per stage, you get deep reasoning where needed and strict determinism downstream:
* **Stage 1 (`01_research` — `HIGH` thinking + Google Search + `65,536` output budget):** Does the heavy lifting—multi-query live web research, deep strategic synthesis, and byte-accurate inline citation weaving (`cleanGroundingLinks`).
* **Stage 2 (`02_script` — `MEDIUM` thinking + zero web access):** Operates in a sealed sandbox using *only* the verified Stage 1 artifact and Layer 3 guide—so downstream deliverables can never introduce unverified claims.

### 3. Frictionless Human-in-the-Loop Iteration
Because every run lives in plain Markdown and JSON files on disk (`workspace/runs/<runId>/`), you can:
1. Run deep research once (watching it stream live via `research_stream.md`).
2. Inspect, curate, or edit `research_summary.md` (or tweak `voice_guide.md`) directly in your local editor or through the reference Web Dashboard ([`public/README.md`](./public/README.md)).
3. Re-run Stage 2 (or future downstream stages) standalone in seconds without re-running or paying for Stage 1 research again.

### 4. Extensible N-Stage Pipeline Roadmap
`01_research` → `02_script` is the blueprint for a **plug-and-play N-stage pipeline**:
* **Fan-out / Downstream Stages (`03_...`, `04_...`):** From a single verified `01_research` artifact, you can branch into multiple specialized outputs (e.g., executive strategy decks, competitor matrices, SEO/content briefs, audio/TTS generation via Gemini TTS, or visual storyboards) simply by adding a numbered stage folder and a `prompts/03_<name>.md` stage contract.
* **1M-Token Deep Context Ingestion:** Drop large local reference corpora (PDFs, competitor dumps, financial reports, or prior run outputs) into a stage's `_config/` or `input/` folder so Argon can synthesize live Google Search grounding *with* hundreds of thousands of tokens of proprietary context.

---

## Using as an Upstream Base / Template Repository

This repository is designed to serve as an **untouched upstream base template** for specialized downstream projects (e.g., `icm-podcast-studio`, `icm-market-strategy`, `icm-legal-review`). Runtime outputs (`workspace/runs/`, `.icm/`, `.sessions/`) are excluded via `.gitignore` so the base repository remains clean.

Because the **Pure ICM Engine** (`src/index.ts`, `prompts/`, `workspace/`) has **zero external framework dependencies** and is completely decoupled from the **Presentation / Server Layer** (`src/server.ts`, `public/`), downstream projects can freely customize stages, prompts, or swap the Express SPA for a full framework like **Next.js** while keeping the core Gemini 4 Argon engine intact.

### Starting a New Specialized Project
```bash
# 1. Clone this base template repository into a new project directory
git clone https://github.com/CatoPaus/icm.git icm-podcast-studio
cd icm-podcast-studio

# 2. Rename 'origin' to 'upstream' (so 'upstream' always points to the untouched base template)
git remote rename origin upstream

# 3. Point 'origin' to your new specialized GitHub repository and push
git remote add origin https://github.com/CatoPaus/icm-podcast-studio.git
git push -u origin main

# 4. Install dependencies and add your Gemini API key
npm install
echo 'GEMINI_API_KEY="your-gemini-api-key"' > .env.local
```

### Pulling Future Engine Upgrades into Specialized Projects
* **If the specialized project still uses the default Express server/UI:**
  ```bash
  git fetch upstream
  git merge upstream/main
  ```
* **If the specialized project replaced the server/UI (e.g., migrated to Next.js) or heavily customized prompts:**
  Pull *only* the core engine updates (such as `src/index.ts`) without touching your Next.js app or custom prompts:
  ```bash
  git fetch upstream
  git checkout upstream/main -- src/index.ts
  ```

---

## Model & Thinking Level Architecture (`gemini-4-argon`)

All legacy models (`gemini-2.5-*`, `gemini-3.5-*`, etc.) and deprecated sampling parameters (`temperature`, `topP`, `topK`) have been purged. Only **`gemini-4-argon`** is used across the entire runtime, configured with stage-appropriate `thinkingConfig.thinkingLevel` (`LOW`, `MEDIUM`, `HIGH`):

| Pipeline Stage / Runner | Thinking Level | `maxOutputTokens` | Context Window | Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **Stage 1: In-Depth Research** (`prompts/01_research.md`) | **`HIGH`** (fallback: `MEDIUM`) | `65536` *(max streaming)* | `1,048,576` | Maximizes reasoning depth for multi-source synthesis and Google Search grounding with verbatim citations. |
| **Stage 2: Scriptwriting** (`prompts/02_script.md`) | **`MEDIUM`** (default) | `32768` | `1,048,576` | Balanced reasoning effort, latency, and token usage for structured JSON generation adhering to voice/pacing constraints. |
| **Interactive Approval Gate** (`handleInteractiveDeployment`, `approveAndResume`, `rejectAndResume`) | **`LOW`** | `32768` | `1,048,576` | Minimizes latency and token usage for fast tool routing and human-in-the-loop approval turns. |

### Token Limits & 1M Context Window Reference (`gemini-4-argon`)
* **Unified 1M Context Window (`1,048,576` tokens):** Shared across **Input + Thinking + Output**. Any stage can ingest up to ~1M tokens of source documents, transcripts, or prior-stage artifacts without code changes.
* **Standard / Streaming Output Ceiling (`65,536` tokens):** When using standard synchronous or SSE streaming requests (`background: false` on `/v1beta/interactions`), `max_output_tokens` caps combined thinking + output at **`65,536` tokens (64K)** per turn (setting `> 65536` without background mode returns HTTP `400`).
  * *Stage 1* is configured at the full **`65,536`** limit (a typical `HIGH`-thinking grounded research run uses ~`1K` input + ~`9K` thinking + ~`24K` output = ~`34K` total tokens).
  * *Stage 2* and the interactive deployment tools are currently set to **`32,768`** tokens and can be raised to `65,536` in `prompts/02_script.md` and `src/index.ts` whenever needed.
* **Future Option — Long Decode (`> 65,536` up to `1,048,576` output tokens):** If a single turn ever needs to generate more than 64K output tokens in one response, Gemini 4 Argon supports **Long Decode** on the Interactions API by enabling `background: true` and setting `max_output_tokens` between `262,144` and `1,048,576 - inputTokens`.

---

## Key Architectural & Reliability Features

1. **Full 5-Layer ICM Context Injection & Self-Documenting Stage Folders**
   * **Layer 0 (`workspace/GEMINI.md`):** Global identity, epistemic rigor, automatic language alignment, and Markdown citation rules.
   * **Layer 1 (`workspace/CONTEXT.md`):** Workspace pipeline routing and stage boundary awareness.
   * **Layer 2 (`prompts/01_research.md` & `prompts/02_script.md`):** Markdown stage contracts (YAML frontmatter + template) parsed directly by `loadStagePromptContract()` in `src/index.ts`.
   * **Layer 3 (`workspace/_config/voice_guide.md`):** Global voice and pacing rules.
   * **Layer 4 (`workspace/runs/<runId>/stages/...`):** Every stage persists its exact assembled input prompt (`input/prompt_assembled.md`), its full reasoning & search trace (`output/thinking_trace.md`), and its final output artifact (`output/research_summary.md`, `output/script_draft.json`), plus token/latency telemetry in `workspace/runs/<runId>/meta.json`.
2. **Direct Interactions API SSE Streaming & Automatic Fallback (`streamGemini4ArgonInteraction`)**
   * Both Stage 1 and Stage 2 execute directly over native Node.js `fetch` SSE streaming (`stream: true` on `https://generativelanguage.googleapis.com/v1beta/interactions`), preventing 300-second `headersTimeout` disconnects during deep `HIGH`-thinking + Google Search turns.
   * Live reasoning steps and partial output stream directly to `stages/01_research/output/research_stream.md` so the Web Dashboard displays real-time progress.
   * Built-in `executeWithRetryAndFallback` automatically retries transient network/503/429 errors and falls back from `HIGH` to `MEDIUM` thinking on `gemini-4-argon` if needed.
3. **Sub-Second Grounding Citation Resolution (`resolveRedirect` & `cleanGroundingLinks`)**
   * Resolves `vertexaisearch.cloud.google.com/grounding-api-redirect/...` URLs using `redirect: 'manual'` first to read Google's `302 Location` header directly (~0.5s total for 100+ links) without timing out on unreachable third-party servers.
   * Weaves Interactions API `url_citation` annotations inline at exact UTF-8 byte offsets and deduplicates references in the **Sources & Citations** section.
4. **Built-In Antigravity 2.0 ICM Co-Architect (`GEMINI.md` & `.agents/`)**
   * **Root `GEMINI.md`:** Configures the main Antigravity 2.0 agent as an interactive **ICM Co-Architect** that guides project customization one question and one stage at a time (avoiding brittle multi-step upfront plans) and audits the self-contained filesystem traces (`meta.json`, `input/prompt_assembled.md`, `output/thinking_trace.md`).
   * **Lifecycle Hooks (`.agents/hooks.json` & `.agents/scripts/icm-hooks.mjs`):** Automatically injects the latest run status at `SessionStart` and enforces a `PreToolUse` guardrail blocking legacy models or deprecated sampling parameters (`temperature`, `topP`, `topK`).
   * **Interactive Playbook Skill (`.agents/skills/icm-co-architect/SKILL.md`):** Step-by-step runbook for specializing Layer 0/1, testing Stage 1 standalone (`npm run cli:stage1`) before designing Stage 2, and expanding the pipeline.
5. **Decoupled Reference Demo Web Dashboard ([`public/README.md`](./public/README.md))**
   * Includes an optional Express + Vanilla JS reference dashboard (`src/server.ts` & `public/`) with SSR state hydration, live DOM reconciliation, `.icm/terminal.log` mirroring, and cross-platform Desktop File Manager integration (Ubuntu/Linux Desktop, WSL, macOS Finder, and Windows 11 Explorer).
   * Full documentation for the demo web app lives in [`public/README.md`](./public/README.md).

---

## Directory Architecture

The workspace layout maps abstract context layers directly to disk directories:

```
.
├── GEMINI.md                    # Antigravity 2.0 Main Agent Rules (ICM Co-Architect)
├── .agents/                     # Antigravity 2.0 Workspace Customizations
│   ├── hooks.json               # SessionStart context injector & PreToolUse Argon guardrail
│   ├── scripts/
│   │   └── icm-hooks.mjs        # Cross-platform Node.js hook handler
│   └── skills/
│       └── icm-co-architect/
│           └── SKILL.md         # Interactive one-stage-at-a-time specialization playbook
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # Pure ICM Engine, Gemini 4 Argon SSE Client & Headless CLI
│   └── server.ts                # Reference Demo Web Server (documented in public/README.md)
├── public/                      # Reference Demo Web Dashboard SPA
│   ├── README.md                # Demo Web Dashboard & Cross-Platform File Manager docs
│   ├── index.html               # Dashboard layout & SSR state mount
│   ├── style.css                # Design system & responsive workspace styling
│   └── app.js                   # Client controller & DOM-reconciled live preview
├── prompts/                     # Layer 2: Stage Contracts (Markdown + YAML frontmatter)
│   ├── 01_research.md           # Stage 1 contract (gemini-4-argon, thinkingLevel: HIGH)
│   └── 02_script.md             # Stage 2 contract (gemini-4-argon, thinkingLevel: MEDIUM)
└── workspace/                   # Scoped Workspace Sandbox
    ├── GEMINI.md                # Layer 0: Global Identity Guide
    ├── CONTEXT.md               # Layer 1: Workspace Route Context
    ├── _config/                 # Layer 3: Global Reference Materials
    │   └── voice_guide.md       # Global brand voice tone
    └── runs/                    # Per-run isolated stage execution directories
        └── <runId>/
            ├── meta.json        # Run status + Stage 1 & 2 token/latency/search telemetry
            └── stages/
                ├── 01_research/
                │   ├── input/prompt_assembled.md
                │   └── output/
                │       ├── thinking_trace.md
                │       └── research_summary.md
                └── 02_script/
                    ├── input/prompt_assembled.md
                    └── output/
                        ├── thinking_trace.md
                        └── script_draft.json
```

---

## Setup & Installation

### 1. Prerequisites
Ensure you have **Node.js v20.6.0+** installed (native `fetch` SSE streaming and `--env-file` support).

### 2. Install Dependencies
Initialize package dependencies (lightweight, zero vulnerabilities):
```bash
npm install
```

### 3. API Keys Configuration
Create a `.env.local` file at the root of the project containing your Gemini API key:
```env
GEMINI_API_KEY="your-gemini-api-key"
```

---

## Running the Developer Environment

Start the ICM Web Dashboard with live file watching (`src/` and `prompts/`):
```bash
npm run dev
```
*(Or run `npm run server` to start the Web Dashboard without file watching.)*
Once started:
* **ICM Web Dashboard:** [http://localhost:3000](http://localhost:3000)

---

## Headless Execution (Linux Terminal / SSH / Docker / Cron Without Web App)

Because the ICM state lives in plain Markdown and JSON files on disk (`workspace/runs/<runId>/`) and `src/index.ts` uses pure cross-platform Node.js with zero browser or OS-specific dependencies, you can run the entire pipeline headlessly from any Linux terminal, SSH session, Docker container, or cron job.

### Direct CLI Runner (`npm run cli:stage1`, `npm run cli:stage2`, `npm run cli`, `--dry-run`)
1. **Preview the assembled 5-layer prompt and Interactions API request at zero token cost (`--dry-run`):**
   ```bash
   npm run cli:stage1 -- --dry-run "Cloud Native Architecture in 2026"
   ```
   *(Writes `workspace/runs/_dry_run/stages/01_research/input/prompt_assembled.md` and prints the exact HTTP request headers and body with credentials redacted.)*
2. **Run Stage 1 only (recommended when testing/tuning `01_research.md` before Stage 2):**
   ```bash
   npm run cli:stage1 -- "Cloud Native Architecture in 2026"
   ```
   *(Stops at the Human-in-the-Loop Intermission gate after writing `input/prompt_assembled.md`, `output/thinking_trace.md`, `output/research_summary.md`, and logging token telemetry to `meta.json`.)*
3. **Inspect or edit the Stage 1 research artifact in `nano` or `vim`:**
   ```bash
   nano workspace/runs/<runId>/stages/01_research/output/research_summary.md
   ```
4. **Run or re-run Stage 2 standalone after reviewing/editing Stage 1 (supports `--dry-run` as well):**
   ```bash
   npm run cli:stage2 -- --dry-run <runId>
   npm run cli:stage2 -- <runId>
   ```
5. **Or run the full pipeline (Stage 1 + Stage 2) in one pass:**
   ```bash
   npm run cli -- "Cloud Native Architecture in 2026"
   ```
6. **Read the final Stage 2 output:**
   ```bash
   cat workspace/runs/<runId>/stages/02_script/output/script_draft.json
   ```

### Multimodal Stage Expansion with the Official `gemini-api` CLI
For downstream stages that generate or analyze media files on disk (images, voiceovers, video, music, or PDF corpora), this repository integrates seamlessly with Google AI Studio's stateless **`gemini-api` CLI** (`google-gemini/gemini-api-cli`):
* **Install `gemini-api`:**
  * **Linux / macOS:** `curl -fsSL https://raw.githubusercontent.com/google-gemini/gemini-api-cli/main/scripts/install.sh | bash`
  * **Windows (PowerShell):** `iwr -useb https://raw.githubusercontent.com/google-gemini/gemini-api-cli/main/scripts/install.ps1 | iex`
* **Example Multimodal Stage Commands (Writing Directly into ICM Stage Folders):**
  ```bash
  # Stage 3 Visuals: Generate slide or illustration assets (gemini-nano-banana-2.1)
  gemini-api image "Minimalist architectural diagram of a cloud-native mesh" \
    --out workspace/runs/<runId>/stages/03_visuals/output/hero.png

  # Stage 3 Audio: Generate spoken voiceover from Stage 2 script (gemini-3.8-flash-tts)
  gemini-api tts "Welcome to Module 1..." \
    --out workspace/runs/<runId>/stages/03_audio/output/voiceover.wav

  # Pre-Stage 1 Local Corpus Analysis: Analyze local PDFs or videos into Stage 1 input
  gemini-api analyze -i ./workspace/_config/reference.pdf "Extract all regulatory requirements"
  ```

---

## Cleaning Up the Workspace

To clean up and reset the workspace (deleting all active stage outputs, cached telemetry files, and session states), run:
```bash
npm run clean
```
