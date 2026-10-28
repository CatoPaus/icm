---
name: icm-co-architect
description: >-
  Interactive one-step-at-a-time playbook for specializing, tuning, and debugging
  a 100% Pure Interpretable Context Methodology (ICM) repository. Activate this skill whenever
  the user wants to customize this template for a new project, rewrite stage contracts
  (01_research.md, 02_script.md), add new ICM stages/layers, inspect filesystem
  traces (prompt_assembled.md, thinking_trace.md, meta.json), or build a custom domain Web Studio.
---

# ICM Co-Architect Playbook

Use this skill to guide the user through customizing, testing, and evolving their ICM pipeline **one question and one stage at a time**.

## Core Rule: Why We Never Write Multi-Step Upfront Plans (or Pre-Baked UIs)

In ICM, Stage 2 (`prompts/02_script.md`) consumes the physical file produced by Stage 1 (`stages/01_research/output/research_summary.md`), Stage 3 consumes Stage 2, and any Web UI is a presentation layer over the final `workspace/runs/<runId>/` artifacts on disk.
- If you design Stage 1, Stage 2, Stage 3, and a Web UI simultaneously before running Stage 1, any adjustment the user makes after seeing Stage 1's real output invalidates every downstream step.
- Likewise, this base template intentionally ships with **zero pre-baked Web UI (`0` runtime npm dependencies)** so you are never anchored to a generic template layout or forced to spend dozens of tool calls patching legacy HTML/JS. Instead, you design a bespoke UI in **Phase 5** *only after* the pipeline's real artifacts exist on disk.

**Always follow the Single-Step Loop:**
1. Ask **1 focused question** (prefer the `ask_question` tool with clear options).
2. Edit **1 layer or stage**.
3. Run a **zero-token `--dry-run`** first (`npm run cli:stage1 -- --dry-run "<topic>"`), then run **only that stage standalone** (`npm run cli:stage1` for Stage 1, `npm run cli:stage2` for Stage 2).
4. Inspect the **Pure ICM filesystem trace** inside `workspace/runs/<runId>/`:
   - `meta.json` (`stage1Telemetry`, `stage2Telemetry`, etc.)
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
   - Stop and ask Question 2 before touching `prompts/01_research.md`.

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
   - Ask what Stage 2 should transform `research_summary.md` into (e.g., course module & instructor lesson script, podcast dialogue, legal risk matrix, executive brief) and what voice/style rules belong in [`workspace/_config/voice_guide.md`](../../workspace/_config/voice_guide.md).
2. **Update Layer 3 & Stage 2:**
   - Update [`workspace/_config/voice_guide.md`](../../workspace/_config/voice_guide.md).
   - Update [`prompts/02_script.md`](../../prompts/02_script.md) (`model: gemini-4-argon`, `thinkingLevel: MEDIUM`, `maxOutputTokens: 32768` or up to `65536`).
3. **Test Stage 2 Standalone (Zero Stage 1 Cost):**
   - First verify with `--dry-run`, then run Stage 2 standalone against the existing `<runId>`:
     ```bash
     npm run cli:stage2 -- --dry-run <runId>
     npm run cli:stage2 -- <runId>
     ```
   - Inspect `stage2Telemetry` in `workspace/runs/<runId>/meta.json`, `stages/02_script/output/thinking_trace.md`, and `stages/02_script/output/script_draft.json`.

---

## Phase 4: Adding Downstream Text or Multimodal Stages (`03_...`, `04_...`)

- **Adding a Vertical Context Layer (e.g., `workspace/_config/course_profile.md`):**
  - Load the file in `loadWorkspaceLayers()` inside [`src/index.ts`](../../src/index.ts) and inject it into the target `prompts/*.md` template.
- **Adding a Horizontal Pipeline Stage (e.g., `prompts/03_slides.md`):**
  1. Create `prompts/03_<name>.md` using `model: gemini-4-argon`. `loadStagePromptContract()` in [`src/index.ts`](../../src/index.ts) natively parses flat scalars (`title: string`), scalar arrays (`bullets: string[]`), and nested object arrays (`slides(array):` or `slides[]:` followed by indented child fields) directly from YAML frontmatter, so you never need to hardcode JSON schemas in `src/index.ts`:
     ```yaml
     output:
       format: json
       schema:
         deckTitle: string
         totalSlides: integer
         slides(array):
           slideNumber: integer
           cueType: string
           slideTitle: string
           bullets: string[]
           speakerNotes: string
           visualPrompt: string
     ```
  2. Add `runStage3Flow` and `--stage3` in [`src/index.ts`](../../src/index.ts) + `"cli:stage3"` in [`package.json`](../../package.json), and chain `runStage3Flow` inside `icmOrchestratorFlow`.
  3. **Test Stage 3 standalone first** (`npm run cli:stage3 -- --dry-run <runId>`, then `npm run cli:stage3 -- <runId>`) and verify `stages/03_<name>/input/prompt_assembled.md`, `output/thinking_trace.md`, and the output artifact on disk.
- **Adding Multimodal Stages (`03_visuals`, `04_audio`, `03_video`, Document Analysis):**
  - You can implement multimodal stages directly in [`src/index.ts`](../../src/index.ts) via zero-dependency `fetch` calls to `https://generativelanguage.googleapis.com/v1beta/interactions` (`gemini-nano-banana-2.1` for PNG slide/visual generation; `gemini-3.8-flash-tts` with `response_format: { type: "audio" }` and `generation_config: { speech_config: [{ voice: "Kore" }] }` for WAV voiceover synthesis), or invoke the `gemini-api` CLI binary (`gemini-api` on PATH, or `$env:LOCALAPPDATA\Programs\gemini-api\gemini-api.exe` on Windows if the IDE has not been restarted since installation):
    - **Image Generation (`gemini-nano-banana-2.1`):** `gemini-api image "<prompt>" --out workspace/runs/<runId>/stages/03_visuals/output/slide_01.png`
    - **Speech / Voiceover (`gemini-3.8-flash-tts`):** `gemini-api tts "<script>" --out workspace/runs/<runId>/stages/04_audio/output/voiceover.wav`
    - **Document / PDF / Video Analysis:** `gemini-api analyze -i ./docs/source.pdf "Extract key data"`
    - **Dry-Run Inspection:** Append `--dry-run` to preview the Interactions API request without sending it.

---

## Phase 5: Optional Bespoke Domain Web Studio (Built From Real Run Artifacts)

Once the pipeline's stages (`01_research`, `02_script`, `03_...`, `04_...`) and a real verified run in `workspace/runs/<runId>/` are complete on disk, ask the user via `ask_question` whether they want to:
1. **Build a Bespoke Domain Web Studio (`src/server.ts` + `public/`)** designed from scratch around their pipeline's *actual* filesystem artifacts, or
2. **Keep the project as a 100% Pure Headless CLI Pipeline** (zero web server code).

If the user chooses to build a custom Domain Web Studio:
- **Design for the Specific Domain & Artifacts (Never a Generic Form):**
  - Inspect the actual JSON/Markdown/image/audio files in `workspace/runs/<runId>/` first and craft a UI tailored to that exact product:
    - *Online Course & Lesson Studio*: Interactive 16:9 Slide Deck Carousel (`slides_deck.json` + rendered PNGs), synchronized HTML5 Instructor Audio Player (`lesson_voiceover.wav`), collapsible Module Syllabus & Speaker Notes drawer, interactive Formative Quiz check cards, and per-stage regenerate/edit controls.
    - *Podcast & Audio Studio*: Dual-host transcript timeline, inline voiceover player, and episode show notes editor.
    - *Executive / Legal / Competitor Intelligence*: Executive KPI summary cards, side-by-side source verification inspector, and interactive filterable tables.
- **Zero-Dependency Native Node HTTP Server (`src/server.ts`):**
  - You can build `src/server.ts` using Node's built-in `node:http` and `node:fs` modules (keeping **0 external npm dependencies**!) or install `express` if preferred.
  - Add `"server": "npx tsx --env-file=.env.local src/server.ts"` and `"dev": "npx tsx watch --clear-screen=false --ignore=.icm/** --ignore=workspace/** --env-file=.env.local src/server.ts"` to `package.json`.
  - Hydrate initial run data from `workspace/runs/` so the first browser paint at `http://localhost:3000` loads immediately with the user's verified run selected.
