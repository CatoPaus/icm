# Interpretable Context Methodology (ICM) with Gemini 4 Argon

This repository contains a **100% Pure Interpretable Context Methodology (ICM)** reference engine built in TypeScript and Node.js, powered directly by the **Google AI Interactions API (`/v1beta/interactions`)** and **Gemini 4 Argon (`gemini-4-argon`)** with **zero runtime `npm` dependencies** and **zero external AI orchestration framework bloat**.

ICM is a declarative, filesystem-centric context management architecture that replaces opaque framework state machines with numbered stage directories, Markdown-based stage contracts, and explicit sandboxing boundaries on disk.

---

## Core Philosophy & Vision

This setup is a **filesystem-first, human-in-the-loop intelligence and production workbench** built on the **Interpretable Context Methodology (ICM)** rather than a black-box multi-agent framework:

### 1. The Filesystem *Is* the State Machine & Trace Log (ICM Layers 0–4)
Instead of trapping intermediate agent state inside in-memory framework closures or external telemetry daemons, every boundary in the pipeline is a **numbered folder and an inspectable file on disk** under `workspace/runs/<runId>/`:
* **Layer 0 & 1 (`workspace/GEMINI.md` + `workspace/CONTEXT.md`):** Global epistemic rules (strict fact-grounding, automatic language matching) and pipeline awareness injected into every stage.
* **Layer 2 (`prompts/01_research.md`, `prompts/02_script.md`):** Strict stage contracts and schemas parsed directly from Markdown files on disk.
* **Layer 3 (`workspace/_config/voice_guide.md`):** Reusable domain/style rules decoupled from the prompt logic.
* **Layer 4 (`research_summary.md`, `script_draft.json`):** Concrete artifacts that act as the *only* handoff between stages, paired with the exact assembled input prompt (`input/prompt_assembled.md`) and reasoning trace (`output/thinking_trace.md`) in every stage folder.

### 2. Asymmetric Cognitive Allocation on a Single Frontier Model (`gemini-4-argon`)
By locking the core reasoning runtime to **Gemini 4 Argon** (`src/index.ts`) and tuning `thinkingLevel` + capabilities per stage, you get deep reasoning where needed and strict determinism downstream:
* **Stage 1 (`01_research` — `HIGH` thinking + Google Search + `65,536` output budget):** Does the heavy lifting—multi-query live web research, deep strategic synthesis, and byte-accurate inline citation weaving (`cleanGroundingLinks`).
* **Stage 2 (`02_script` — `MEDIUM` thinking + zero web access):** Operates in a sealed sandbox using *only* the verified Stage 1 artifact and Layer 3 guide—so downstream deliverables can never introduce unverified claims.

### 3. Frictionless Human-in-the-Loop Iteration
Because every run lives in plain Markdown and JSON files on disk (`workspace/runs/<runId>/`), you can:
1. Preview the assembled 5-layer prompt at zero token cost (`--dry-run`) and run deep Stage 1 research once (`npm run cli:stage1`).
2. Inspect, curate, or edit `research_summary.md` (or tweak `voice_guide.md`) directly in your editor.
3. Re-run Stage 2 (or downstream stages) standalone in seconds (`npm run cli:stage2 -- <runId>`) without re-running or paying for Stage 1 research again.

### 4. Extensible N-Stage Pipeline & Bespoke Domain UI (Built After Real Artifacts Exist)
Just as ICM never designs Stage 2 before verifying Stage 1's actual output on disk, **this base template intentionally ships with zero pre-baked Web UI (`0` runtime dependencies)**:
* **Why No Pre-Baked Generic UI:** A pre-built generic dashboard anchors the AI agent to an arbitrary layout and wastes tokens patching legacy HTML/JS. An Online Course Studio (16:9 slide carousel + synchronized audio player + formative quiz runner), a Legal Contract Auditor (side-by-side clause diff & risk heatmap), and a Podcast Studio (dual-host waveform timeline) each require fundamentally different interfaces.
* **Bespoke UI in Phase 5:** Once your pipeline stages (`01_research`, `02_script`, `03_...`, `04_...`) and a real verified run in `workspace/runs/<runId>/` are locked in on disk, the **ICM Co-Architect** (`GEMINI.md` & `.agents/skills/icm-co-architect/SKILL.md`) offers to generate a **custom Domain Web Studio** (`src/server.ts` + `public/`) tailored specifically to your pipeline's real artifacts—or keep your project as a pure headless CLI pipeline.

---

## Using as an Upstream Base / Template Repository

This repository is designed to serve as an **untouched upstream base template** for specialized downstream projects (e.g., `icm-course-studio`, `icm-podcast-studio`, `icm-market-strategy`, `icm-legal-review`). Runtime outputs (`workspace/runs/`, `.icm/`, `.sessions/`) are excluded via `.gitignore` so the base repository remains clean.

### Starting a New Specialized Project

> **Important — Name Your Project Folder After Your Target Domain:**
> When you clone this template (`git clone https://github.com/CatoPaus/icm.git <project-folder-name>`), the **Antigravity 2.0 ICM Co-Architect** automatically reads your project directory name at `SessionStart` (via `.agents/hooks.json`) and uses it as an immediate semantic signal to pre-populate domain-specific recommendations and multiple-choice options during setup.
> * Example: Naming your folder `icm-course-studio` or `icm-course-builder` automatically steers the Co-Architect's first interactive question and `(Recommended)` options toward online course creation.
> * Example: Naming your folder `icm-podcast-studio`, `icm-legal-review`, or `icm-competitor-intel` automatically tailors its Layer 0–3, Stage 1–4, and Phase 5 UI recommendations to those domains.

```bash
# 1. Clone this base template repository into a domain-named project directory
git clone https://github.com/CatoPaus/icm.git icm-course-studio
cd icm-course-studio

# 2. Rename 'origin' to 'upstream' (so 'upstream' always points to the untouched base template)
git remote rename origin upstream

# 3. Point 'origin' to your new specialized GitHub repository and push
git remote add origin https://github.com/CatoPaus/icm-course-studio.git
git push -u origin main

# 4. Install dev dependencies (tsx, typescript, @types/node) and add your Gemini API key
npm install
echo 'GEMINI_API_KEY="your-gemini-api-key"' > .env.local
```

### Pulling Future Engine Upgrades into Specialized Projects
```bash
git fetch upstream
git checkout upstream/main -- src/index.ts
```

---

## Model & Thinking Level Architecture (`gemini-4-argon`)

All legacy text models (`gemini-2.5-*`, `gemini-3.5-*`, etc.) and deprecated sampling parameters (`temperature`, `topP`, `topK`) have been purged. **`gemini-4-argon`** is used across all text/reasoning stages, configured with stage-appropriate `thinkingConfig.thinkingLevel` (`LOW`, `MEDIUM`, `HIGH`), and paired with Google AI's Interactions API multimodal models when visual or audio stages are added:

| Pipeline Stage / Runner | Model & Thinking Level | `maxOutputTokens` | Context Window | Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **Stage 1: In-Depth Research** (`prompts/01_research.md`) | `gemini-4-argon` — **`HIGH`** (fallback: `MEDIUM`) | `65536` *(max streaming)* | `1,048,576` | Maximizes reasoning depth for multi-source synthesis and Google Search grounding with verbatim citations. |
| **Stage 2+: Structured Synthesis** (`prompts/02_script.md`, `03_...`) | `gemini-4-argon` — **`MEDIUM`** (default) | `32768` | `1,048,576` | Balanced reasoning effort, latency, and token usage for structured JSON/Markdown generation from verified upstream artifacts. |
| **Optional Multimodal Stages** (`03_visuals`, `04_audio`) | `gemini-nano-banana-2.1` (PNG images)<br>`gemini-3.8-flash-tts` (WAV speech) | N/A | `131,072` | Native `/v1beta/interactions` image and voiceover generation directly into stage output directories on disk. |

### Token Limits & 1M Context Window Reference (`gemini-4-argon`)
* **Unified 1M Context Window (`1,048,576` tokens):** Shared across **Input + Thinking + Output**. Any stage can ingest up to ~1M tokens of source documents, transcripts, or prior-stage artifacts without code changes.
* **Standard / Streaming Output Ceiling (`65,536` tokens):** When using standard synchronous or SSE streaming requests (`background: false` on `/v1beta/interactions`), `max_output_tokens` caps combined thinking + output at **`65,536` tokens (64K)** per turn (setting `> 65536` without background mode returns HTTP `400`).
* **Future Option — Long Decode (`> 65,536` up to `1,048,576` output tokens):** If a single turn ever needs to generate more than 64K output tokens in one response, Gemini 4 Argon supports **Long Decode** on the Interactions API by enabling `background: true` and setting `max_output_tokens` between `262,144` and `1,048,576 - inputTokens`.

---

## Key Architectural & Reliability Features

1. **Full 5-Layer ICM Context Injection & Self-Documenting Stage Folders**
   * **Layer 0 (`workspace/GEMINI.md`):** Global identity, epistemic rigor, automatic language alignment, and Markdown citation rules.
   * **Layer 1 (`workspace/CONTEXT.md`):** Workspace pipeline routing and stage boundary awareness.
   * **Layer 2 (`prompts/01_research.md` & `prompts/02_script.md`):** Markdown stage contracts (YAML frontmatter + template) parsed directly by `loadStagePromptContract()` and `parseFrontmatterOutputSchema()` in `src/index.ts` (supporting flat scalars, scalar arrays like `string[]`, nested object arrays like `slides(array):`, and inline JSON Schema).
   * **Layer 3 (`workspace/_config/voice_guide.md`):** Global voice and pacing rules.
   * **Layer 4 (`workspace/runs/<runId>/stages/...`):** Every stage persists its exact assembled input prompt (`input/prompt_assembled.md`), its full reasoning & search trace (`output/thinking_trace.md`), and its final output artifact (`output/research_summary.md`, `output/script_draft.json`), plus token/latency telemetry in `workspace/runs/<runId>/meta.json`.
2. **Direct Interactions API SSE Streaming & Automatic Fallback (`streamGemini4ArgonInteraction`)**
   * Both Stage 1 and Stage 2 execute directly over native Node.js `fetch` SSE streaming (`stream: true` on `https://generativelanguage.googleapis.com/v1beta/interactions`), preventing 300-second `headersTimeout` disconnects during deep `HIGH`-thinking + Google Search turns.
   * Built-in `executeWithRetryAndFallback` automatically retries transient network/503/429 errors and falls back from `HIGH` to `MEDIUM` thinking on `gemini-4-argon` if needed.
3. **Sub-Second Grounding Citation Resolution & Per-Source Temporal Provenance (`resolveRedirect` & `cleanGroundingLinks`)**
   * Resolves `vertexaisearch.cloud.google.com/grounding-api-redirect/...` URLs using `redirect: 'manual'` first to read Google's `302 Location` header directly (~0.5s total for 100+ links) without timing out on unreachable third-party servers, while opportunistically capturing HTTP `Last-Modified` (`last_modified` in ISO 8601 UTC).
   * Stamps every grounded source in `sources[]` with `retrieved_at` (ISO 8601 UTC timestamp), preserves existing bundle `retrieved_at` timestamps across concept merges, weaves Interactions API `url_citation` annotations inline as `[^id]` footnotes at exact UTF-8 byte offsets, and renders `retrieved` / `last_modified` badges in `viz.html`.
4. **Built-In Antigravity 2.0 ICM Co-Architect (`GEMINI.md` & `.agents/`)**
   * **Root `GEMINI.md`:** Configures the main Antigravity 2.0 agent as an interactive **ICM Co-Architect** that guides project customization one question and one stage at a time, audits filesystem traces (`meta.json`, `input/prompt_assembled.md`, `output/thinking_trace.md`), and builds a bespoke Domain Web Studio in Phase 5 after real run artifacts exist on disk.
   * **Lifecycle Hooks (`.agents/hooks.json` & `.agents/scripts/icm-hooks.mjs`):** Automatically injects the project folder domain signal and latest run status at `SessionStart`, and enforces a `PreToolUse` guardrail blocking legacy models or deprecated sampling parameters (`temperature`, `topP`, `topK`).
   * **Interactive Playbook Skill (`.agents/skills/icm-co-architect/SKILL.md`):** 5-phase runbook covering Layer 0/1 setup, Stage 1 verification, Stage 2 synthesis, Stage 3/4 multimodal expansion, and Phase 5 custom Domain Web Studio creation.

---

## Directory Architecture

The workspace layout maps abstract context layers directly to disk directories:

```
.
├── .gitattributes               # Enforces clean LF line endings across Windows, macOS, and Linux
├── GEMINI.md                    # Antigravity 2.0 Main Agent Rules (ICM Co-Architect)
├── SPEC.md                      # Open Knowledge Format (OKF v0.2) Upstream Specification
├── .agents/                     # Antigravity 2.0 Workspace Customizations
│   ├── hooks.json               # SessionStart context injector & PreToolUse Argon guardrail
│   ├── scripts/
│   │   └── icm-hooks.mjs        # Cross-platform Node.js hook handler
│   └── skills/
│       └── icm-co-architect/
│           └── SKILL.md         # Interactive 5-phase specialization & custom UI playbook
├── package.json                 # Zero runtime dependencies (only tsx, typescript, @types/node)
├── tsconfig.json
├── src/
│   └── index.ts                 # 100% Pure ICM + OKF v0.2 Engine, Gemini 4 Argon SSE Client & CLI
├── prompts/                     # Layer 2: Stage Contracts (Markdown + YAML frontmatter)
│   ├── 01_research.md           # Stage 1 contract (gemini-4-argon, thinkingLevel: HIGH)
│   └── 02_script.md             # Stage 2 contract (gemini-4-argon, thinkingLevel: MEDIUM)
└── workspace/                   # Scoped Workspace Sandbox
    ├── GEMINI.md                # Layer 0: Global Identity Guide (OKF v0.2 Provenance)
    ├── CONTEXT.md               # Layer 1: Workspace Route Context
    ├── _config/                 # Layer 3: Global Reference Materials
    │   └── voice_guide.md       # Global brand voice tone
    ├── bundle/                  # Layer 3: Persistent OKF v0.2 Knowledge Bundle (Git-Tracked)
    │   ├── index.md             # Progressive disclosure directory listing (okf_version: "0.2")
    │   ├── log.md               # Chronological audit log (## YYYY-MM-DD)
    │   ├── viz.html             # Optional interactive Cytoscape.js + Marked graph explorer (--viz)
    │   └── research/            # Promoted OKF v0.2 concept documents (<concept>.md)
    └── runs/                    # Per-run isolated stage execution directories
        └── <runId>/
            ├── meta.json        # Run status + Stage 1 & 2 token/latency/search & OKF trust telemetry
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
Initialize package dependencies (`0` runtime dependencies, `0` vulnerabilities):
```bash
npm install
```

### 3. API Keys Configuration
Create a `.env.local` file at the root of the project containing your Gemini API key:
```env
GEMINI_API_KEY="your-gemini-api-key"
```

---

## Running the ICM + OKF v0.2 Pipeline (`cli:stage1`, `cli:verify`, `cli:stage2`, `cli:viz`, `cli`, `--dry-run`)

Because the ICM state lives in plain Markdown and JSON files on disk (`workspace/runs/<runId>/` and `workspace/bundle/`) and `src/index.ts` uses pure cross-platform Node.js with zero external dependencies, you can run every stage standalone from any Windows, macOS, or Linux terminal, SSH session, Docker container, or cron job:

1. **Preview the assembled 5-layer prompt and Interactions API request at zero token cost (`--dry-run`):**
   ```bash
   npm run cli:stage1 -- --dry-run "Cloud Native Architecture in 2026"
   ```
   *(Writes `workspace/runs/_dry_run/stages/01_research/input/prompt_assembled.md` and prints the exact HTTP request headers and body with credentials redacted.)*
2. **Run Stage 1 only (recommended when testing/tuning `01_research.md` before Stage 2):**
   ```bash
   npm run cli:stage1 -- "Cloud Native Architecture in 2026"
   ```
   *(Stops at the Human-in-the-Loop Intermission gate after writing `input/prompt_assembled.md`, `output/thinking_trace.md`, `output/research_summary.md` with OKF v0.2 frontmatter + `[^id]` footnotes, syncing to `workspace/bundle/`, and logging token + OKF telemetry to `meta.json`.)*
3. **Inspect, edit, and verify the Stage 1 OKF concept artifact at Intermission (`cli:verify`):**
   ```bash
   nano workspace/runs/<runId>/stages/01_research/output/research_summary.md
   npm run cli:verify -- <runId> --by human:reviewer
   ```
   *(Stamps `verified: [{ by: "human:reviewer", at: "..." }]` and `status: stable`, upgrading `trust_tier` from `unverified` to `human-reviewed` in both `research_summary.md` and `workspace/bundle/`.)*
4. **Run or re-run Stage 2 standalone after reviewing/verifying Stage 1 (supports `--dry-run` and `--verify`):**
   ```bash
   npm run cli:stage2 -- --dry-run <runId>
   npm run cli:stage2 -- <runId>
   ```
5. **Generate the zero-dependency interactive OKF Knowledge Graph Explorer (`cli:viz`):**
   ```bash
   npm run cli:viz
   ```
   *(Walks `workspace/bundle/` and writes a self-contained single-file `workspace/bundle/viz.html` with Cytoscape.js force-directed graph, trust-tier & staleness badges, and bidirectional backlinks.)*
6. **Or run the full pipeline (Stage 1 + Stage 2) in one pass:**
   ```bash
   npm run cli -- "Cloud Native Architecture in 2026"
   ```
7. **Read the final Stage 2 output:**
   ```bash
   cat workspace/runs/<runId>/stages/02_script/output/script_draft.json
   ```

### Multimodal Stage Expansion (`gemini-nano-banana-2.1`, `gemini-3.8-flash-tts`, & `gemini-api` CLI)
Downstream stages that generate or analyze media files on disk (slide illustrations, voiceovers, video, music, or PDF corpora) can either call `/v1beta/interactions` directly via `fetch` in `src/index.ts` or use Google AI Studio's stateless **`gemini-api` CLI** (`google-gemini/gemini-api-cli`):
* **Install `gemini-api`:**
  * **Linux / macOS:**
    ```bash
    curl -fsSL https://raw.githubusercontent.com/google-gemini/gemini-api-cli/main/scripts/install.sh | bash
    ```
  * **Windows (Direct GitHub Release ZIP — avoids Defender AMSI false-positives on `iwr | iex`):**
    Download `gemini-api_Windows_x86_64.zip` from [github.com/google-gemini/gemini-api-cli/releases/latest](https://github.com/google-gemini/gemini-api-cli/releases/latest) and extract `gemini-api.exe` into your `PATH` (e.g., `%LOCALAPPDATA%\Programs\gemini-api`).
* **Example Multimodal Stage Commands (Writing Directly into ICM Stage Folders):**
  ```bash
  # Stage 3 Visuals: Generate slide or illustration assets (gemini-nano-banana-2.1)
  gemini-api image "Minimalist architectural diagram of a cloud-native mesh" \
    --out workspace/runs/<runId>/stages/03_visuals/output/hero.png

  # Stage 4 Audio: Generate spoken voiceover from Stage 2 script (gemini-3.8-flash-tts)
  gemini-api tts "Welcome to Module 1..." \
    --out workspace/runs/<runId>/stages/04_audio/output/voiceover.wav

  # Pre-Stage 1 Local Corpus Analysis: Analyze local PDFs or videos into Stage 1 input
  gemini-api analyze -i ./workspace/_config/reference.pdf "Extract all regulatory requirements"
  ```

---

## Cleaning Up the Workspace

To clean up and reset the workspace (deleting all active stage outputs and cached telemetry files), run:
```bash
npm run clean
```
