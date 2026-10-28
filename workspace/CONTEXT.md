# Layer 1: Workspace Route Context (`CONTEXT.md`)

This workspace executes a two-stage sequential **100% Pure Interpretable Context Methodology (ICM)** pipeline where each stage communicates strictly through explicit filesystem artifacts on disk:

1. **Stage 1 — Grounded Web Research (`stages/01_research`)**
   - **Model & Thinking**: `gemini-4-argon` (`thinkingLevel: HIGH` by default, `maxOutputTokens: 65536`) with Google Search grounding enabled via the Google AI Interactions API.
   - **Output Artifact**: `stages/01_research/output/research_summary.md`
   - **Role**: Synthesize comprehensive, source-backed findings on the requested topic so downstream stages need zero external web access.

2. **Intermission — Human-in-the-Loop Inspection & Editing**
   - **Role**: Between Stage 1 and Stage 2, a human reviewer can inspect or edit `research_summary.md` directly in the Web Dashboard or on disk, and re-run Stage 2 standalone at any time (`npm run cli:stage2 -- <runId>`) at zero Stage 1 token cost.

3. **Stage 2 — Voiceover Scriptwriting (`stages/02_script`)**
   - **Model & Thinking**: `gemini-4-argon` (`thinkingLevel: MEDIUM` by default, `maxOutputTokens: 32768`).
   - **Inputs**: `stages/01_research/output/research_summary.md` (Layer 4 prior-stage artifact) + `_config/voice_guide.md` (Layer 3 voice constraints).
   - **Output Artifact**: `stages/02_script/output/script_draft.json` (`{ title, scriptBody, estimatedDuration }`).
