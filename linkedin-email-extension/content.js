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
  
  const machine = new StateMachine("ContentScraper", (oldState, newState, meta) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    console.log(`[${time}] [ScraperState] ${oldState} ➔ ${newState}`, meta);
    chrome.runtime.sendMessage({
      cmd: "content_state_change",
      state: newState,
      metadata: meta
    }).catch(() => {});
  });

  machine.transition(States.PAGE_LOADING);

  function validateEmail(email) {
    if (!email) return false;
    const lower = email.toLowerCase().trim();
    return (
      lower.includes("@") &&
      lower.includes(".") &&
      !lower.endsWith(".png") && 
      !lower.endsWith(".jpg") && 
      !lower.endsWith(".gif") && 
      !lower.endsWith(".jpeg") && 
      !lower.includes("example.com")
    );
  }

  // 1. Wait until LinkedIn fully loads
  async function waitForLinkedIn() {
    console.log("[SheetsBot-Content] Waiting for LinkedIn profile scaffold...");
    await RetryManager.retry(async () => {
      for (const selector of selectors.linkedin.readyIndicators) {
        const el = querySelectorAllInclusive(selector)[0];
        if (el) return true;
      }
      throw new Error("LinkedIn indicators not found yet");
    }, 15, 1000);
  }

  // 2. Wait until SalesQL extension is ready/injected in the page
  async function waitForSalesQLReady() {
    console.log("[SheetsBot-Content] Waiting for SalesQL extension iframe or widget...");
    await WaitManager.waitUntil(() => {
      const hasIframe = querySelectorAllInclusive(selectors.salesql.iframes).length > 0;
      const hasWidget = querySelectorAllInclusive(selectors.salesql.revealButton).length > 0;
      return hasIframe || hasWidget;
    }, 30000, 1000);
  }

  // 3. Find the SalesQL popup container
  function findSalesQLPopup() {
    const roots = querySelectorAllInclusive(selectors.salesql.popup);
    if (roots.length > 0) return roots[0];
    
    // Fallback: locate via child email selectors
    const mailto = querySelectorAllInclusive(selectors.salesql.emailLinks)[0];
    if (mailto) {
      return mailto.closest("div, sq-root, [class*='salesql']") || mailto.parentElement;
    }
    return null;
  }

  // 4. Extract email specifically from the SalesQL popup container
  function extractEmail() {
    const popup = findSalesQLPopup();
    if (!popup) return null;
    
    // Check mailto links inside the popup
    const mailtoLink = popup.querySelector("a[href^='mailto:']");
    if (mailtoLink) {
      const email = mailtoLink.getAttribute("href").replace(/^mailto:/i, "").trim();
      if (validateEmail(email)) return email;
    }
    
    // Check sq-copy-text components
    const sqCopy = popup.querySelector("sq-copy-text");
    if (sqCopy) {
      const text = sqCopy.textContent || sqCopy.getAttribute("text") || "";
      const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (match && validateEmail(match[0])) return match[0];
    }
    
    // Generic fallback inside the popup
    const elements = popup.querySelectorAll("span, div, a, p");
    for (const el of elements) {
      const text = el.textContent ? el.textContent.trim() : "";
      const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (match && validateEmail(match[0])) {
        return match[0];
      }
    }
    
    return null;
  }

  // 5. Find the Reveal button
  function findRevealButton() {
    const elementsToSearch = querySelectorAllInclusive(selectors.salesql.revealButton);
    if (elementsToSearch.length > 0) {
      const nonCopy = elementsToSearch.filter(btn => {
        const text = (btn.textContent || "").toLowerCase();
        return !text.includes("copy") && !btn.querySelector("sq-copy-text");
      });
      if (nonCopy.length > 0) return nonCopy[0];
      return elementsToSearch[0];
    }

    // Fallback: search by text keywords
    const buttons = querySelectorAllInclusive("button, [role='button'], div[class*='button']");
    for (const btn of buttons) {
      const text = btn.textContent ? btn.textContent.trim().toLowerCase() : "";
      for (const keyword of selectors.salesql.revealTextKeywords) {
        if (text === keyword || text.includes(keyword)) {
          if (btn.tagName === 'BUTTON' || btn.getAttribute('role') === 'button' || text.length < 35) {
            return btn;
          }
        }
      }
    }
    return null;
  }

  // 6. Click the Reveal button using robust PointerEvents and MouseEvents
  async function clickReveal(button) {
    console.log("[SheetsBot-Content] Dispatching robust click events to Reveal button...");
    button.scrollIntoView({ block: 'center' });
    button.focus();

    try {
      // Pointer events
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
      
      // Mouse events
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      
      // Native click
      button.click();
    } catch (e) {
      console.warn("[SheetsBot-Content] Click dispatch warning", e);
    }
  }

  // 7. Wait for email insertion using MutationObserver and backup polling
  async function waitEmail(timeoutMs = 15000) {
    const existing = extractEmail();
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const found = extractEmail();
        if (found) {
          observer.disconnect();
          clearInterval(interval);
          resolve(found);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });

      const interval = setInterval(() => {
        const found = extractEmail();
        if (found) {
          observer.disconnect();
          clearInterval(interval);
          resolve(found);
        }
      }, 500);

      setTimeout(() => {
        observer.disconnect();
        clearInterval(interval);
        reject(new Error("Timeout waiting for email to reveal"));
      }, timeoutMs);
    });
  }

  function sendResult(email, status) {
    chrome.runtime.sendMessage({
      cmd: "scrape_response",
      email: email || "",
      status: status
    });
  }

  // Orchestrated flow
  try {
    // Stage 1: Wait for LinkedIn Ready
    await waitForLinkedIn();
    machine.transition(States.LINKEDIN_READY);

    // Stage 2: Wait for SalesQL Ready
    await waitForSalesQLReady();
    machine.transition(States.SALESQL_READY);

    // Stage 3: Check if email is already revealed to save credits
    const alreadyRevealed = extractEmail();
    if (alreadyRevealed) {
      console.log(`[SheetsBot-Content] Email already visible: ${alreadyRevealed}`);
      machine.transition(States.EMAIL_FOUND, { email: alreadyRevealed, alreadyRevealed: true });
      machine.transition(States.DONE);
      sendResult(alreadyRevealed, "Found");
      return;
    }

    // Stage 4: Locate Reveal button and click
    const button = findRevealButton();
    if (!button) {
      throw new Error("SalesQL Reveal button not found in page");
    }

    machine.transition(States.CLICK_REVEAL);
    await clickReveal(button);

    // Stage 5: Wait for Email with Click Retry Fallback
    machine.transition(States.WAIT_EMAIL);
    let email = null;
    try {
      email = await waitEmail(15000); // Wait 15s first
    } catch (e) {
      console.warn("[SheetsBot-Content] Email not found on first click. Retrying click...", e);
      // Find button again and retry click (network/UI hiccup handler)
      const retryBtn = findRevealButton();
      if (retryBtn) {
        await clickReveal(retryBtn);
        email = await waitEmail(15000); // Wait another 15s
      } else {
        throw e;
      }
    }

    if (email) {
      machine.transition(States.EMAIL_FOUND, { email });
      machine.transition(States.DONE);
      sendResult(email, "Found");
    } else {
      throw new Error("Failed to find email in SalesQL popup container");
    }

  } catch (err) {
    console.error("[SheetsBot-Content] Scrape failed:", err);
    machine.transition(States.FAILED, { error: err.message || String(err) });
    sendResult("", "Not Found");
  }
})();
