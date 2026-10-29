# Layer 1: Workspace Route Context (`CONTEXT.md`)

This workspace executes a two-stage sequential **100% Pure Interpretable Context Methodology (ICM)** pipeline integrated with the **Open Knowledge Format (`OKF v0.2` — `SPEC.md`)**, where each stage communicates strictly through explicit filesystem artifacts on disk and compounds domain knowledge in `workspace/bundle/`:

1. **Stage 1 — Grounded Web Research & OKF v0.2 Concept Authoring (`stages/01_research`)**
   - **Model & Thinking**: `gemini-4-argon` (`thinkingLevel: HIGH` by default, `maxOutputTokens: 65536`) with Google Search grounding enabled via the Google AI Interactions API.
   - **Progressive Disclosure Input**: Reads `workspace/bundle/index.md` and fresh domain concepts (`now < stale_after`) from `workspace/bundle/` so research builds upon existing verified knowledge.
   - **Output Artifact**: `stages/01_research/output/research_summary.md` (an OKF v0.2 Concept Document with YAML frontmatter `type`, `title`, `description`, `tags`, `status: draft`, `generated`, `stale_after`, and `sources`, plus `[^id]` footnotes in the body) and automatic augmentation-guarded sync to `workspace/bundle/research/`.
   - **Role**: Synthesize comprehensive, source-backed findings on the requested topic so downstream stages need zero external web access.

2. **Intermission — Human-in-the-Loop Inspection, Editing & OKF Verification (`--verify`)**
   - **Role**: Between Stage 1 and Stage 2, a human reviewer can inspect or edit `research_summary.md` directly on disk, stamp human sign-off (`npm run cli:verify -- <runId> [--by human:<id>]` to transition `status: stable` and `trust_tier: human-reviewed`), and re-run Stage 2 standalone at any time (`npm run cli:stage2 -- <runId>`) at zero Stage 1 token cost.

3. **Stage 2 — Voiceover Scriptwriting (`stages/02_script`)**
   - **Model & Thinking**: `gemini-4-argon` (`thinkingLevel: MEDIUM` by default, `maxOutputTokens: 32768`).
   - **Inputs**: `stages/01_research/output/research_summary.md` (Layer 4 prior-stage OKF artifact, checked for `trust_tier` and `is_stale` and recorded in `meta.json`) + `_config/voice_guide.md` (Layer 3 voice constraints).
   - **Output Artifact**: `stages/02_script/output/script_draft.json` (`{ title, scriptBody, estimatedDuration }` — clean spoken narration with zero inline URL or footnote leakage).

4. **OKF Knowledge Graph Explorer (`workspace/bundle/viz.html` via `--viz`)**
   - **Role**: Generates a single-file interactive Cytoscape.js + Marked knowledge graph explorer (`npm run cli:viz`) over `workspace/bundle/` with trust-tier badges, staleness indicators, and bidirectional backlinks.
