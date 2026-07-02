// background.js (Service Worker)

// Import SheetJS global setup
import './excel/xlsx.full.min.js';

// Import our modular components
import { readExcel } from './excel/reader.js';
import { QueueManager } from './utils/QueueManager.js';
import { ExportManager } from './utils/Export.js';
import { log, error, warn } from './utils/logger.js';
import { saveCheckpoint, getCheckpoint, clearAll } from './utils/storage.js';

// Import state machine
import './utils/StateMachine.js';

const { States, StateMachine } = globalThis.StateMachineLib;

// State Controller instances
const bgMachine = new StateMachine("BackgroundController", (oldState, newState, meta) => {
  log(`State transition: ${oldState} ➔ ${newState}`);
  broadcastProgress();
});

let isRunning = false;
const queueManager = new QueueManager();
const exportManager = new ExportManager();

// Global configuration loaded dynamically from .env
let APIFY_TOKEN = "";
const APIFY_ACTOR_KEY = "x_guru~linkedin-email-Scraper-no-cookies";

async function initApifyConfig() {
  try {
    const url = chrome.runtime.getURL('.env');
    const resp = await fetch(url);
    const text = await resp.text();
    const tokenMatch = text.match(/token=([a-zA-Z0-9_]+)/i);
    if (tokenMatch) {
      APIFY_TOKEN = tokenMatch[1];
      log(`Apify token successfully loaded from .env: ${APIFY_TOKEN.substring(0, 8)}...`);
    } else {
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.toLowerCase().includes("token=")) {
          const m = line.match(/token=([a-zA-Z0-9_]+)/i);
          if (m) {
            APIFY_TOKEN = m[1];
            break;
          }
        }
      }
    }
  } catch (e) {
    warn("Failed to load .env file, using default fallback token.");
  }
}

// Initialize state from storage on startup (crash recovery)
(async () => {
  try {
    const checkpoint = await getCheckpoint();
    if (checkpoint) {
      queueManager.restore(checkpoint.queue);
      isRunning = checkpoint.isRunning;
      await exportManager.load();
      
      log(`Restored session state: ${queueManager.getDone().length + queueManager.getFailed().length}/${queueManager.size()} processed.`);
      
      if (isRunning) {
        isRunning = false; 
        runStaticQueueLoop();
      }
    }
  } catch (err) {
    error("Failed to initialize background state", err);
  }
})();

// Message listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === "start") {
    const { rows } = msg;
    log(`Starting new scraping session with ${rows.length} rows.`);
    
    clearAll().then(() => {
      queueManager.initialize(rows);
      exportManager.clear();
      saveState().then(() => {
        runStaticQueueLoop();
      });
    });
    sendResponse({ success: true });
    return true;
  } 
  
  else if (msg.cmd === "pause") {
    log("Pausing execution...");
    isRunning = false;
    saveState().then(() => {
      bgMachine.transition(States.IDLE);
      sendResponse({ success: true });
    });
    return true;
  } 
  
  else if (msg.cmd === "resume") {
    log("Resuming execution...");
    if (!isRunning && queueManager.size() > 0) {
      runStaticQueueLoop();
    }
    sendResponse({ success: true });
    return true;
  } 
  
  else if (msg.cmd === "stop") {
    log("Stopping execution and clearing progress.");
    isRunning = false;
    clearAll().then(() => {
      queueManager.clear();
      exportManager.clear();
      bgMachine.transition(States.IDLE);
      sendResponse({ success: true });
    });
    return true;
  }
  
  else if (msg.cmd === "getStatus") {
    const currentIndex = queueManager.getDone().length + queueManager.getFailed().length;
    sendResponse({
      isRunning: isRunning,
      currentIndex,
      totalJobs: queueManager.size(),
      resultsCount: exportManager.results.length,
      queueSize: queueManager.getPending().length,
      currentState: bgMachine.getState()
    });
  }
  
  else if (msg.cmd === "triggerDownload") {
    log("Manual download of results requested.");
    exportManager.getExcelDataUrl().then((dataUrl) => {
      sendResponse({ success: true, dataUrl: dataUrl, filename: "linkedin_emails_scraped.xlsx" });
    }).catch((e) => {
      sendResponse({ success: false, error: e.message || String(e) });
    });
    return true;
  }
  
  else if (msg.cmd === "loadSheetUrl") {
    const { url } = msg;
    log(`Requested to load Google Sheet URL: ${url}`);
    
    const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) {
      sendResponse({ success: false, error: "Invalid Google Sheets link format." });
      return;
    }
    
    const spreadsheetId = match[1];
    const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx`;
    
    log("Attempting to fetch Google Sheet workbook...");
    
    (async () => {
      let arrayBuffer;
      try {
        // Try direct fetch first
        const response = await fetch(exportUrl, { credentials: 'include' });
        if (response.ok) {
          arrayBuffer = await response.arrayBuffer();
        } else {
          throw new Error(`Direct fetch failed (HTTP ${response.status})`);
        }
      } catch (directErr) {
        log(`Direct fetch failed: ${directErr.message}. Attempting to fetch via browser tab session...`, "warn");
        try {
          const base64Data = await fetchPrivateSheetViaTab(url, exportUrl, spreadsheetId);
          arrayBuffer = dataURLToArrayBuffer(base64Data);
        } catch (tabErr) {
          throw new Error("This sheet is private. Please share the sheet as 'Anyone with the link can view' or ensure you have the tab open in your browser.");
        }
      }
      
      const rows = readExcel(arrayBuffer);
      if (!rows || rows.length === 0) {
        throw new Error("No rows found in the sheet.");
      }
      
      // Rows must contain a LinkedIn profile link
      const validRows = rows.filter(row => row.linkedin !== "");
      if (validRows.length === 0) {
        throw new Error("No rows with valid LinkedIn links detected in the sheet.");
      }
      
      await clearAll();
      queueManager.initialize(validRows);
      exportManager.clear();
      await saveState();
      
      runStaticQueueLoop();
      
      return { success: true, count: validRows.length };
    })()
    .then((result) => {
      sendResponse(result);
    })
    .catch((err) => {
      error("Failed to load Google Sheet", err);
      sendResponse({ success: false, error: err.message || String(err) });
    });
    
    return true;
  }
});

/**
 * Trigger an Apify Actor Run.
 */
async function startApifyRun(urls) {
  const endpoint = `https://api.apify.com/v2/acts/${APIFY_ACTOR_KEY}/runs?token=${APIFY_TOKEN}`;
  const payload = {
    includePersonalEmails: true,
    includeWorkEmails: true,
    onlyWithEmails: true,
    linkedinUrls: urls,
    profileUrls: urls
  };
  console.log("Apify payload:", payload);
  
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to start Apify actor run: HTTP ${response.status} - ${errText}`);
  }
  
  const json = await response.json();
  return json.data;
}

/**
 * Fetch status of Apify run.
 */
async function pollApifyRun(runId) {
  const endpoint = `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Failed to fetch run status: HTTP ${response.status}`);
  }
  const json = await response.json();
  return json.data.status;
}

/**
 * Fetch elements from completed dataset.
 */
async function fetchDatasetItems(datasetId) {
  const endpoint = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Failed to fetch dataset items: HTTP ${response.status}`);
  }
  return await response.json();
}

/**
 * Helper to safely extract a valid email address from Apify output.
 */
function getValidEmail(result) {
  if (!result) return "";
  const candidates = [
    result.workEmail,
    result.personalEmail,
    result.email,
    result.work_email,
    ...(Array.isArray(result.personal_emails) ? result.personal_emails : []),
    result.personal_emails,
    result.has_email
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes('@') && c.includes('.')) {
      return c.trim();
    }
  }
  return "";
}

/**
 * Main worker loop for static spreadsheet queues running concurrently via Apify.
 */
async function runStaticQueueLoop() {
  if (isRunning) return;
  isRunning = true;
  
  await initApifyConfig();
  
  if (!APIFY_TOKEN) {
    error("No Apify token found in .env! Please add token=YOUR_APIFY_TOKEN to the .env file in the extension folder.");
    isRunning = false;
    bgMachine.transition(States.IDLE);
    return;
  }
  
  bgMachine.transition(States.IDLE);
  
  while (isRunning) {
    const pendingJobs = queueManager.getPending();
    if (pendingJobs.length === 0) {
      break;
    }
    
    // Get the next job from queue and mark as Running internally
    const job = queueManager.getNextPending();
    if (!job) continue;
    
    const rawLinkedin = job.data.linkedin;
    const linkedin = getLinkedInUrl(rawLinkedin);
    
    if (!linkedin) {
      log(`No valid LinkedIn URL found for row ${job.id}. Skipping...`, "warn");
      queueManager.markFailed(job.id, "No LinkedIn URL");
      
      // H, I, J) Mark done/failed and appendResult
      await exportManager.appendResult(job.id, {
        ...job.data,
        email: "",
        status: "No LinkedIn URL"
      });
      await saveState();
      continue;
    }
    
    log(`Processing row ${job.id}: ${linkedin}`);
    
    try {
      // 1. START_APIFY_RUN
      bgMachine.transition(States.START_APIFY_RUN, { url: linkedin });
      const runInfo = await startApifyRun([linkedin]);
      const runId = runInfo.id;
      const datasetId = runInfo.defaultDatasetId;
      
      await saveState();
      
      // 2. POLL_APIFY_STATUS
      bgMachine.transition(States.POLL_APIFY_STATUS, { runId });
      let status = runInfo.status;
      
      while (isRunning && (status === 'READY' || status === 'RUNNING')) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        status = await pollApifyRun(runId);
        log(`Apify run status: ${status}`);
      }
      
      if (!isRunning) {
        break; // Paused or stopped
      }
      
      if (status !== 'SUCCEEDED') {
        throw new Error(`Apify run ended with state: ${status}`);
      }
      
      // 3. FETCH_APIFY_DATASET
      bgMachine.transition(States.FETCH_APIFY_DATASET, { datasetId });
      const items = await fetchDatasetItems(datasetId);
      log(`Fetched ${items.length} records from Apify for this row.`);
      
      // 4. SAVE
      bgMachine.transition(States.SAVE);
      
      const result = items[0];
      const email = getValidEmail(result);
      const finalStatus = email ? "Found" : "No Email";
      
      // Mark job as Done with email and status
      queueManager.markDone(job.id, { email, status: finalStatus, linkedin });
      
      // Append results
      await exportManager.appendResult(job.id, {
        ...job.data,
        email,
        status: finalStatus
      });
      
      await saveState();
      
    } catch (err) {
      error(`Apify execution failed for row ${job.id}`, err);
      // Real API/system failure gets marked as failed (Retryable)
      queueManager.markFailed(job.id, err.message || "Failed");
      await exportManager.appendResult(job.id, {
        ...job.data,
        status: "Failed"
      });
      await saveState();
    }
    
    // K) Wait 1500-2000 ms between requests
    if (isRunning) {
      const waitTime = 1500 + Math.random() * 500;
      await new Promise(res => setTimeout(res, waitTime));
    }
  }
  
  isRunning = false;
  bgMachine.transition(States.IDLE);
  
  await finalizeJob();
}

/**
 * Saves current execution state.
 */
async function saveState() {
  const checkpoint = {
    queue: queueManager.serialize(),
    totalJobs: queueManager.size(),
    currentIndex: queueManager.getDone().length + queueManager.getFailed().length,
    isRunning
  };
  await saveCheckpoint(checkpoint);
}

/**
 * Broadcasts progress details to popup UI.
 */
function broadcastProgress() {
  const currentIndex = queueManager.getDone().length + queueManager.getFailed().length;
  chrome.runtime.sendMessage({
    cmd: "progress_update",
    progress: {
      isRunning,
      currentIndex,
      totalJobs: queueManager.size(),
      resultsCount: exportManager.results.length,
      queueSize: queueManager.getPending().length,
      currentState: bgMachine.getState()
    }
  }).catch(() => {});
}

/**
 * Generates final Excel workbook, saves it, and downloads it.
 */
async function finalizeJob() {
  try {
    const dataUrl = await exportManager.getExcelDataUrl();
    if (!dataUrl) {
      log("No results to finalize.", "warn");
      return;
    }
    await chrome.downloads.create({
      url: dataUrl,
      filename: "linkedin_emails_scraped.xlsx",
      saveAs: true
    });
    log("Excel spreadsheet exported and download initiated.", "success");
  } catch (err) {
    error("Failed to generate or download final Excel file", err);
  }
}

/**
 * Normalizes input text into a full, valid LinkedIn URL.
 */
function getLinkedInUrl(val) {
  if (!val) return null;
  val = val.trim();
  if (val === "") return null;
  
  if (val.includes("linkedin.com/")) {
    if (!val.startsWith("http")) {
      return "https://" + val;
    }
    return val;
  }
  
  if (val.startsWith("in/") || val.startsWith("/in/")) {
    const cleanHandle = val.startsWith("/") ? val.substring(1) : val;
    return "https://www.linkedin.com/" + cleanHandle;
  }
  
  if (/^[a-zA-Z0-9\-_]+$/.test(val)) {
    return "https://www.linkedin.com/in/" + val;
  }
  
  return null;
}

/**
 * Helper to fetch sheet content using an active tab session to bypass private sheet restrictions.
 */
async function fetchPrivateSheetViaTab(url, exportUrl, spreadsheetId) {
  const tabs = await chrome.tabs.query({});
  let targetTab = tabs.find(t => t.url && t.url.includes(spreadsheetId));
  let created = false;
  
  if (!targetTab) {
    // Open a temporary background tab
    targetTab = await chrome.tabs.create({ url, active: false });
    created = true;
    // Wait for the page to initialize and fetch cookies
    await new Promise(r => setTimeout(r, 4000));
  }
  
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: async (fetchUrl) => {
        const resp = await fetch(fetchUrl);
        if (!resp.ok) throw new Error(`Fetch failed inside tab: ${resp.status}`);
        const blob = await resp.blob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      },
      args: [exportUrl]
    });
    
    if (created) {
      chrome.tabs.remove(targetTab.id).catch(() => {});
    }
    return result;
  } catch (err) {
    if (created) {
      chrome.tabs.remove(targetTab.id).catch(() => {});
    }
    throw err;
  }
}

/**
 * Converts base64 Data URL to ArrayBuffer.
 */
function dataURLToArrayBuffer(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}
