// google_sheets_bot.js (Content Script injected into Google Sheets or Excel Online tabs)

(() => {
  if (window.hasSheetsBotAttached) {
    console.log("[SheetsBot] Already attached to this tab.");
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

    // 2. Google Sheets specific keyboard focus handler
    const gsHandler = document.querySelector('.grid-keyboard-handler');
    if (gsHandler && document.activeElement !== gsHandler) {
      try {
        gsHandler.focus();
      } catch (e) {}
    }
    
    const activeEl = document.activeElement || document.body;
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
    activeEl.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    activeEl.dispatchEvent(new KeyboardEvent('keyup', eventInit));

    // For Excel Online, also dispatch globally to document to catch capturing/global event listeners
    if (activeEl !== document.body) {
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
    if (msg.cmd === "readActiveCell") {
      const formulaBar = getFormulaBar();
      let value = '';
      if (formulaBar) {
        value = (formulaBar.value || formulaBar.textContent || formulaBar.innerText || '').trim();
      }
      sendResponse({ value });
    }
    
    else if (msg.cmd === "moveDown") {
      pressKey('ArrowDown');
      sendResponse({ success: true });
    }
    
    else if (msg.cmd === "writeResultAndMove") {
      (async () => {
        // Move selection right to the adjacent email column
        pressKey('ArrowRight');
        await delay(500);
        
        // Write result to the sheet cell (saves with Enter, moving down one row)
        await writeToActiveCell(msg.text);
        await delay(500);
        
        // Navigate back left to the original column (which is now on the next row)
        pressKey('ArrowLeft');
        await delay(400);
        
        sendResponse({ success: true });
      })();
      return true; // Keep message channel open for async response
    }
  });

  console.log("[SheetsBot] Content script loaded and listening.");
})();
