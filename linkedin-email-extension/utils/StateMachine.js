// utils/StateMachine.js
// Universal State Machine for tracking scraping progress states.

(function() {
  const States = {
    // Background automation states
    IDLE: 'IDLE',
    OPEN_PROFILE: 'OPEN_PROFILE',
    WAIT_READY: 'WAIT_READY',
    START_SCRAPER: 'START_SCRAPER',
    WAIT_RESULT: 'WAIT_RESULT',
    SAVE: 'SAVE',
    NEXT_ROW: 'NEXT_ROW',
    
    // Content script scraping states
    PAGE_LOADING: 'PAGE_LOADING',
    LINKEDIN_READY: 'LINKEDIN_READY',
    SALESQL_READY: 'SALESQL_READY',
    CLICK_REVEAL: 'CLICK_REVEAL',
    WAIT_EMAIL: 'WAIT_EMAIL',
    EMAIL_FOUND: 'EMAIL_FOUND',
    DONE: 'DONE',
    FAILED: 'FAILED'
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
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        console.log(`[${time}] [${this.name}] ${oldState} ➔ ${newState}`, metadata);
      }
    }

    getState() {
      return this.state;
    }
  }

  // Export globally for both Service Worker and Content Script contexts
  const exportLib = { States, StateMachine };
  
  if (typeof globalThis !== 'undefined') {
    globalThis.StateMachineLib = exportLib;
  } else if (typeof window !== 'undefined') {
    window.StateMachineLib = exportLib;
  }
})();
