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
      widgetReady: [
        'sq-button',
        '.salesql-button',
        '[class*="salesql"]',
        '[id*="salesql"]'
      ],
      revealButton: 'sq-button, button.salesql-button, .salesql-reveal-button, [class*="salesql-button"]',
      revealTextKeywords: [
        "reveal", 
        "reveal & add", 
        "show contact", 
        "reveal contact", 
        "reveal email", 
        "salesql", 
        "show email"
      ],
      emailContainer: 'span, div, a, p, sq-copy-text, .salesql-email, [class*="salesql-email"]'
    }
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.selectors = selectors;
  } else if (typeof window !== 'undefined') {
    window.selectors = selectors;
  }
})();
