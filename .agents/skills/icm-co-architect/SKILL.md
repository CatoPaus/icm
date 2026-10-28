---
name: icm-co-architect
description: >-
  Interactive one-step-at-a-time playbook for specializing, tuning, and debugging
  a 100% Pure Interpretable Context Methodology (ICM) repository. Activate this skill whenever
  the user wants to customize this template for a new project, rewrite stage contracts
  (01_research.md, 02_script.md), add new ICM stages/layers, or inspect filesystem
  traces (prompt_assembled.md, thinking_trace.md, meta.json) after a test run.
---

# ICM Co-Architect Playbook

Use this skill to guide the user through customizing or debugging the ICM pipeline **one question and one stage at a time**.

## Core Rule: Why We Never Write Multi-Step Upfront Plans

In ICM, Stage 2 (`prompts/02_script.md`) consumes the physical file produced by Stage 1 (`stages/01_research/output/research_summary.md`). Empirically, over 90% of human edits happen right after Stage 1. If you design Stage 1 and Stage 2 simultaneously before running Stage 1, any adjustment the user makes after seeing Stage 1's real output invalidates everything written for Stage 2.

**Always follow the Single-Step Loop:**
1. Ask **1 focused question** (prefer the `ask_question` tool with clear options).
2. Edit **1 layer or stage**.
3. Run **only that stage standalone** (`npm run cli:stage1` for Stage 1, `npm run cli:stage2` for Stage 2).
4. Inspect the **Pure ICM filesystem trace** inside `workspace/runs/<runId>/`:
   - `meta.json` (`stage1Telemetry` / `stage2Telemetry`)
   - `stages/<stage>/input/prompt_assembled.md`
   - `stages/<stage>/output/thinking_trace.md`
   - `stages/<stage>/output/<artifact>`
5. Apply the **Edit-Source Principle**: if something needs adjustment, fix the Layer 2/3 contract (`prompts/` or `_config/`) before moving to the next stage.

---

## Phase 1: Project Goal & Layer 0 / Layer 1 Setup

1. **Ask Question 1 (Domain & Goal — Informed by Project Folder Name):**
   - Inspect the workspace folder name (e.g., `icm-course-studio`, `icm-podcast-studio`, `icm-legal-review`) injected at `SessionStart` and use it as a semantic hint to pre-populate tailored `(Recommended)` multiple-choice options via `ask_question` for the project's domain, target deliverable, and language/tone rules.
2. **Update Layer 0 & Layer 1 Only:**
   - Update [`workspace/GEMINI.md`](../../workspace/GEMINI.md) (Layer 0: Global Identity & Epistemic Rules).
   - Update [`workspace/CONTEXT.md`](../../workspace/CONTEXT.md) (Layer 1: Workspace Route Context).
   - Stop and present the updated Layer 0/1 files before touching `prompts/01_research.md`.

---

## Phase 2: Stage 1 (`prompts/01_research.md`) & Standalone Verification

1. **Ask Question 2 (Stage 1 Output Structure):**
   - Ask what specific sections, facts, or strategic angles Stage 1 should research and write into `research_summary.md`, and whether `thinkingLevel` should remain `HIGH` (`maxOutputTokens: 65536`).
2. **Edit Only `prompts/01_research.md`:**
   - Keep `model: gemini-4-argon`, `maxOutputTokens: 65536`, and `{{#if globalIdentity}}` / `{{#if workspaceContext}}` blocks intact.
3. **Run & Audit Stage 1 Standalone (Do NOT Run Stage 2 Yet):**
   - **Important:** Do **not** run `npm run cli -- "<topic>"` here, because `npm run cli` also runs Stage 2 with the old uncustomized prompt and wastes tokens.
   - First, run a **zero-token `--dry-run`** to verify how `Layer 0 + Layer 1 + Layer 2` assembled in `workspace/runs/_dry_run/stages/01_research/input/prompt_assembled.md`:
     ```bash
     npm run cli:stage1 -- --dry-run "<topic>"
     ```
   - Next, run **Stage 1 standalone** via:
     ```bash
     npm run cli:stage1 -- "<topic>"
     ```
   - Once completed, perform the **Stage 1 Pure ICM Filesystem Audit**:
     1. **Telemetry & Search Query Check:** Read `workspace/runs/<runId>/meta.json` (`stage1Telemetry`: `inputTokens`, `thoughtsTokens`, `outputTokens`, `totalTokens`, `durationMs`, `thoughtSteps`, `searchQueries`) and `stages/01_research/output/thinking_trace.md`.
     2. **Assembled Input Check:** Verify `stages/01_research/input/prompt_assembled.md` if you need to confirm how Layer 0 + Layer 1 + Layer 2 combined.
     3. **Output Artifact:** Read `workspace/runs/<runId>/stages/01_research/output/research_summary.md` and review its sections and resolved citations with the user.
   - If Stage 1 needs refinement, apply the **Edit-Source Principle** (update `prompts/01_research.md` for reusable changes, or `research_summary.md` for one-off edits) before moving to Phase 3.

---

## Phase 3: Layer 3 (`workspace/_config/voice_guide.md`) & Stage 2 (`prompts/02_script.md`)

Only start Phase 3 after Stage 1's `research_summary.md` artifact is verified on disk:

1. **Ask Question 3 (Stage 2 Deliverable & Schema):**
   - Ask what Stage 2 should transform `research_summary.md` into (e.g., course module, spoken script, podcast dialogue, executive brief) and what voice/style rules belong in [`workspace/_config/voice_guide.md`](../../workspace/_config/voice_guide.md).
2. **Update Layer 3 & Stage 2:**
   - Update [`workspace/_config/voice_guide.md`](../../workspace/_config/voice_guide.md).
   - Update [`prompts/02_script.md`](../../prompts/02_script.md) (`model: gemini-4-argon`, `thinkingLevel: MEDIUM`, `maxOutputTokens: 32768` or up to `65536`).
3. **Test Stage 2 Standalone (Zero Stage 1 Cost):**
   - Run Stage 2 standalone against the existing `<runId>`:
     ```bash
     npm run cli:stage2 -- <runId>
     ```
     *(Or click **Regenerate Script** in the Web Dashboard at `http://localhost:3000`.)*
   - Inspect `stage2Telemetry` in `workspace/runs/<runId>/meta.json`, `stages/02_script/output/thinking_trace.md`, and `stages/02_script/output/script_draft.json`.

---

## Phase 4: Adding New Context Layers or Stages (`03_...`, `04_...`) & UI Customization

- **Adding a Vertical Context Layer (e.g., `workspace/_config/course_profile.md`):**
  - Load the file in `loadWorkspaceLayers()` inside [`src/index.ts`](../../src/index.ts) and inject it into the target `prompts/*.md` template.
- **Adding a Horizontal Pipeline Stage (e.g., `prompts/03_slides.md`):**
  1. Create `prompts/03_<name>.md` using `model: gemini-4-argon`.
  2. Add `runStage3Flow` and `--stage3` in [`src/index.ts`](../../src/index.ts) + `"cli:stage3"` in [`package.json`](../../package.json), and chain `runStage3Flow` inside `icmOrchestratorFlow`.
  3. **Test Stage 3 standalone first** (`npm run cli:stage3 -- <runId>`) and verify `stages/03_<name>/input/prompt_assembled.md`, `output/thinking_trace.md`, and the output artifact on disk *before* wiring the new tab into [`src/server.ts`](../../src/server.ts), [`public/index.html`](../../public/index.html), and [`public/app.js`](../../public/app.js).
- **Adding Multimodal Stages (`03_visuals`, `03_audio`, `03_video`, Document Analysis) via `gemini-api` CLI:**
  - The official Google AI Studio `gemini-api` CLI (`google-gemini/gemini-api-cli`) is installed on the host and pairs naturally with ICM's filesystem-first stage directories:
    - **Image Generation (`gemini-nano-banana-2.1`):** `gemini-api image "<prompt>" --out workspace/runs/<runId>/stages/03_visuals/output/slide_01.png`
    - **Speech / Voiceover (`gemini-3.8-flash-tts`):** `gemini-api tts "<script>" --out workspace/runs/<runId>/stages/03_audio/output/voiceover.wav`
    - **Document / PDF / Video Analysis:** `gemini-api analyze -i ./docs/source.pdf "Extract key data"`
    - **Dry-Run Inspection:** Append `--dry-run` to any `gemini-api` command to preview the Interactions API request without sending it.
- **Editing Large Files Safely:**
  - Never fire multiple parallel `edit_file` calls on the same file (`public/index.html`, `public/app.js`, `src/index.ts`, `src/server.ts`). Make targeted sequential `edit_file` calls to save output tokens and avoid CRLF target mismatches.
