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
    this.jobs = rows.map((row, index) => ({
      id: index + 1, // 1-indexed row number
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
   */
  restore(serializedJobs) {
    if (Array.isArray(serializedJobs)) {
      this.jobs = serializedJobs;
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

  clear() {
    this.jobs = [];
  }
}
