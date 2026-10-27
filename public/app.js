// State management variables
let activeSessionId = null;
let activeInterrupt = null;
let currentTab = 'tab-research';
let currentRunId = null;
let runsHistory = [];
let lastRenderedResearchRaw = null;
let lastRenderedScriptRaw = null;
let lastRenderedRunsSignature = null;

// DOM Elements
const topicInput = document.getElementById('topic-input');
const clearTopicBtn = document.getElementById('clear-topic-btn');
const runPipelineBtn = document.getElementById('run-pipeline-btn');
const pipelineStatusText = document.getElementById('pipeline-status-text');
const researchThinkingSelect = document.getElementById('research-thinking-level');
const scriptThinkingSelect = document.getElementById('script-thinking-level');

const deploymentPrompt = document.getElementById('deployment-prompt');
const runInteractiveBtn = document.getElementById('run-interactive-btn');
const interactiveStatusText = document.getElementById('interactive-status-text');
const interactiveThinkingSelect = document.getElementById('interactive-thinking-level');

const researchEditor = document.getElementById('research-editor');
const scriptEditor = document.getElementById('script-editor');
const saveResearchBtn = document.getElementById('save-research-btn');
const saveScriptBtn = document.getElementById('save-script-btn');
const runStage2Btn = document.getElementById('run-stage2-btn');
const refreshFilesBtn = document.getElementById('refresh-files-btn');
const runsListEl = document.getElementById('runs-list');
const researchViewMode = document.getElementById('research-view-mode');
const researchPreview = document.getElementById('research-preview');
const activeRunMeta = document.getElementById('active-run-meta');
const activeRunTopicText = document.getElementById('active-run-topic-text');
const activeRunStatusPill = document.getElementById('active-run-status-pill');
const activeRunReuseBtn = document.getElementById('active-run-reuse-btn');
const bannerNewResearchBtn = document.getElementById('banner-new-research-btn');
const newResearchBtn = document.getElementById('new-research-btn');
const newResearchCard = document.getElementById('new-research-card');
const runsCountBadge = document.getElementById('runs-count-badge');
const deploymentTargetTitle = document.getElementById('deployment-target-title');
const visualizerContextBadge = document.getElementById('visualizer-context-badge');
const scriptViewMode = document.getElementById('script-view-mode');
const scriptPreview = document.getElementById('script-preview');

// Timeline Elements
const stepStage1 = document.getElementById('step-stage1');
const stepIntermission = document.getElementById('step-intermission');
const stepStage2 = document.getElementById('step-stage2');
const stepApproval = document.getElementById('step-approval');

// Tab buttons & Panels
const tabBtnResearch = document.getElementById('tab-btn-research');
const tabBtnScript = document.getElementById('tab-btn-script');
const tabBtnGate = document.getElementById('tab-btn-gate');
const tabPanelResearch = document.getElementById('tab-research');
const tabPanelScript = document.getElementById('tab-script');
const tabPanelGate = document.getElementById('tab-gate');

// Server status indicator elements
const serverStatusDot = document.getElementById('server-status-dot');
const serverStatusText = document.getElementById('server-status-text');
const serverWarningBanner = document.getElementById('server-warning-banner');
const serverWarningTitle = document.getElementById('server-warning-title');
const serverWarningDesc = document.getElementById('server-warning-desc');

// Approval Gate elements
const approvalSessionId = document.getElementById('approval-session-id');
const approvalReason = document.getElementById('approval-reason');
const approvalMessage = document.getElementById('approval-message');
const approvalDraftText = document.getElementById('approval-draft-text');
const approveBtn = document.getElementById('approve-deployment-btn');
const rejectBtn = document.getElementById('reject-deployment-btn');

// Base API URL
const API_BASE = '';

// Helper to show/hide elements
function show(el) { el.classList.remove('hide'); }
function hide(el) { el.classList.add('hide'); }

// Helper to set timeline step state
// state can be: 'idle', 'active', 'completed', 'awaiting'
function setStepState(stepElement, state) {
  stepElement.className = 'timeline-step';
  if (state !== 'idle') {
    stepElement.classList.add(state);
  }
  
  const statusEl = stepElement.querySelector('.step-status');
  if (statusEl) {
    statusEl.textContent = state === 'idle' ? 'Idle' : state;
  }
}

function updateTimelineConnectors() {
  const steps = [stepStage1, stepIntermission, stepStage2, stepApproval];
  const connectors = document.querySelectorAll('.timeline-connector');
  
  for (let i = 0; i < connectors.length; i++) {
    const prevStep = steps[i];
    const nextStep = steps[i+1];
    
    connectors[i].className = 'timeline-connector';
    if (prevStep.classList.contains('completed')) {
      if (nextStep.classList.contains('completed') || nextStep.classList.contains('active') || nextStep.classList.contains('awaiting')) {
        connectors[i].classList.add('completed');
      } else {
        connectors[i].classList.add('active');
      }
    }
  }
}

// Tab Switching logic
function switchTab(tabId) {
  currentTab = tabId;
  const tabs = [
    { btn: tabBtnResearch, panel: tabPanelResearch, id: 'tab-research' },
    { btn: tabBtnScript, panel: tabPanelScript, id: 'tab-script' },
    { btn: tabBtnGate, panel: tabPanelGate, id: 'tab-gate' }
  ];
  
  tabs.forEach(t => {
    if (t.id === tabId) {
      t.btn.classList.add('active');
      t.panel.classList.add('active');
    } else {
      t.btn.classList.remove('active');
      t.panel.classList.remove('active');
    }
  });
}

// Event Listeners for tabs
tabBtnResearch.addEventListener('click', () => switchTab('tab-research'));
tabBtnScript.addEventListener('click', () => switchTab('tab-script'));
tabBtnGate.addEventListener('click', () => switchTab('tab-gate'));

// Fetch runs history from backend
async function fetchRunsHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/runs`);
    const data = await res.json();
    if (data.success) {
      runsHistory = data.runs;
      renderRunsList();
      
      // Auto-select the first run if none selected
      if (!currentRunId && runsHistory.length > 0) {
        selectRun(runsHistory[0].runId);
      }
    }
  } catch (error) {
    console.error('Error fetching runs history:', error);
    runsListEl.innerHTML = '<div class="runs-error"><i class="fa-solid fa-circle-exclamation"></i> Error loading runs</div>';
  }
}

// Render Runs items in the sidebar (diffed to avoid unnecessary DOM teardown/flicker)
function renderRunsList() {
  if (runsCountBadge) {
    runsCountBadge.textContent = runsHistory.length.toString();
  }

  if (runsHistory.length === 0) {
    if (lastRenderedRunsSignature !== '__EMPTY__') {
      lastRenderedRunsSignature = '__EMPTY__';
      runsListEl.innerHTML = '<div class="runs-empty">No runs executed yet</div>';
    }
    return;
  }

  const signature = runsHistory.map(r => `${r.runId}:${r.topic}:${r.createdAt}`).join('|');
  if (signature === lastRenderedRunsSignature) {
    // Only update active selection class without rebuilding DOM nodes
    const items = runsListEl.querySelectorAll('.run-item');
    items.forEach(item => {
      if (item.id === `run-item-${currentRunId}`) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
    return;
  }

  lastRenderedRunsSignature = signature;
  runsListEl.innerHTML = runsHistory
    .map(run => {
      const isActive = run.runId === currentRunId ? 'active' : '';
      const formattedDate = new Date(run.createdAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      return `
        <div class="run-item ${isActive}" onclick="selectRun('${run.runId}')" id="run-item-${run.runId}">
          <div class="run-info">
            <div class="run-topic" title="${escapeHtml(run.topic)}">${escapeHtml(run.topic)}</div>
            <div class="run-date">${formattedDate}</div>
          </div>
          <div class="run-actions">
            <button class="run-action-btn reuse-prompt-btn" onclick="reusePrompt('${escapeHtml(run.topic).replace(/'/g, "\\'")}', event)" title="Load topic into input box for a new run">
              <i class="fa-solid fa-copy"></i>
            </button>
            <button class="run-action-btn open-folder-btn" onclick="openRunFolder('${run.runId}', event)" title="Open folder in File Explorer">
              <i class="fa-solid fa-folder-open"></i>
            </button>
            <button class="run-action-btn delete-run-btn" onclick="deleteRun('${run.runId}', event)" title="Delete run">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

// Reset dashboard to "New Research" mode (deselecting any past run)
function startNewResearchMode(focusInput = true) {
  currentRunId = null;
  renderRunsList();

  if (visualizerContextBadge) {
    visualizerContextBadge.className = 'visualizer-badge';
    visualizerContextBadge.textContent = 'Ready for New Research';
  }

  hide(pipelineStatusText);
  syncFiles();

  if (focusInput && topicInput) {
    topicInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    topicInput.focus();
    topicInput.select();

    if (newResearchCard) {
      newResearchCard.classList.add('highlight-focus');
      setTimeout(() => {
        newResearchCard.classList.remove('highlight-focus');
      }, 1200);
    }
  }
}

if (newResearchBtn) {
  newResearchBtn.addEventListener('click', () => startNewResearchMode(true));
}
if (bannerNewResearchBtn) {
  bannerNewResearchBtn.addEventListener('click', () => startNewResearchMode(true));
}

// Allow pressing Enter inside topic input to start research
if (topicInput) {
  topicInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !runPipelineBtn.disabled) {
      e.preventDefault();
      runPipelineBtn.click();
    }
  });
}

// Select a specific run
function selectRun(runId) {
  currentRunId = runId;
  renderRunsList();
  syncFiles();
}

function reusePrompt(topicText, event) {
  if (event) event.stopPropagation();
  if (topicInput) {
    topicInput.value = topicText;
    topicInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    topicInput.focus();
    
    // Visual feedback pulse
    topicInput.style.transition = 'all 0.15s ease-in-out';
    topicInput.style.boxShadow = '0 0 15px var(--accent-color)';
    topicInput.style.borderColor = 'var(--accent-color)';
    setTimeout(() => {
      topicInput.style.boxShadow = '';
      topicInput.style.borderColor = '';
    }, 450);
  }
}
window.reusePrompt = reusePrompt;

async function openRunFolder(runId, event) {
  if (event) event.stopPropagation();
  try {
    const res = await fetch(`${API_BASE}/api/run/${runId}/open`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!data.success) {
      alert(`Error opening folder: ${data.error}`);
    }
  } catch (error) {
    alert(`Failed to open folder: ${error.message}`);
  }
}

async function deleteRun(runId, event) {
  if (event) event.stopPropagation();
  if (!confirm(`Are you sure you want to delete this run? This will permanently delete all its files.`)) {
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/run/${runId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      await fetchRunsHistory();
      if (currentRunId === runId) {
        currentRunId = null;
        if (runsHistory.length > 0) {
          selectRun(runsHistory[0].runId);
        } else {
          startNewResearchMode(false);
        }
      }
    } else {
      alert(`Error deleting run: ${data.error}`);
    }
  } catch (error) {
    alert(`Failed to delete run: ${error.message}`);
  }
}

// Expose handlers to global scope for inline onclick
window.selectRun = selectRun;
window.openRunFolder = openRunFolder;
window.deleteRun = deleteRun;

function escapeHtml(text) {
  return text
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function makeLinksOpenInNewTab(container) {
  if (!container) return;
  container.querySelectorAll('a').forEach(link => {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  });
}

// Next.js/React-style child-level DOM reconciliation to prevent full-container repaint flicker during live streaming
function reconcilePreviewHtml(container, html) {
  if (!container) return;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  makeLinksOpenInNewTab(tpl.content);

  const nextNodes = Array.from(tpl.content.childNodes);
  const currNodes = Array.from(container.childNodes);

  for (let i = 0; i < nextNodes.length; i++) {
    const next = nextNodes[i];
    const curr = currNodes[i];
    if (!curr) {
      container.appendChild(next);
    } else if (!curr.isEqualNode(next)) {
      if (curr.nodeType === Node.ELEMENT_NODE && next.nodeType === Node.ELEMENT_NODE && curr.tagName === next.tagName) {
        if (curr.innerHTML !== next.innerHTML) {
          curr.innerHTML = next.innerHTML;
        }
        if (curr.className !== next.className) {
          curr.className = next.className;
        }
      } else {
        container.replaceChild(next, curr);
      }
    }
  }

  while (container.childNodes.length > nextNodes.length) {
    container.removeChild(container.lastChild);
  }
}

// Update Markdown preview element using marked.js (diffed to prevent flicker)
function updateResearchPreview() {
  if (!researchPreview || !researchEditor) return;
  const raw = (researchEditor.value || '').trim();
  if (raw === lastRenderedResearchRaw) return;
  lastRenderedResearchRaw = raw;

  if (!raw) {
    reconcilePreviewHtml(
      researchPreview,
      `
      <div class="empty-preview-state">
        <i class="fa-solid fa-magnifying-glass-chart"></i>
        <h4>Ready for New Research</h4>
        <p>Enter a topic in the <strong>Start New Research</strong> card above and click <strong>Start New Research &amp; Script</strong> (or select a past run from the left sidebar).</p>
      </div>
    `
    );
    return;
  }
  const html = typeof marked !== 'undefined' ? marked.parse(raw) : escapeHtml(raw);
  reconcilePreviewHtml(researchPreview, html);
}

// Listen for view mode selector change
if (researchViewMode) {
  researchViewMode.addEventListener('change', () => {
    if (researchViewMode.value === 'preview') {
      updateResearchPreview();
      researchEditor.style.display = 'none';
      researchPreview.style.display = 'block';
      if (saveResearchBtn) saveResearchBtn.style.display = 'none';
    } else {
      researchEditor.style.display = 'block';
      researchPreview.style.display = 'none';
      if (saveResearchBtn) saveResearchBtn.style.display = 'inline-block';
    }
  });
}

// Update Script preview element and deployment target indicator (diffed to prevent flicker)
function updateScriptPreview() {
  if (!scriptPreview || !scriptEditor) return;
  const raw = (scriptEditor.value || '').trim();
  if (raw === lastRenderedScriptRaw) return;
  lastRenderedScriptRaw = raw;

  if (!raw) {
    if (deploymentTargetTitle) deploymentTargetTitle.textContent = 'None loaded';
    reconcilePreviewHtml(
      scriptPreview,
      `
      <div class="empty-preview-state">
        <i class="fa-solid fa-feather-pointed"></i>
        <h4>No Script Draft Loaded</h4>
        <p>Once Stage 1 Research finishes, the Stage 2 Scriptwriter will automatically generate a structured script draft here.</p>
      </div>
    `
    );
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    if (deploymentTargetTitle) {
      deploymentTargetTitle.textContent = parsed.title || 'Untitled Script';
    }
    const title = parsed.title ? `<h1>${escapeHtml(parsed.title)}</h1>` : '';
    const body = parsed.scriptBody ? marked.parse(parsed.scriptBody) : '';
    reconcilePreviewHtml(scriptPreview, title + body);
  } catch (e) {
    if (deploymentTargetTitle) deploymentTargetTitle.textContent = 'Pending Stage 2...';
    reconcilePreviewHtml(
      scriptPreview,
      `<div class="status-msg info" style="margin: 20px;"><i class="fa-solid fa-circle-info"></i> ${escapeHtml(raw)}</div>`
    );
  }
}

// Listen for script view mode selector change
if (scriptViewMode) {
  scriptViewMode.addEventListener('change', () => {
    if (scriptViewMode.value === 'preview') {
      updateScriptPreview();
      scriptEditor.style.display = 'none';
      scriptPreview.style.display = 'block';
      if (saveScriptBtn) saveScriptBtn.style.display = 'none';
    } else {
      scriptEditor.style.display = 'block';
      scriptPreview.style.display = 'none';
      if (saveScriptBtn) saveScriptBtn.style.display = 'inline-block';
    }
  });
}

function updateStage2ButtonState(enabled, labelHtml) {
  if (!runStage2Btn) return;
  runStage2Btn.disabled = !enabled;
  runStage2Btn.style.opacity = enabled ? '1' : '0.55';
  runStage2Btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
  const nextHtml = labelHtml || '<i class="fa-solid fa-feather-pointed"></i> Regenerate Script (Stage 2)';
  if (runStage2Btn.innerHTML !== nextHtml) {
    runStage2Btn.innerHTML = nextHtml;
  }
}

// Apply stage files payload to DOM (shared between SSR initial hydration and async syncFiles)
function applyStageFilesData(data) {
  if (!data) return;
  const isRunning = data.meta && data.meta.status === 'running';

  // Update Active Run prompt metadata header
  if (data.meta && data.meta.topic) {
    if (activeRunMeta) activeRunMeta.style.display = 'flex';
    if (activeRunTopicText) activeRunTopicText.textContent = data.meta.topic;
    if (activeRunStatusPill) {
      activeRunStatusPill.textContent = isRunning ? 'Running Now' : 'Viewing Saved Run';
    }
    if (visualizerContextBadge) {
      visualizerContextBadge.className = isRunning ? 'visualizer-badge running' : 'visualizer-badge completed';
      visualizerContextBadge.textContent = `${isRunning ? 'Running' : 'Viewing'}: ${data.meta.topic}`;
    }
    if (activeRunReuseBtn) {
      activeRunReuseBtn.onclick = (e) => {
        reusePrompt(data.meta.topic, e);
      };
    }
  } else {
    if (activeRunMeta) activeRunMeta.style.display = 'none';
  }

  if (data.researchExists) {
    researchEditor.value = data.research;
    updateResearchPreview();
    setStepState(stepStage1, 'completed');
    if (isRunning && !data.scriptExists) {
      updateStage2ButtonState(false, '<i class="fa-solid fa-spinner fa-spin"></i> Stage 2 Running Automatically...');
    } else {
      updateStage2ButtonState(true, '<i class="fa-solid fa-feather-pointed"></i> Regenerate Script (Stage 2)');
    }
  } else if (data.researchStream) {
    researchEditor.value = data.researchStream;
    updateResearchPreview();
    setStepState(stepStage1, 'active');
    updateStage2ButtonState(false, '<i class="fa-solid fa-hourglass-half"></i> Waiting for Stage 1...');
  } else {
    researchEditor.value = '';
    updateResearchPreview();
    setStepState(stepStage1, isRunning ? 'active' : 'idle');
    updateStage2ButtonState(
      false,
      isRunning
        ? '<i class="fa-solid fa-hourglass-half"></i> Waiting for Stage 1...'
        : '<i class="fa-solid fa-feather-pointed"></i> Regenerate Script (Stage 2)'
    );
  }

  if (data.scriptExists) {
    scriptEditor.value = data.script;
    updateScriptPreview();
    setStepState(stepStage2, 'completed');
    if (data.researchExists) {
      setStepState(stepIntermission, 'completed');
    }
  } else {
    scriptEditor.value = isRunning
      ? data.researchExists
        ? 'Stage 2 Scriptwriter is currently generating your structured script from Stage 1 research...'
        : 'Stage 1 Research is still in progress. Stage 2 Scriptwriting will start automatically as soon as Stage 1 finishes.'
      : '';
    updateScriptPreview();
    setStepState(stepStage2, isRunning && data.researchExists ? 'active' : 'idle');
    if (data.researchExists) {
      setStepState(stepIntermission, isRunning ? 'completed' : 'active');
    } else {
      setStepState(stepIntermission, 'idle');
    }
  }
  setStepState(stepApproval, 'idle');
  updateTimelineConnectors();
}

// Sync files from backend disk for the current active runId
async function syncFiles() {
  if (!currentRunId) {
    researchEditor.value = '';
    updateResearchPreview();
    scriptEditor.value = '';
    updateScriptPreview();
    updateStage2ButtonState(false, '<i class="fa-solid fa-feather-pointed"></i> Regenerate Script (Stage 2)');
    if (activeRunMeta) activeRunMeta.style.display = 'none';
    setStepState(stepStage1, 'idle');
    setStepState(stepIntermission, 'idle');
    setStepState(stepStage2, 'idle');
    setStepState(stepApproval, 'idle');
    updateTimelineConnectors();
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/stages/files?runId=${currentRunId}`);
    const data = await res.json();
    applyStageFilesData(data);
  } catch (error) {
    console.error('Error syncing workspace files:', error);
  }
}

refreshFilesBtn.addEventListener('click', syncFiles);

// Save Stage 1 Research summary back to disk for current runId
saveResearchBtn.addEventListener('click', async () => {
  if (!currentRunId) return;

  try {
    saveResearchBtn.disabled = true;
    saveResearchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    
    const res = await fetch(`${API_BASE}/api/stages/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'research',
        content: researchEditor.value,
        runId: currentRunId
      })
    });
    
    const data = await res.json();
    if (data.success) {
      updateResearchPreview();
      setStepState(stepIntermission, 'completed');
      updateTimelineConnectors();
      alert('Research summary saved to disk successfully!');
    } else {
      alert(`Error saving file: ${data.error}`);
    }
  } catch (error) {
    alert(`Request failed: ${error.message}`);
  } finally {
    saveResearchBtn.disabled = false;
    saveResearchBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save to Disk';
  }
});

// Save Stage 2 Script back to disk for current runId
saveScriptBtn.addEventListener('click', async () => {
  if (!currentRunId) return;

  try {
    saveScriptBtn.disabled = true;
    saveScriptBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    
    const res = await fetch(`${API_BASE}/api/stages/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'script',
        content: scriptEditor.value,
        runId: currentRunId
      })
    });
    
    const data = await res.json();
    if (data.success) {
      updateScriptPreview();
      alert('Script draft saved to disk successfully!');
    } else {
      alert(`Error saving file: ${data.error}`);
    }
  } catch (error) {
    alert(`Request failed: ${error.message}`);
  } finally {
    saveScriptBtn.disabled = false;
    saveScriptBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Edits';
  }
});

// Standalone Stage 2 Scriptwriting execution
runStage2Btn.addEventListener('click', async () => {
  if (!currentRunId) {
    alert('Please select a run first');
    return;
  }

  try {
    updateStage2ButtonState(false, '<i class="fa-solid fa-spinner fa-spin"></i> Generating...');
    
    // Set timeline step active for Stage 2
    setStepState(stepStage2, 'active');
    updateTimelineConnectors();

    const thinkingLevel = scriptThinkingSelect ? scriptThinkingSelect.value : 'MEDIUM';
    const res = await fetch(`${API_BASE}/api/run-stage2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: currentRunId, thinkingLevel })
    });
    
    const data = await res.json();
    if (data.success) {
      // Sync the editors to load the newly generated script
      await syncFiles();
      // Switch tab to Stage 2 script to review
      switchTab('tab-script');
      alert('Script draft successfully regenerated using your updated research summary!');
    } else {
      setStepState(stepStage2, 'idle');
      updateTimelineConnectors();
      alert(`Error running Stage 2: ${data.error}`);
    }
  } catch (error) {
    setStepState(stepStage2, 'idle');
    updateTimelineConnectors();
    alert(`Request failed: ${error.message}`);
  } finally {
    updateStage2ButtonState(true);
  }
});

// Clear topic input field
clearTopicBtn.addEventListener('click', () => {
  topicInput.value = '';
  topicInput.focus();
});

let pipelinePollInterval = null;

function resetRunPipelineButton() {
  if (!runPipelineBtn) return;
  runPipelineBtn.disabled = false;
  runPipelineBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass-chart"></i> Start New Research &amp; Script';
}

function formatElapsed(seconds) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function startPipelinePolling(runId, topic) {
  if (pipelinePollInterval) clearInterval(pipelinePollInterval);
  
  let stage1Finished = false;
  let attempts = 0;
  const maxAttempts = 600; // 10 minutes timeout for Gemini 4 Argon HIGH thinking + grounding

  // Immediately make the first poll to ensure states sync fast
  poll();

  pipelinePollInterval = setInterval(poll, 1000);

  async function poll() {
    attempts++;
    const elapsedStr = formatElapsed(attempts);

    if (attempts > maxAttempts) {
      clearInterval(pipelinePollInterval);
      resetRunPipelineButton();
      pipelineStatusText.className = 'status-msg error';
      pipelineStatusText.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Pipeline execution timed out.';
      return;
    }

    if (!stage1Finished) {
      pipelineStatusText.innerHTML = `<i class="fa-solid fa-magnifying-glass fa-pulse"></i> Stage 1: Gemini 4 Argon researching &amp; verifying sources... <strong>(${elapsedStr})</strong>`;
      if (visualizerContextBadge) {
        visualizerContextBadge.className = 'visualizer-badge running';
        visualizerContextBadge.textContent = `Stage 1 Researching (${elapsedStr}): ${topic}`;
      }
    } else {
      pipelineStatusText.innerHTML = `<i class="fa-solid fa-feather-pointed fa-pulse"></i> Stage 2: Gemini 4 Argon writing structured script... <strong>(${elapsedStr})</strong>`;
      if (visualizerContextBadge) {
        visualizerContextBadge.className = 'visualizer-badge running';
        visualizerContextBadge.textContent = `Stage 2 Writing Script (${elapsedStr}): ${topic}`;
      }
    }

    try {
      const res = await fetch(`${API_BASE}/api/stages/files?runId=${runId}`);
      const data = await res.json();

      // Check if backend reported failure
      if (data.meta && data.meta.status === 'failed') {
        clearInterval(pipelinePollInterval);
        
        setStepState(stepStage1, 'idle');
        setStepState(stepStage2, 'idle');
        updateTimelineConnectors();
        updateStage2ButtonState(false);

        resetRunPipelineButton();
        pipelineStatusText.className = 'status-msg error';
        pipelineStatusText.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Execution failed: ${data.meta.error || 'Flow execution error'}`;
        if (visualizerContextBadge) {
          visualizerContextBadge.className = 'visualizer-badge';
          visualizerContextBadge.textContent = 'Execution Failed';
        }
        return;
      }

      // Live stream preview while Stage 1 is still running
      if (!data.researchExists && !stage1Finished && data.researchStream) {
        researchEditor.value = data.researchStream;
        updateResearchPreview();
        updateStage2ButtonState(false, '<i class="fa-solid fa-hourglass-half"></i> Waiting for Stage 1...');
      }

      // If Stage 1 (research) completes, load it and update button to Stage 2
      if (data.researchExists && !stage1Finished) {
        stage1Finished = true;
        researchEditor.value = data.research;
        updateResearchPreview();
        scriptEditor.value = 'Stage 1 complete! Gemini 4 Argon is now writing your structured script in Stage 2...';
        updateScriptPreview();
        updateStage2ButtonState(false, '<i class="fa-solid fa-spinner fa-spin"></i> Stage 2 Running Automatically...');
        
        setStepState(stepStage1, 'completed');
        setStepState(stepIntermission, 'completed');
        setStepState(stepStage2, 'active');
        updateTimelineConnectors();
        
        runPipelineBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Executing Stage 2...';
        pipelineStatusText.innerHTML = `<i class="fa-solid fa-feather-pointed fa-pulse"></i> Stage 2: Gemini 4 Argon writing structured script... <strong>(${elapsedStr})</strong>`;
      }

      // If Stage 2 (script) completes, or backend reports completed, we finish!
      if (data.scriptExists && data.meta && data.meta.status === 'completed') {
        clearInterval(pipelinePollInterval);
        
        currentRunId = runId;
        applyStageFilesData(data);
        await fetchRunsHistory();

        resetRunPipelineButton();
        
        pipelineStatusText.className = 'status-msg success';
        pipelineStatusText.innerHTML = `<i class="fa-solid fa-circle-check"></i> Completed in ${elapsedStr}! Review your Research &amp; Script below.`;
        
        // Switch to script output tab to view results
        switchTab('tab-script');
      }
    } catch (error) {
      console.error('Error polling pipeline status:', error);
    }
  }
}

// Run full pipeline
runPipelineBtn.addEventListener('click', async () => {
  const topic = topicInput.value.trim();
  if (!topic) {
    topicInput.focus();
    alert('Please enter a research topic first.');
    return;
  }
  
  try {
    // Deselect active run in history and clear editors to prevent confusion
    currentRunId = null;
    renderRunsList();
    
    researchEditor.value = '### Stage 1 in progress...\n\nGemini 4 Argon is searching Google, verifying sources, and synthesizing your research summary.';
    updateResearchPreview();
    scriptEditor.value = 'Stage 1 Research is currently in progress. Stage 2 Scriptwriting will start automatically as soon as Stage 1 finishes.';
    updateScriptPreview();
    updateStage2ButtonState(false, '<i class="fa-solid fa-hourglass-half"></i> Waiting for Stage 1...');
    
    if (activeRunMeta) activeRunMeta.style.display = 'flex';
    if (activeRunStatusPill) activeRunStatusPill.textContent = 'Running Now';
    if (activeRunTopicText) activeRunTopicText.textContent = topic;
    if (visualizerContextBadge) {
      visualizerContextBadge.className = 'visualizer-badge running';
      visualizerContextBadge.textContent = `Stage 1 Researching (00:00): ${topic}`;
    }

    // UI Loading state
    runPipelineBtn.disabled = true;
    runPipelineBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Executing Stage 1...';
    show(pipelineStatusText);
    pipelineStatusText.className = 'status-msg info';
    pipelineStatusText.innerHTML = '<i class="fa-solid fa-magnifying-glass fa-pulse"></i> Stage 1: Gemini 4 Argon researching &amp; verifying sources... <strong>(00:00)</strong>';
    
    setStepState(stepStage1, 'active');
    setStepState(stepIntermission, 'idle');
    setStepState(stepStage2, 'idle');
    setStepState(stepApproval, 'idle');
    updateTimelineConnectors();
    
    // Switch to research tab to see output generate
    switchTab('tab-research');
    
    const researchThinkingLevel = researchThinkingSelect ? researchThinkingSelect.value : 'HIGH';
    const scriptThinkingLevel = scriptThinkingSelect ? scriptThinkingSelect.value : 'MEDIUM';

    const res = await fetch(`${API_BASE}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, researchThinkingLevel, scriptThinkingLevel })
    });
    
    const data = await res.json();
    
    if (data.success) {
      // Set run ID and start polling
      currentRunId = data.runId;
      await fetchRunsHistory();
      startPipelinePolling(data.runId, topic);
    } else {
      setStepState(stepStage1, 'idle');
      updateTimelineConnectors();
      resetRunPipelineButton();
      pipelineStatusText.className = 'status-msg error';
      pipelineStatusText.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Error: ${data.error}`;
    }
  } catch (error) {
    setStepState(stepStage1, 'idle');
    updateTimelineConnectors();
    resetRunPipelineButton();
    pipelineStatusText.className = 'status-msg error';
    pipelineStatusText.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Execution failed: ${error.message}`;
  }
});

// Run interactive deployment
runInteractiveBtn.addEventListener('click', async () => {
  const promptText = deploymentPrompt.value.trim();
  let enrichedPromptText = promptText;
  
  // Enrich prompt with script editor details if available
  if (scriptEditor && scriptEditor.value) {
    try {
      const scriptObj = JSON.parse(scriptEditor.value);
      if (scriptObj && (scriptObj.title || scriptObj.scriptBody)) {
        const title = scriptObj.title || "untitled-run";
        const body = scriptObj.scriptBody || "";
        
        if (promptText === 'Deploy script draft to media systems') {
          enrichedPromptText = `Deploy the script with ID "${title}" and approved text: "${body}" using the deployScriptDraftTool tool.`;
        } else {
          enrichedPromptText = `${promptText}\n\n[Script Context for Deployment]\nScript ID: ${title}\nApproved Text: ${body}`;
        }
      }
    } catch (e) {
      console.warn("Could not parse script editor JSON for prompt enrichment:", e);
    }
  }
  
  try {
    runInteractiveBtn.disabled = true;
    runInteractiveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Triggering Deployment...';
    show(interactiveStatusText);
    interactiveStatusText.className = 'status-msg info';
    interactiveStatusText.innerHTML = '<i class="fa-solid fa-gears fa-pulse"></i> Initiating stateful interactive deployment process...';
    
    setStepState(stepApproval, 'active');
    updateTimelineConnectors();
    
    const thinkingLevel = interactiveThinkingSelect ? interactiveThinkingSelect.value : 'LOW';
    const res = await fetch(`${API_BASE}/api/run-interactive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptText: enrichedPromptText, thinkingLevel })
    });
    
    const data = await res.json();
    
    if (data.status === 'AWAITING_APPROVAL') {
      activeSessionId = data.sessionId;
      activeInterrupt = data.interrupt;
      
      // Update visualizer
      setStepState(stepApproval, 'awaiting');
      updateTimelineConnectors();
      
      interactiveStatusText.className = 'status-msg info';
      interactiveStatusText.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Action suspended. Approval required in the <strong>Gated Approval Terminal</strong> tab below.';
      
      // Populate approval panel
      approvalSessionId.textContent = activeSessionId;
      approvalReason.textContent = activeInterrupt.reason || 'N/A';
      approvalMessage.textContent = activeInterrupt.message || 'N/A';
      approvalDraftText.textContent = activeInterrupt.toolRequest.input.approvedText || '';
      
      // Show tab and switch to it
      show(tabBtnGate);
      switchTab('tab-gate');
    } else if (data.status === 'COMPLETED') {
      setStepState(stepApproval, 'completed');
      updateTimelineConnectors();
      interactiveStatusText.className = 'status-msg success';
      interactiveStatusText.innerHTML = `<i class="fa-solid fa-circle-check"></i> Completed immediately: ${data.text}`;
    } else {
      setStepState(stepApproval, 'idle');
      updateTimelineConnectors();
      interactiveStatusText.className = 'status-msg error';
      interactiveStatusText.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Error: Unhandled status ${data.status}`;
    }
  } catch (error) {
    interactiveStatusText.className = 'status-msg error';
    interactiveStatusText.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Trigger failed: ${error.message}`;
  } finally {
    runInteractiveBtn.disabled = false;
    runInteractiveBtn.innerHTML = '<i class="fa-solid fa-terminal"></i> Start Interactive Run';
  }
});

// Resume flow handler
async function handleResume(approved) {
  if (!activeSessionId || !activeInterrupt) {
    alert('No active interrupt to resume');
    return;
  }
  
  try {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    
    const thinkingLevel = interactiveThinkingSelect ? interactiveThinkingSelect.value : 'LOW';
    const res = await fetch(`${API_BASE}/api/session/${activeSessionId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interrupt: activeInterrupt,
        approved: approved,
        thinkingLevel: thinkingLevel
      })
    });
    
    const data = await res.json();
    
    if (approved) {
      setStepState(stepApproval, 'completed');
      alert(`Success: ${data.text}`);
    } else {
      setStepState(stepApproval, 'idle');
      alert(`Rejected: ${data.text}`);
    }
    updateTimelineConnectors();
    
    // Clear state
    activeSessionId = null;
    activeInterrupt = null;
    hide(tabBtnGate);
    switchTab('tab-script');
    
    // Clear status texts
    hide(interactiveStatusText);
  } catch (error) {
    alert(`Resume failed: ${error.message}`);
  } finally {
    approveBtn.disabled = false;
    rejectBtn.disabled = false;
  }
}

approveBtn.addEventListener('click', () => handleResume(true));
rejectBtn.addEventListener('click', () => handleResume(false));

let isServerOnline = true;
let serverOfflineSeconds = 0;

async function checkServerHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    if (res.ok) {
      if (!isServerOnline) {
        // We just reconnected!
        isServerOnline = true;
        serverOfflineSeconds = 0;
        
        if (serverStatusDot) {
          serverStatusDot.className = 'dot green-glow';
        }
        if (serverStatusText) {
          serverStatusText.textContent = 'Server Connected';
        }
        if (serverWarningBanner) {
          serverWarningBanner.style.display = 'none';
        }
        
        // Reload runs and workspace files in case they were updated
        await fetchRunsHistory();
        if (currentRunId) {
          await syncFiles();
        }
        console.log('Dashboard reconnected to the server.');
      }
    } else {
      handleServerOffline();
    }
  } catch (error) {
    handleServerOffline();
  }
}

function handleServerOffline() {
  serverOfflineSeconds += 2;
  isServerOnline = false;
  
  // Only show the top banner after 2 consecutive failed checks (4s) to avoid flashing on fast tsx --watch reloads
  if (serverWarningBanner && serverOfflineSeconds >= 4) {
    serverWarningBanner.style.display = 'flex';
  }
  
  if (serverOfflineSeconds > 15) {
    if (serverStatusDot) {
      serverStatusDot.className = 'dot red-glow';
    }
    if (serverStatusText) {
      serverStatusText.textContent = 'Server Offline';
    }
    if (serverWarningTitle) {
      serverWarningTitle.textContent = 'Server Offline';
    }
    if (serverWarningDesc) {
      serverWarningDesc.textContent = 'The local server appears to be completely offline. Please check if your terminal process has stopped and restart it if necessary.';
    }
  } else {
    if (serverStatusDot) {
      serverStatusDot.className = 'dot amber-glow';
    }
    if (serverStatusText) {
      serverStatusText.textContent = 'Server Restarting...';
    }
    if (serverWarningTitle) {
      serverWarningTitle.textContent = 'Server Reconnecting / Restarting...';
    }
    if (serverWarningDesc) {
      serverWarningDesc.textContent = 'The local server is currently restarting (usually triggered by a code update, prompt modification, or Genkit schema recompiling). This dashboard will automatically reconnect once it is back online.';
    }
  }
}

// Initialize page (hydrating synchronously from Express SSR window.__INITIAL_STATE__ when available)
document.addEventListener('DOMContentLoaded', () => {
  if (researchViewMode && researchViewMode.value === 'preview' && saveResearchBtn) {
    saveResearchBtn.style.display = 'none';
  }
  if (scriptViewMode && scriptViewMode.value === 'preview' && saveScriptBtn) {
    saveScriptBtn.style.display = 'none';
  }

  if (window.__INITIAL_STATE__ && Array.isArray(window.__INITIAL_STATE__.runs)) {
    runsHistory = window.__INITIAL_STATE__.runs;
    currentRunId = window.__INITIAL_STATE__.initialRunId || null;
    renderRunsList();
    if (currentRunId && window.__INITIAL_STATE__.initialFiles) {
      applyStageFilesData(window.__INITIAL_STATE__.initialFiles);
    } else {
      updateResearchPreview();
      updateScriptPreview();
    }
  } else {
    updateResearchPreview();
    updateScriptPreview();
    fetchRunsHistory();
  }

  // Start health checking every 2 seconds
  setInterval(checkServerHealth, 2000);
});
