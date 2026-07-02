// excel/writer.js
// Assumes XLSX library is loaded (globally in popup/background)

/**
 * Converts results array to an Excel file represented as a base64 Data URL.
 * @param {Array<Object>} results List of scraped results
 * @returns {string} Data URL containing the Excel file
 */
export function exportToExcelDataUrl(results) {
  if (typeof XLSX === 'undefined') {
    throw new Error("SheetJS (XLSX) library is not loaded.");
  }
  const wb = XLSX.utils.book_new();
  
  // Format rows for Excel export
  const data = results.map(item => {
    const row = {
      "Company Name": item.company,
      "LinkedIn URL": item.linkedin,
      "Email": item.email || "",
      "Status": item.status || "Not Found",
      "Scraped Name": item.scrapedName || "",
      "Scraped Title": item.scrapedTitle || "",
      "Scraped Company": item.scrapedCompany || "",
      "Scraped LinkedIn": item.scrapedLinkedin || "",
      "Timestamp": item.timestamp || new Date().toISOString()
    };
    
    // Add any original spreadsheet columns back, excluding the fields we mapped
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

  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "Scrape Results");
  
  // Write to base64 string
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${wbout}`;
}
