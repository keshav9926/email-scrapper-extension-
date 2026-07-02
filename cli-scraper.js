#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';

// ANSI escape codes for coloring terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  underscore: "\x1b[4m",
  blink: "\x1b[5m",
  reverse: "\x1b[7m",
  hidden: "\x1b[8m",
  
  fgBlack: "\x1b[30m",
  fgRed: "\x1b[31m",
  fgGreen: "\x1b[32m",
  fgYellow: "\x1b[33m",
  fgBlue: "\x1b[34m",
  fgMagenta: "\x1b[35m",
  fgCyan: "\x1b[36m",
  fgWhite: "\x1b[37m",
  fgGray: "\x1b[90m"
};

function log(msg, color = colors.reset) {
  console.log(`${color}${msg}${colors.reset}`);
}

// 1. Locate Apify Token
let APIFY_TOKEN = "";
const envPaths = [
  path.join('.', '.env'),
  path.join('linkedin-email-extension', '.env')
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf8');
    const tokenMatch = text.match(/token=([a-zA-Z0-9_]+)/i);
    if (tokenMatch) {
      APIFY_TOKEN = tokenMatch[1];
      break;
    }
  }
}

if (!APIFY_TOKEN) {
  log("❌ Error: Apify API token not found!", colors.fgRed);
  log("Please create a .env file containing your token in the root folder:", colors.fgYellow);
  log("token=YOUR_APIFY_TOKEN", colors.fgCyan);
  process.exit(1);
}

log(`🔑 Apify token loaded: ${APIFY_TOKEN.substring(0, 8)}...`, colors.fgGreen);

// 2. Locate input Excel file
let filePath = process.argv[2];

if (!filePath) {
  // Scan directory for any .xlsx or .xls file (excluding output scraped_ files and temporary files starting with ~$)
  const files = fs.readdirSync('.').filter(file => {
    const ext = path.extname(file).toLowerCase();
    return (ext === '.xlsx' || ext === '.xls') && 
           !file.startsWith('~$') && 
           !file.startsWith('scraped_') &&
           file !== 'package-lock.json' &&
           file !== 'package.json';
  });
  
  if (files.length === 1) {
    filePath = files[0];
    log(`📂 Automatically detected Excel file: ${filePath}`, colors.fgCyan);
  } else if (files.length > 1) {
    log(`❌ Error: Multiple Excel files found in the current directory:`, colors.fgRed);
    files.forEach(f => log(`  - ${f}`, colors.fgYellow));
    log(`Please specify which file to process: node cli-scraper.js <filename>`, colors.fgCyan);
    process.exit(1);
  } else {
    log("❌ Error: No Excel file (.xlsx or .xls) detected in the current directory.", colors.fgRed);
    log("Please copy your Excel file into this directory or specify its path: node cli-scraper.js <path-to-file>", colors.fgCyan);
    process.exit(1);
  }
}

if (!fs.existsSync(filePath)) {
  log(`❌ Error: File not found at path "${filePath}"`, colors.fgRed);
  process.exit(1);
}

// 3. Read spreadsheet workbook
log(`📖 Reading spreadsheet "${filePath}"...`, colors.fgCyan);
let workbook;
try {
  workbook = XLSX.readFile(filePath);
} catch (err) {
  log(`❌ Failed to read spreadsheet: ${err.message}`, colors.fgRed);
  process.exit(1);
}

const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(worksheet);

if (rows.length === 0) {
  log("❌ Error: The Excel file contains no readable rows of data.", colors.fgRed);
  process.exit(1);
}

log(`📊 Loaded sheet "${sheetName}" with ${rows.length} rows of data.`, colors.fgGreen);

// 4. Identify columns
let linkedinKey = null;
let companyKey = null;
let emailKey = "Email";
let statusKey = "Status";

const firstRow = rows[0];
const headers = Object.keys(firstRow);

for (const header of headers) {
  const lower = header.toLowerCase().trim();
  if (lower.includes("linkedin") || lower === "profile" || lower === "url" || lower === "link") {
    linkedinKey = header;
  }
  if (lower.includes("company") || lower.includes("firm") || lower === "name") {
    companyKey = header;
  }
  if (lower === "email") {
    emailKey = header;
  }
  if (lower === "status") {
    statusKey = header;
  }
}

if (!linkedinKey) {
  log("❌ Error: Could not detect any column containing LinkedIn URLs.", colors.fgRed);
  log(`Available columns: ${headers.join(", ")}`, colors.fgYellow);
  log("Please ensure one of your Excel headers is named 'LinkedIn', 'Profile', or 'URL'.", colors.fgCyan);
  process.exit(1);
}

log(`🔍 Mapped LinkedIn column to: "${linkedinKey}"`, colors.fgCyan);
if (companyKey) {
  log(`🔍 Mapped Company column to: "${companyKey}"`, colors.fgCyan);
}

// Define output file path
const parsedPath = path.parse(filePath);
const outputFileName = `scraped_${parsedPath.name}${parsedPath.ext}`;
const outputFilePath = path.join(parsedPath.dir, outputFileName);

log(`💾 Progress will be saved continuously to: "${outputFileName}"`, colors.fgCyan);

// Helper to normalize input into a valid LinkedIn URL
function getLinkedInUrl(val) {
  if (!val) return null;
  val = String(val).trim();
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

// Helper to safely extract a valid email
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

// Apify actor communication functions
const APIFY_ACTOR_KEY = "x_guru~linkedin-email-Scraper-no-cookies";

async function startApifyRun(linkedinUrl) {
  const endpoint = `https://api.apify.com/v2/acts/${APIFY_ACTOR_KEY}/runs?token=${APIFY_TOKEN}`;
  const payload = {
    includePersonalEmails: true,
    includeWorkEmails: true,
    onlyWithEmails: true,
    linkedinUrls: [linkedinUrl],
    profileUrls: [linkedinUrl]
  };
  
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Apify Run Failed: HTTP ${response.status} - ${errText}`);
  }
  
  const json = await response.json();
  return json.data;
}

async function pollApifyRun(runId) {
  const endpoint = `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Failed to check run status: HTTP ${response.status}`);
  }
  const json = await response.json();
  return json.data.status;
}

async function fetchDatasetItems(datasetId) {
  const endpoint = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`;
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Failed to fetch dataset items: HTTP ${response.status}`);
  }
  return await response.json();
}

// Main Runner
async function main() {
  const startTime = Date.now();
  let foundCount = 0;
  let noEmailCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  
  log(`🚀 Starting scraping process...`, colors.bright + colors.fgMagenta);
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const indexStr = `[${i + 1}/${rows.length}]`;
    
    // Check if already processed (Resumability)
    if (row[emailKey] && String(row[emailKey]).includes('@')) {
      log(`${colors.fgGray}${indexStr} Skipping Row: Already has email (${row[emailKey]})${colors.reset}`);
      skippedCount++;
      continue;
    }
    
    const rawUrl = row[linkedinKey];
    const linkedin = getLinkedInUrl(rawUrl);
    
    if (!linkedin) {
      log(`${colors.fgYellow}${indexStr} Skipping Row: No valid LinkedIn URL found (${rawUrl || "Empty"})${colors.reset}`);
      row[emailKey] = "";
      row[statusKey] = "No LinkedIn URL";
      noEmailCount++;
      
      // Save progress
      saveProgress();
      continue;
    }
    
    log(`\n${colors.bright}${colors.fgCyan}${indexStr} Scraping: ${linkedin}${colors.reset}`);
    
    let runId = null;
    try {
      // 1. Start Apify Actor
      log(`  ⏳ Starting Apify actor...`, colors.fgGray);
      const runInfo = await startApifyRun(linkedin);
      runId = runInfo.id;
      const datasetId = runInfo.defaultDatasetId;
      
      // 2. Poll Status
      let status = runInfo.status;
      while (status === 'READY' || status === 'RUNNING') {
        await new Promise(resolve => setTimeout(resolve, 3000));
        status = await pollApifyRun(runId);
        log(`  ⏳ Status: ${status}`, colors.fgGray);
      }
      
      if (status !== 'SUCCEEDED') {
        throw new Error(`Apify run ended with status: ${status}`);
      }
      
      // 3. Fetch Items
      log(`  📥 Fetching dataset results...`, colors.fgGray);
      const items = await fetchDatasetItems(datasetId);
      
      // 4. Save and Parse
      const result = items[0];
      const email = getValidEmail(result);
      
      if (email) {
        row[emailKey] = email;
        row[statusKey] = "Found";
        foundCount++;
        log(`  ✅ Email Found: ${colors.bright}${colors.fgGreen}${email}${colors.reset}`);
      } else {
        row[emailKey] = "";
        row[statusKey] = "No Email";
        noEmailCount++;
        log(`  ❌ No Email Found`, colors.fgYellow);
      }
      
    } catch (err) {
      log(`  ❌ Error processing row: ${err.message}`, colors.fgRed);
      row[statusKey] = `Failed: ${err.message || err}`;
      errorCount++;
    }
    
    // Save progress after every row to prevent losing work
    saveProgress();
    
    // Short wait between requests to Apify
    if (i < rows.length - 1) {
      const waitTime = 1500 + Math.random() * 500;
      await new Promise(res => setTimeout(res, waitTime));
    }
  }
  
  // Finish and display stats
  const totalDurationSec = Math.round((Date.now() - startTime) / 1000);
  const minutes = Math.floor(totalDurationSec / 60);
  const seconds = totalDurationSec % 60;
  
  log(`\n==================================================`, colors.bright + colors.fgMagenta);
  log(`🏁 Scraper Finished!`, colors.bright + colors.fgGreen);
  log(`==================================================`, colors.bright + colors.fgMagenta);
  log(`⏱️  Total Duration: ${minutes}m ${seconds}s`, colors.fgCyan);
  log(`📈 Total Rows:     ${rows.length}`, colors.fgCyan);
  log(`✅ Emails Found:    ${foundCount}`, colors.fgGreen);
  log(`❌ No Email:        ${noEmailCount}`, colors.fgYellow);
  log(`⚠️  Errors:          ${errorCount}`, colors.fgRed);
  log(`⏭️  Skipped:         ${skippedCount}`, colors.fgGray);
  log(`💾 Output File:     ${outputFileName}`, colors.bright + colors.fgGreen);
  log(`==================================================\n`, colors.bright + colors.fgMagenta);
  
  function saveProgress() {
    try {
      const newWs = XLSX.utils.json_to_sheet(rows);
      workbook.Sheets[sheetName] = newWs;
      XLSX.writeFile(workbook, outputFilePath);
    } catch (err) {
      log(`⚠️ Warning: Failed to write progress to Excel file: ${err.message}`, colors.fgYellow);
    }
  }
}

main().catch(err => {
  log(`💥 Critical Script Error: ${err.stack || err}`, colors.fgRed);
  process.exit(1);
});
