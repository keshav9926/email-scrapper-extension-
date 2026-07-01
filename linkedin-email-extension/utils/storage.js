// utils/storage.js

/**
 * Saves the current state of automation as a checkpoint.
 * @param {Object} state - { currentIndex, results, queue, totalJobs, isRunning }
 */
export async function saveCheckpoint(state) {
  await chrome.storage.local.set({ checkpoint: state });
}

/**
 * Retrieves the saved checkpoint if it exists.
 * @returns {Promise<Object|null>}
 */
export async function getCheckpoint() {
  const data = await chrome.storage.local.get('checkpoint');
  return data.checkpoint || null;
}

/**
 * Clears the saved checkpoint.
 */
export async function clearCheckpoint() {
  await chrome.storage.local.remove('checkpoint');
}

/**
 * Saves current processed results.
 * @param {Array<Object>} results 
 */
export async function saveResults(results) {
  await chrome.storage.local.set({ scrape_results: results });
}

/**
 * Retrieves all saved results.
 * @returns {Promise<Array<Object>>}
 */
export async function getResults() {
  const data = await chrome.storage.local.get('scrape_results');
  return data.scrape_results || [];
}

/**
 * Clears both the checkpoint and saved results to start a new job.
 */
export async function clearAll() {
  await chrome.storage.local.remove(['checkpoint', 'scrape_results']);
}
