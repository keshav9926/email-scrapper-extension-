# LinkedIn Email Scraper Chrome Extension

A high-performance Chrome Extension designed to resolve valid email addresses from a list of LinkedIn profiles. The extension integrates with **Apify** using the **`snipercoder~bulk-linkedin-email-finder`** actor, running 100% in the background to achieve maximum speed, stability, and efficiency without opening browser tabs for profile navigation.

---

## Features

- **Multi-Source Input:** 
  - **Excel Upload:** Upload `.xlsx` files directly.
  - **Google Sheets Integration:** Automatically load sheets via URL. Supports private sheets by fetching through the active tab credentials.
- **Background Execution:** Queries Apify actor endpoints and polls for results asynchronously in a background service worker.
- **Enriched Metadata Export:** Exports results back to a custom Excel file containing:
  - Original spreadsheet fields
  - Resolved Email
  - Scraping Status (`Found`, `Email Not Found`, `Unknown`, `Failed`)
  - Enriched Profile Metadata (`Scraped Name`, `Scraped Title`, `Scraped Company`, `Scraped LinkedIn`)
- **Robust Crash Recovery:** Checkpoints the queue status automatically to `chrome.storage.local`. If the browser restarts or crashes, the execution resumes exactly where it left off.
- **Pluggable Architecture:** Easily adjustable actor keys and input/output mapping functions.

---

## Project Structure

```text
linkedin-email-extension/
├── icons/                 # Extension toolbar icons (16x16, 48x48, 128x128)
├── excel/
│   ├── reader.js          # Client-side Excel parser (SheetJS wrapper)
│   ├── writer.js          # Client-side Excel builder & formatter
│   └── xlsx.full.min.js   # SheetJS library distribution
├── utils/
│   ├── StateMachine.js    # FSM managing service worker progress states
│   ├── QueueManager.js    # Memory-backed job queue tracker
│   ├── Export.js          # Scrape result storage & formatting formatter
│   ├── storage.js         # Chrome storage wrapper for checkpoint persistence
│   └── logger.js          # Custom background console & visual logger
├── .env                   # Configuration file containing Apify API token
├── manifest.json          # Chrome Extension Manifest V3 configuration
├── background.js          # Main service worker execution engine
├── popup.html             # Premium glassmorphic extension UI layout
├── popup.css              # Dashboard styling rules (dark-mode theme)
└── popup.js               # Frontend UI handlers and runtime message listener
```

---

## Installation & Setup

### 1. Configure the Apify API Token & Actors
Create a file named `.env` in the root of the `linkedin-email-extension` directory and customize your configuration:
```env
# Required: Your Apify API Token
token=YOUR_APIFY_API_TOKEN

# Optional: Override the default primary Apify Actor (default is snipercoder~bulk-linkedin-email-finder)
actor=snipercoder~bulk-linkedin-email-finder

# Optional: Set a fallback actor to run if the primary actor returns "Email Not Found"
fallback_actor=apify~apollo-scraper

# Optional: Set a fallback Apify API token (defaults to primary token if omitted)
fallback_token=YOUR_FALLBACK_APIFY_API_TOKEN
```

### 2. Load the Chrome Extension
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** in the top-left corner.
4. Select the `linkedin-email-extension/` directory.

---

## How to Use

1. Click the Extension icon in your browser toolbar to open the popup.
2. **Import Profiles:**
   - **Upload Excel File:** Drag-and-drop or click to upload an `.xlsx` file containing a column with LinkedIn URLs.
   - **Load Google Sheet:** Enter a Google Sheets link in the URL box and click "Load URL". (Ensure the sheet is active or readable).
3. **Scrape & Monitor:**
   - Monitor the progress percentage, processed rows, and discovered emails in real-time on the dashboard.
   - Pause, Resume, or Stop the queue at any time.
4. **Download Results:**
   - Click **Download Results** to retrieve the compiled Excel spreadsheet containing emails, status, and enriched profile details.
