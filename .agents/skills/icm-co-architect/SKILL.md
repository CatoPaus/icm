---
name: icm-co-architect
description: >-
  Interactive one-step-at-a-time playbook for specializing, tuning, and debugging
  an Interpretable Context Methodology (ICM) repository. Activate this skill whenever
  the user wants to customize this template for a new project, rewrite stage prompts
  (01_research.prompt, 02_script.prompt), add new ICM stages/layers, or inspect Genkit
  traces and terminal logs after a test run.
---

# ICM Co-Architect Playbook

Use this skill to guide the user through customizing or debugging the ICM pipeline **one question and one stage at a time**.

## Core Rule: Why We Never Write Multi-Step Upfront Plans

In ICM, Stage 2 (`prompts/02_script.prompt`) consumes the physical file produced by Stage 1 (`stages/01_research/output/research_summary.md`). If you design Stage 1 and Stage 2 simultaneously before running Stage 1, any adjustment the user makes after seeing Stage 1's real output invalidates everything written for Stage 2.

**Always follow the Single-Step Loop:**
1. Ask **1 focused question** (prefer the `ask_question` tool with clear options).
2. Edit **1 layer or stage**.
3. Have the user **run a test** (or run it for them via CLI / MCP).
4. Inspect the **Genkit trace (`genkit-mcp-server`)**, **`.genkit/terminal.log`**, and the **output file on disk**.
5. Confirm satisfaction before moving to the next stage.

---

## Phase 1: Project Goal & Layer 0 / Layer 1 Setup

1. **Ask Question 1 (Domain & Goal):**
   - Ask the user what specialized project they are building (e.g., market intelligence, podcast studio, legal analysis, technical course builder) and what language/tone rules apply.
2. **Update Layer 0 & Layer 1 Only:**
   - Update [`workspace/GEMINI.md`](../../workspace/GEMINI.md) (Layer 0: Global Identity & Epistemic Rules).
   - Update [`workspace/CONTEXT.md`](../../workspace/CONTEXT.md) (Layer 1: Workspace Route Context).
   - Stop and show the user the updated Layer 0/1 files before touching `prompts/01_research.prompt`.

---

## Phase 2: Stage 1 (`prompts/01_research.prompt`) & Live Verification

1. **Ask Question 2 (Stage 1 Output Structure):**
   - Ask what specific sections, facts, or strategic angles Stage 1 should research and write into `research_summary.md`, and whether `thinkingLevel` should remain `HIGH` (`maxOutputTokens: 65536`).
2. **Edit Only `prompts/01_research.prompt`:**
   - Keep `model: googleai/gemini-4-argon`, `maxOutputTokens: 65536`, and ` `{{#if globalIdentity}}` / `{{#if workspaceContext}}` blocks intact.
3. **Run & Audit Stage 1 Before Touching Stage 2:**
   - Ask the user to run a test topic in the Web Dashboard (`http://localhost:3000`) or run `npm run cli -- "<topic>"`.
   - Once triggered or completed, perform the **3-Point Stage Audit**:
     1. **Terminal Log:** Read `.genkit/terminal.log` to check streaming progress (`[Stage 1 Thought]`), grounding link resolution (`Resolved X/Y grounding redirect links`), and any errors.
     2. **Genkit Trace via MCP:** Find the newest trace filename in `.genkit/traces/` and call `genkit-mcp-server` -> `get_trace` (`{ projectRoot, traceId }`). Verify input/thinking/output token counts, `thinkingLevel`, and Google Search queries.
     3. **Output Artifact:** Read `workspace/runs/<runId>/stages/01_research/output/research_summary.md` and review its structure and citations with the user.
   - If Stage 1 needs refinement, tweak `prompts/01_research.prompt` and re-test until the user locks it in.

---

## Phase 3: Layer 3 (`workspace/_config/voice_guide.md`) & Stage 2 (`prompts/02_script.prompt`)

Only start Phase 3 after Stage 1's output format is verified on disk:

1. **Ask Question 3 (Stage 2 Deliverable & Schema):**
   - Ask what Stage 2 should transform `research_summary.md` into (e.g., spoken script, podcast dialogue, executive brief, JSON action plan) and what voice/style rules belong in [`workspace/_config/voice_guide.md`](../../workspace/_config/voice_guide.md).
2. **Update Layer 3 & Stage 2:**
   - Update [`workspace/_config/voice_guide.md`](../../workspace/_config/voice_guide.md).
   - Update [`prompts/02_script.prompt`](../../prompts/02_script.prompt) (`model: googleai/gemini-4-argon`, `thinkingLevel: MEDIUM`, `maxOutputTokens: 32768` or up to `65536`).
   - If the JSON schema in `prompts/02_script.prompt` changes, update the matching rendering in [`public/app.js`](../../public/app.js) only after confirming the schema.
3. **Test Stage 2 Standalone (Zero Stage 1 Cost):**
   - Have the user click **Regenerate Script** in the Web Dashboard (or run `npm run cli:stage2 -- <runId>`) so Stage 2 runs directly against the already-verified `research_summary.md`.
   - Audit the new trace via `genkit-mcp-server` -> `get_trace` and inspect `stages/02_script/output/script_draft.json`.

---

## Phase 4: Adding New Context Layers or Stages (`03_...`, `04_...`)

If the user wants to expand the pipeline:
- **Adding a Vertical Context Layer (e.g., `workspace/_config/competitors.md`):**
  - Load the file in `loadWorkspaceLayers()` inside [`src/index.ts`](../../src/index.ts) and inject it into the target `.prompt` template.
- **Adding a Horizontal Pipeline Stage (e.g., `prompts/03_storyboard.prompt`):**
  - Create `prompts/03_<name>.prompt` using `googleai/gemini-4-argon`.
  - Add a standalone Genkit flow in [`src/index.ts`](../../src/index.ts) that reads the verified upstream artifact from `workspace/runs/<runId>/stages/...` and writes to `stages/03_<name>/output/...`.
  - Test the new stage standalone before wiring any extra UI tabs.
