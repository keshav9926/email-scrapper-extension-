// utils/DOMObserver.js
// MutationObserver wrappers to react immediately to DOM changes.

(function() {
  const DOMObserver = {
    async waitForElementAddition(selector, parent = document.body, timeoutMs = 15000) {
      if (typeof querySelectorAllInclusive === 'function') {
        const existing = querySelectorAllInclusive(selector, parent)[0];
        if (existing) return existing;
      }

      return new Promise((resolve, reject) => {
        const observer = new MutationObserver((mutations, obs) => {
          if (typeof querySelectorAllInclusive === 'function') {
            const found = querySelectorAllInclusive(selector, parent)[0];
            if (found) {
              obs.disconnect();
              resolve(found);
            }
          }
        });

        observer.observe(parent, {
          childList: true,
          subtree: true
        });

        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Timeout waiting for element addition: "${selector}"`));
        }, timeoutMs);
      });
    }
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.DOMObserver = DOMObserver;
  } else if (typeof window !== 'undefined') {
    window.DOMObserver = DOMObserver;
  }
})();
