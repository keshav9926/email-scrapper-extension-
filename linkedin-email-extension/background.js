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
let activeTabId = null;
let scrapePromiseResolve = null;

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
        isRunning = false; // Reset to allow loop to re-enter
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
        
        const validRows = rows.filter(row => row.linkedin);
        if (validRows.length === 0) {
          throw new Error("No rows with valid LinkedIn links detected.");
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

  else if (msg.cmd === "scrape_response") {
    if (scrapePromiseResolve) {
      scrapePromiseResolve(msg);
      scrapePromiseResolve = null;
    }
    sendResponse({ success: true });
  }

  else if (msg.cmd === "content_state_change") {
    log(`[ContentState] ${msg.state}`, msg.metadata);
  }
});

/**
 * Safely routes messages to the registered active sheet iframe, falling back to the main frame if needed.
 */
async function sendSheetMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(activeSheetTabId, msg, { frameId: activeSheetFrameId }, (response) => {
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
 * Returns a promise that resolves when the given tab finishes loading.
 */
async function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const listener = (changeTabId, changeInfo) => {
      if (changeTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    
    // Check if it's already complete
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    });

    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timeout"));
    }, timeoutMs);
  });
}

/**
 * Main worker loop for static spreadsheet queues.
 */
async function runStaticQueueLoop() {
  if (isRunning) return;
  isRunning = true;
  
  log(`Scraping queue started. Remaining: ${queueManager.getPending().length}`);
  
  while (isRunning && !queueManager.isEmpty()) {
    const currentJob = queueManager.getNextPending();
    if (!currentJob) break;
    
    log(`Processing row ${currentJob.id}: ${currentJob.data.company} -> ${currentJob.data.linkedin}`);
    
    const cleanUrl = getLinkedInUrl(currentJob.data.linkedin);
    if (!cleanUrl) {
      warn(`Skipping invalid URL for ${currentJob.data.company}: "${currentJob.data.linkedin}"`);
      bgMachine.transition(States.SAVE, { jobId: currentJob.id, status: "Invalid URL" });
      queueManager.markFailed(currentJob.id, "Invalid URL");
      await exportManager.appendResult(currentJob.id, currentJob.data);
      await saveState();
      continue;
    }

    try {
      // 1. OPEN_PROFILE
      bgMachine.transition(States.OPEN_PROFILE, { url: cleanUrl });
      const tab = await chrome.tabs.create({ url: cleanUrl, active: true });
      activeTabId = tab.id;

      // 2. WAIT_READY
      bgMachine.transition(States.WAIT_READY);
      await waitForTabComplete(activeTabId);

      // 3. START_SCRAPER
      bgMachine.transition(States.START_SCRAPER);
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        files: [
          "utils/selectors.js",
          "utils/WaitManager.js",
          "utils/DOMObserver.js",
          "utils/StateMachine.js",
          "utils/RetryManager.js",
          "content.js"
        ]
      });

      // 4. WAIT_RESULT
      bgMachine.transition(States.WAIT_RESULT);
      const result = await new Promise((resolve) => {
        scrapePromiseResolve = resolve;
        // Safety timeout to prevent locking if tab is closed
        setTimeout(() => {
          if (scrapePromiseResolve === resolve) {
            resolve({ email: "", status: "Timeout" });
          }
        }, 30000);
      });

      // Close the tab
      try {
        await chrome.tabs.remove(activeTabId);
      } catch (e) {}

      // 5. SAVE
      bgMachine.transition(States.SAVE, { result });
      if (result.email) {
        queueManager.markDone(currentJob.id, { email: result.email, status: result.status });
      } else {
        queueManager.markFailed(currentJob.id, result.status || "Not Found");
      }
      
      await exportManager.appendResult(currentJob.id, currentJob.data);
      await saveState();

    } catch (err) {
      error(`Scraping error for row ${currentJob.id}`, err);
      try {
        if (activeTabId) await chrome.tabs.remove(activeTabId);
      } catch (e) {}
      
      queueManager.markFailed(currentJob.id, err.message || "Failed");
      await exportManager.appendResult(currentJob.id, currentJob.data);
      await saveState();
    }

    // 6. NEXT_ROW
    bgMachine.transition(States.NEXT_ROW);
    if (!queueManager.isEmpty() && isRunning) {
      const waitTime = Math.floor(Math.random() * (6000 - 3000 + 1)) + 3000;
      await new Promise(res => setTimeout(res, waitTime));
    }
  }

  isRunning = false;
  bgMachine.transition(States.IDLE);
  
  if (queueManager.getPending().length === 0) {
    log("All jobs completed. Finalizing export...");
    await finalizeJob();
  }
}

/**
 * Main orchestration loop for active tab Google Sheets / Excel Online.
 */
async function runActiveSheetLoop() {
  let emptyRowStreak = 0;
  const maxEmptyRows = 10;
  
  log("[SheetsBot] Row-by-row active Sheet loop started.");
  
  exportManager.clear();
  currentIndex = 0;
  await saveState();
  broadcastProgress();
  
  while (activeSheetLoopRunning && emptyRowStreak < maxEmptyRows) {
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
    
    const cleanUrl = getLinkedInUrl(value);
    if (cleanUrl) {
      log(`[SheetsBot] Reconstructed profile URL: ${cleanUrl}`);
      
      let emailFound = "";
      let status = "Not Found";
      
      try {
        // 1. OPEN_PROFILE
        bgMachine.transition(States.OPEN_PROFILE, { url: cleanUrl });
        const tab = await chrome.tabs.create({ url: cleanUrl, active: true });
        activeTabId = tab.id;

        // 2. WAIT_READY
        bgMachine.transition(States.WAIT_READY);
        await waitForTabComplete(activeTabId);

        // 3. START_SCRAPER
        bgMachine.transition(States.START_SCRAPER);
        await chrome.scripting.executeScript({
          target: { tabId: activeTabId },
          files: [
            "utils/selectors.js",
            "utils/WaitManager.js",
            "utils/DOMObserver.js",
            "utils/StateMachine.js",
            "utils/RetryManager.js",
            "content.js"
          ]
        });

        // 4. WAIT_RESULT
        bgMachine.transition(States.WAIT_RESULT);
        const result = await new Promise((resolve) => {
          scrapePromiseResolve = resolve;
          setTimeout(() => {
            if (scrapePromiseResolve === resolve) {
              resolve({ email: "", status: "Timeout" });
            }
          }, 30000);
        });

        // Close the tab
        try {
          await chrome.tabs.remove(activeTabId);
        } catch (e) {}

        emailFound = result.email;
        status = result.status;

      } catch (err) {
        error(`[SheetsBot] Failed to scrape profile ${cleanUrl}`, err);
        status = `Error: ${err.message || err}`;
        try {
          if (activeTabId) await chrome.tabs.remove(activeTabId);
        } catch (e) {}
      }
      
      if (!activeSheetLoopRunning) {
        log("[SheetsBot] Automation was paused or stopped during scraping.");
        break;
      }
      
      // 5. SAVE
      bgMachine.transition(States.SAVE, { email: emailFound, status });
      const jobData = { id: currentIndex, company: "Active Sheet Row " + currentIndex, linkedin: cleanUrl, email: emailFound, status: status };
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
      bgMachine.transition(States.NEXT_ROW);
      const waitTime = Math.floor(Math.random() * (6000 - 3500 + 1)) + 3500;
      await new Promise(res => setTimeout(res, waitTime));
      
    } else {
      log(`[SheetsBot] Active cell value ("${value}") is not a valid LinkedIn URL. Skipping down...`);
      const jobData = { id: currentIndex, company: "Active Sheet Row " + currentIndex, linkedin: value, email: "", status: "Invalid URL" };
      await exportManager.appendResult(currentIndex, jobData);
      await saveState();

      try {
        await chrome.tabs.update(activeSheetTabId, { active: true });
        await new Promise(res => setTimeout(res, 500));
        await sendSheetMessage({ 
          cmd: "writeResultAndMove", 
          text: "Invalid URL" 
        });
      } catch (e) {}
      await new Promise(res => setTimeout(res, 500));
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
 * Broadcasts progress details to any listener.
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
