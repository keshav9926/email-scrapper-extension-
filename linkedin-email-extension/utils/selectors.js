// utils/selectors.js
// Centralized DOM selectors for LinkedIn and SalesQL extension interfaces.

(function() {
  const selectors = {
    linkedin: {
      readyIndicators: [
        '.scaffold-layout',
        'h1.text-heading-xlarge',
        '.pv-text-details__left-panel',
        '#profile-wrapper'
      ],
      contactInfoLink: 'a[href*="/overlay/contact-info/"], #topcard-contact-info'
    },
    salesql: {
      iframes: 'iframe[src*="salesql"], iframe[id*="salesql"]',
      popup: 'sq-popup, [class*="salesql-popup"], [class*="salesql-widget"], .salesql-container, sq-root',
      widgetReady: [
        'sq-button',
        '.salesql-button',
        '[class*="salesql"]',
        '[id*="salesql"]',
        'iframe[src*="salesql"]'
      ],
      revealButton: 'sq-button, button.salesql-button, .salesql-reveal-button, [class*="salesql-button"]',
      revealTextKeywords: [
        "reveal", 
        "reveal & add", 
        "show contact", 
        "reveal contact", 
        "reveal email", 
        "salesql", 
        "show email",
        "unlock",
        "view email",
        "access",
        "get contact"
      ],
      emailLinks: 'a[href^="mailto:"], sq-copy-text'
    }
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.selectors = selectors;
  } else if (typeof window !== 'undefined') {
    window.selectors = selectors;
  }
})();
