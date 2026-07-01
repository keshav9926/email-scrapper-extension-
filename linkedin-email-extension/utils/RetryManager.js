// utils/RetryManager.js
// Asynchronous action retry manager.

(function() {
  const RetryManager = {
    async retry(actionFn, maxRetries = 5, delayMs = 1000, onRetry = null) {
      let lastError = null;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          return await actionFn(attempt);
        } catch (err) {
          lastError = err;
          if (onRetry) {
            onRetry(attempt, maxRetries, err);
          }
          if (attempt < maxRetries) {
            await new Promise(res => setTimeout(res, delayMs));
          }
        }
      }
      throw lastError || new Error(`Action failed after ${maxRetries} attempts`);
    }
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.RetryManager = RetryManager;
  } else if (typeof window !== 'undefined') {
    window.RetryManager = RetryManager;
  }
})();
