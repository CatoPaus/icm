# Interpretable Context Methodology (ICM) with Firebase Genkit & Gemini 4 Argon

This repository contains a reference implementation of the **Interpretable Context Methodology (ICM)** built with Firebase Genkit (`v1.43.0`) and TypeScript, powered exclusively by **Gemini 4 Argon (`googleai/gemini-4-argon`)**.

ICM is a declarative, filesystem-centric context management architecture that replaces programmatic agent-orchestration layers with numbered stage directories, markdown-based stage contracts, and explicit sandboxing boundaries.

---

## Core Philosophy & Vision

This setup is a **filesystem-first, human-in-the-loop intelligence and production workbench** built on the **Interpretable Context Methodology (ICM)** rather than a black-box multi-agent loop:

### 1. The Filesystem *Is* the State Machine (ICM Layers 0–4)
Instead of trapping intermediate agent state inside opaque in-memory chat histories where context bloats and hallucinates across turns, every boundary in the pipeline is a **numbered folder and an inspectable file on disk** under `workspace/runs/<runId>/`:
* **Layer 0 & 1 (`workspace/GEMINI.md` + `workspace/CONTEXT.md`):** Global epistemic rules (strict fact-grounding, automatic Norwegian/English language matching) and pipeline awareness injected into every stage.
* **Layer 2 (`prompts/01_research.prompt`, `prompts/02_script.prompt`):** Strict stage contracts and schemas.
* **Layer 3 (`workspace/_config/voice_guide.md`):** Reusable domain/style rules decoupled from the prompt logic.
* **Layer 4 (`research_summary.md`, `script_draft.json`):** Concrete artifacts that act as the *only* handoff between stages.

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
* **Fan-out / Downstream Stages (`03_...`, `04_...`):** From a single verified `01_research` artifact, you can branch into multiple specialized outputs (e.g., executive strategy decks, competitor matrices, SEO/content briefs, audio/TTS generation via Gemini TTS, or visual storyboards) simply by adding a numbered stage folder and a `.prompt` file.
* **1M-Token Deep Context Ingestion:** Drop large local reference corpora (PDFs, competitor dumps, financial reports, or prior run outputs) into a stage's `_config/` or `input/` folder so Argon can synthesize live Google Search grounding *with* hundreds of thousands of tokens of proprietary context.

---

## Using as an Upstream Base / Template Repository

This repository is designed to serve as an **untouched upstream base template** for specialized downstream projects (e.g., `icm-podcast-studio`, `icm-market-strategy`, `icm-legal-review`). Runtime outputs (`workspace/runs/`, `.genkit/`, `.sessions/`) are excluded via `.gitignore` so the base repository remains clean.

Because the **ICM Engine** (`src/index.ts`, `prompts/`, `workspace/`) is completely decoupled from the **Presentation / Server Layer** (`src/server.ts`, `public/`), downstream projects can freely customize stages, prompts, or even swap the Express SPA for a full framework like **Next.js** while keeping the core Genkit + Gemini 4 Argon engine intact.

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

All legacy models (`gemini-2.5-*`, `gemini-3.5-*`, etc.) and deprecated sampling parameters (`temperature`, `topP`, `topK`) have been purged. Only **`googleai/gemini-4-argon`** is registered in the Genkit runtime and Developer UI, configured with stage-appropriate `thinkingConfig.thinkingLevel` (`LOW`, `MEDIUM`, `HIGH`):

| Pipeline Stage / Flow | Thinking Level | `maxOutputTokens` | Context Window | Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **Stage 1: In-Depth Research** (`prompts/01_research.prompt`) | **`HIGH`** (fallback: `MEDIUM`) | `65536` *(max streaming)* | `1,048,576` | Maximizes reasoning depth for multi-source synthesis and Google Search grounding with verbatim citations. |
| **Stage 2: Scriptwriting** (`prompts/02_script.prompt`) | **`MEDIUM`** (default) | `32768` | `1,048,576` | Balanced reasoning effort, latency, and token usage for structured JSON generation adhering to voice/pacing constraints. |
| **Interactive Deployment Gate** (`handleInteractiveDeployment`, `approveAndResume`, `rejectAndResume`) | **`LOW`** | `32768` | `1,048,576` | Minimizes latency and token usage for fast tool routing and human-in-the-loop interrupt/resume turns. |

### Token Limits & 1M Context Window Reference (`gemini-4-argon`)
* **Unified 1M Context Window (`1,048,576` tokens):** Shared across **Input + Thinking + Output**. Any stage can ingest up to ~1M tokens of source documents, transcripts, or prior-stage artifacts without code changes.
* **Standard / Streaming Output Ceiling (`65,536` tokens):** When using standard synchronous or SSE streaming requests (`background: false`, used by Genkit's `createInteractionStream`), `maxOutputTokens` caps combined thinking + output at **`65,536` tokens (64K)** per turn (setting `> 65536` without background mode returns HTTP `400`).
  * *Stage 1* is configured at the full **`65,536`** limit (a typical `HIGH`-thinking grounded research run uses ~`1K` input + ~`9K` thinking + ~`24K` output = ~`34K` total tokens).
  * *Stage 2* and the interactive deployment tools are currently set to **`32,768`** tokens and can be raised to `65,536` in `prompts/02_script.prompt` and `src/index.ts` whenever needed.
* **Future Option — Long Decode (`> 65,536` up to `1,048,576` output tokens):** If a single turn ever needs to generate more than 64K output tokens in one response, Gemini 4 Argon supports **Long Decode** on the Interactions API by enabling `background: true` and setting `maxOutputTokens` between `262,144` and `1,048,576 - inputTokens`.

---

## Key Architectural & Reliability Features

1. **Full 5-Layer ICM Context Injection (`loadWorkspaceLayers`)**
   * **Layer 0 (`workspace/GEMINI.md`):** Global identity, epistemic rigor, automatic language alignment, and Markdown citation rules.
   * **Layer 1 (`workspace/CONTEXT.md`):** Workspace pipeline routing and stage boundary awareness.
   * **Layer 2 (`prompts/01_research.prompt` & `prompts/02_script.prompt`):** Dotprompt stage contracts.
   * **Layer 3 (`workspace/_config/voice_guide.md`):** Global voice and pacing rules.
   * **Layer 4 (`workspace/runs/<runId>/stages/...`):** Immutable prior-stage filesystem artifacts passed between stages.
2. **SSE Streaming & Timeout-Proof Research (`onChunk`)**
   * Both Stage 1 and Stage 2 execute over SSE streaming (`stream: true` on `/v1beta/interactions`), preventing Node/Undici's 300-second `headersTimeout` (`TypeError: fetch failed`) during deep `HIGH`-thinking + Google Search turns.
   * Live reasoning steps and partial output stream directly to `stages/01_research/output/research_stream.md` so the Web Dashboard displays real-time progress.
   * Transport/stream errors are normalized into `GenkitError({ status: 'UNAVAILABLE' })` so Genkit's `retry` and `fallback` (`HIGH` -> `MEDIUM`) middleware trigger reliably.
3. **Sub-Second Grounding Citation Resolution (`resolveRedirect` & `cleanGroundingLinks`)**
   * Resolves `vertexaisearch.cloud.google.com/grounding-api-redirect/...` URLs using `redirect: 'manual'` first to read Google's `302 Location` header directly (~0.5s total for 100+ links) without timing out on unreachable third-party servers.
   * Weaves Interactions API `url_citation` annotations inline at exact UTF-8 byte offsets and deduplicates references in the **Sources & Citations** section.
4. **Built-In Antigravity 2.0 ICM Co-Architect (`GEMINI.md` & `.agents/`)**
   * **Root `GEMINI.md`:** Configures the main Antigravity 2.0 agent as an interactive **ICM Co-Architect** that guides project customization one question and one stage at a time (avoiding brittle multi-step upfront plans), inspects traces via `genkit-mcp-server` (`get_trace`), and checks `.genkit/terminal.log`.
   * **Lifecycle Hooks (`.agents/hooks.json` & `.agents/scripts/icm-hooks.mjs`):** Automatically injects the latest run and trace ID at `SessionStart` and enforces a `PreToolUse` guardrail blocking legacy models or deprecated sampling parameters (`temperature`, `topP`, `topK`).
   * **Interactive Playbook Skill (`.agents/skills/icm-co-architect/SKILL.md`):** Step-by-step runbook for specializing Layer 0/1, testing Stage 1 standalone (`npm run cli:stage1`) before designing Stage 2, and expanding the pipeline.
5. **Decoupled Reference Demo Web Dashboard ([`public/README.md`](./public/README.md))**
   * Includes an optional Express + Vanilla JS reference dashboard (`src/server.ts` & `public/`) with SSR state hydration, live DOM reconciliation, `.genkit/terminal.log` mirroring, and cross-platform Desktop File Manager integration (Ubuntu/Linux Desktop, WSL, macOS Finder, and Windows 11 Explorer).
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
│   ├── index.ts                 # Main Orchestrator Flow, Gemini 4 Argon Plugin & Headless CLI
│   └── server.ts                # Reference Demo Web Server (documented in public/README.md)
├── public/                      # Reference Demo Web Dashboard SPA
│   ├── README.md                # Demo Web Dashboard & Cross-Platform File Manager docs
│   ├── index.html               # Dashboard layout & SSR state mount
│   ├── style.css                # Design system & responsive workspace styling
│   └── app.js                   # Client controller & DOM-reconciled live preview
├── prompts/                     # Layer 2: Stage Contracts (Dotprompt templates)
│   ├── 01_research.prompt       # Stage 1 contract (gemini-4-argon, thinkingLevel: HIGH)
│   └── 02_script.prompt         # Stage 2 contract (gemini-4-argon, thinkingLevel: MEDIUM)
└── workspace/                   # Scoped Workspace Sandbox
    ├── GEMINI.md                # Layer 0: Global Identity Guide
    ├── CONTEXT.md               # Layer 1: Workspace Route Context
    ├── _config/                 # Layer 3: Global Reference Materials
    │   └── voice_guide.md       # Global brand voice tone
    └── runs/                    # Per-run isolated stage execution directories
```

---

## Setup & Installation

### 1. Prerequisites
Ensure you have **Node.js v20.6.0+** installed (native support for loading `.env` configuration files).

### 2. Install Dependencies
Initialize package dependencies and development utilities:
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

Start the Web Dashboard and Genkit Developer UI concurrently:
```bash
npm run genkit:dev
```
*(Or run `npm run server` to start only the Web Dashboard on port 3000 without the Genkit Developer UI.)*
Once started:
* **ICM Web Dashboard:** [http://localhost:3000](http://localhost:3000)
* **Genkit Developer UI:** [http://localhost:4000](http://localhost:4000)

---

## Headless Execution (Linux Terminal / SSH / Docker / Cron Without Web App)

Because the ICM state lives in plain Markdown and JSON files on disk (`workspace/runs/<runId>/`) and `src/index.ts` uses pure cross-platform Node.js with zero browser or OS-specific dependencies, you can run the entire pipeline headlessly from any Linux terminal, SSH session, Docker container, or cron job.

### Option 1: Direct CLI Runner (`npm run cli:stage1`, `npm run cli:stage2`, `npm run cli`)
1. **Run Stage 1 only (recommended when testing/tuning `01_research.prompt` before Stage 2):**
   ```bash
   npm run cli:stage1 -- "Cloud Native Architecture in 2026"
   ```
   *(Stops at the Human-in-the-Loop Intermission gate after writing `research_summary.md` and logging token telemetry to `meta.json`.)*
2. **Inspect or edit the Stage 1 research artifact in `nano` or `vim`:**
   ```bash
   nano workspace/runs/<runId>/stages/01_research/output/research_summary.md
   ```
3. **Run or re-run Stage 2 standalone after reviewing/editing Stage 1:**
   ```bash
   npm run cli:stage2 -- <runId>
   ```
4. **Or run the full pipeline (Stage 1 + Stage 2) in one pass:**
   ```bash
   npm run cli -- "Cloud Native Architecture in 2026"
   ```
5. **Read the final Stage 2 output:**
   ```bash
   cat workspace/runs/<runId>/stages/02_script/output/script_draft.json
   ```

### Option 2: Genkit CLI Flow Runner (`genkit flow:run`)
You can also invoke individual Genkit flows with explicit JSON parameters (including custom `thinkingLevel` parameters):
```bash
# Run Stage 1 standalone
node --env-file=.env.local ./node_modules/genkit-cli/dist/bin/genkit.js flow:run runStage1Flow \
  '{"workspaceRoot":"./workspace","runId":"linux-test-01","topic":"Cloud Native Architecture","thinkingLevel":"HIGH"}' -- npx tsx src/index.ts

# Run Stage 2 standalone
node --env-file=.env.local ./node_modules/genkit-cli/dist/bin/genkit.js flow:run runStage2Flow \
  '{"workspaceRoot":"./workspace","runId":"linux-test-01","thinkingLevel":"MEDIUM"}' -- npx tsx src/index.ts

# Run the full pipeline (Stage 1 + Stage 2)
node --env-file=.env.local ./node_modules/genkit-cli/dist/bin/genkit.js flow:run icmOrchestratorFlow \
  '{"workspaceRoot":"./workspace","runId":"linux-test-01","topic":"Cloud Native Architecture","researchThinkingLevel":"HIGH","scriptThinkingLevel":"MEDIUM"}' -- npx tsx src/index.ts
```

---

## Testing Use Case: Video Script Creator

### Step-by-Step Test Walkthrough

#### Step 1: Trigger the Orchestration Flow
1. Open the ICM Web Dashboard at `http://localhost:3000` (or Genkit Developer UI at `http://localhost:4000`).
2. Select your desired Thinking Levels (`HIGH` for Stage 1 Research, `MEDIUM` for Stage 2 Scriptwriting) or use the defaults:
   ```json
   {
     "workspaceRoot": "./workspace",
     "runId": "quantum-computing-demo",
     "topic": "Quantum Computing Superposition and Entanglement",
     "researchThinkingLevel": "HIGH",
     "scriptThinkingLevel": "MEDIUM"
   }
   ```
3. Click **Run Full Pipeline**.

#### Step 2: Audit Stage 1 (Research) Outputs
1. Inspect `workspace/runs/<runId>/stages/01_research/output/research_summary.md`.
2. Verify that Gemini 4 Argon (`HIGH` thinking) has generated a comprehensive research summary with resolved source citations.

#### Step 3: Human-in-the-Loop Intermission (Simulating Manual Editing)
1. Edit `research_summary.md` in the dashboard or your text editor and save to disk.
2. Click **Regenerate Script** to re-run Stage 2 (`MEDIUM` thinking) with your edited research notes.

---

### Testing Stateful Resumable Interrupts (Stateless API Handoffs)

```typescript
// Initial call (uses Gemini 4 Argon with thinkingLevel: 'LOW', returns status AWAITING_APPROVAL)
const runState = await handleInteractiveDeployment(
  "session-abc-123",
  "Deploy script draft to media systems",
  "LOW"
);

// Approval call (resumes execution, registers approval, and completes)
const finalizedRun = await approveAndResume(
  "session-abc-123",
  runState.interrupt,
  "LOW"
);
```

---

## Cleaning Up the Workspace

To clean up and reset the workspace (deleting all active stages outputs, cached telemetry files, and session states), run:
```bash
npm run clean
```
