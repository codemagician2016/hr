'use strict';
// In-process pub/sub for the HR helpdesk / support conversations (SSE fan-out).
// Replaces the deleted chat module's eventBus with the same surface: publish a
// payload to a named room, subscribe a handler (receives { event, payload }) and
// get an unsubscribe fn. Single-process scope — for multi-instance real-time,
// back this with Redis pub/sub at deploy time (same API).
const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // many concurrent SSE subscribers per room

module.exports = {
  roomConversation: (conversationId) => `support:conversation:${conversationId}`,
  roomBusinessCustomer: (businessId) => `support:business-customer:${businessId}`,
  publish(room, event, payload) {
    emitter.emit(room, { event, payload });
  },
  subscribe(room, handler) {
    emitter.on(room, handler);
    return () => emitter.off(room, handler);
  },
};
