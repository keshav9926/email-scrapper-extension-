// utils/logger.js
// Modern logging utility displaying clean, timestamped logs.

/**
 * Log a message with a formatted local time timestamp and level.
 * @param {string} message 
 * @param {string} level 'info' | 'warn' | 'error' | 'success'
 */
export function log(message, level = 'info') {
  const date = new Date();
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const formatted = `[${timeStr}] [${level.toUpperCase()}] ${message}`;
  
  if (level === 'error') {
    console.error(formatted);
  } else if (level === 'warn') {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
  
  // Broadcast log to any listeners (like the popup window)
  chrome.runtime.sendMessage({
    cmd: "log",
    log: { 
      timestamp: date.toISOString(), 
      level, 
      message, 
      formatted: `[${timeStr}] ${message}` 
    }
  }).catch(() => {
    // Ignored when popup is closed
  });
}

/**
 * Log an error.
 * @param {string} message 
 * @param {Error|string} err 
 */
export function error(message, err) {
  const errMsg = err ? `${message}: ${err.message || err}` : message;
  log(errMsg, 'error');
}

/**
 * Log a warning.
 * @param {string} message 
 */
export function warn(message) {
  log(message, 'warn');
}
