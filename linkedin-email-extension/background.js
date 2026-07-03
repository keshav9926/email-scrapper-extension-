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
const APIFY_ACTOR_KEY = "snipercoder~bulk-linkedin-email-finder";

async function initApifyConfig() {
  try {
    const url = chrome.runtime.getURL('.env');
    const resp = await fetch(url);
    const text = await resp.text();
    const lines = text.split('\n');
    for (const line of lines) {
      const parts = line.split('=');
      if (parts[0] && parts[0].trim().toLowerCase() === 'token') {
        APIFY_TOKEN = parts.slice(1).join('=').trim();
        log(`Apify token successfully loaded from .env: ${APIFY_TOKEN.substring(0, 8)}...`);
        break;
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
      let rows;
      try {
        // Try direct fetch first
        const response = await fetch(exportUrl, { credentials: 'include' });
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          rows = readExcel(arrayBuffer);
        } else {
          throw new Error(`Direct fetch failed (HTTP ${response.status})`);
        }
      } catch (directErr) {
        log(`Export endpoint unavailable. trying GViz... Details: ${directErr.message}`, "warn");
        try {
          const rawText = await fetchPrivateSheetViaTab(url, spreadsheetId, msg.tabId);
          rows = parseGvizResponse(rawText);
        } catch (tabErr) {
          throw new Error(`Failed to load Google Sheet via active tab session: ${tabErr.message}`);
        }
      }
      
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
    linkedin_url_or_ids: urls
  };
  console.log("Payload:", JSON.stringify(payload, null, 2));
  console.log("INPUT");
  console.log(payload);
  log("Apify input payload: " + JSON.stringify(payload));
  
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
  console.log("RUN");
  console.log(json);
  log("Apify start run result: " + JSON.stringify(json.data));
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
  console.log(json.data);
  log("Apify polling raw data: " + JSON.stringify(json.data));
  if (json.data && json.data.status === 'FAILED') {
    log(`Apify run failed! Message: ${json.data.statusMessage || 'No status message provided.'}`, 'error');
  }
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
  const json = await response.json();
  console.log(json);
  return json;
}

/**
 * Helper to safely extract a valid email address from Apify output.
 */
function getValidEmail(result) {
  if (!result) return "";
  const candidates = [
    result["04_Email"],
    result.email,
    result.workEmail,
    result.personalEmail,
    result.work_email,
    result.personal_email,
    result.businessEmail,
    result.publicEmail,
    result.contactEmail,
    ...(Array.isArray(result.personalEmails) ? result.personalEmails : typeof result.personalEmails === 'string' ? [result.personalEmails] : []),
    ...(Array.isArray(result.workEmails) ? result.workEmails : typeof result.workEmails === 'string' ? [result.workEmails] : []),
    ...(Array.isArray(result.emails) ? result.emails : typeof result.emails === 'string' ? [result.emails] : []),
    ...(Array.isArray(result.personal_emails) ? result.personal_emails : typeof result.personal_emails === 'string' ? [result.personal_emails] : []),
    ...(Array.isArray(result.work_emails) ? result.work_emails : typeof result.work_emails === 'string' ? [result.work_emails] : [])
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes('@')) {
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
      console.log("LinkedIn being sent:", linkedin);
      const runInfo = await startApifyRun([linkedin]);
      console.log("RUN INFO");
      console.log(runInfo);
      console.log(runInfo.status);
      console.log("INITIAL RUN STATUS:", runInfo.status);
      const runId = runInfo.id;
      const datasetId = runInfo.defaultDatasetId || runInfo.datasetId;
      if (!datasetId) {
        throw new Error(`Failed to retrieve dataset ID from runInfo: ${JSON.stringify(runInfo)}`);
      }
      console.log(`runId: ${runId}, datasetId: ${datasetId}`);
      
      await saveState();
      
      // 2. POLL_APIFY_STATUS
      bgMachine.transition(States.POLL_APIFY_STATUS, { runId });
      let status = runInfo.status;
      
      while (isRunning && (status === 'READY' || status === 'RUNNING')) {
        console.log(status);
        console.log("POLLING STATUS ITERATION:", status);
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
      console.log("DATASET");
      console.log(items);
      log(`Fetched ${items.length} records from Apify for this row.`);
      log("Apify dataset items: " + JSON.stringify(items, null, 2));
      
      // 4. SAVE
      bgMachine.transition(States.SAVE);
      
      console.log("FULL APIFY DATASET", JSON.stringify(items, null, 2));
      const result = items && items[0];
      console.log("RESULT RECORD FOR PARSING:", JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
      const email = getValidEmail(result);
      
      const reason = result ? result["02_First_name"] : "";
      let finalStatus = "Unknown";
      if (reason === "email not found.") {
        finalStatus = "Email Not Found";
      } else if (email) {
        finalStatus = "Found";
      } else {
        finalStatus = "Unknown";
      }
      
      const scrapedName = result ? result["01_Name"] : "";
      const scrapedTitle = result ? result["07_Title"] : "";
      const scrapedCompany = result ? result["16_Company_name"] : "";
      const scrapedLinkedin = result ? result["17_Query_linkedin"] : "";
      
      // Mark job as Done with email and status
      queueManager.markDone(job.id, { 
        email, 
        status: finalStatus, 
        linkedin,
        scrapedName,
        scrapedTitle,
        scrapedCompany,
        scrapedLinkedin
      });
      
      // Append results
      await exportManager.appendResult(job.id, {
        ...job.data,
        email,
        status: finalStatus,
        scrapedName,
        scrapedTitle,
        scrapedCompany,
        scrapedLinkedin
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
 * Generates final Excel workbook and silently saves it to Downloads folder.
 * No dialog shown — safe to run overnight while user is asleep.
 * Also marks completion in chrome.storage as a backup in case download fails.
 */
async function finalizeJob() {
  try {
    const dataUrl = await exportManager.getExcelDataUrl();
    if (!dataUrl) {
      log("No results to finalize.", "warn");
      return;
    }

    // Timestamped filename so multiple runs never overwrite each other
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
    const filename = `linkedin_emails_${ts}.xlsx`;

    // Silent download — no dialog, goes straight to Downloads folder
    await chrome.downloads.create({
      url: dataUrl,
      filename: filename,
      saveAs: false
    });

    log(`✅ All done! Excel file saved to Downloads as "${filename}"`, "success");

    // Backup: mark job as completed in storage so data is never lost
    // even if something went wrong with the download
    await chrome.storage.local.set({
      last_completed_job: {
        completedAt: now.toISOString(),
        filename: filename,
        totalProcessed: queueManager.getDone().length + queueManager.getFailed().length,
        totalFound: exportManager.results.filter(r => r.status === "Found").length
      }
    });

  } catch (err) {
    error("Failed to generate or download final Excel file", err);

    // Even if download fails, the raw results are still in chrome.storage.local
    // User can open popup and click Download manually to recover them
    log("⚠️ Auto-download failed. Open the extension and click Download to get your results.", "warn");
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
 * Parses the raw GViz response format into structured row objects.
 */
function parseGvizResponse(text) {
  log("GViz response preview: " + text.substring(0, 500));
  const match = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*?)\);/);
  if (!match) {
    throw new Error("Invalid GViz response format. Response did not match setResponse pattern.");
  }
  
  const json = JSON.parse(match[1]);
  if (json.status === "error") {
    const errorMsg = json.errors && json.errors[0] ? json.errors[0].detailed_message : "Unknown Google Sheets GViz error";
    throw new Error(errorMsg);
  }
  
  const table = json.table;
  if (!table || !table.cols || !table.rows) {
    throw new Error("No table data found in GViz response.");
  }
  
  const cols = table.cols.map((col, idx) => col.label || col.id || `Col${idx}`);
  
  return table.rows.map((row, index) => {
    let linkedinUrl = "";
    let companyName = "";
    const rawRow = {};
    
    if (row && row.c) {
      row.c.forEach((cell, cellIndex) => {
        const colName = cols[cellIndex];
        const val = cell && cell.v !== null && cell.v !== undefined ? String(cell.v).trim() : "";
        rawRow[colName] = val;
        
        const lowerKey = colName.toLowerCase().trim();
        if (lowerKey.includes("linkedin") || lowerKey === "url" || lowerKey === "profile" || lowerKey === "link") {
          if (val && !linkedinUrl) {
            linkedinUrl = val;
          }
        }
        if (lowerKey.includes("company") || lowerKey.includes("firm")) {
          companyName = val;
        } else if (lowerKey === "name" && !companyName) {
          companyName = val;
        }
      });
    }
    
    return {
      id: index + 1,
      company: companyName || "Unknown",
      linkedin: (linkedinUrl && linkedinUrl.startsWith("https://www.linkedin.com/")) ? linkedinUrl.trim() : "",
      raw: rawRow
    };
  });
}

/**
 * Helper to fetch sheet content using an active tab session to bypass private sheet restrictions.
 */
async function fetchPrivateSheetViaTab(url, spreadsheetId, tabId) {
  let targetTab = null;
  if (tabId) {
    targetTab = await chrome.tabs.get(tabId).catch(() => null);
  }
  
  const tabs = await chrome.tabs.query({});
  if (!targetTab) {
    targetTab = tabs.find(t => t.url && t.url.includes(spreadsheetId));
  }
  
  let created = false;
  if (!targetTab) {
    log("Spreadsheet tab not found. Creating a temporary background tab...");
    targetTab = await chrome.tabs.create({ url, active: false });
    created = true;
  }
  
  try {
    // Wait until the tab URL is on docs.google.com and not loading/redirecting
    let retries = 15;
    while (retries > 0) {
      const tabInfo = await chrome.tabs.get(targetTab.id).catch(() => null);
      if (tabInfo && tabInfo.url && tabInfo.url.includes("docs.google.com") && tabInfo.status === "complete") {
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
      retries--;
    }
    
    // Parse GID from sheet URL
    let gid = "0";
    const gidMatch = url.match(/[?&]gid=([0-9]+)/);
    if (gidMatch) {
      gid = gidMatch[1];
    }
    const gvizUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&gid=${gid}`;
    log(`GViz Query URL: ${gvizUrl}`);
    
    log(`Injecting data fetch script into tab ${targetTab.id} using GViz endpoint...`);
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      world: "ISOLATED",
      func: async (fetchUrl) => {
        try {
          const resp = await fetch(fetchUrl, { credentials: "include" });
          if (!resp.ok) {
            return { success: false, error: `Fetch failed inside tab context: HTTP ${resp.status}` };
          }
          const text = await resp.text();
          return { success: true, data: text };
        } catch (e) {
          return { success: false, error: e.message || String(e) };
        }
      },
      args: [gvizUrl]
    });
    
    if (created && targetTab) {
      chrome.tabs.remove(targetTab.id).catch(() => {});
    }
    
    if (!results || results.length === 0) {
      throw new Error("Script injection returned no results array.");
    }
    
    const { result } = results[0];
    if (!result) {
      throw new Error("Script injection returned undefined/null result.");
    }
    
    if (!result.success) {
      throw new Error(result.error || "Unknown error during tab data fetch execution");
    }
    
    return result.data;
  } catch (err) {
    if (created && targetTab) {
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
