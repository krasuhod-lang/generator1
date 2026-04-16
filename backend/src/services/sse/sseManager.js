const EventEmitter = require('events');

class SSEManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    /** @type {Map<string, Set<import('http').ServerResponse>>} */
    this.clients = new Map();
  }

  /**
   * Subscribe an SSE response to a task channel.
   */
  subscribe(taskId, res) {
    if (!this.clients.has(taskId)) {
      this.clients.set(taskId, new Set());
    }
    this.clients.get(taskId).add(res);
  }

  /**
   * Publish data to all subscribers of a task channel.
   */
  publish(taskId, data) {
    const clients = this.clients.get(taskId);
    if (!clients || clients.size === 0) return;

    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch (_err) {
        clients.delete(res);
      }
    }
  }

  /**
   * Unsubscribe an SSE response from a task channel.
   */
  unsubscribe(taskId, res) {
    const clients = this.clients.get(taskId);
    if (!clients) return;
    clients.delete(res);
    if (clients.size === 0) {
      this.clients.delete(taskId);
    }
  }
}

// Singleton
module.exports = new SSEManager();
