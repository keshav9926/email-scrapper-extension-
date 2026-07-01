// utils/WaitManager.js
// Asynchronous element and condition waiting utilities.

(function() {
  const WaitManager = {
    timeout(ms, message = "Timeout exceeded") {
      return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
    },

    async waitUntil(checkFn, timeoutMs = 15000, intervalMs = 250) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        try {
          const res = await checkFn();
          if (res) return res;
        } catch (e) {}
        await new Promise(res => setTimeout(res, intervalMs));
      }
      throw new Error(`Wait condition not met within ${timeoutMs}ms`);
    },

    async waitForElement(selector, root = document, timeoutMs = 15000) {
      return this.waitUntil(() => {
        return querySelectorAllInclusive(selector, root)[0] || null;
      }, timeoutMs);
    },

    async waitForDisappear(selector, root = document, timeoutMs = 15000) {
      return this.waitUntil(() => {
        const found = querySelectorAllInclusive(selector, root)[0];
        return !found;
      }, timeoutMs);
    },

    waitForMutation(targetNode, config, conditionFn, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const observer = new MutationObserver((mutations, obs) => {
          if (conditionFn(mutations)) {
            obs.disconnect();
            resolve(true);
          }
        });
        
        observer.observe(targetNode, config);
        
        setTimeout(() => {
          observer.disconnect();
          reject(new Error("Mutation wait timeout"));
        }, timeoutMs);
      });
    }
  };

  function querySelectorAllInclusive(selector, root = document) {
    const results = [];
    function traverse(node) {
      if (!node) return;
      if (node.matches && node.matches(selector)) {
        results.push(node);
      }
      let child = node.firstElementChild;
      while (child) {
        traverse(child);
        child = child.nextElementSibling;
      }
      if (node.shadowRoot) {
        traverse(node.shadowRoot);
      }
    }
    traverse(root);
    return results;
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.WaitManager = WaitManager;
    globalThis.querySelectorAllInclusive = querySelectorAllInclusive;
  } else if (typeof window !== 'undefined') {
    window.WaitManager = WaitManager;
    window.querySelectorAllInclusive = querySelectorAllInclusive;
  }
})();
