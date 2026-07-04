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

// Global error handlers to catch and report uncaught service worker errors
self.addEventListener('error', (event) => {
  error("Uncaught service worker error", event.error || event.message);
});
self.addEventListener('unhandledrejection', (event) => {
  error("Unhandled promise rejection in service worker", event.reason);
});

let isRunning = false;
let currentLoopId = 0;
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
    const { rows, resumeAfterUrl = "", startFromRow = 0, endAtRow = 0 } = msg;
    log(`Starting new scraping session with ${rows.length} rows.`);

    clearAll().then(async () => {
      await initApifyConfig();

      queueManager.initialize(rows);

      if (resumeAfterUrl) {
        const skipped = queueManager.skipUpToAndIncluding(resumeAfterUrl);
        log(`Resume mode (URL): skipped ${skipped} rows up to and including "${resumeAfterUrl}".`, 'warn');
        if (skipped === 0) {
          log('WARNING: Resume URL not found in queue. Processing all rows from start.', 'error');
        }
      } else if (startFromRow > 1) {
        const skipped = queueManager.skipBefore(startFromRow);
        log(`Resume mode (Sr. No. ${startFromRow}): skipped ${skipped} rows before row ${startFromRow}.`, 'warn');
      }

      if (endAtRow > 0) {
        const capped = queueManager.skipFrom(endAtRow);
        log(`Range cap: skipped ${capped} rows after Sr. No. ${endAtRow}.`, 'warn');
      }

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
    const currentIndex = queueManager.getDone().length + queueManager.getFailed().length + queueManager.getSkipped().length;
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
    
    // Parse GID to export the correct tab (sheet)
    let gid = "";
    const gidMatch = url.match(/[#?&]gid=([0-9]+)/);
    if (gidMatch) {
      gid = gidMatch[1];
    }
    
    let exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx`;
    if (gid) {
      exportUrl += `&gid=${gid}`;
    }

    log(`Attempting to fetch Google Sheet workbook (tab gid: ${gid || "default"})...`);

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

      const resumeAfterUrl = msg.resumeAfterUrl || "";
      const startFromRow = msg.startFromRow || 0;
      const endAtRow = msg.endAtRow || 0;

      await clearAll();
      queueManager.initialize(validRows);

      if (resumeAfterUrl) {
        const skipped = queueManager.skipUpToAndIncluding(resumeAfterUrl);
        log(`Resume mode (URL): skipped ${skipped} rows up to and including "${resumeAfterUrl}".`, 'warn');
        if (skipped === 0) {
          log('WARNING: Resume URL not found in queue. Processing all rows from start.', 'error');
        }
      } else if (startFromRow > 1) {
        const skipped = queueManager.skipBefore(startFromRow);
        log(`Resume mode (Sr. No. ${startFromRow}): skipped ${skipped} rows before row ${startFromRow}.`, 'warn');
      }

      if (endAtRow > 0) {
        const capped = queueManager.skipFrom(endAtRow);
        log(`Range cap: skipped ${capped} rows after Sr. No. ${endAtRow}.`, 'warn');
      }
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
    linkedin_url_or_ids: urls  // snipercoder actor expects linkedin_url_or_ids: ["url1", "url2"]
  };
  log("Apify input payload: " + JSON.stringify(payload));

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to start Apify actor run: HTTP ${response.status} - ${errText}`);
  }

  const json = await response.json();
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
 * Checks every known field name AND does a brute-force scan of all keys.
 */
function getValidEmail(result) {
  if (!result) return "";

  // --- Named field checks (known schema variants) ---
  const candidates = [
    result["04_Email"],
    result["Email"],
    result["email"],
    result["EMAIL"],
    result.workEmail,
    result.personalEmail,
    result.work_email,
    result.personal_email,
    result.businessEmail,
    result.publicEmail,
    result.contactEmail,
    result.emailAddress,
    result.email_address,
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

  // --- Brute-force scan: check EVERY key in the result for an email-like value ---
  for (const key of Object.keys(result)) {
    const val = result[key];
    if (typeof val === 'string' && val.includes('@') && val.includes('.')) {
      log(`[EMAIL FOUND via brute-force] Key: "${key}" → Value: "${val}"`, 'warn');
      return val.trim();
    }
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string' && item.includes('@') && item.includes('.')) {
          log(`[EMAIL FOUND in array] Key: "${key}" → Value: "${item}"`, 'warn');
          return item.trim();
        }
      }
    }
  }

  return "";
}

/**
 * Logs all keys and values from an Apify result for debugging field name mismatches.
 */
function diagnoseMissingEmail(result, jobId) {
  if (!result) {
    log(`[DIAG #${jobId}] Apify returned null/empty result item.`, 'warn');
    return;
  }
  const keys = Object.keys(result);
  log(`[DIAG #${jobId}] Apify result has ${keys.length} keys: ${keys.join(', ')}`, 'warn');
  for (const key of keys) {
    const val = result[key];
    // Only log non-empty, non-object values to keep logs manageable
    if (val !== null && val !== undefined && val !== '' && typeof val !== 'object') {
      log(`[DIAG #${jobId}]   "${key}": "${String(val).substring(0, 120)}"`, 'warn');
    } else if (Array.isArray(val) && val.length > 0) {
      log(`[DIAG #${jobId}]   "${key}" (array): ${JSON.stringify(val).substring(0, 120)}`, 'warn');
    }
  }
}

/**
 * Main worker loop for static spreadsheet queues running concurrently via Apify.
 */
async function runStaticQueueLoop() {
  const myLoopId = ++currentLoopId;
  isRunning = true;

  await initApifyConfig();
  if (myLoopId !== currentLoopId) return;

  if (!APIFY_TOKEN) {
    error("No Apify token found in .env! Please add token=YOUR_APIFY_TOKEN to the .env file in the extension folder.");
    isRunning = false;
    bgMachine.transition(States.IDLE);
    return;
  }

  bgMachine.transition(States.IDLE);

  const BATCH_SIZE = 1;

  while (isRunning && myLoopId === currentLoopId) {
    const pendingJobs = queueManager.getPending();
    if (pendingJobs.length === 0) {
      break;
    }

    // Build a batch of up to BATCH_SIZE processable jobs
    const batch = [];
    const skippedJobs = [];

    for (const job of pendingJobs) {
      if (batch.length >= BATCH_SIZE) break;

      const rawLinkedin = job.data.linkedin;
      const linkedin = getLinkedInUrl(rawLinkedin);

      if (!linkedin) {
        skippedJobs.push({ job, status: "No LinkedIn URL" });
        continue;
      }

      if (linkedin.includes("/company/")) {
        skippedJobs.push({ job, status: "Company Page", linkedin });
        continue;
      }

      batch.push({ job, linkedin });
    }

    // Process skipped jobs first
    for (const item of skippedJobs) {
      const { job, status } = item;
      log(`Skipping row ${job.id}: ${status}`, "warn");
      queueManager.markFailed(job.id, status);
      await exportManager.appendResult(job.id, {
        ...job.data,
        email: "",
        status: status
      });
      if (myLoopId !== currentLoopId) return;
    }

    if (skippedJobs.length > 0) {
      await saveState();
      if (myLoopId !== currentLoopId) return;
    }

    // If no valid jobs to run in this batch, continue
    if (batch.length === 0) {
      if (isRunning && pendingJobs.length > skippedJobs.length) {
        continue;
      }
      break;
    }

    // Mark batch jobs as running internally
    for (const b of batch) {
      b.job.state = 'Running';
    }

    const urls = batch.map(b => b.linkedin);
    log(`Processing batch of ${batch.length} rows concurrently via Apify...`);

    try {
      // 1. START_APIFY_RUN
      bgMachine.transition(States.START_APIFY_RUN, { urls });
      const runInfo = await startApifyRun(urls);
      if (myLoopId !== currentLoopId) return;

      const runId = runInfo.id;
      const datasetId = runInfo.defaultDatasetId || runInfo.datasetId;
      if (!datasetId) {
        throw new Error(`Failed to retrieve dataset ID from runInfo: ${JSON.stringify(runInfo)}`);
      }

      await saveState();
      if (myLoopId !== currentLoopId) return;

      // 2. POLL_APIFY_STATUS
      bgMachine.transition(States.POLL_APIFY_STATUS, { runId });
      let status = runInfo.status;

      while (isRunning && myLoopId === currentLoopId && (status === 'READY' || status === 'RUNNING')) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (myLoopId !== currentLoopId) return;
        status = await pollApifyRun(runId);
        if (myLoopId !== currentLoopId) return;
        log(`Apify batch run status: ${status}`);
      }

      if (!isRunning || myLoopId !== currentLoopId) {
        // If paused/stopped, mark the running batch back to pending so they can resume next time
        for (const b of batch) {
          b.job.state = 'Pending';
        }
        await saveState();
        return;
      }

      if (status !== 'SUCCEEDED') {
        throw new Error(`Apify run ended with state: ${status}`);
      }

      // 3. FETCH_APIFY_DATASET
      bgMachine.transition(States.FETCH_APIFY_DATASET, { datasetId });
      const items = await fetchDatasetItems(datasetId);
      if (myLoopId !== currentLoopId) return;
      log(`Fetched ${items.length} records from Apify for this batch.`);

      // 4. SAVE
      bgMachine.transition(States.SAVE);

      const getLinkedinFromItem = (item) => {
        if (!item) return "";
        let url = item.url || item["06_Linkedin_url"] || item["Linkedin_url"] || item["linkedin_url"] || item["17_Query_linkedin"] || item["Query Linkedin"] || "";
        if (url && !url.includes("linkedin.com")) {
          url = `https://www.linkedin.com/in/${url}`;
        }
        return url;
      };

      const normalize = (url) => {
        if (!url) return "";
        let clean = String(url).toLowerCase().trim().replace(/\/$/, '');
        clean = clean.replace(/^https?:\/\//, '').replace(/^www\./, '');
        return clean;
      };

      const itemsMap = new Map();
      for (const item of items) {
        const itemUrl = getLinkedinFromItem(item);
        if (itemUrl) {
          itemsMap.set(normalize(itemUrl), item);
        }
      }

      log("[SAVE] Processing batch results...");
      for (const b of batch) {
        const normUrl = normalize(b.linkedin);
        const result = itemsMap.get(normUrl);

        let email = "";
        let finalStatus = "Email Not Found";

        if (!result) {
          finalStatus = "No Results";
        } else {
          email = getValidEmail(result);
          if (email) {
            finalStatus = "Found";
          } else {
            const errMsg = result.errorMessage || result.error || result["01_Name"] || "";
            if (errMsg && (errMsg.toLowerCase().includes("limit") || errMsg.toLowerCase().includes("monthly"))) {
              finalStatus = "Limit Reached";
            } else {
              finalStatus = "Email Not Found";
            }
          }
        }

        queueManager.markDone(b.job.id, {
          email,
          status: finalStatus,
          linkedin: b.linkedin
        });

        log(`[SAVE] Saving result for job ${b.job.id}...`);
        await exportManager.appendResult(b.job.id, {
          ...b.job.data,
          email,
          status: finalStatus
        });
        log(`[SAVE] Saved result for job ${b.job.id}.`);
        if (myLoopId !== currentLoopId) return;
      }

      log("[SAVE] Saving execution state...");
      await saveState();
      log("[SAVE] Done saving execution state.");
      if (myLoopId !== currentLoopId) return;

    } catch (err) {
      error(`Apify batch execution failed`, err);
      // Mark all jobs in this batch as failed (can be retried)
      for (const b of batch) {
        queueManager.markFailed(b.job.id, err.message || "Failed");
        await exportManager.appendResult(b.job.id, {
          ...b.job.data,
          status: "Failed"
        });
        if (myLoopId !== currentLoopId) return;
      }
      await saveState();
      if (myLoopId !== currentLoopId) return;
    }

    // Wait slightly between batches to avoid rate limit/spam issues
    if (isRunning && myLoopId === currentLoopId) {
      await new Promise(res => setTimeout(res, 2000));
      if (myLoopId !== currentLoopId) return;
    }
  }

  if (myLoopId === currentLoopId) {
    isRunning = false;
    bgMachine.transition(States.IDLE);
    await finalizeJob();
  }
}

/**
 * Saves current execution state.
 */
async function saveState() {
  const checkpoint = {
    queue: queueManager.serialize(),
    totalJobs: queueManager.size(),
    currentIndex: queueManager.getDone().length + queueManager.getFailed().length + queueManager.getSkipped().length,
    isRunning
  };
  await saveCheckpoint(checkpoint);
}

/**
 * Broadcasts progress details to popup UI.
 */
function broadcastProgress() {
  const currentIndex = queueManager.getDone().length + queueManager.getFailed().length + queueManager.getSkipped().length;
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
  }).catch(() => { });
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
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
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
      });

      // Target Column I (index 8) for Individual's/Founder's LinkedIn profile
      const linkedinCell = row.c[8];
      const val = linkedinCell && linkedinCell.v !== null && linkedinCell.v !== undefined ? String(linkedinCell.v).trim() : "";
      if (val && val.includes("linkedin.com/")) {
        linkedinUrl = val;
      }


      // Target Column A (index 0) or fallback to first name column for company name
      const companyCell = row.c[0];
      const cName = companyCell && companyCell.v !== null && companyCell.v !== undefined ? String(companyCell.v).trim() : "";
      if (cName && cName !== "null") {
        companyName = cName;
      } else {
        row.c.forEach((cell, cellIndex) => {
          const colName = cols[cellIndex];
          const cVal = cell && cell.v !== null && cell.v !== undefined ? String(cell.v).trim() : "";
          if (cVal && cVal !== "null" && !companyName) {
            const lowerKey = colName.toLowerCase().trim();
            if (lowerKey.includes("company") || lowerKey.includes("firm") || lowerKey === "name") {
              companyName = cVal;
            }
          }
        });
      }
    }

    // Normalize LinkedIn URL format
    let normalizedLinkedin = "";
    if (linkedinUrl) {
      let cleanUrl = linkedinUrl;
      if (!cleanUrl.startsWith("http")) {
        cleanUrl = "https://" + cleanUrl;
      }
      cleanUrl = cleanUrl.replace("http://", "https://")
        .replace("https://linkedin.com/", "https://www.linkedin.com/");
      normalizedLinkedin = cleanUrl;
    }

    return {
      id: index + 1,
      company: companyName || "Unknown",
      linkedin: normalizedLinkedin,
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
      chrome.tabs.remove(targetTab.id).catch(() => { });
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
      chrome.tabs.remove(targetTab.id).catch(() => { });
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
