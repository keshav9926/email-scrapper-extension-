// utils/Export.js
// Progressively appends scraped records and exports them to Excel.

import { exportToExcelDataUrl } from '../excel/writer.js';
import { saveResults, getResults } from './storage.js';

export class ExportManager {
  constructor() {
    this.results = [];
  }

  async load() {
    this.results = await getResults();
  }

  appendResultInMemory(jobId, rowData) {
    const existingIndex = this.results.findIndex(r => r.id === jobId);
    const formattedResult = {
      id: jobId,
      company: rowData.company || `Row ${jobId}`,
      linkedin: rowData.linkedin,
      email: rowData.email || "",
      status: rowData.status || "Not Found",
      timestamp: new Date().toISOString(),
      raw: rowData.raw || null,
      scrapedName: rowData.scrapedName || "",
      scrapedTitle: rowData.scrapedTitle || "",
      scrapedCompany: rowData.scrapedCompany || "",
      scrapedLinkedin: rowData.scrapedLinkedin || ""
    };

    if (existingIndex > -1) {
      this.results[existingIndex] = formattedResult;
    } else {
      this.results.push(formattedResult);
    }
  }

  async save() {
    await saveResults(this.results);
  }

  async appendResult(jobId, rowData) {
    await this.load();
    this.appendResultInMemory(jobId, rowData);
    await this.save();
  }

  async getExcelDataUrl() {
    await this.load();
    return exportToExcelDataUrl(this.results);
  }

  clear() {
    this.results = [];
  }
}
