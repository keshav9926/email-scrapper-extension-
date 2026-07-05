// utils/storage.js

/**
 * Saves the current state of automation as a checkpoint.
 * @param {Object} state - { currentIndex, results, queue, totalJobs, isRunning }
 */
export async function saveCheckpoint(state) {
  try {
    await chrome.storage.local.set({ checkpoint: state });
  } catch (err) {
    console.error("[Storage] Failed to save checkpoint:", err);
  }
}

/**
 * Retrieves the saved checkpoint if it exists.
 * @returns {Promise<Object|null>}
 */
export async function getCheckpoint() {
  try {
    const data = await chrome.storage.local.get('checkpoint');
    return data.checkpoint || null;
  } catch (err) {
    console.error("[Storage] Failed to get checkpoint:", err);
    return null;
  }
}

/**
 * Clears the saved checkpoint.
 */
export async function clearCheckpoint() {
  try {
    await chrome.storage.local.remove('checkpoint');
  } catch (err) {
    console.error("[Storage] Failed to clear checkpoint:", err);
  }
}

/**
 * Saves current processed results.
 * @param {Array<Object>} results 
 */
export async function saveResults(results) {
  try {
    await chrome.storage.local.set({ scrape_results: results });
  } catch (err) {
    console.error("[Storage] Failed to save results:", err);
  }
}

/**
 * Retrieves all saved results.
 * @returns {Promise<Array<Object>>}
 */
export async function getResults() {
  try {
    const data = await chrome.storage.local.get('scrape_results');
    return data.scrape_results || [];
  } catch (err) {
    console.error("[Storage] Failed to get results:", err);
    return [];
  }
}

/**
 * Clears both the checkpoint and saved results to start a new job.
 */
export async function clearAll() {
  try {
    await chrome.storage.local.remove(['checkpoint', 'scrape_results', 'original_rows']);
  } catch (err) {
    console.error("[Storage] Failed to clear all:", err);
  }
}
