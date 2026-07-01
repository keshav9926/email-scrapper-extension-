// content.js (injected into LinkedIn profile page)

(async () => {
  const { selectors } = window;
  const { WaitManager, querySelectorAllInclusive } = window;
  const { DOMObserver } = window;
  const { StateMachineLib } = window;
  const { RetryManager } = window;

  if (!selectors || !WaitManager || !StateMachineLib) {
    console.error("[SheetsBot-Content] Modular dependencies missing!");
    chrome.runtime.sendMessage({
      cmd: "scrape_response",
      email: "",
      status: "Error: Dependencies missing"
    });
    return;
  }

  const { States, StateMachine } = StateMachineLib;
  
  // Create content state machine to track scraping lifecycle
  const machine = new StateMachine("ContentScraper", (oldState, newState, meta) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    console.log(`[${time}] [ScraperState] ${oldState} ➔ ${newState}`, meta);
    
    // Broadcast state transition back to the background worker/popup
    chrome.runtime.sendMessage({
      cmd: "content_state_change",
      state: newState,
      metadata: meta
    }).catch(() => {});
  });

  // Start in PAGE_LOADING state
  machine.transition(States.PAGE_LOADING);

  // 1. Wait until LinkedIn fully loads
  async function waitForLinkedIn() {
    console.log("[SheetsBot-Content] Waiting for LinkedIn profile scaffold...");
    await RetryManager.retry(async () => {
      for (const selector of selectors.linkedin.readyIndicators) {
        const el = querySelectorAllInclusive(selector)[0];
        if (el) return true;
      }
      throw new Error("LinkedIn indicators not found yet");
    }, 10, 1000);
  }

  // 2. Wait until SalesQL extension is ready/injected in the page
  async function waitForSalesQL() {
    console.log("[SheetsBot-Content] Waiting for SalesQL extension button/widget...");
    for (const selector of selectors.salesql.widgetReady) {
      try {
        await DOMObserver.waitForElementAddition(selector, document.body, 5000);
        return true;
      } catch (e) {}
    }
    
    return WaitManager.waitUntil(() => {
      return !!findRevealButton();
    }, 10000, 500);
  }

  // 3. Find the Reveal button
  function findRevealButton() {
    const elementsToSearch = querySelectorAllInclusive("button, div, span, a, [role='button'], sq-button");
    
    for (const el of elementsToSearch) {
      const className = el.className && typeof el.className === 'string' ? el.className.toLowerCase() : "";
      const id = el.id && typeof el.id === 'string' ? el.id.toLowerCase() : "";
      
      if (className.includes("salesql") || id.includes("salesql")) {
        return el;
      }

      const text = el.textContent ? el.textContent.trim().toLowerCase() : "";
      for (const keyword of selectors.salesql.revealTextKeywords) {
        if (text === keyword || text.includes(keyword)) {
          if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || text.length < 35) {
            return el;
          }
        }
      }
    }
    return null;
  }

  // 4. Click the Reveal button
  async function clickReveal(button) {
    console.log("[SheetsBot-Content] SalesQL button found. Clicking...", button);
    await RetryManager.retry(async () => {
      const opts = { bubbles: true, cancelable: true, view: window };
      button.dispatchEvent(new MouseEvent('mousedown', opts));
      button.dispatchEvent(new MouseEvent('mouseup', opts));
      button.click();
      return true;
    }, 3, 500);
  }

  // 5. Wait for the email to appear in the SalesQL widget/page
  async function waitEmail() {
    console.log("[SheetsBot-Content] Waiting for email to be revealed...");
    return WaitManager.waitUntil(() => {
      return extractEmail();
    }, 15000, 500);
  }

  // 6. Extract the email address
  function extractEmail() {
    const elementsToSearch = querySelectorAllInclusive("span, div, a, p, sq-copy-text");
    for (const el of elementsToSearch) {
      const text = el.textContent ? el.textContent.trim() : "";
      if (text.includes("@") && text.includes(".")) {
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
        const match = text.match(emailRegex);
        if (match) {
          const email = match[0];
          const lower = email.toLowerCase();
          if (
            !lower.endsWith(".png") && 
            !lower.endsWith(".jpg") && 
            !lower.endsWith(".gif") && 
            !lower.endsWith(".jpeg") && 
            !lower.includes("example.com")
          ) {
            return email;
          }
        }
      }
    }
    return null;
  }

  // 7. Send the scraped email back to the background worker
  function sendResult(email, status) {
    chrome.runtime.sendMessage({
      cmd: "scrape_response",
      email: email || "",
      status: status
    });
  }

  // Orchestrate Content Scraper flow
  try {
    await waitForLinkedIn();
    machine.transition(States.LINKEDIN_READY);

    await waitForSalesQL();
    machine.transition(States.SALESQL_READY);

    const button = findRevealButton();
    if (!button) {
      throw new Error("SalesQL button could not be located in the DOM");
    }
    machine.transition(States.CLICK_REVEAL);
    await clickReveal(button);

    machine.transition(States.WAIT_EMAIL);
    const email = await waitEmail();
    
    if (email) {
      machine.transition(States.EMAIL_FOUND, { email });
      machine.transition(States.DONE);
      sendResult(email, "Found");
    } else {
      throw new Error("No email addresses revealed by SalesQL");
    }
  } catch (err) {
    console.error("[SheetsBot-Content] Scrape failed:", err);
    machine.transition(States.FAILED, { error: err.message || String(err) });
    sendResult("", "Not Found");
  }
})();
