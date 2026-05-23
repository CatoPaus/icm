# Interpretable Context Methodology (ICM) with Firebase Genkit

This repository contains a reference implementation of the **Interpretable Context Methodology (ICM)** built with Firebase Genkit and TypeScript. 

ICM is a declarative, filesystem-centric context management architecture that replaces programmatic agent-orchestration layers with numbered stage directories, markdown-based stage contracts, and explicit sandboxing boundaries.

---

## 🏗️ Directory Architecture

The workspace layout maps abstract context layers directly to disk directories:

```
.
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts                 # Main Orchestrator Flow & Resumable Interrupts
├── prompts/                     # Layer 2: Stage Contracts (Dotprompt templates)
│   ├── 01_research.prompt       # Stage 1 contract
│   └── 02_script.prompt         # Stage 2 contract
└── workspace/                   # Scoped Workspace Sandbox
    ├── CLAUDE.md                # Layer 0: Global Identity Guide
    ├── CONTEXT.md               # Layer 1: Workspace Route Context
    ├── _config/                 # Layer 3: Global Reference Materials
    │   └── voice_guide.md       # Global brand voice tone
    └── stages/                  # Live execution directories
        ├── 01_research/
        │   ├── references/      # Stage 1 reference docs
        │   └── output/          # Stage 1 working artifacts (Layer 4)
        └── 02_script/
            ├── references/      # Stage 2 reference docs
            └── output/          # Stage 2 working artifacts (Layer 4)
```

---

## 🚀 Setup & Installation

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

## 💻 Running the Developer environment

Start the Genkit CLI runner and local Developer UI:
```bash
npm run genkit:dev
```
Once started, the CLI will output:
* **Telemetry API:** `http://localhost:4033`
* **Genkit Developer UI:** [http://localhost:4000](http://localhost:4000)

Open the Developer UI in your browser to inspect, trigger, and debug traces of flows and prompts.

---

## 🧪 Testing Use Case: Video Script Creator

This testing scenario demonstrates a 2-stage pipeline: researching a topic, allowing human-in-the-loop editing, and writing a structured script conforming to specific brand rules.

### 📋 Scenario Goal
Create an engaging 2-minute video script about **"How Quantum Computing Works"** matching the brand's voice guide rules.

---

### Step-by-Step Test Walkthrough

#### Step 1: Trigger the Orchestration Flow
1. Open the Genkit Developer UI at `http://localhost:4000`.
2. Under the **Flows** section on the left sidebar, click `icmOrchestratorFlow`.
3. Provide the input arguments in the JSON editor:
   ```json
   {
     "workspaceRoot": "./workspace",
     "topic": "Quantum Computing Superposition and Entanglement"
   }
   ```
4. Click **Run**.

#### Step 2: Audit Stage 1 (Research) Outputs
1. Observe the console logs or trace spans in the Dev UI.
2. Open the file system and locate:
   📂 `workspace/stages/01_research/output/research_summary.md`
3. Verify that the model has successfully generated a comprehensive text summary outlines.

#### Step 3: Human-in-the-Loop Intermission (Simulating Manual Editing)
One of the core tenets of ICM is that all stages handoff plain files.
1. Open `workspace/stages/01_research/output/research_summary.md` in your text editor.
2. Modify or add a custom sentence (e.g., *“Note: Einstein famously called entanglement 'spooky action at a distance'.”*).
3. Save the file.

#### Step 4: Execute Stage 2 (Scriptwriting)
The orchestrator now runs Stage 2. It will automatically:
1. Ingest the edited `research_summary.md` from Stage 1.
2. Ingest the brand guidelines from `workspace/_config/voice_guide.md`.
3. Call the `02_script` contract.
4. Output a structured JSON file at:
   📂 `workspace/stages/02_script/output/script_draft.json`
5. Verify the JSON matches the schema with keys `title`, `scriptBody`, and `estimatedDuration`.

---

### ⏳ Testing Stateful Resumable Interrupts (Stateless API Handoffs)

For server-based, interactive applications where human gating is required before execution completes, you can test the **Restartable Tool Interrupt** loop:

#### 1. Start the Interactive Run
In your code/tests (or by instantiating the CLI handlers), invoke `handleInteractiveDeployment` with a session identifier and deployment prompt:
```typescript
// Initial call (returns status AWAITING_APPROVAL)
const runState = await handleInteractiveDeployment(
  "session-abc-123",
  "Deploy script draft to media systems"
);
```
At this point, the flow encounters the sensitive `deployScriptDraftTool` tool call. Since it has not been approved, it halts and returns:
```json
{
  "status": "AWAITING_APPROVAL",
  "sessionId": "session-abc-123",
  "interrupt": { ... }
}
```

#### 2. Resume & Approve the Action
Simulate the human approval turn by passing the session ID and the saved `interrupt` metadata object to the approval function:
```typescript
// Approval call (resumes execution, registers approval, and completes)
const finalizedRun = await approveAndResume(
  "session-abc-123",
  runState.interrupt
);
```
Verify the output status resolves to `COMPLETED` and the terminal logs confirm the deployment successfully executed:
```
Successfully deployed script [scriptId]
```
All interactive steps will be saved in the persistent session directory under `.sessions/session-abc-123.json`.

---

## 🧹 Cleaning Up the Workspace

To clean up and reset the workspace (deleting all active stages outputs, cached telemetry files, and session states), run:
```bash
npm run clean
```
This script removes the `.sessions/`, `.genkit/`, and stage output directories.
