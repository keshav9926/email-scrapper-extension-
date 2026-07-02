// excel/reader.js
// Assumes XLSX library is loaded (globally in popup/background)

/**
 * Reads an Excel file (ArrayBuffer) and returns normalized row objects.
 * @param {ArrayBuffer} arrayBuffer 
 * @returns {Array<Object>} list of rows with company and linkedin fields
 */
export function readExcel(arrayBuffer) {
  if (typeof XLSX === 'undefined') {
    throw new Error("SheetJS (XLSX) library is not loaded.");
  }
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const rawRows = XLSX.utils.sheet_to_json(worksheet);
  
  return rawRows.map((row, index) => {
    let linkedinUrl = "";
    let companyName = "";
    
    for (const key of Object.keys(row)) {
      const lowerKey = key.toLowerCase().trim();
      if (lowerKey.includes("linkedin") || lowerKey === "url" || lowerKey === "profile" || lowerKey === "link") {
        linkedinUrl = String(row[key]).trim();
      }
      if (lowerKey.includes("company") || lowerKey.includes("firm")) {
        companyName = String(row[key]).trim();
      } else if (lowerKey === "name" && !companyName) {
        companyName = String(row[key]).trim();
      }
    }
    
    return {
      id: index + 1,
      company: companyName || "Unknown",
      linkedin: (linkedinUrl && linkedinUrl.startsWith("https://www.linkedin.com/")) ? linkedinUrl.trim() : "",
      raw: row
    };
  });
}
