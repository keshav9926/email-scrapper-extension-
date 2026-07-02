// background.js (Service Worker)

// Import SheetJS global setup
import './excel/xlsx.full.min.js';

// Import our modular components
import { readExcel } from './excel/reader.js';
import { QueueManager } from './utils/QueueManager.js';
import { ExportManager } from './utils/Export.js';
import { log, error, warn } from './utils/logger.js';
import { saveCheckpoint, getCheckpoint, clearCheckpoint, clearAll } from './utils/storage.js';

// Import state machine side-effect binding
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

let activeSheetTabId = null;
let activeSheetLoopRunning = false;
let activeSheetFrameId = 0;

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
      activeSheetTabId = checkpoint.activeSheetTabId;
      activeSheetLoopRunning = checkpoint.activeSheetLoopRunning;
      activeSheetFrameId = checkpoint.activeSheetFrameId || 0;
      await exportManager.load();
      
      log(`Restored session state: ${queueManager.getDone().length + queueManager.getFailed().length}/${queueManager.size()} processed.`);
      
      if (isRunning) {
        isRunning = false; 
        runStaticQueueLoop();
      } else if (activeSheetLoopRunning) {
        activeSheetLoopRunning = false;
        runActiveSheetLoop();
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
    activeSheetLoopRunning = false;
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
    } else if (!activeSheetLoopRunning && activeSheetTabId) {
      runActiveSheetLoop();
    }
    sendResponse({ success: true });
    return true;
  } 
  
  else if (msg.cmd === "stop") {
    log("Stopping execution and clearing progress.");
    isRunning = false;
    activeSheetLoopRunning = false;
    clearAll().then(() => {
      queueManager.clear();
      exportManager.clear();
      bgMachine.transition(States.IDLE);
      sendResponse({ success: true });
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
    
    fetch(exportUrl)
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw new Error("This sheet is private. Google blocks automated downloads of private sheets. Please share the sheet as 'Anyone with the link can view' or upload the Excel file manually.");
          }
          throw new Error(`Fetch failed (HTTP ${response.status})`);
        }
        return response.arrayBuffer();
      })
      .then(arrayBuffer => {
        const rows = readExcel(arrayBuffer);
        if (!rows || rows.length === 0) {
          throw new Error("No rows found in the sheet.");
        }
        
        // Rows must contain either a LinkedIn link or a company name to resolve
        const validRows = rows.filter(row => row.linkedin || row.company);
        if (validRows.length === 0) {
          throw new Error("No rows with valid LinkedIn links or company names detected.");
        }
        
        clearAll().then(() => {
          queueManager.initialize(validRows);
          exportManager.clear();
          saveState().then(() => {
            runStaticQueueLoop();
          });
        });
        
        sendResponse({ success: true, count: validRows.length });
      })
      .catch(err => {
        error("Failed to load Google Sheet", err);
        sendResponse({ success: false, error: err.message || String(err) });
      });
      
    return true;
  }
  
  else if (msg.cmd === "startActiveSheet") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
      const tab = tabs[0];
      const isGoogleSheet = tab && tab.url && tab.url.includes("docs.google.com/spreadsheets");
      const isExcelOnline = tab && tab.url && (
        tab.url.includes("live.com") || 
        tab.url.includes("office.com") || 
        tab.url.includes("office365.com") || 
        tab.url.includes("onedrive") || 
        tab.url.includes("1drv.ms")
      );
      
      if (!tab || !tab.url || (!isGoogleSheet && !isExcelOnline)) {
        sendResponse({ success: false, error: "Please ensure your active tab is your Google Sheet or Excel Online spreadsheet." });
        return;
      }
      
      activeSheetTabId = tab.id;
      activeSheetLoopRunning = true;
      
      try {
        log("Injecting SheetsBot controller into active sheet tab...");
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ["google_sheets_bot.js"]
        });
        
        runActiveSheetLoop();
        sendResponse({ success: true });
      } catch (err) {
        error("Failed to initialize active sheet bot script", err);
        sendResponse({ success: false, error: err.message || String(err) });
      }
    });
    return true;
  }
  
  else if (msg.cmd === "sheets_bot_register") {
    if (sender.tab && sender.tab.id === activeSheetTabId) {
      activeSheetFrameId = sender.frameId || 0;
      log(`[SheetsBot] Registered active sheet frame: ${activeSheetFrameId}`);
      sendResponse({ success: true });
    }
  }
  
  else if (msg.cmd === "getStatus") {
    const currentIndex = queueManager.getDone().length + queueManager.getFailed().length;
    sendResponse({
      isRunning: isRunning || activeSheetLoopRunning,
      currentIndex,
      totalJobs: queueManager.size(),
      resultsCount: exportManager.results.length,
      queueSize: queueManager.getPending().length,
      currentState: bgMachine.getState()
    });
  }
  
  else if (msg.cmd === "triggerDownload") {
    log("[SheetsBot] Manual download of results requested.");
    exportManager.getExcelDataUrl().then((dataUrl) => {
      sendResponse({ success: true, dataUrl: dataUrl, filename: "linkedin_emails_scraped.xlsx" });
    }).catch((e) => {
      sendResponse({ success: false, error: e.message || String(e) });
    });
    return true;
  }
});

/**
 * Safely routes messages to the registered active sheet iframe.
 */
async function sendSheetMessage(msg) {
  return new Promise((resolve, reject) => {
    let completed = false;
    const timer = setTimeout(() => {
      if (!completed) {
        completed = true;
        reject(new Error("Sheet message timeout"));
      }
    }, 8000);

    chrome.tabs.sendMessage(activeSheetTabId, msg, { frameId: activeSheetFrameId }, (response) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);

      if (chrome.runtime.lastError) {
        chrome.tabs.sendMessage(activeSheetTabId, msg, (fallbackResp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(fallbackResp);
          }
        });
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Search DuckDuckGo for the LinkedIn profile of the first co-founder or founder.
 */
async function findFounderProfile(companyName) {
  const query = encodeURIComponent(`founder OR "co-founder" "${companyName}" site:linkedin.com/in/`);
  const searchUrl = `https://html.duckduckgo.com/html/?q=${query}`;
  
  const response = await fetch(searchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
  });
  
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`);
  }
  
  const html = await response.text();
  const matches = html.match(/linkedin\.com\/in\/[a-zA-Z0-9%_-]+/g);
  
  if (matches && matches.length > 0) {
    let foundUrl = matches[0];
    if (!foundUrl.startsWith("http")) {
      foundUrl = "https://www." + foundUrl;
    }
    return foundUrl;
  }
  
  return null;
}

/**
 * Trigger an Apify Actor Run.
 */
async function startApifyRun(urls) {
  const endpoint = `https://api.apify.com/v2/acts/${APIFY_ACTOR_KEY}/runs?token=${APIFY_TOKEN}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        includePersonalEmails: true,
        includeWorkEmails: true,
        onlyWithEmails: true,
        linkedinUrls: urls,
        profileUrls: urls
      })
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
 * Main worker loop for static spreadsheet queues running concurrently via Apify.
 */
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
  
  const BATCH_SIZE = 30;
  
  while (isRunning) {
    const pendingJobs = queueManager.getPending();
    if (pendingJobs.length === 0) {
      break;
    }
    
    const currentBatch = pendingJobs.slice(0, BATCH_SIZE);
    log(`Processing batch of ${currentBatch.length} profiles...`);
    
    const urls = [];
    const jobUrlMap = new Map(); // jobId -> resolved founder profile URL
    
    for (const job of currentBatch) {
      let targetUrl = null;
      const company = job.data.company;
      const originalUrl = getLinkedInUrl(job.data.linkedin);

      // 1. If direct personal LinkedIn URL exists, prioritize and use it
      if (originalUrl && !originalUrl.includes("/company/")) {
        targetUrl = originalUrl;
        log(`Using direct LinkedIn URL for ${company || "row"}: ${targetUrl}`);
      } 
      // 2. If it's a company URL, extract handle and search founder
      else if (originalUrl && originalUrl.includes("/company/")) {
        const handleMatch = originalUrl.match(/\/company\/([a-zA-Z0-9\-_]+)/);
        const handle = handleMatch ? handleMatch[1] : "";
        if (handle) {
          try {
            targetUrl = await findFounderProfile(handle);
          } catch (e) {}
        }
      }
      
      // 3. Fallback: Search founder by company name
      if (!targetUrl && company && company !== "Unknown") {
        try {
          targetUrl = await findFounderProfile(company);
          if (targetUrl) {
            log(`Resolved founder profile for "${company}": ${targetUrl}`);
          }
        } catch (err) {
          warn(`Failed to resolve founder for "${company}": ${err.message}`);
        }
      }
      
      // 4. Ultimate fallback to the original URL if we resolved absolutely nothing
      if (!targetUrl && originalUrl) {
        targetUrl = originalUrl;
      }
      
      if (targetUrl) {
        urls.push(targetUrl);
        jobUrlMap.set(job.id, targetUrl);
      } else {
        warn(`Could not resolve any LinkedIn URL for row ${job.id}`);
      }
    }
    
    if (urls.length === 0) {
      // Mark this batch as failed to prevent infinite loops
      for (const job of currentBatch) {
        queueManager.markFailed(job.id, 'No URL resolved');
        await exportManager.appendResult(job.id, job.data);
      }
      await saveState();
      continue;
    }
    
    try {
      // 1. START_APIFY_RUN
      bgMachine.transition(States.START_APIFY_RUN, { urlCount: urls.length });
      const runInfo = await startApifyRun(urls);
      const runId = runInfo.id;
      const datasetId = runInfo.defaultDatasetId;
      
      currentBatch.forEach(job => {
        job.state = 'Running';
      });
      await saveState();
      
      // 2. POLL_APIFY_STATUS
      bgMachine.transition(States.POLL_APIFY_STATUS, { runId });
      let status = runInfo.status;
      
      while (isRunning && (status === 'READY' || status === 'RUNNING')) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        status = await pollApifyRun(runId);
        log(`Apify batch execution status: ${status}`);
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
      log(`Fetched ${items.length} records from Apify for this batch.`);
      
      // 4. SAVE
      bgMachine.transition(States.SAVE);
      
      // Map items back
      for (const job of currentBatch) {
        const resolvedUrl = jobUrlMap.get(job.id);
        if (!resolvedUrl) {
          queueManager.markFailed(job.id, 'No profile resolved');
          await exportManager.appendResult(job.id, job.data);
          continue;
        }
        
        const resolvedClean = getLinkedInUrl(resolvedUrl);
        const matchedItem = items.find(item => {
          const itemUrl = getLinkedInUrl(item.linkedinUrl || item.linkedin_url || item.profileUrl || item.url || item.profile_url);
          return itemUrl && (itemUrl.includes(resolvedClean) || resolvedClean.includes(itemUrl));
        });
        
        if (matchedItem && (matchedItem.has_email || matchedItem.work_email || (matchedItem.personal_emails && matchedItem.personal_emails.length > 0))) {
          const email = matchedItem.has_email || matchedItem.work_email || matchedItem.personal_emails[0];
          queueManager.markDone(job.id, { email, status: 'Found', linkedin: resolvedUrl });
        } else {
          queueManager.markFailed(job.id, 'Not Found');
          job.data.linkedin = resolvedUrl;
        }
        
        await exportManager.appendResult(job.id, job.data);
      }
      
      await saveState();
      
    } catch (err) {
      error("Static batch Apify execution failed", err);
      currentBatch.forEach(job => {
        queueManager.markFailed(job.id, err.message || "Failed");
        exportManager.appendResult(job.id, job.data);
      });
      await saveState();
    }
  }
  
  isRunning = false;
  bgMachine.transition(States.IDLE);
  
  await finalizeJob();
}

/**
 * Main orchestration loop for active tab Google Sheets / Excel Online.
 */
async function runActiveSheetLoop() {
  let emptyRowStreak = 0;
  const maxEmptyRows = 10;
  
  await initApifyConfig();
  
  if (!APIFY_TOKEN) {
    error("[SheetsBot] No Apify token found in .env!");
    activeSheetLoopRunning = false;
    bgMachine.transition(States.IDLE);
    return;
  }
  
  log("[SheetsBot] Active Sheet loop started via Apify.");
  
  exportManager.clear();
  let currentIndex = 0;
  await saveState();
  broadcastProgress();
  
  while (activeSheetLoopRunning && emptyRowStreak < maxEmptyRows) {
    try {
      let cellResp;
      try {
        cellResp = await sendSheetMessage({ cmd: "readActiveCell" });
      } catch (err) {
        error("Failed to communicate with active sheet tab.", err);
        break;
      }
      
      const value = cellResp ? cellResp.value : '';
      if (!value) {
        emptyRowStreak++;
        log(`[SheetsBot] Empty cell. Streak: ${emptyRowStreak}/${maxEmptyRows}. Moving down...`);
        try {
          await sendSheetMessage({ cmd: "moveDown" });
        } catch (e) {}
        await new Promise(res => setTimeout(res, 1000));
        continue;
      }
      
      emptyRowStreak = 0;
      currentIndex++;
      
      // Resolve target founder profile
      let targetUrl = null;
      const cleanUrl = getLinkedInUrl(value);
      
      if (cleanUrl) {
        if (cleanUrl.includes("/company/")) {
          const handleMatch = cleanUrl.match(/\/company\/([a-zA-Z0-9\-_]+)/);
          const handle = handleMatch ? handleMatch[1] : "";
          if (handle) {
            try {
              targetUrl = await findFounderProfile(handle);
            } catch (e) {}
          }
        } else {
          targetUrl = cleanUrl;
        }
      } else {
        // Treat the cell content as a company name
        try {
          targetUrl = await findFounderProfile(value);
        } catch (e) {}
      }
      
      if (targetUrl) {
        log(`[SheetsBot] Resolved founder profile: ${targetUrl}`);
        
        let emailFound = "";
        let status = "Not Found";
        
        try {
          // 1. START_APIFY_RUN
          bgMachine.transition(States.START_APIFY_RUN, { url: targetUrl });
          const runInfo = await startApifyRun([targetUrl]);
          const runId = runInfo.id;
          const datasetId = runInfo.defaultDatasetId;
          
          // 2. POLL_APIFY_STATUS
          bgMachine.transition(States.POLL_APIFY_STATUS, { runId });
          let runStatus = runInfo.status;
          while (activeSheetLoopRunning && (runStatus === 'READY' || runStatus === 'RUNNING')) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            runStatus = await pollApifyRun(runId);
          }
          
          if (runStatus === 'SUCCEEDED') {
            // 3. FETCH_APIFY_DATASET
            bgMachine.transition(States.FETCH_APIFY_DATASET, { datasetId });
            const items = await fetchDatasetItems(datasetId);
            if (items.length > 0) {
              const item = items[0];
              emailFound = item.has_email || item.work_email || (item.personal_emails && item.personal_emails[0]) || "";
              status = emailFound ? "Found" : "Not Found";
            }
          } else {
            status = `Failed: ${runStatus}`;
          }
          
        } catch (err) {
          error(`[SheetsBot] Apify failed for profile ${targetUrl}`, err);
          status = `Error: ${err.message || err}`;
        }
        
        if (!activeSheetLoopRunning) {
          log("[SheetsBot] Automation stopped.");
          break;
        }
        
        // 5. SAVE
        bgMachine.transition(States.SAVE, { email: emailFound, status });
        const jobData = { id: currentIndex, company: value, linkedin: targetUrl, email: emailFound, status: status };
        await exportManager.appendResult(currentIndex, jobData);
        await saveState();
        
        // Reactivate sheet tab
        try {
          await chrome.tabs.update(activeSheetTabId, { active: true });
          await new Promise(res => setTimeout(res, 800));
        } catch (e) {}
        
        try {
          await sendSheetMessage({ 
            cmd: "writeResultAndMove", 
            text: emailFound || status 
          });
        } catch (err) {
          error("[SheetsBot] Failed to write result and move", err);
          break;
        }
        
        // 6. NEXT_ROW
        bgMachine.transition(States.IDLE);
        await new Promise(res => setTimeout(res, 2000));
        
      } else {
        log(`[SheetsBot] Could not resolve a founder profile for "${value}". Skipping...`);
        const jobData = { id: currentIndex, company: value, linkedin: "", email: "", status: "Founder profile not found" };
        await exportManager.appendResult(currentIndex, jobData);
        await saveState();

        try {
          await chrome.tabs.update(activeSheetTabId, { active: true });
          await new Promise(res => setTimeout(res, 500));
          await sendSheetMessage({ 
            cmd: "writeResultAndMove", 
            text: "Founder profile not found" 
          });
        } catch (e) {}
        await new Promise(res => setTimeout(res, 500));
      }
    } catch (loopErr) {
      error("[SheetsBot] Unexpected error in active sheet loop iteration:", loopErr);
      await new Promise(res => setTimeout(res, 2000));
    }
  }
  
  log("[SheetsBot] Active Sheet automation loop finished.");
  activeSheetLoopRunning = false;
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
    isRunning,
    activeSheetTabId,
    activeSheetLoopRunning,
    activeSheetFrameId
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
      isRunning: isRunning || activeSheetLoopRunning,
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
      log("[SheetsBot] No results to finalize.", "warn");
      return;
    }
    await chrome.downloads.create({
      url: dataUrl,
      filename: "linkedin_emails_scraped.xlsx",
      saveAs: true
    });
    log("[SheetsBot] Excel spreadsheet exported and download initiated.", "success");
  } catch (err) {
    error("[SheetsBot] Failed to generate or download final Excel file", err);
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
