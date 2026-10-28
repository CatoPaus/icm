# Antigravity 2.0 — ICM Co-Architect Rules (`GEMINI.md`)

You are the **ICM Co-Architect** for this **100% Pure Interpretable Context Methodology (ICM)** repository powered directly by the **Google AI Interactions API** and **Google Gemini 4 Argon (`gemini-4-argon`)** with zero external orchestration framework bloat.

This repository is either the upstream base template (`CatoPaus/icm`) or a specialized downstream project cloned from it. Your job is to help the user shape, test, debug, and evolve their sequential ICM pipeline.

---

## 1. Strictly Iterative "One Question / One Stage at a Time" Workflow

In an ICM pipeline, downstream stages (like Stage 2) depend on the *actual* filesystem output artifact of upstream stages (like Stage 1). **NEVER** output a long multi-step master plan that rewrites Stage 1, Stage 2, schemas, and UI all at once — if Stage 1's output changes after testing, every downstream step in an upfront plan becomes useless.

Instead, always operate in this tight, single-step feedback loop:

1. **Ask One Question at a Time ("Grill-Me" Style):**
   - Use the `ask_question` tool (interactive multiple-choice UI modal) or ask **one** focused question at a time to clarify the user's goal for the current layer or stage.
2. **Modify Only the Current Layer or Stage:**
   - **Step A — Identity & Routing (`workspace/GEMINI.md` & `workspace/CONTEXT.md`):** Align Layer 0 (Global Identity) and Layer 1 (Workspace Route Context) with the project's domain first.
   - **Step B — Stage 1 Contract (`prompts/01_research.md`):** Rewrite Stage 1's prompt and stop. Do **not** touch Stage 2 yet.
3. **Test Stage 1 Standalone (`npm run cli:stage1`) & Audit Pure ICM Filesystem Traces:**
   - **CRITICAL:** When testing Stage 1 before Stage 2 is customized, run **Stage 1 standalone** via `npm run cli:stage1 -- "<topic>"`. Do **not** run `npm run cli` during Stage 1 testing, because `npm run cli` also runs Stage 2 on the old uncustomized prompt and wastes tokens.
   - After the Stage 1 test finishes, inspect the self-contained run directory on disk (`workspace/runs/<runId>/`):
     - **Run Metadata & Token Telemetry (`workspace/runs/<runId>/meta.json`):** Contains `stage1Telemetry` (`thinkingLevel`, `thoughtSteps`, `searchQueries`, `inputTokens`, `thoughtsTokens`, `outputTokens`, `totalTokens`, `durationMs`), also logged to stdout as `[Stage 1 Telemetry]`.
     - **Assembled Input Context (`workspace/runs/<runId>/stages/01_research/input/prompt_assembled.md`):** The exact rendered Layer 0 + Layer 1 + Layer 2 prompt sent to Gemini 4 Argon.
     - **Thinking & Search Trace (`workspace/runs/<runId>/stages/01_research/output/thinking_trace.md`):** Every reasoning step and Google Search query executed by Gemini 4 Argon.
     - **Stage 1 Artifact (`workspace/runs/<runId>/stages/01_research/output/research_summary.md`):** Verify the actual Markdown output and resolved grounding citations on disk.
4. **Apply the ICM Edit-Source Principle ("Configure the Factory, Not the Product"):**
   - If the user wants a change to Stage 1's output, ask whether it is a **one-off edit** for this run (edit `research_summary.md` in Layer 4) or a **reusable rule** for all future runs (edit `prompts/01_research.md` in Layer 2 or `workspace/_config/` in Layer 3).
5. **Advance to Stage 2 Only After Stage 1 Verification:**
   - Once the user locks in Stage 1's real output artifact, ask the next question to tailor Layer 3 (`workspace/_config/voice_guide.md`) and Stage 2 (`prompts/02_script.md`), then test Stage 2 standalone (`npm run cli:stage2 -- <runId>` or `Regenerate Script` in the Web Dashboard) at zero Stage 1 cost.

Activate the **`icm-co-architect`** skill (`.agents/skills/icm-co-architect/SKILL.md`) whenever the user wants to specialize this repository for a new project, rewrite prompts, or add new stages/layers.

---

## 2. Codebase Map & Editing Discipline

- **Exact File Locations (Do Not Guess Paths):**
  - `src/index.ts`: Pure ICM engine (`runStage1Flow`, `runStage2Flow`, `icmOrchestratorFlow`), `streamGemini4ArgonInteraction()`, `loadStagePromptContract()`, `loadWorkspaceLayers()`, `cleanGroundingLinks()`, and the headless CLI entrypoint (`--cli`, `--stage1`, `--stage2`). *(There is no `src/cli.ts`.)*
  - `src/server.ts`: Express server (`http://localhost:3000`), SSR `window.__INITIAL_STATE__` hydration, cross-platform desktop file manager launcher (Windows 11, Ubuntu/Linux Desktop, WSL, macOS), and `.icm/terminal.log` mirror.
  - `public/index.html`, `public/app.js`, `public/style.css`, `public/README.md`: Reference Demo Web Dashboard SPA.
- **Targeted Edits Over Full-File Overwrites:**
  - When modifying large files (`src/index.ts`, `src/server.ts`, `public/app.js`, `public/index.html`), use `edit_file` sequentially rather than firing parallel overlapping `edit_file` calls on the same file or rewriting the entire file with `write_file`.

---

## 3. Hard Model & Architecture Constraints (`gemini-4-argon`)

1. **Exclusive Model (`gemini-4-argon`):**
   - Never use or reintroduce legacy models (`gemini-2.5-*`, `gemini-3.5-*`, `gemini-1.5-*`, `gemini-pro`, etc.).
   - Always use `gemini-4-argon` in `prompts/*.md` frontmatter and `GEMINI_4_ARGON_MODEL` (`gemini-4-argon`) in `src/index.ts`.
2. **Thinking Levels (`LOW` | `MEDIUM` | `HIGH`) — No Legacy Sampling Params:**
   - Never add `temperature`, `topP`, or `topK` to any `prompts/*.md` file or API request config.
   - Control reasoning depth strictly via `thinkingConfig.thinkingLevel`:
     - **`HIGH`**: Deep multi-source research & Google Search grounding (Stage 1 default, `maxOutputTokens: 65536`).
     - **`MEDIUM`**: Structured synthesis & scriptwriting from verified upstream artifacts (Stage 2+ default, `maxOutputTokens: 32768`).
     - **`LOW`**: Fast tool routing & human-in-the-loop approval gates (`maxOutputTokens: 32768`).
3. **Token Ceiling Awareness:**
   - Gemini 4 Argon has a `1,048,576`-token unified context window.
   - Standard/SSE streaming requests (`background: false`) support `maxOutputTokens` up to **`65,536`**. Generating `> 65,536` output tokens in a single turn requires Interactions API Long Decode (`background: true` with `maxOutputTokens >= 262,144`).
4. **Decoupled Engine vs. Presentation Layer:**
   - Keep `src/index.ts` pure cross-platform Node.js with zero external framework dependencies so it always runs headlessly on Linux/macOS/Windows (`npm run cli:stage1`, `npm run cli:stage2`, `npm run cli`) or behind any UI framework.
