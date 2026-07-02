// utils/StateMachine.js
// Universal State Machine for tracking scraping progress states.

(function() {
  const States = {
    // Background automation states (Apify Flow)
    IDLE: 'IDLE',
    START_APIFY_RUN: 'START_APIFY_RUN',
    POLL_APIFY_STATUS: 'POLL_APIFY_STATUS',
    FETCH_APIFY_DATASET: 'FETCH_APIFY_DATASET',
    SAVE: 'SAVE',
    DONE: 'DONE',
    FAILED: 'FAILED',

    // Legacy/Browser-based states (kept for fallback / content logging compatibility)
    PAGE_LOADING: 'PAGE_LOADING',
    LINKEDIN_READY: 'LINKEDIN_READY',
    SALESQL_READY: 'SALESQL_READY',
    CLICK_REVEAL: 'CLICK_REVEAL',
    WAIT_EMAIL: 'WAIT_EMAIL',
    EMAIL_FOUND: 'EMAIL_FOUND'
  };

  class StateMachine {
    constructor(name = "StateMachine", onTransition = null) {
      this.name = name;
      this.state = States.IDLE;
      this.onTransition = onTransition;
    }

    transition(newState, metadata = {}) {
      if (!States[newState]) {
        throw new Error(`[${this.name}] Invalid state transition target: "${newState}"`);
      }
      
      const oldState = this.state;
      this.state = newState;
      
      if (this.onTransition) {
        this.onTransition(oldState, newState, metadata);
      } else {
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        console.log(`[${time}] [${this.name}] ${oldState} ➔ ${newState}`, metadata);
      }
    }

    getState() {
      return this.state;
    }
  }

  const exportLib = { States, StateMachine };
  
  if (typeof globalThis !== 'undefined') {
    globalThis.StateMachineLib = exportLib;
  } else if (typeof window !== 'undefined') {
    window.StateMachineLib = exportLib;
  }
})();
