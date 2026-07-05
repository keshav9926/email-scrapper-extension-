const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Configuration
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1w11kuIGWOVATOad5acQqVWSzELF25xCyP6j3yoBiEUc/gviz/tq?tqx=out:json&gid=0&headers=1";
const ACTOR_KEY = "snipercoder~bulk-linkedin-email-finder";
const BATCH_SIZE = 1; // Process 1 profiles per Apify run (faster and uses less startup credits)
const CHECKPOINT_FILE = path.join(__dirname, 'cli_checkpoint.json');
const OUTPUT_FILE = path.join(__dirname, 'scraped_results.xlsx');

// Fetch Apify token from the extension .env
function getApifyToken() {
  const envPath = path.join(__dirname, 'linkedin-email-extension', '.env');
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf8');
    const match = text.match(/token\s*=\s*([^\r\n]+)/i);
    if (match) return match[1].trim();
  }
  return null;
}

const token = getApifyToken();
if (!token) {
  console.error("❌ Error: Apify API token not found. Please set 'token=YOUR_TOKEN' in linkedin-email-extension/.env");
  process.exit(1);
}

// Helpers
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

function parseGvizResponse(text) {
  const match = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*?)\);/);
  if (!match) {
    throw new Error("Invalid GViz response format.");
  }

  const json = JSON.parse(match[1]);
  if (json.status === "error") {
    throw new Error("GViz response error");
  }

  const table = json.table;
  const cols = table.cols.map((col, idx) => col.label || col.id || `Col${idx}`);

  return table.rows.slice(1).map((row, index) => {
    let linkedinUrl = "";
    let companyName = "";
    const rawRow = {};

    if (row && row.c) {
      row.c.forEach((cell, cellIndex) => {
        const colName = cols[cellIndex];
        const val = cell && cell.v !== null && cell.v !== undefined ? String(cell.v).trim() : "";
        rawRow[colName] = val;
      });

      const linkedinCell = row.c[8];
      const val = linkedinCell && linkedinCell.v !== null && linkedinCell.v !== undefined ? String(linkedinCell.v).trim() : "";
      if (val && val.includes("linkedin.com/")) {
        linkedinUrl = val;
      }

      const companyCell = row.c[0];
      const cName = companyCell && companyCell.v !== null && companyCell.v !== undefined ? String(companyCell.v).trim() : "";
      if (cName && cName !== "null") {
        companyName = cName;
      }
    }

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
      id: index + 4, // Row ID aligns exactly with spreadsheet row numbers (telli is Row 4)
      company: companyName || "Unknown",
      linkedin: normalizedLinkedin,
      raw: rawRow
    };
  });
}

function getLinkedinFromItem(item) {
  if (!item) return "";
  const candidates = [
    item.url,
    item.linkedin,
    item.linkedinUrl,
    item.linkedin_url,
    item.profileUrl,
    item.profile_url,
    item["06_Linkedin_url"],
    item["Linkedin_url"],
    item["17_Query_linkedin"],
    item["Query Linkedin"],
    item.query,
    item.input
  ];
  for (const url of candidates) {
    if (typeof url === 'string' && url.includes('linkedin.com/')) {
      return url;
    }
  }
  for (const key of Object.keys(item)) {
    const val = item[key];
    if (typeof val === 'string' && val.includes('linkedin.com/')) {
      return val;
    }
  }
  return "";
}

function normalizeUrl(url) {
  if (!url) return "";
  let clean = String(url).toLowerCase().trim();
  clean = clean.split('?')[0].split('#')[0];
  clean = clean.replace(/\/+$/, '');
  clean = clean.replace(/^https?:\/\//, '');
  clean = clean.replace(/^[a-z0-9-]+\.linkedin\.com/, 'linkedin.com');
  return clean;
}

function getValidEmail(item) {
  if (!item) return "";
  const candidates = [
    item.email,
    item.emailAddress,
    item.email_address,
    item.personalEmail,
    item.workEmail,
    item["08_Email"],
    item["Email"],
    item.companyEmail
  ];
  for (const email of candidates) {
    if (typeof email === 'string' && email.includes('@') && !email.toLowerCase().includes('placeholder') && !email.toLowerCase().includes('null')) {
      return email.trim();
    }
  }
  for (const key of Object.keys(item)) {
    const val = item[key];
    if (typeof val === 'string' && val.includes('@') && val.includes('.') && !val.toLowerCase().includes('placeholder') && !val.toLowerCase().includes('null')) {
      return val.trim();
    }
  }
  return "";
}

function log(msg, type = "info") {
  const time = new Date().toLocaleTimeString();
  const icons = { info: "ℹ️", success: "✅", warn: "⚠️", error: "❌" };
  console.log(`[${time}] ${icons[type] || "ℹ️"} ${msg}`);
}

async function fetchWithRetry(url, options = {}, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (err) {
      if (i === retries - 1) throw err;
      log(`Network request failed: ${err.message}. Retrying in ${delay / 1000}s... (${i + 1}/${retries})`, "warn");
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function startApifyRun(urls) {
  const endpoint = `https://api.apify.com/v2/acts/${ACTOR_KEY}/runs?token=${token}`;
  const payload = {
    linkedin_url_or_ids: urls,
    urls: urls,
    queries: urls.map(u => ({ url: u })),
    linkedin: urls.length === 1 ? urls[0] : urls
  };

  const response = await fetchWithRetry(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Apify run startup failed (${response.status}): ${text}`);
  }

  const json = await response.json();
  return json.data;
}

async function pollApifyRun(runId) {
  const endpoint = `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`;
  const response = await fetchWithRetry(endpoint);
  if (!response.ok) return "RUNNING"; // safe fallback
  const json = await response.json();
  return json.data.status;
}

async function fetchDatasetItems(datasetId) {
  const endpoint = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}`;
  const response = await fetchWithRetry(endpoint);
  if (!response.ok) {
    throw new Error(`Failed to fetch dataset items (${response.status})`);
  }
  return await response.json();
}

function saveToExcel(results, filename) {
  const data = results.map(item => {
    const row = {
      "Row ID": item.id,
      "Company Name": item.company,
      "LinkedIn URL": item.linkedin,
      "Email": item.email || "",
      "Status": item.status || "Not Found",
      "Scraped Name": item.scrapedName || "",
      "Scraped Title": item.scrapedTitle || "",
      "Scraped Company": item.scrapedCompany || "",
      "Scraped LinkedIn": item.scrapedLinkedIn || "",
      "Timestamp": item.timestamp || new Date().toISOString()
    };

    if (item.raw) {
      for (const [key, val] of Object.entries(item.raw)) {
        const lowerKey = key.toLowerCase().trim();
        const isMapped = lowerKey.includes("linkedin") || 
                         lowerKey === "url" || 
                         lowerKey === "profile" || 
                         lowerKey === "link" ||
                         lowerKey.includes("company") || 
                         lowerKey.includes("firm") || 
                         lowerKey === "name" ||
                         lowerKey === "email" ||
                         lowerKey === "status" ||
                         lowerKey === "timestamp" ||
                         lowerKey.includes("scraped");
        if (!isMapped) {
          row[key] = val;
        }
      }
    }
    return row;
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "Scrape Results");
  XLSX.writeFile(wb, filename);
}

// Main automation runner
async function main() {
  const args = process.argv.slice(2);
  const isFresh = args.includes('--fresh') || args.includes('--reset');

  if (isFresh) {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      fs.unlinkSync(CHECKPOINT_FILE);
      log("Cleared previous CLI checkpoint file.", "warn");
    }
    if (fs.existsSync(OUTPUT_FILE)) {
      fs.unlinkSync(OUTPUT_FILE);
      log("Cleared previous Excel output file.", "warn");
    }
  }

  log("Initializing CLI Automation Scraper...");
  
  // 1. Fetch Google Sheet
  log("Fetching spreadsheet data from Google Sheets...");
  const res = await fetchWithRetry(SHEET_URL);
  const text = await res.text();
  const allRows = parseGvizResponse(text);
  const validRows = allRows.filter(r => r.linkedin !== "");
  log(`Successfully loaded ${allRows.length} total rows. Found ${validRows.length} rows with LinkedIn profiles.`, "success");

  // 2. Load or initialize checkpoint & results
  let processedResults = [];
  let currentIndex = 0;

  if (fs.existsSync(CHECKPOINT_FILE)) {
    try {
      const cp = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
      processedResults = cp.results || [];
      currentIndex = cp.currentIndex || 0;
      log(`Restored checkpoint: Resuming from index ${currentIndex} (${processedResults.length} records processed so far).`, "warn");
    } catch (e) {
      log("Could not parse checkpoint file, starting fresh.", "warn");
    }
  }

  // 3. Main Loop
  while (currentIndex < validRows.length) {
    const remaining = validRows.slice(currentIndex);
    const currentBatch = [];
    const skippedJobs = [];

    // Build batch
    for (const row of remaining) {
      if (currentBatch.length >= BATCH_SIZE) break;

      const linkedin = getLinkedInUrl(row.linkedin);
      if (!linkedin) {
        skippedJobs.push({ row, status: "No LinkedIn URL" });
        continue;
      }
      if (linkedin.includes("/company/")) {
        skippedJobs.push({ row, status: "Company Page" });
        continue;
      }
      currentBatch.push({ row, linkedin });
    }

    // Process skipped jobs first
    if (skippedJobs.length > 0) {
      for (const item of skippedJobs) {
        log(`Skipping Row #${item.row.id}: ${item.status}`, "warn");
        processedResults.push({
          id: item.row.id,
          company: item.row.company,
          linkedin: item.row.linkedin,
          email: "",
          status: item.status,
          timestamp: new Date().toISOString(),
          raw: item.row.raw
        });
        currentIndex++;
      }
      await saveCheckpoint(currentIndex, processedResults);
    }

    if (currentBatch.length === 0) {
      if (currentIndex < validRows.length) {
        continue;
      }
      break;
    }

    // Run batch via Apify
    const urls = currentBatch.map(b => b.linkedin);
    const rowIds = currentBatch.map(b => b.row.id);
    log(`Processing batch of ${currentBatch.length} profiles (Row #${rowIds[0]} to #${rowIds[rowIds.length-1]})...`);

    try {
      const runInfo = await startApifyRun(urls);
      const runId = runInfo.id;
      const datasetId = runInfo.defaultDatasetId || runInfo.datasetId;
      log(`Apify run started successfully. Run ID: ${runId}`);

      // Poll run status
      let status = runInfo.status;
      while (status === 'READY' || status === 'RUNNING') {
        await new Promise(resolve => setTimeout(resolve, 5000));
        status = await pollApifyRun(runId);
        log(`Apify run status: ${status}`);
      }

      if (status !== 'SUCCEEDED') {
        throw new Error(`Apify run failed with state: ${status}`);
      }

      // Fetch dataset
      log("Retrieving scraped dataset items from Apify...");
      const items = await fetchDatasetItems(datasetId);
      log(`Fetched ${items.length} records. Mapping results...`);

      // Check for hardcoded actor limit
      const hasActorLimit = items.some(item => {
        const nameVal = String(item["01_Name"] || "").toLowerCase();
        const queryVal = String(item["17_Query_linkedin"] || "").toLowerCase();
        return nameVal.includes("free users are limited") || queryVal.includes("limit_reached");
      });

      if (hasActorLimit) {
        log("Apify Actor Limit Reached: Free users are limited to 1000 results.", "error");
        log("Please upgrade your Apify actor subscription or use a new Apify token/account.", "error");
        
        // Mark remaining batch profiles as Limit Reached
        for (const b of currentBatch) {
          processedResults.push({
            id: b.row.id,
            company: b.row.company,
            linkedin: b.linkedin,
            email: "",
            status: "Limit Reached",
            timestamp: new Date().toISOString(),
            raw: b.row.raw
          });
          currentIndex++;
        }
        await saveCheckpoint(currentIndex, processedResults);
        throw new Error("Apify Actor Limit Reached. Scraper stopped.");
      }

      // Map dataset items by normalized LinkedIn URL
      const itemsMap = new Map();
      for (const item of items) {
        const itemUrl = getLinkedinFromItem(item);
        if (itemUrl) {
          itemsMap.set(normalizeUrl(itemUrl), item);
        }
      }

      // Save results
      for (const b of currentBatch) {
        const normUrl = normalizeUrl(b.linkedin);
        const result = itemsMap.get(normUrl);

        let email = "";
        let finalStatus = "Email Not Found";

        if (!result) {
          finalStatus = "No Results";
        } else {
          email = getValidEmail(result);
          if (email) {
            finalStatus = "Found";
            log(`Found email for Row #${b.row.id} (${b.row.company}): ${email}`, "success");
          } else {
            const errMsg = result.errorMessage || result.error || "";
            if (errMsg.toLowerCase().includes("limit") || errMsg.toLowerCase().includes("monthly")) {
              finalStatus = "Limit Reached";
            }
          }
        }

        processedResults.push({
          id: b.row.id,
          company: b.row.company,
          linkedin: b.linkedin,
          email,
          status: finalStatus,
          scrapedName: result ? (result["01_Name"] || result.name || "") : "",
          scrapedTitle: result ? (result["03_Title"] || result.title || "") : "",
          scrapedCompany: result ? (result["04_Company"] || result.company || "") : "",
          scrapedLinkedIn: result ? (result["06_Linkedin_url"] || result.linkedin || "") : "",
          timestamp: new Date().toISOString(),
          raw: b.row.raw
        });

        currentIndex++;
      }

      await saveCheckpoint(currentIndex, processedResults);

    } catch (e) {
      log(`Failed to process batch: ${e.message}`, "error");
      if (e.message.includes("Limit Reached")) {
        throw e;
      }
      log("Marking batch jobs as failed and waiting 10s before retry...", "warn");
      
      // Fallback: Mark this batch as failed so progress can move forward if needed
      for (const b of currentBatch) {
        processedResults.push({
          id: b.row.id,
          company: b.row.company,
          linkedin: b.linkedin,
          email: "",
          status: "Failed",
          timestamp: new Date().toISOString(),
          raw: b.row.raw
        });
        currentIndex++;
      }
      await saveCheckpoint(currentIndex, processedResults);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  log("🎉 CLI Scraper completed successfully! All rows processed.", "success");
  
  // Clean up checkpoint
  if (fs.existsSync(CHECKPOINT_FILE)) {
    fs.unlinkSync(CHECKPOINT_FILE);
  }
}

async function saveCheckpoint(currentIndex, results) {
  // Save checkpoint file first (unlocked, always succeeds)
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ currentIndex, results }, null, 2));

  // Try writing to excel
  let success = false;
  while (!success) {
    try {
      saveToExcel(results, OUTPUT_FILE);
      success = true;
    } catch (err) {
      if (err.code === 'EBUSY' || err.message.includes('EBUSY') || err.message.includes('locked')) {
        log(`Excel file '${path.basename(OUTPUT_FILE)}' is busy/locked (probably open in Microsoft Excel).`, "warn");
        log("Please close the Excel file so progress can be saved. Retrying in 5 seconds...", "warn");
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        throw err;
      }
    }
  }

  log(`Checkpoint saved: ${currentIndex} rows processed. Output written to '${path.basename(OUTPUT_FILE)}'.`);
}

main().catch(err => {
  log(`Fatal Scraper Error: ${err.message}`, "error");
});
