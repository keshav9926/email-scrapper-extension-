// utils/QueueManager.js
// Advanced queue manager tracking job execution states for crash resilience.

export class QueueManager {
  constructor(jobs = []) {
    this.jobs = jobs; // array of { id, data, state }
  }

  /**
   * Initialize queue from fresh Excel rows.
   */
  initialize(rows) {
    this.jobs = rows.map((row) => ({
      id: row.id, // Preserve original spreadsheet row number
      data: { ...row, email: row.email || "", status: row.status || "" },
      state: 'Pending'
    }));
  }

  /**
   * Gets the next Pending job and marks it as Running.
   */
  getNextPending() {
    const job = this.jobs.find(j => j.state === 'Pending');
    if (job) {
      job.state = 'Running';
    }
    return job;
  }

  /**
   * Gets up to batchSize Pending jobs and marks them as Running.
   */
  getNextPendingBatch(batchSize) {
    const pendingJobs = this.jobs.filter(j => j.state === 'Pending');
    const batch = pendingJobs.slice(0, batchSize);
    for (const job of batch) {
      job.state = 'Running';
    }
    return batch;
  }

  /**
   * Mark a job as Done with its scraped result.
   */
  markDone(jobId, resultData = {}) {
    const job = this.jobs.find(j => j.id === jobId);
    if (job) {
      job.state = 'Done';
      job.data = { ...job.data, ...resultData, status: resultData.status || 'Found' };
    }
  }

  /**
   * Mark a job as Failed with its error status.
   */
  markFailed(jobId, statusMessage = 'Failed') {
    const job = this.jobs.find(j => j.id === jobId);
    if (job) {
      job.state = 'Failed';
      job.data = { ...job.data, status: statusMessage };
    }
  }

  /**
   * Serialize state to store in chrome.storage.
   */
  serialize() {
    return this.jobs;
  }

  /**
   * Deserialize/restore state from chrome.storage.
   * Any jobs stuck in 'Running' state (from a crashed/killed service worker)
   * are reset to 'Pending' so they are retried on next run.
   */
  restore(serializedJobs) {
    if (Array.isArray(serializedJobs)) {
      this.jobs = serializedJobs;
      this.resetRunningToPending(); // crash recovery
    }
  }

  /**
   * Resets any orphaned 'Running' jobs back to 'Pending'.
   * Called on restore to recover from service worker termination mid-job.
   */
  resetRunningToPending() {
    let recovered = 0;
    for (const job of this.jobs) {
      if (job.state === 'Running') {
        job.state = 'Pending';
        recovered++;
      }
    }
    if (recovered > 0) {
      console.warn(`[QueueManager] Recovered ${recovered} orphaned job(s) from 'Running' → 'Pending'.`);
    }
  }

  getPending() {
    return this.jobs.filter(j => j.state === 'Pending');
  }

  getRunning() {
    return this.jobs.filter(j => j.state === 'Running');
  }

  getDone() {
    return this.jobs.filter(j => j.state === 'Done');
  }

  getFailed() {
    return this.jobs.filter(j => j.state === 'Failed');
  }

  size() {
    return this.jobs.length;
  }

  isEmpty() {
    return this.getPending().length === 0;
  }

  /**
   * Marks all jobs with id < startFromRow as 'Skipped'.
   * They count toward processed total (for correct progress %) but are never run.
   * Since jobs are initialized in spreadsheet row order, this guarantees
   * we start from exactly the Nth row of the original file.
   */
  skipBefore(startFromRow) {
    let count = 0;
    for (const job of this.jobs) {
      if (job.id < startFromRow && job.state === 'Pending') {
        job.state = 'Skipped';
        job.data = { ...job.data, status: 'Skipped' };
        count++;
      }
    }
    return count;
  }

  /**
   * Marks all jobs up to AND INCLUDING the one matching resumeUrl as 'Skipped'.
   * Uses normalized URL comparison (lowercase, trailing slash stripped) for robustness.
   * This is the recommended resume method — pass the LinkedIn URL of the last processed person.
   */
  skipUpToAndIncluding(resumeUrl) {
    if (!resumeUrl) return 0;

    const normalize = (url) => String(url || '').toLowerCase().trim().replace(/\/$/, '');
    const targetNorm = normalize(resumeUrl);

    // Find the job whose linkedin URL matches
    let matchId = -1;
    for (const job of this.jobs) {
      const jobUrl = normalize(job.data.linkedin || '');
      if (jobUrl === targetNorm) {
        matchId = job.id;
        break;
      }
    }

    if (matchId === -1) return 0; // URL not found in queue

    // Mark all jobs up to and including matchId as Skipped
    let count = 0;
    for (const job of this.jobs) {
      if (job.id <= matchId && job.state === 'Pending') {
        job.state = 'Skipped';
        job.data = { ...job.data, status: 'Skipped' };
        count++;
      }
    }
    return count;
  }

  /**
   * Marks all jobs with id > endAtRow as 'Skipped'.
   * Use this to cap processing at a specific row number (inclusive end).
   * e.g. skipFrom(2132) means process rows up to and INCLUDING 2132, skip everything after.
   */
  skipFrom(endAtRow) {
    let count = 0;
    for (const job of this.jobs) {
      if (job.id > endAtRow && job.state === 'Pending') {
        job.state = 'Skipped';
        job.data = { ...job.data, status: 'Skipped' };
        count++;
      }
    }
    return count;
  }

  getSkipped() {
    return this.jobs.filter(j => j.state === 'Skipped');
  }

  clear() {
    this.jobs = [];
  }
}
