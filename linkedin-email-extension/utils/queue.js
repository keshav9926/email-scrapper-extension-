// utils/queue.js

/**
 * A simple FIFO queue for URLs / scraping jobs.
 */
export class Queue {
  constructor(items = []) {
    this.items = [...items];
  }

  /**
   * Add a job to the queue
   * @param {*} item 
   */
  enqueue(item) {
    this.items.push(item);
  }

  /**
   * Remove and return the next job from the queue
   * @returns {*}
   */
  dequeue() {
    return this.items.shift();
  }

  /**
   * View the next job without removing it
   * @returns {*}
   */
  peek() {
    return this.items[0];
  }

  /**
   * Check if queue is empty
   * @returns {boolean}
   */
  isEmpty() {
    return this.items.length === 0;
  }

  /**
   * Get size of remaining queue
   * @returns {number}
   */
  size() {
    return this.items.length;
  }

  /**
   * Clear the queue
   */
  clear() {
    this.items = [];
  }

  /**
   * Get a copy of all items in the queue
   * @returns {Array}
   */
  getAll() {
    return [...this.items];
  }
}
