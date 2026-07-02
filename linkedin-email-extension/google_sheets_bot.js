// google_sheets_bot.js (Content Script injected into Google Sheets or Excel Online tabs)

(() => {
  if (window.hasSheetsBotAttached) {
    console.log("[SheetsBot] Already attached to this tab. Re-registering frame...");
    const fb = document.querySelector('#t-formula-bar-input') || 
               document.querySelector('#FormulaBarTextDiv') || 
               document.querySelector('[aria-label="Formula Bar"]') ||
               document.querySelector('.formula-bar-text-editor') ||
               document.querySelector('[role="textbox"][aria-label="Formula Bar"]');
    if (fb || document.querySelector('.grid-keyboard-handler')) {
      chrome.runtime.sendMessage({ cmd: "sheets_bot_register" });
    }
    return;
  }
  window.hasSheetsBotAttached = true;

  const delay = ms => new Promise(res => setTimeout(res, ms));
  
  function getKeyCode(key) {
    const codes = { 
      'Enter': 13, 
      'Tab': 9, 
      'ArrowDown': 40, 
      'ArrowLeft': 37, 
      'ArrowRight': 39, 
      'ArrowUp': 38 
    };
    return codes[key] || 0;
  }
  
  function pressKey(key) {
    // 1. Defocus formula bar or cell editor input before sending arrow keys.
    // Otherwise, Excel/Google Sheets will move the text cursor within the editor rather than moving the grid cell selection.
    if (key.startsWith('Arrow')) {
      const activeEl = document.activeElement;
      if (activeEl && (
        activeEl.tagName === 'INPUT' || 
        activeEl.tagName === 'TEXTAREA' || 
        activeEl.contentEditable === 'true' || 
        activeEl.id === 'FormulaBarTextDiv' || 
        activeEl.classList.contains('FormulaBarTextDiv')
      )) {
        try {
          activeEl.blur();
        } catch (e) {}
      }
    }

    // 2. Google Sheets specific keyboard focus handler (skip if currently focused on formula bar)
    const activeEl = document.activeElement;
    const formulaBar = getFormulaBar();
    const isFormulaBar = formulaBar && (activeEl === formulaBar || formulaBar.contains(activeEl));
    
    if (!isFormulaBar) {
      const gsHandler = document.querySelector('.grid-keyboard-handler');
      if (gsHandler && document.activeElement !== gsHandler) {
        try {
          gsHandler.focus();
        } catch (e) {}
      }
    }
    
    const currentActive = document.activeElement || document.body;
    const code = getKeyCode(key);
    
    const eventInit = {
      key: key,
      code: key,
      keyCode: code,
      which: code,
      bubbles: true,
      cancelable: true
    };
    
    // Simulate KeyDown and KeyUp on the active element
    currentActive.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    currentActive.dispatchEvent(new KeyboardEvent('keyup', eventInit));

    // For Excel Online, also dispatch globally to document to catch capturing/global event listeners
    if (currentActive !== document.body) {
      document.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      document.dispatchEvent(new KeyboardEvent('keyup', eventInit));
    }
  }
  
  function getFormulaBar() {
    return document.querySelector('#t-formula-bar-input') || 
           document.querySelector('#FormulaBarTextDiv') || 
           document.querySelector('[aria-label="Formula Bar"]') ||
           document.querySelector('.formula-bar-text-editor') ||
           document.querySelector('[role="textbox"][aria-label="Formula Bar"]');
  }
  
  async function writeToActiveCell(text) {
    // Try to update using the formula bar first (works in both Google Sheets and Excel Online)
    const formulaBar = getFormulaBar();
    if (formulaBar) {
      formulaBar.focus();
      
      if (formulaBar.tagName === 'INPUT' || formulaBar.tagName === 'TEXTAREA') {
        formulaBar.value = text;
      } else {
        formulaBar.innerText = text;
        formulaBar.textContent = text;
      }
      
      // Dispatch input events so the spreadsheet application registers the change
      formulaBar.dispatchEvent(new Event('input', { bubbles: true }));
      formulaBar.dispatchEvent(new Event('change', { bubbles: true }));
      await delay(250);
      
      // Press Enter to commit and save the edit
      pressKey('Enter');
      return true;
    }
    
    // Fallback: If editor is a textarea or other input currently focused
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT' || activeEl.contentEditable === 'true')) {
      if (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') {
        activeEl.value = text;
      } else {
        activeEl.innerText = text;
        activeEl.textContent = text;
      }
      activeEl.dispatchEvent(new Event('input', { bubbles: true }));
      await delay(250);
      pressKey('Enter');
      return true;
    }
    
    return false;
  }

  // Handle instructions from background service worker
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    console.log("[SheetsBot] Received command:", msg.cmd);
    
    if (msg.cmd === "readActiveCell") {
      const formulaBar = getFormulaBar();
      let value = '';
      if (formulaBar) {
        value = (formulaBar.value || formulaBar.textContent || formulaBar.innerText || '').trim();
      }
      console.log("[SheetsBot] readActiveCell returning value:", value);
      sendResponse({ value });
      return true;
    }
    
    else if (msg.cmd === "moveDown") {
      console.log("[SheetsBot] Pressing ArrowDown...");
      pressKey('ArrowDown');
      sendResponse({ success: true });
      return true;
    }
    
    else if (msg.cmd === "writeResultAndMove") {
      console.log("[SheetsBot] Writing result and moving:", msg.text);
      (async () => {
        try {
          // Move selection right to the adjacent email column
          pressKey('ArrowRight');
          await delay(500);
          
          // Write result to the sheet cell (saves with Enter, moving down one row)
          await writeToActiveCell(msg.text);
          await delay(500);
          
          // Verify if formula bar is still focused. If so, blur it to force commit.
          const activeEl = document.activeElement;
          const formulaBar = getFormulaBar();
          if (formulaBar && (activeEl === formulaBar || formulaBar.contains(activeEl))) {
            try {
              formulaBar.blur();
            } catch (e) {}
            await delay(200);
            // Since blur doesn't move selection down, we explicitly press ArrowDown!
            pressKey('ArrowDown');
            await delay(300);
          }
          
          // Navigate back left to the original column (which is now on the next row)
          pressKey('ArrowLeft');
          await delay(400);
          
          sendResponse({ success: true });
        } catch (e) {
          console.error("[SheetsBot] Error writing result and moving:", e);
          sendResponse({ success: false, error: e.message || String(e) });
        }
      })();
      return true; // Keep message channel open for async response
    }
  });

  console.log("[SheetsBot] Content script loaded and listening.");

  // Register active editor frame with background service worker
  let registered = false;
  function tryRegister() {
    if (registered) return;
    if (getFormulaBar() || document.querySelector('.grid-keyboard-handler')) {
      chrome.runtime.sendMessage({ cmd: "sheets_bot_register" });
      registered = true;
      console.log("[SheetsBot] Registered active editor frame with background.");
    }
  }

  tryRegister();
  for (let i = 1; i <= 10; i++) {
    setTimeout(tryRegister, i * 500);
  }
})();
