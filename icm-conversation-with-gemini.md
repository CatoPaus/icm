# Conversation with Gemini

# Folder-Structured Agentic Architectures: Implementing the Interpretable Context Methodology via Firebase Genkit

The shift from code-heavy multi-agent orchestration frameworks to declarative, filesystem-centric context management represents a significant structural optimization for sequential, human-in-the-loop generative pipelines. The Interpretable Context Methodology (ICM) formalizes this by replacing programmatic coordination layers with numbered directories, markdown-based stage contracts, and explicit context-layering boundaries.

Using the JavaScript/TypeScript SDK of the Firebase Genkit framework, developers can map the abstract context layers and execution gates of ICM directly to native framework primitives—specifically Flows, Dotprompt templates, resumable Interrupts, and composable Middleware. This blueprint outlines the complete step-by-step setup and code implementation required to build an enterprise-grade, folder-structured agentic environment.

## Technical Mapping: ICM to Firebase Genkit (JS/TS)

| ICM Architectural Layer | Operational Role in Workflow | Genkit SDK Primitive | Native TypeScript Implementation Mechanism |
| --- | --- | --- | --- |
| Layer 0: Global Identity | Defines global workspace identity, agent persona, and filesystem structures. | System Instruction Context | Passed during model initialization or declared globally in base prompts. |
| Layer 1: Task Routing | Directs request routing to the appropriate numbered pipeline stages. | Centralized Genkit Flow | A master ai.defineFlow orchestration workflow coordinating stage transition logic. |
| Layer 2: Stage Contracts | Declares step-specific inputs, instruction processes, and expected outputs. | Dotprompt File (.prompt) | External prompt templates featuring YAML frontmatter for schemas, models, and options. |
| Layer 3: Reference Material | Houses stable style guides, brand conventions, and reference patterns. | skills Middleware | Automated directory scanning that injects markdown rules and exposes a use_skill tool. |
| Layer 4: Working Artifacts | Contains per-run dynamic inputs and outputs of active execution passes. | filesystem Middleware | Sandboxed execution tools (list_files, read_file, write_file) restricted to the stage root. |
| Stage Handoffs & Review Gates | Enables human intervention and output editing before downstream processing. | Resumable Interrupts / Tool Gating | Flow execution suspension using toolApproval middleware or explicit manual-response interrupts. |

   
## Step 1: Project Initialization and Setup

To build this environment, configure a modern Node.js project targeting ECMAScript Modules (ESM) and TypeScript.

### 1. Initialize Node.js and TypeScript Configuration

Run the following commands in your terminal to initialize your directory structure and configure dependencies:

Bash
```bash
# Create and navigate to the project root
mkdir genkit-icm-environment && cd genkit-icm-environment

# Initialize project and enforce ESM
npm init -y
npm pkg set type="module"

# Install Genkit core and Google AI provider plugins
npm install genkit@latest @genkit-ai/google-genai@latest

# Install the official Genkit Middleware package
npm install @genkit-ai/middleware@latest

# Install TypeScript, the Genkit CLI, and execution dependencies
npm install -D typescript tsx @types/node genkit-cli@latest

# Initialize TypeScript compiler configurations
npx tsc --init
```

Configure your `tsconfig.json` to support ESM, module resolution, and async execution:

JSON
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true
  }
}
```

### 2. Configure Environment Variables

Set your model API key locally. Genkit automatically reads `GEMINI_API_KEY` when initializing the Google GenAI plugin:

Bash
```bash
export GEMINI_API_KEY="your-google-studio-api-key"
```

## Step 2: Filesystem Layout Configuration

To enforce the separation of concerns between stages, set up your workspace directory layout to reflect the different context layers. Create this directory structure in your project root:

```
genkit-icm-environment/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts                 # Main Orchestrator Flow
├── prompts/                     # Dynamic Layer 2 Prompt Registries 
│   ├── 01_research.prompt       # Stage 1 Contract File
│   └── 02_script.prompt         # Stage 2 Contract File
└── workspace/                   # Scoped Workspace Area 
    ├── GEMINI.md                # Layer 0: Global Identity Guide
    ├── CONTEXT.md               # Layer 1: Workspace Route Context
    ├── _config/                 # Layer 3: Global Reference Materials
    │   └── voice_guide.md       # Global brand tone
    └── stages/                  # Live execution sandbox
        ├── 01_research/
        │   ├── references/      # Stage-specific reference docs
        │   └── output/          # Stage 1 working artifacts (Layer 4)
        └── 02_script/
            ├── references/      # Stage-specific reference docs
            └── output/          # Stage 2 working artifacts (Layer 4)
```

## Step 3: Implementing Stage Contracts with Dotprompt

By utilizing `.prompt` files, you define your model parameters, schemas, and instructions separate from your core application logic.

Create `prompts/01_research.prompt` in your project to serve as the Stage 1 Contract:

YAML
```yaml
---
model: googleai/gemini-4-argon
config:
  temperature: 0.2
input:
  schema:
    topic: string
output:
  format: text
---
You are an expert researcher. Your system identity is defined in GEMINI.md.

TASK:
Conduct in-depth research on: {{topic}}. Outline the core arguments and data.
```

Create `prompts/02_script.prompt` in your project to serve as the Stage 2 Contract:

YAML
```yaml
---
model: googleai/gemini-4-argon
config:
  temperature: 0.3
input:
  schema:
    researchFile: string
    toneRules: string
output:
  format: json
  schema:
    title: string
    scriptBody: string
    estimatedDuration: integer
---
You are an expert scriptwriter. Your system identity is defined in GEMINI.md.

TASK:
Transform the provided research text into a highly engaging, structured script.

STYLE CONSTRAINTS:
Adhere to these tone requirements:
{{toneRules}}

SOURCE RESEARCH:
{{researchFile}}

Generate the final output matching the JSON output schema.
```

When running in development (`NODE_ENV=development` or `GENKIT_ENV=dev`), Genkit automatically reloads these files from disk before each call, allowing immediate iteration on stage instructions without restarting the server.

## Step 4: Core Orchestration and Middleware Pipelines

Create your main orchestrator inside `src/index.ts`. This file initializes Genkit, defines the schemas, configures the sandbox environment using middleware, and coordinates execution across the stages.

TypeScript
```typescript
import { genkit } from 'genkit/beta';
import { z } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';
import { filesystem, skills, retry, fallback } from '@genkit-ai/middleware';
import * as fs from 'fs';
import * as path from 'path';

// 1. Initialize Genkit and specify the dynamic prompt directory [8, 5]
const ai = genkit({
  plugins: [googleAI()],
  promptDir: './prompts',
});

// Define schemas for our orchestrator inputs/outputs 
const ICMWorkflowSchema = z.object({
  workspaceRoot: z.string().describe('Path to the target workspace folder'),
  topic: z.string().describe('The primary topic for the pipeline'),
});

// 2. Define the Central Orchestration Flow (Layer 1 Task Router) 
export const icmOrchestratorFlow = ai.defineFlow(
  {
    name: 'icmOrchestratorFlow',
    inputSchema: ICMWorkflowSchema,
    outputSchema: z.object({
      status: z.string(),
      outputPath: z.string(),
    }),
  },
  async (input) => {
    const workspacePath = path.resolve(input.workspaceRoot);
    
    // --- STAGE 1: RESEARCH ---
    console.log('--- Executing Stage 1: Research ---');
    const stage1Dir = path.join(workspacePath, 'stages/01_research');
    
    // We load the Layer 2 Stage Contract dynamically from prompts/01_research.prompt 
    const researchPrompt = ai.prompt('01_research');
    const stage1Response = await researchPrompt({
      topic: input.topic,
    }, {
      use: [
        filesystem({
          rootDirectory: stage1Dir,
          allowWriteAccess: true,
        }),
        // Load Layer 3: Dynamic reference guides under the workspace configuration directory 
        skills({
          skillPaths: [path.join(workspacePath, '_config')],
        }),
        // Resilience optimization 
        retry({ maxRetries: 3 }),
        fallback({
          models: [googleAI.model('gemini-4-argon')],
          statuses: ['FAILED', 'TIMEOUT'],
        })
      ],
    });

    // Save the output of Stage 1 to disk. This becomes the handoff artifact 
    const researchFileTarget = path.join(stage1Dir, 'output/research_summary.md');
    fs.mkdirSync(path.dirname(researchFileTarget), { recursive: true });
    fs.writeFileSync(researchFileTarget, stage1Response.text);
    console.log(`Stage 1 complete. Output written to: ${researchFileTarget}`);

    // --- INTERMISSION: HUMAN-IN-THE-LOOP INTERRUPT GATE ---
    // At this boundary, the developer or reviewer can pause the script, inspect
    // workspace/stages/01_research/output/research_summary.md, edit it in a standard editor,
    // and let the next stage ingest the edited content.

    // --- STAGE 2: SCRIPTWRITING ---
    console.log('--- Executing Stage 2: Scriptwriting ---');
    const stage2Dir = path.join(workspacePath, 'stages/02_script');
    
    // Ingest Layer 4 output from prior stage 
    const activeResearchData = fs.readFileSync(researchFileTarget, 'utf-8');
    
    // Ingest Layer 3 voice parameters safely
    const toneGuidePath = path.join(workspacePath, '_config/voice_guide.md');
    const toneGuide = fs.existsSync(toneGuidePath)
      ? fs.readFileSync(toneGuidePath, 'utf-8')
      : 'Maintain a professional and clear tone.';

    // Retrieve the compiled stage contract prompt 
    const scriptPrompt = ai.prompt('02_script');
    
    const stage2Response = await scriptPrompt({
      researchFile: activeResearchData,
      toneRules: toneGuide,
    }, {
      // Sandboxing Stage 2 directory
      use: [
        filesystem({
          rootDirectory: stage2Dir,
          allowWriteAccess: true,
        }),
      ]
    });

    // Destructure the structured JSON output requested by the Stage Contract [6, 13]
    const scriptJson = stage2Response.output;
    const scriptOutputTarget = path.join(stage2Dir, 'output/script_draft.json');
    fs.mkdirSync(path.dirname(scriptOutputTarget), { recursive: true });
    fs.writeFileSync(scriptOutputTarget, JSON.stringify(scriptJson, null, 2));
    
    console.log(`Stage 2 complete. Output written to: ${scriptOutputTarget}`);

    return {
      status: 'Pipeline executed successfully',
      outputPath: scriptOutputTarget,
    };
  }
);
```

## Step 5: Implementing Human-in-the-Loop Interceptions

For web services or decentralized apps, local pauses are insufficient. Workflows must survive server restarts and be resumable across stateless HTTP execution cycles. This is implemented using **Restartable Tool Interrupts** coupled with a persistent **Session Store**.

### 1. Register a Stateful Session Store

Implement a database-backed or local JSON storage engine that implements Genkit's `SessionStore` interface to save state variables across execution turns:

TypeScript
```typescript
import { SessionStore, SessionData } from 'genkit/beta'; // Sessions is a beta capability [16]
import * as fs from 'fs';
import * as path from 'path';

export class LocalDiskSessionStore<S = any> implements SessionStore<S> {
  private storageDir: string;

  constructor(storageDir: string = './.sessions') {
    this.storageDir = path.resolve(storageDir);
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private getFilePath(sessionId: string): string {
    return path.join(this.storageDir, `${sessionId}.json`);
  }

  async get(sessionId: string): Promise<SessionData<S> | undefined> {
    const filepath = this.getFilePath(sessionId);
    if (!fs.existsSync(filepath)) return undefined;
    const raw = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as SessionData<S>;
  }

  async save(sessionId: string, data: SessionData<S>): Promise<void> {
    const filepath = this.getFilePath(sessionId);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  }
}
```

### 2. Define a Gated Tool with Restartable Interruption

Create a sensitive tool (such as writing finalized content or trigger deployments) that halts execution for human verification using `interrupt` and `resumed` controllers:

TypeScript
```typescript
export const deployScriptDraftTool = ai.defineTool(
  {
    name: 'deployScriptDraftTool',
    description: 'Deploys the generated script to production media systems.',
    inputSchema: z.object({
      scriptId: z.string(),
      approvedText: z.string(),
    }),
    outputSchema: z.object({
      deploymentStatus: z.string(),
    }),
  },
  async (input, { interrupt, resumed }) => {
    const resumedObj = resumed as Record<string, any> | undefined;
    // 1. If we have resumed and the user explicitly rejected the action 
    if (resumedObj?.status === 'REJECTED') {
      return { deploymentStatus: 'Deployment rejected by human reviewer.' };
    }

    // 2. If the user has not approved it yet, trigger an Interrupt 
    if (resumedObj?.status !== 'APPROVED') {
      interrupt({
        reason: 'human_review_required',
        message: 'Please review and approve the draft before deployment.',
        draftText: input.approvedText,
      });
    }

    // 3. Perform the actual action once approved 
    return {
      deploymentStatus: `Successfully deployed script ${input.scriptId}`,
    };
  }
);
```

### 3. Coordinate the Interrupted Execution Loop

Wrap the call inside your execution handler. The runtime will stop when the interrupt is thrown and resume when a verified response metadata block is passed back:

TypeScript
```typescript
async function handleInteractiveDeployment(sessionId: string, promptText: string) {
  const store = new LocalDiskSessionStore();
  
  // Load session or initialize a new stateful turn 
  const session = await ai.loadSession(sessionId, { store });
  
  let response = await ai.generate({
    model: googleAI.model('gemini-4-argon'),
    prompt: promptText,
    tools: [deployScriptDraftTool],
  });

  // Handle the Interrupted Exception gracefully 
  if (response.finishReason === 'interrupted' && response.interrupts && response.interrupts.length > 0) {
    const interrupt = response.interrupts[0];
    console.log(`Execution paused. Interrupt ID: ${interrupt.toolRequest.ref}`);
    console.log(`Review Payload: ${JSON.stringify(interrupt.toolRequest.input)}`);
    
    // Execution stops here, returning state to the client for human approval 
    return {
      status: 'AWAITING_APPROVAL',
      sessionId,
      interrupt,
    };
  }

  return { status: 'COMPLETED', text: response.text };
}

// Function triggered when human hits "Approve" button on Client UI 
async function approveAndResume(sessionId: string, interruptObj: any) {
  const store = new LocalDiskSessionStore();
  const session = await ai.loadSession(sessionId, { store });

  // Use the `.restart` helper on the tool to bind confirmation metadata 
  const approvedPart = deployScriptDraftTool.restart(interruptObj, {
    status: 'APPROVED',
  });

  const messages = session.toJSON()?.threads?.['main'] || [];

  // Resume processing, injecting conversation history and approval variables 
  const response = await ai.generate({
    model: googleAI.model('gemini-4-argon'),
    tools: [deployScriptDraftTool],
    messages: messages, // Carry over conversational turn context 
    resume: {
      restart: [approvedPart],
    },
  });

  // Save the resumed messages back to the session store
  if (response.messages) {
    await session.updateMessages('main', [...messages, ...response.messages]);
  }

  return { status: 'COMPLETED', text: response.text };
}
```

## Step 6: Observability and Tracing in Development

Observability is built directly into Genkit's runtime through OpenTelemetry integration.

### 1. Add NPM Script for Execution

Add a script definition in your workspace `package.json` to monitor execution and support immediate prompt hot-reloading:

JSON
```json
"scripts": {
  "genkit:dev": "genkit start -- npx tsx --watch src/index.ts",
  "clean": "node scripts/cleanup.js"
}
```

### 2. Run the Development Server

Launch the local developer runtime:

Bash
```bash
npm run genkit:dev
```

This starts your application server and launches the **Genkit Developer UI** locally on port `4000` (by default).

### 3. Debugging and Auditing Context Scopes

Open the Developer UI in your browser to inspect traces:

1. **View Executions:** Navigate to the **Traces** or **Inspect** tab to see every execution step.
         
2. **Audit Context Windows:** Expand the `generate` spans to inspect exactly what was fed into the context window. Verify that:
            - Stage 1 only loaded documents located inside `stages/01_research`.
                  - Stage 2 only ingested the dynamic research summary and the `voice_guide.md` guidelines.
               
3. **Inspect Middleware Spans:** Middleware executions (such as `filesystem` tool calls or `skills` prompts) are captured as distinct spans. You can review timing metrics and input/output payloads of every individual tool execution to detect performance bottlenecks or context drifts early.
         
## Context Optimization Modeling

By scoping context dynamically using Genkit's modular structures, you achieve significant token reduction compared to monolithic architectures. We can express this efficiency mathematically:

Let the context window of a monolithic pipeline $C_{\text{mono}}$ run across $N$ sequential stages be modeled as:

$$C_{\text{mono}}=\sum_{i=1}^{N}\tau(I_i)+\sum_{j=1}^{R}\tau(R_j)+\sum_{k=1}^{N-1}\tau(O_k)$$

where:
* $\tau(I_i)$ is the token payload of instructions for stage $i$.
* $\tau(R_j)$ is the token payload of static guideline files.
* $\tau(O_k)$ is the token payload of prior outputs.

By contrast, using Genkit's `filesystem` and `skills` middleware to restrict context loading, the context size $C_{\text{ICM}}(s)$ at any active stage $s$ is bounded by:

$$C_{\text{ICM}}(s)=\tau(I_s)+\tau(R_{\text{active}})+\tau(O_{s-1})$$

where:
* $\tau(I_s)$ is the token size of the active Stage Contract `.prompt`.
  * $\tau(R_{\text{active}})$ is the token size of only the active reference materials loaded dynamically via the `use_skill` tool.
  * $\tau(O_{s-1})$ is the output of the immediate prior stage, loaded as the active input.
  
This ensures that the token overhead remains bounded and independent of the total pipeline depth $N$, avoiding information retrieval degradation in bloated context windows. 1

## Trace-Based Telemetry, Semantic Debugging, and Local Ergonomics

A central objective of the ICM protocol is to provide inherently observable pipelines. Because every intermediate output is saved as a plain text file, the system is readable and editable by default. Genkit enhances this observability with automated OpenTelemetry-powered Tracing and its local Developer UI.

### The Span Tree as a Semantic Execution Graph

Every action within a Genkit Flow—such as model calls (`generate()`), embedding calculations (`embed()`), vector search retrievals (`retrieve()`), and tool executions—is automatically wrapped in a distinct OpenTelemetry span. These spans form a hierarchical tree representing the complete execution graph.

When an agent produces an unexpected output or fails to follow style guidelines:

1. **Examine the Trace:** The developer opens the Developer UI and selects the trace for the failed run.
2. **Inspect Spans:** Each middleware execution (including filesystem calls and skill retrievals) is logged as a step in the trace. The developer can inspect the exact prompt sent to the model and the model's raw response.
3. **Trace Style Guidelines:** The developer can verify whether the correct style rules were injected by the skills middleware or if they were ignored during generation.
4. **Pinpoint Failure Points:** Instead of guessing where an error occurred in a complex chain, the developer can isolate the specific stage, input variable, or tool call that triggered the issue.

This trace-based debugging approach allows developers to treat prompts as code. When an output drifts from the desired format, the developer modifies the source prompt or reference file on disk and runs the stage again—rather than patching the final output.

## Operational Hardening: Resiliency and Error Recovery

While the standard ICM design relies on human review gates to recover from errors, production deployments can implement automated fallback and resiliency strategies directly within Genkit's middleware stack.

To handle transient model errors, rate limits, or style drifts without breaking the pipeline, developers can stack pre-packaged middlewares:

* **Retry Middleware (`retry`):** Automatically retries failed model calls on transient errors (such as rate limits or service unavailability) using exponential backoff with jitter.
* **Fallback Middleware (`fallback`):** If a primary model exceeds its quota or fails repeatedly, this middleware automatically switches execution to an alternate model (such as falling back from a pro model to a faster, cheaper flash model).
* **Soft Fail and Turn Gating:** Custom middleware can be written using `generateMiddleware()` to catch framework-level errors (such as exceeding maximum turn counts). Instead of crashing and losing state, the middleware extracts the model's last valid response, flags the turn as aborted, and saves the intermediate work to the session store.

By composing these middlewares in array order, developers can build highly resilient agent pipelines that gracefully handle runtime failures.

## Strategic Conclusions and Enterprise Recommendations

Implementing the Interpretable Context Methodology via Firebase Genkit offers a clean, observable, and highly controllable architecture for multi-step generative pipelines. By replacing programmatic orchestration layers with filesystem-based configurations, developers can build agentic workflows that are easy to inspect, test, and maintain.

For enterprise teams deploying this architecture in production, the following design patterns are recommended:

* **Use Dotprompts for Stage Contracts:** Keep prompt instructions, configuration settings, and schemas separated from application code by organizing them as `.prompt` files within stage directories.
* **Enforce Sandbox Isolation:** Secure Layer 4 directories by using Genkit's filesystem middleware with a strictly defined `rootDirectory` to prevent unauthorized file-system operations.
* **Implement Cloud-Ready Session Stores:** When deploying to serverless cloud environments, avoid volatile memory-only storage. Implement persistent session stores using databases like Cloud Firestore or Redis to ensure resumable workflows survive server restarts.
* **Leverage Trace-Based Debugging:** Standardize on Genkit's trace-based telemetry to audit, analyze, and optimize model performance across all pipeline stages.

By combining the structural simplicity of folder-structured designs with the robust runtime capabilities of the Genkit SDK, developers can build resilient, production-ready AI applications that remain transparent and highly controllable.

## References

1. J. Van Clief and D. McDermott, "Interpretable Context Methodology: Folder Structure as Agent Architecture," *arXiv preprint arXiv:2603.16021v2 [cs.AI]*, 2026.
2. Firebase Genkit Team, "Genkit SDK Go Edition," *firebase/genkit/go*, 2025.
3. Firebase Genkit Team, "JavaScript/TypeScript Developer Guide," *genkit-ai/genkit*, 2025.
4. P. Jbanov, "Beyond the Prompt: Building Agentic Behaviors with Genkit Middleware," *Firebase Developers Blog*, 2025.
5. T. Wu, M. Terry, and C. J. Cai, "AI Chains: Transparent and Controllable Human-AI Interaction by Chaining Large Language Model Prompts," *Proceedings of CHI '22*, 2022.
6. J. S. Park et al., "Generative Agents: Interactive Simulacra of Human Behavior," *Proceedings of UIST '23*, 2023.
