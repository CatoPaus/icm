import { genkit } from 'genkit/beta';
import { z } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';
import { filesystem, skills, retry, fallback } from '@genkit-ai/middleware';
import * as fs from 'fs';
import * as path from 'path';
import { SessionStore, SessionData } from 'genkit/beta';

// 1. Initialize Genkit and specify the dynamic prompt directory
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
          models: [googleAI.model('gemini-2.5-pro')],
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

async function handleInteractiveDeployment(sessionId: string, promptText: string) {
  const store = new LocalDiskSessionStore();
  
  // Load session or initialize a new stateful turn 
  const session = await ai.loadSession(sessionId, { store });
  
  let response = await ai.generate({
    model: googleAI.model('gemini-2.5-flash'),
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
    model: googleAI.model('gemini-2.5-flash'),
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
