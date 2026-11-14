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
5. Apply the **Edit-Source Principle**: if something needs adjustment, fix the Layer 2/3 contract (`prompts/` or `_config/`) before moving to the next stage. (Use `npm run cli:status` at any time for a zero-token ASCII pipeline & OKF v0.2 bundle overview.)
6. Whenever you modify [`src/index.ts`](../../src/index.ts), run `npm test` (`npx tsx src/index.ts --test`, which programmatically executes `tsc --noEmit` plus all self-test assertions in a single process) to execute the zero-token TypeScript + OKF v0.2 + UTF-8 grounding + A2UI v1.0 self-test suite.
7. **Cross-Platform Shell Rule (Windows PowerShell Compatibility):** **Never** chain terminal commands with `&&` (which fails in Windows PowerShell 5.1 with `ParserError: The token '&&' is not a valid statement separator`). Always run CLI scripts as separate single commands.

---

## Phase 1: Project Goal & Layer 0 / Layer 1 Setup

1. **Ask Question 1 (Domain & Goal — Informed by Project Folder Name):**
   - Inspect the workspace folder name (e.g., `icm-course-studio`, `icm-podcast-studio`, `icm-legal-review`) injected at `SessionStart` and use it as a semantic hint to pre-populate tailored `(Recommended)` multiple-choice options via `ask_question` for the project's domain, target deliverable, and language/tone rules.
2. **Update Layer 0 & Layer 1 Only:**
   - Update [`workspace/GEMINI.md`](../../workspace/GEMINI.md) (Layer 0: Global Identity & Epistemic Rules).
   - Update [`workspace/CONTEXT.md`](../../workspace/CONTEXT.md) (Layer 1: Workspace Route Context).
   - **No Unverified Parametric Document IDs (Prompt or Search-Query Self-Echo):** When writing Layer 0, Layer 1, or `prompts/01_research.md` prior to Stage 1's Google Search run, refer to formal documents (standards, statutes, regulations, filings, RFCs, CVEs, trials) by their canonical titles (or exact identifiers explicitly provided by the user)—**never** hardcode unverified alphanumeric document IDs or enactment dates from parametric memory into prompt templates. Always preserve the **Verbatim Formal Identifiers** invariant in `workspace/GEMINI.md` and `prompts/01_research.md`: Stage 1 must formulate Google Search queries using canonical titles/concepts rather than guessed alphanumeric IDs, and may include a formal alphanumeric identifier in `research_summary.md` **only** when that exact string appears verbatim in a retrieved source (otherwise citing the canonical title and section alone, never echoing its own search query).
   - Stop and ask Question 2 before touching `prompts/01_research.md`.

---

## Phase 2: Stage 1 (`prompts/01_research.md`), OKF v0.2 Bundle Sync & Standalone Verification

1. **Ask Question 2 (Stage 1 Output Structure & OKF Concept Type):**
   - Ask what specific sections, facts, or strategic angles Stage 1 should research and write into `research_summary.md`, what OKF v0.2 `type` name fits best (e.g., `Research Concept`, `Forskriftsveileder`, `Playbook`, `Metric`), and whether `thinkingLevel` should remain `HIGH` (`maxOutputTokens: 65536`).
2. **Edit Only `prompts/01_research.md`:**
   - Keep `model: gemini-4-argon`, `maxOutputTokens: 65536`, and `{{#if globalIdentity}}`, `{{#if workspaceContext}}`, and `{{#if bundleContext}}` blocks intact.
   - Ensure the OKF v0.2 frontmatter instructions require `type`, `title`, `description`, `tags`, `stale_after` (in full ISO 8601 UTC format `YYYY-MM-DDTHH:MM:SSZ`), and `sources` (`id`, `resource`, `title` — explicitly noting that `vertexaisearch.cloud.google.com/grounding-api-redirect/...` URLs from Google Search are normal and automatically resolved by the engine, so the model should run 1–2 focused search batches, never re-search solely to unwrap redirect URLs, cross-check each search result's hosting domain/site label so third-party PDF mirrors are never titled as primary official registries, and unless historical/archival comparison is requested, prefer the currently active consolidated canonical page over superseded revisions, amendment-history snapshots, or dated archive PDFs even on official domains), with `[^source-id]` footnotes in the body (and never double-caret `^[^source-id]`), and instruct Stage 1 to: (a) search using canonical titles/concepts rather than guessed alphanumeric IDs and include formal alphanumeric identifiers **only** when verbatim in a retrieved source, and (b) explicitly surface any **source conflicts** (`[^source-a]` vs. `[^source-b]`) or **unconfirmed evidence gaps** rather than smoothing them over or guessing.
3. **Run & Audit Stage 1 Standalone (Do NOT Run Stage 2 Yet):**
   - **Important:** Do **not** run `npm run cli -- "<topic>"` here, because `npm run cli` also runs Stage 2 with the old uncustomized prompt and wastes tokens.
   - First, run a **zero-token `--dry-run`** to verify how `Layer 0 + Layer 1 + Layer 2 + Layer 3 (OKF Bundle)` assembled in `workspace/runs/_dry_run/stages/01_research/input/prompt_assembled.md`:
     ```bash
     npm run cli:stage1 -- --dry-run "<topic>"
     ```
   - Next, run **Stage 1 standalone** via:
     ```bash
     npm run cli:stage1 -- --artifact-dir "<appDataDir>\brain\<conversation-id>" "<topic>"
     ```
   - Once completed, perform the **Stage 1 Pure ICM + OKF v0.2 Filesystem Audit**:
     1. **Telemetry, OKF & Search Query Check:** Read `workspace/runs/<runId>/meta.json` (`stage1Telemetry` and `okf`: `type`, `status`, `trust_tier`, `is_stale`, `stale_after`, `sourcesCount`, `bundleConceptId`) and `stages/01_research/output/thinking_trace.md`.
     2. **Assembled Input Check:** Verify `stages/01_research/input/prompt_assembled.md` if you need to confirm how Layer 0 + Layer 1 + Layer 2 + Layer 3 combined.
     3. **Output Artifact, Source-Domain Provenance & Edition Currency Audit, Bundle Promotion & Stage-1 Intermission A2UI Review Studio (`a2ui.html` & `viz.html`):** Read `workspace/runs/<runId>/stages/01_research/output/research_summary.md` and `workspace/bundle/` (`index.md`, `log.md`, `research/<slug>.md`), verifying that every entry in `sources[]` has a resolved URL, `retrieved_at` UTC timestamp (plus HTTP/HTML/PDF `last_modified` when available), and matching `[^id]` footnotes in the body. Semantically cross-check each source's `id`, `title`, unwrapped `resource` URL, and `last_modified` date for **domain provenance** (including any `(via <hostname>)` notices stamped by `cleanGroundingLinks()`), **edition/temporal currency** (unless historical research was requested, proactively flag any superseded revisions, amendment-history snapshots, or dated archive PDFs even on official domains so the user can swap them in 1 click via `🔀 Replace source` / `🔀 Erstatt kilde`), and **verbatim formal identifiers** (cross-checked against `thinking_trace.md`). Note that `npm run cli:stage1` **automatically compiles** the **Stage-1 Intermission A2UI Review Studio** (`workspace/runs/<runId>/a2ui.html`, `workspace/runs/<runId>/a2ui_surface.json`, `workspace/bundle/a2ui.html`, and `workspace/bundle/viz.html`) and (when `--artifact-dir` is passed) copies them to `<appDataDir>\brain\<conversation-id>\a2ui_studio.html` and `okf_viz_studio.html`.
     4. **Primary-Registry Blind-Spot & Open-Data / MCP Discovery Protocol:** Check whether the domain's **canonical primary registry** (e.g., official statute/regulation database, corporate/securities filing registry, clinical-trial/patent registry, or standards archive) returned `0` grounded hits in `thinking_trace.md` or is completely absent from `sources[]` (forcing Stage 1 to rely on secondary summaries). If so:
        - Quickly inspect why web grounding missed it (e.g., check `https://<registry>/robots.txt` for `Disallow: /` or AI-crawler blocks), check `search_marketplace` (when available) for an existing MCP plugin, and run `search_web("<registry> open data API OR OpenAPI")` (in the domain's language + English) to discover official Open Data feeds, bulk archives, or REST/OpenAPI specs—inspecting any discovered Swagger/OpenAPI/docs URL to check **keyless open data vs. `API_KEY`-gated endpoints** and reuse license.
        - Include a concise **`🔌 Primary Registry & Open-Data / MCP Opportunity`** callout in your Stage 1 Audit Report (alongside the clickable Studio links—never blocking them with an `ask_question` modal): explain why web search missed the primary registry, detail the official API / open-data feed and auth split you found, and offer to **guide the user in creating a zero-dependency local MCP Server + Layer 3 OKF Reference Connector (`workspace/bundle/references/`)**!
        - **If the user opts to connect the API / create the MCP Server:**
          1. **Self-contained zero-dependency workspace plugin (`.agents/plugins/<registry>-mcp/mcp/index.mjs`):** Place the entry script inside `.agents/plugins/<registry>-mcp/mcp/index.mjs` (resolving `REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')`) so `"args": ["mcp/index.mjs"]` in `.agents/plugins/<registry>-mcp/mcp_config.json` resolves cleanly from the plugin directory while `npm run cli:<registry>` (`node .agents/plugins/<registry>-mcp/mcp/index.mjs`) also runs cleanly from the repo root. Implement a pure Node.js `stdio` JSON-RPC 2.0 MCP server (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`) using native `fetch()` (reading any `API_KEY` from `.env`), or—when live search requires a key while official bulk Open Data archives (`.tar.bz2`, `.tar.gz`, `.zip`, `.json`) are keyless—downloading/indexing into gitignored `.cache/open-data/` via built-in system `tar` (`bsdtar` on Windows/macOS, GNU `tar` on Linux).
          2. **Bridge MCP ↔ Headless ICM (`workspace/bundle/references/`):** Because MCP tools serve the *chat agent* while headless `npm run cli:stage1` reads `workspace/bundle/`, include a `sync_to_okf_bundle` tool / `--sync` CLI mode that writes matching authoritative records as OKF v0.2 `.md` files into `workspace/bundle/references/<slug>.md` (with canonical `sources[]` URLs, verbatim formal IDs, `status: stable`, `stale_after`, and `regenerateBundleIndexes()`), which `loadWorkspaceLayers()` automatically hydrates into Stage 1's `{{bundleContext}}` and renders in `viz.html`.
          3. **Register & Verify (`plugin.json` + `mcp_config.json`):** Consult `agy-customizations` / `plugin` skills to write `.agents/plugins/<registry>-mcp/plugin.json` (valid manifest fields only: `name`, `displayName`, `description`, `version`, `homepage`) and `mcp_config.json` (with a prefixed server key like `"<registry>-open-data"` and `"args": ["mcp/index.mjs"]`), link `[<name>](customization://<registry>-mcp)` for 1-click UI management, smoke-test JSON-RPC `tools/list` + `tools/call`, sync the relevant primary records into `workspace/bundle/references/`, and verify via `npm run cli:stage1 -- --dry-run "<topic>"` that `prompt_assembled.md` hydrates the primary-registry sources!
     5. **Open in Antigravity 2.0 HTML Auxiliary Pane & Start One-Shot Ping-Pong Listener (ONLY When Antigravity 2.0 `/browser` Capability Is Installed):** If the user has Antigravity 2.0 with `/browser` capabilities installed (`hasAntigravityBrowserCapability() === true`, i.e., `<appDataDir>\brain\<conversation-id>` and `browser_recordings` / `html_artifacts` / `chrome-devtools-plugin` exist):
        - Immediately register `<appDataDir>\brain\<conversation-id>\a2ui_studio.html` (and `okf_viz_studio.html`) in the **HTML Auxiliary Pane** at zero LLM output token cost by calling `write_file` with `Path: "<appDataDir>\\brain\\<conversation-id>\\a2ui_studio.html"`, `Append: true`, `Content: "\n"`, and `ArtifactMetadata: { UserFacing: true, RequestFeedback: false, Summary: "..." }` (never read/paste the ~500 KB HTML string into `Content`), and
        - Launch the one-shot **Ping-Pong Reactive Wakeup listener** (`npm run cli:ping-pong -- <runId>`) as a background task (`WaitMsBeforeAsync: 500`, `IsDaemon: false`). When the user clicks **`🚀 Godkjenn & Send til AGY`** inside `a2ui_studio.html` or `a2ui.html`, the listener receives `{ runId, verifierActor, rejectedSources, addedSources, replacedSources, agyText, cliText }` on `127.0.0.1:44820`, prints the JSON payload, and exits `0`—which **automatically wakes up the active chat via Antigravity 2.0 Reactive Wakeup** without the user typing in chat! *(If Antigravity 2.0 `/browser` capability is NOT installed, `hasAntigravityBrowserCapability()` returns `false`, hides the Ping-Pong button, and uses the standard `📋 Kopier svar til AGY` clipboard flow.)*
        - **Immediately output the Stage 1 Audit Report with clickable `[a2ui_studio.html](file:///...)`, `[a2ui.html](file:///...)`, and `[viz.html](file:///...)` links directly in chat and end your turn** so the user can review and curate sources in the Auxiliary Pane or browser before Stage 2 (**NEVER call `ask_question` before outputting the clickable links in chat**, as a modal blocks the user from seeing or clicking the links).
   - **Intermission Verification & Zero-Token Source Citation Re-Anchoring (`npm run cli:verify`):** Once the user is happy with Stage 1's output—or submits a curated approval prompt via Ping-Pong or clipboard from `a2ui.html` (or after applying the **Edit-Source Principle**)—**do NOT manually rewrite `research_summary.md` via `edit_file` just to swap rejected footnote IDs**! Instead, pass `--replace-source <oldId=newId_or_URL>` directly to `cli:verify` so `curateOkfSources()` re-anchors every `[^oldId]` citation to an existing `source.id` or newly added canonical URL in `<50ms` at **zero LLM token cost**:
     ```bash
     npm run cli:verify -- <runId> --by "human:<reviewer-id>" [--reject-source <id1,id2>] [--add-source "<url>|<title>"] [--replace-source <oldId=newId_or_URL>] --artifact-dir "<appDataDir>\brain\<conversation-id>"
     ```
     *(Atomically re-anchors `[^oldId]` -> `[^newId]`, deduplicates adjacent footnotes, removes rejected sources from YAML frontmatter and inline/bottom `[^id]` footnotes, warns only if any claims still lack a citation (`orphanClaimLines`), resolves & weaves added human sources (`curateOkfSources()`), transitions `status: stable` and `trust_tier: human-reviewed` in both `research_summary.md` and `workspace/bundle/research/<slug>.md` (`allowDestructiveOverwrite: true`), and automatically regenerates `a2ui.html`, `viz.html`, `a2ui_studio.html`, and `okf_viz_studio.html` at zero token cost. Refresh `a2ui_studio.html` in the HTML Auxiliary Pane via a 1-byte `write_file(Append: true, Content: "\n", ArtifactMetadata: ...)` call. Only edit `research_summary.md` directly if a factual claim itself needs prose changes. If Stage 2 (`script_draft.json`) already exists and the curated sources do not invalidate any Stage 2 claims, do **not** re-run `npm run cli:stage2`.)*

---

## Phase 3: Layer 3 (`workspace/_config/voice_guide.md`) & Stage 2 (`prompts/02_script.md`)

Only start Phase 3 after Stage 1's `research_summary.md` artifact is verified on disk:

1. **Ask Question 3 (Stage 2 Deliverable & Schema):**
   - Ask what Stage 2 should transform `research_summary.md` into (e.g., course module & instructor lesson script, institutional investment committee memo, podcast dialogue, legal risk matrix, executive brief) and what voice/style rules belong in [`workspace/_config/voice_guide.md`](../../workspace/_config/voice_guide.md).
2. **Update Layer 3 & Stage 2:**
   - Update [`workspace/_config/voice_guide.md`](../../workspace/_config/voice_guide.md).
   - Update [`prompts/02_script.md`](../../prompts/02_script.md) (`model: gemini-4-argon`, `thinkingLevel: MEDIUM`, `maxOutputTokens: 32768` or up to `65536`).
   - **Canonical Stage 2 JSON Schema Keys Recognized Automatically by `normalizeStage2ForA2ui()`** (use these directly in `prompts/02_script.md` frontmatter `output.schema` without reading or patching `src/index.ts`):
     - **Top-level:** `title` (or `courseTitle` / `reportTitle` / `memoTitle`), `subtitle` (or `description` / `verdict`), `targetAudience` (or `audience`), `totalEstimatedMinutes` / `durationMinutes` / `readingTimeMinutes` (for duration in minutes; `estimatedDuration` is in seconds for short scripts or auto-inferred as minutes when modules/pillars have `durationMinutes`), `scriptBody` (or `visualSummary` / `executiveSummary` / `investmentThesis` / `memoBody` / `overview`), `spokenScript` (optional dedicated TTS narration string when separate from `visualSummary` / `scriptBody`), `overviewVisualPrompt` (optional scene description consumed automatically by Stage 3 `03_visuals`), `learningObjectives` (or `keyTakeaways` / `thesisPoints`: `string[]`), `checklistGroups` (`{ category, items: string[] }[]`, or auto-extracted from Stage 1 Markdown `- [ ]` checklists), `scenarios` / `stressTests` / `cases` (`{ title, scenario, recommendation, resolution, mitigation, legalBasis }[]`).
     - **Module / Pillar items (`trainingModules` / `modules` / `lessons` / `sections` / `pillars` / `analysisPillars`):** `moduleNumber` (or `pillarNumber` / `sectionNumber`), `title` (or `moduleTitle` / `pillarTitle` / `sectionTitle`), `durationMinutes` (or `readingTimeMinutes`), `legalBasis` (or `regulatoryBasis` / `legalReference` / `statute` / `analyticalFramework` / `valuationMethodology`), `narration` (or `analysis` / `content` / `summary` / `spokenNarration`), `spokenNarration` (optional dedicated TTS string when `analysis` / `narration` is visual-first), `visualPrompt` (optional scene description consumed automatically by Stage 3 `03_visuals`), `slideCues` (or `keyPoints` / `keyTakeaways`: `string[]`), `actionItem` (or `recommendation` / `icDirective` / `practicalTask` / `exercise` / `boardActionItem`), `caseScenario` (or `scenario` / `stressTest` / `dilemma`), `caseResolution` (or `recommendedAction` / `mitigation` / `resolution` / `solution`).
     - **Course vs. Non-Course Decision/Analytical Pipelines (Quiz Rule):**
       - For **course, training, or certification pipelines**, include `quizQuestion`, `quizOptions` (`string[]`), `quizCorrectIndex` (`0`-based integer), and `quizExplanation` on each module (or top-level `quiz`) so `a2ui.html` renders the interactive Quiz tab.
       - For **non-course analytical, investment, legal, executive, or decision pipelines** (e.g., equity valuation, Buy/Hold/Sell IC memo, M&A due diligence, legal compliance opinion, architecture RFC), **DO NOT** recommend or generate `quizQuestion` / `quizOptions` / `quizCorrectIndex` / `quizExplanation` / `quiz` in `prompts/02_script.md`. Instead, use `pillars` / `sections`, `thesisPoints` / `keyTakeaways`, `recommendation` / `actionItem` / `icDirective`, and `caseScenario` / `caseResolution` (or top-level `scenarios` / `stressTests`). When `quiz` is empty, `generateA2uiSurface()` automatically omits the Quiz tab from `a2ui.html` and switches the UI into analytical/decision mode.
     - **Dual-Register Stage 2 Formatting Rule (Visual Readability + Automatic TTS Normalization):**
       - Stage 2 prose fields (`scriptBody` / `visualSummary` / `investmentThesis` / `executiveSummary` and `modules[*].narration` / `pillars[*].analysis`) serve both as **visual Markdown cards** in `a2ui.html` and as **TTS audio input** via `speakNarration()`, which automatically runs `normalizeTextForTts()` to expand currency, units, and mathematical symbols into natural spoken words at playback time (`-$1,795.7M` -> `"negative 1,795.7 million dollars"`, `Iₛₚ` -> `"specific impulse"`, `6 μg` -> `"6 micro-g"`, `±` -> `"plus or minus"` / `"pluss eller minus"`).
       - Therefore, in `workspace/_config/voice_guide.md` and `prompts/02_script.md`, keep Stage 2 output free of raw URLs, `[^id]` footnotes, and raw LaTeX backslashes (`\frac`, `\text`), **but always write numbers, currencies, and scientific units in clean, scannable visual notation** (e.g., `-$1,795.7M`, `$800.0B`, `$500/kg`, `3.88 ± 0.25 g/cm³`, `Δv = 4.630 km/s`, `Iₛₚ`, `NPV₈`) rather than spelling out numbers or formulas as long verbal strings (`"negative one thousand seven hundred ninety-five point seven million dollars"`).
       - Require **multi-paragraph formatting** (`\n\n` paragraph breaks separating 2–3 focused paragraphs, with optional **bold lead-ins** or bullet points) inside `scriptBody` / `investmentThesis` and each `narration` / `analysis` field so visual cards never render as a single unformatted wall of text.
3. **Test Stage 2 Standalone (Zero Stage 1 Cost):**
   - First verify with `--dry-run`, then run Stage 2 standalone against the existing `<runId>`:
     ```bash
     npm run cli:stage2 -- --dry-run <runId>
     npm run cli:stage2 -- --artifact-dir "<appDataDir>\brain\<conversation-id>" <runId>
     ```
   - Inspect `stage2Telemetry` in `workspace/runs/<runId>/meta.json`, `stages/02_script/output/thinking_trace.md`, and `stages/02_script/output/script_draft.json`. `runStage2Flow()` automatically recompiles `a2ui.html` and copies `a2ui_studio.html` into `--artifact-dir`; refresh `a2ui_studio.html` in the **HTML Auxiliary Pane** via a 1-byte `write_file(Append: true, Content: "\n", ArtifactMetadata: ...)` call (and open in the integrated browser if `chrome-devtools` MCP is available). **Always output your Stage 2 Audit summary with clickable `[a2ui_studio.html](file:///...)`, `[a2ui.html](file:///...)`, and `[script_draft.json](file:///...)` links directly in chat before calling `ask_question`** (or ask your Phase 5 follow-up in plain text at the end of that message) so a modal never hides the Stage 2 links while the user inspects the refreshed Studio.

---

## Phase 4: Adding Downstream Text or Multimodal Stages (`03_visuals`, `04_audio`, `03_...`)

- **Built-In Zero-Patch Multimodal Stages (`prompts/03_visuals.md` & `prompts/04_audio.md`):**
  - `runStage3Flow` (`npm run cli:stage3`), `runStage4Flow` (`npm run cli:stage4` — both single-speaker and multi-speaker dialogue), binary magic-byte MIME/extension detection (`detectMediaMimeAndExtension()`), bilingual (`en`/`no`) prosody normalization (`prepareTextForStudioTts()`), `getIcmPipelineStatus()` downstream token aggregation, and automatic A2UI media hydration (`overview_hero_image` + `ModuleCarousel` `16:9` figures + `SpeechPlayer` studio `<audio>` controls, keeping compact relative `./stages/...` URLs in `a2ui_surface.json` and `surface.dataModel` while deduplicating portable `data:` URIs in `window.A2UI_SURFACE_PAYLOAD.mediaUrisByRun` with `24 kHz -> 12 kHz` FIR WAV downsampling for multi-module HTML portability while keeping lossless `24 kHz` `.wav` files untouched on disk) are **already pre-wired in [`src/index.ts`](../../src/index.ts)**! You do **not** need to read or patch `src/index.ts` to add Stage 3 illustrations or Stage 4 studio voiceover:
  1. **Stage 3 Visual Illustrations (`prompts/03_visuals.md` -> `gemini-nano-banana-2.1`):**
     - Create `prompts/03_visuals.md` with `output.format: image`, `aspectRatio: "16:9"` (or `"4:3"` / `"1:1"`), and `imageSize: "1K"` (or `"2K"`). Available Handlebars variables per slot (`overview` + `module_01..module_NN`): `{{slotId}}`, `{{slotKind}}`, `{{moduleNumber}}`, `{{slotTitle}}`, `{{courseTitle}}`, `{{subtitle}}`, `{{targetAudience}}`, `{{visualPrompt}}`, `{{narration}}`, `{{slideCues}}`, `{{actionItem}}`, `{{globalIdentity}}`, `{{workspaceContext}}`:
       ```yaml
       ---
       model: gemini-nano-banana-2.1
       aspectRatio: "16:9"
       imageSize: "1K"
       output:
         format: image
       ---
       Create a clean 16:9 editorial illustration for "{{slotTitle}}" ({{courseTitle}}).
       Scene direction: {{visualPrompt}}
       Key visual elements: {{slideCues}}
       Zero embedded text, watermarks, or labels inside the image.
       ```
     - Verify at zero token cost first, then run standalone (omitting `[runId]` automatically selects the latest Stage-2-complete run):
       ```bash
       npm run cli:stage3 -- --dry-run <runId>
       npm run cli:stage3 -- --artifact-dir "<appDataDir>\brain\<conversation-id>" <runId>
       ```
     - Refresh `a2ui_studio.html` in the HTML Auxiliary Pane via a 1-byte `write_file(Append: true, Content: "\n", ArtifactMetadata: ...)` call and output clickable links to `a2ui_studio.html`, `a2ui.html`, and `stages/03_visuals/output/visuals_manifest.json` before asking the next question.
  2. **Stage 4 Studio Voiceover (`prompts/04_audio.md` -> `gemini-3.8-flash-tts`, Single-Speaker or Multi-Speaker Dialogue):**
     - Create `prompts/04_audio.md` with `output.format: audio`, `audioMimeType: "audio/wav"`, and `sampleRate: 24000`, choosing either **single-speaker** (`voice: "Kore"` / `"Sulafat"` / `"Puck"` / `"Charon"` / `"Aoede"` / `"Fenrir"`) or **multi-speaker dialogue** (`primarySpeaker`, `primaryVoice`, `primaryStyle`, `secondarySpeaker`, `secondaryVoice`, `secondaryStyle`). `runStage4Flow` automatically normalizes spoken prosody (`prepareTextForStudioTts`), segments explicit `dialogueTurns[]`, `Speaker: ...` prefixes, or alternating paragraphs in multi-speaker mode, records `durationSeconds` & `voicesUsed` in `audio_manifest.json` (bound to `SpeechPlayer.voicesLabel`), and passes the rendered `04_audio.md` body as `speech_metadata.style` (`{{slotId}}`, `{{slotKind}}`, `{{moduleNumber}}`, `{{slotTitle}}`, `{{courseTitle}}`, `{{targetAudience}}`, `{{voiceGuide}}`, `{{globalIdentity}}`):
       ```yaml
       ---
       model: gemini-3.8-flash-tts
       voice: "Kore"
       # Optional multi-speaker dialogue mode (omit `voice` or pair with primary/secondary keys):
       # primarySpeaker: "Lead"
       # primaryVoice: "Sulafat"
       # primaryStyle: "Warm, steady instructor tone"
       # secondarySpeaker: "Specialist"
       # secondaryVoice: "Kore"
       # secondaryStyle: "Crisp, practical field specialist tone"
       audioMimeType: "audio/wav"
       sampleRate: 24000
       output:
         format: audio
       ---
       Deliver "{{slotTitle}}" ({{courseTitle}}) in a warm, clear, steady studio voice.
       {{#if voiceGuide}}{{voiceGuide}}{{/if}}
       ```
     - Verify at zero token cost first, then run standalone:
       ```bash
       npm run cli:stage4 -- --dry-run <runId>
       npm run cli:stage4 -- --artifact-dir "<appDataDir>\brain\<conversation-id>" <runId>
       ```
     - Refresh `a2ui_studio.html` in the HTML Auxiliary Pane and output clickable links to `a2ui_studio.html`, `a2ui.html`, and `stages/04_audio/output/audio_manifest.json` before asking the next question.
- **Adding a Vertical Context Layer (e.g., `workspace/_config/course_profile.md`):**
  - Load the file in `loadWorkspaceLayers()` inside [`src/index.ts`](../../src/index.ts) and inject it into the target `prompts/*.md` template.
- **Adding a Custom Structured Text Stage (e.g., `prompts/03_slides.md`):**
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
  2. Wire a custom stage runner in [`src/index.ts`](../../src/index.ts) and test standalone (`--dry-run` first) to verify `stages/03_<name>/input/prompt_assembled.md`, `output/thinking_trace.md`, and the output artifact on disk.
- **Video Generation (`gemini-omni-1.2-flash`) & Document Analysis:**
  - Activate the `gemini-api-dev` or `gemini-omni-flash-api` skill on demand for exact `/v1beta/interactions` video/multimodal schemas (Progressive Disclosure — never bloat `GEMINI.md` or `CONTEXT.md` with API reference docs).
  - For generative video (`gemini-omni-1.2-flash` with `response_format: { type: "video", delivery: "uri" }` and `store: true`), call `/v1beta/interactions` via native `fetch` or invoke the `gemini-api` CLI binary (`gemini-api` on PATH, or `$env:LOCALAPPDATA\Programs\gemini-api\gemini-api.exe` on Windows):
    - **Image Generation (`gemini-nano-banana-2.1`):** `gemini-api image "<prompt>" --out workspace/runs/<runId>/stages/03_visuals/output/overview.jpg`
    - **Speech / Voiceover (`gemini-3.8-flash-tts`):** `gemini-api tts "<script>" --out workspace/runs/<runId>/stages/04_audio/output/overview.wav`
    - **Document / PDF / Video Analysis:** `gemini-api analyze -i ./docs/source.pdf "Extract key data"`
    - **Dry-Run Inspection:** Append `--dry-run` to preview the Interactions API request without sending it.

---

## Phase 5: A2UI v1.0 Declarative Surface (`npm run cli:a2ui`) or Optional Bespoke Domain Web Studio

Once the pipeline's stages (`01_research`, `02_script`, `03_...`, `04_...`) and a real verified run in `workspace/runs/<runId>/` are complete on disk (and **after** you have already output the clickable `[a2ui_studio.html](file:///...)` / `[a2ui.html](file:///...)` links in chat so a modal never blocks them), ask the user via `ask_question` (or plain text) whether they want to:
1. **(Recommended) Compile a Declarative A2UI v1.0 Surface & Bi-Directional Studio (`npm run cli:a2ui -- <runId>`)** generating `a2ui_surface.json`, `a2ui_surface.jsonl`, `workspace/runs/<runId>/a2ui.html`, `workspace/bundle/a2ui.html`, and automatically refreshing `workspace/bundle/viz.html` in a single command with Tier 1 A2UI Basic Catalog Primitives + `@catalogId`-scoped Tier 2 ICM/OKF Domain Components (`Badge`, `SpeechPlayer`, `OkfMarkdown`, `OkfKnowledgeGraph`, `InteractiveChecklist`, `ModuleCarousel`, `QuizRunner`, `CaseSimulator`),
2. **Build a Bespoke Domain Web Studio (`src/server.ts` + `public/`)** designed from scratch around their pipeline's *actual* filesystem artifacts, or
3. **Keep the project as a 100% Pure Headless CLI Pipeline** (zero web server code).

If the user chooses to build a custom Domain Web Studio:
- **Design for the Specific Domain & Artifacts (Never a Generic Form):**
  - Inspect the actual JSON/Markdown/image/audio files in `workspace/runs/<runId>/` first and craft a UI tailored to that exact product:
    - *Online Course & Lesson Studio*: Interactive 16:9 Slide Deck Carousel (`slides_deck.json` + rendered PNGs), synchronized HTML5 Instructor Audio Player (`lesson_voiceover.wav`), collapsible Module Syllabus & Speaker Notes drawer, interactive Formative Quiz check cards, and per-stage regenerate/edit controls.
    - *Podcast & Audio Studio*: Dual-host transcript timeline, inline voiceover player, and episode show notes editor.
    - *Executive / Legal / Competitor Intelligence*: Executive KPI summary cards, side-by-side source verification inspector, and interactive filterable tables.
- **Zero-Dependency Native Node HTTP Server (`src/server.ts`) & OKF v0.2 / A2UI v1.0 UI Best Practices:**
  - Generate the A2UI v1.0 surface and interactive OKF knowledge graph in a single command (`npm run cli:a2ui -- <runId>` → `a2ui.html`, `workspace/bundle/a2ui.html`, and `workspace/bundle/viz.html`) so they are ready to embed or view alongside the studio.
  - Build `src/server.ts` using Node's built-in `node:http` and `node:fs` modules (keeping **0 external npm dependencies**!) or install `express` if preferred.
  - When rendering OKF v0.2 Markdown documents (`research_summary.md`) inside a custom Web Studio (`public/index.html`):
    - Preprocess OKF `[^id]` footnotes and `[^id]: Title` footnote definitions before calling `marked.parse()` so inline `[^id]` citations render as clickable superscript links tied to `frontmatter.sources`, and display each source's `retrieved_at` (and `last_modified` if present) timestamp badge.
    - Intercept clicks on internal OKF bundle links (e.g., `/research/<concept>.md`) inside the studio preview so clicking them selects the matching run/concept or opens the `viz.html` graph tab rather than navigating to a 404 URL.
    - If extracting Markdown checklists (`- [ ] ...`) into a checklist UI tab, strip `[^id]` footnotes, backticks, and inline LaTeX (`$\text{...}$`), and render top-level `- [ ] **Category**:` lines that precede indented `  - [ ]` sub-items as group headers.
    - In `src/server.ts`, whenever an endpoint saves edited Stage 1 Markdown (`PUT /api/runs/:id/research`), call `syncRunToBundle()`, `generateBundleVisualization()`, and `generateA2uiSurface()`; when verifying a run (`POST /api/runs/:id/verify`), `verifyOkfConcept()` already calls `syncRunToBundle()` internally, so only call `verifyOkfConcept()`, `generateBundleVisualization()`, and `generateA2uiSurface()`.
  - Add `"server": "npx tsx --env-file=.env.local src/server.ts"` and `"dev": "npx tsx watch --clear-screen=false --ignore=.icm/** --ignore=workspace/** --env-file=.env.local src/server.ts"` to `package.json`, and run the server in development using `npm run dev` (`IsDaemon: true`) so edits to `src/server.ts` hot-reload automatically without manual task restarts.
  - Hydrate initial run data from `workspace/runs/` so the first browser paint at `http://localhost:3000` loads immediately with the user's verified run selected.
