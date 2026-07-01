// utils/delay.js

/**
 * Promisified setTimeout.
 * @param {number} ms 
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Delays for a random duration between min and max milliseconds.
 * Useful to avoid detection on sites like LinkedIn.
 * @param {number} min 
 * @param {number} max 
 * @returns {Promise<void>}
 */
export function delayRandom(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return delay(ms);
}
