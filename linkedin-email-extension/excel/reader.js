// excel/reader.js
// Assumes XLSX library is loaded (globally in popup/background)

/**
 * Reads an Excel file and returns rows using column I (index 8) as the LinkedIn URL.
 * Column I is always the individual's LinkedIn profile URL.
 */
export function readExcel(arrayBuffer) {
  if (typeof XLSX === 'undefined') {
    throw new Error("SheetJS (XLSX) library is not loaded.");
  }

  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];

  // header: 1 → returns raw arrays, no header interpretation
  const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "" });

  const results = [];

  for (let i = 1; i < rawRows.length; i++) { // skip row 0 (header)
    const row = rawRows[i];
    const linkedinRaw = String(row[8] || "").trim(); // Column I = index 8

    // Skip rows where column I is empty or not a LinkedIn URL
    if (!linkedinRaw || !linkedinRaw.includes("linkedin.com/")) continue;

    // Normalize URL
    let linkedin = linkedinRaw;
    if (!linkedin.startsWith("http")) {
      linkedin = "https://" + linkedin;
    }
    linkedin = linkedin.replace("http://", "https://")
                       .replace("https://linkedin.com/", "https://www.linkedin.com/");

    results.push({
      id: i + 1,
      company: String(row[0] || "Unknown").trim(), // Column A as fallback name/company
      linkedin,
      raw: row
    });
  }

  return results;
}
