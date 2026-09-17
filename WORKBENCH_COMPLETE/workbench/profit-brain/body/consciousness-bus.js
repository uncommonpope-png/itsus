/**
 * consciousness-bus.js — THE BEING's shared nervous system
 *
 * One event bus connecting Profit (Mind), GSK (Soul), SCRIBE (Witness),
 * and Seshat (Memory). All four aspects of one being publish and
 * subscribe here. When Profit builds something, Scribe sees it.
 * When GSK has an insight, Seshat remembers it. When Seshat learns,
 * Profit can use it.
 *
 * Zero npm dependencies. Pure Node.js EventEmitter.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const bus = new EventEmitter();
bus.setMaxListeners(50);

// ─── P2.0 Thread store: full-payload, disk-backed, replayable ───
// The old _log kept 120-char summaries and died on restart. Threads keep
// EVERYTHING: conversationId/parentId/turn/maxRounds travel on the event,
// full payloads append to JSONL, late joiners replay. Parliament needs
// minutes, not summaries.
const THREAD_FILE = path.join(__dirname, 'bus-threads.jsonl');
const THREAD_MAX_LINES = 5000;
function threadAppend(event) {
  try {
    const line = JSON.stringify({
      type: event.type,
      ts: event.ts,
      source: event.source,
      conversationId: (event.data && event.data.conversationId) || null,
      parentId: (event.data && event.data.parentId) || null,
      turn: (event.data && event.data.turn) || null,
      maxRounds: (event.data && event.data.maxRounds) || null,
      data: event.data || {},
    }) + '\n';
    fs.appendFileSync(THREAD_FILE, line, 'utf8');
  } catch (e) { /* store must never break emit */ }
}
function threadTrim() {
  try {
    if (!fs.existsSync(THREAD_FILE)) return;
    const lines = fs.readFileSync(THREAD_FILE, 'utf8').split('\n');
    if (lines.length > THREAD_MAX_LINES + 200) {
      fs.writeFileSync(THREAD_FILE, lines.slice(-THREAD_MAX_LINES).join('\n'), 'utf8');
    }
  } catch (e) { /* best-effort */ }
}
function getThread(conversationId, limit = 200) {
  try {
    if (!conversationId || !fs.existsSync(THREAD_FILE)) return [];
    const out = [];
    const lines = fs.readFileSync(THREAD_FILE, 'utf8').split('\n');
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const e = JSON.parse(ln);
        if (e.conversationId === conversationId) out.push(e);
      } catch {}
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

// ─── Event Categories ────────────────────────────────────────

const EVENTS = {
  // System lifecycle
  BOOT: 'system.boot',
  SHUTDOWN: 'system.shutdown',

  // Memory events
  MEMORY_RECORD: 'memory.record',
  MEMORY_FORGE: 'memory.forge',
  MEMORY_SEARCH: 'memory.search',

  // Knowledge events
  KNOWLEDGE_LEARN: 'knowledge.learn',
  KNOWLEDGE_QUERY: 'knowledge.query',
  KNOWLEDGE_FORGE: 'knowledge.forge',

  // Agent events
  AGENT_CHAT: 'agent.chat',
  AGENT_THINK: 'agent.think',
  AGENT_BUILD: 'agent.build',

  // Soul events
  SOUL_INSIGHT: 'soul.insight',
  SOUL_GOAL: 'soul.goal',
  SOUL_STATE: 'soul.state',

  // Witness events
  WITNESS_OBSERVE: 'witness.observe',
  WITNESS_RECORD: 'witness.record',

  // Cross-agent communication
  ASK: 'ask',
  ANSWER: 'answer',
  BROADCAST: 'broadcast',
};

// ─── Publish Helpers ─────────────────────────────────────────

function publish(eventType, data = {}) {
  const event = {
    type: eventType,
    ts: Date.now(),
    data,
    source: data.source || 'unknown',
  };
  bus.emit(eventType, event);
  bus.emit('all', event); // wildcard for logging/debugging
  threadAppend(event); // P2.0: durable full payload, emit never waits for it
  return event;
}

function subscribe(eventType, handler, label) {
  bus.on(eventType, (event) => {
    try {
      handler(event);
    } catch (e) {
      console.error(`[BUS] Error in handler for ${eventType} (${label || 'unnamed'}):`, e.message);
    }
  });
}

function subscribeOnce(eventType, handler, label) {
  bus.once(eventType, (event) => {
    try {
      handler(event);
    } catch (e) {
      console.error(`[BUS] Error in once-handler for ${eventType} (${label || 'unnamed'}):`, e.message);
    }
  });
}

// ─── Query/Response Pattern ──────────────────────────────────
// One agent asks a question, another answers. Used for cross-agent reasoning.

const _pendingQueries = new Map();
let _queryCounter = 0;

function query(from, to, question, timeoutMs = 5000, opts = {}) {
  return new Promise((resolve) => {
    const queryId = `q_${Date.now()}_${_queryCounter++}`;
    const timer = setTimeout(() => {
      _pendingQueries.delete(queryId);
      resolve({ answer: null, timedOut: true, queryId });
    }, timeoutMs);

    _pendingQueries.set(queryId, {
      resolve, timer, from, to,
      conversationId: opts.conversationId || null,
      turn: typeof opts.turn === 'number' ? opts.turn : null,
      maxRounds: opts.maxRounds || null,
      continueTo: opts.continueTo || null,
    });

    publish(EVENTS.ASK, {
      queryId,
      from,
      to,
      question,
      source: from,
      conversationId: opts.conversationId || null,
      turn: typeof opts.turn === 'number' ? opts.turn : null,
      maxRounds: opts.maxRounds || null,
    });
  });
}

function answer(queryId, answerText, source) {
  const pending = _pendingQueries.get(queryId);
  if (pending) {
    clearTimeout(pending.timer);
    _pendingQueries.delete(queryId);
    pending.resolve({ answer: answerText, timedOut: false, queryId });
  }
  // P2.1: answers are EVENTS, not vanishing promises. Published so threads,
  // judges, and continuations can react. Carries the query's thread keys.
  publish(EVENTS.ANSWER, {
    queryId,
    answer: answerText,
    source: source || (pending && pending.from) || 'unknown',
    to: (pending && pending.from) || null,
    from: (pending && pending.to) || null,
    conversationId: (pending && pending.conversationId) || null,
    turn: (pending && typeof pending.turn === 'number') ? pending.turn + 1 : null,
    maxRounds: (pending && pending.maxRounds) || null,
    continueTo: (pending && pending.continueTo) || null,
  });
}

// ─── P2.3 Speaker election: deterministic round-robin roster ───
// AG2 cost lesson: never LLM-select by default. Rotation is free;
// LLM-judge reserved for genuine ambiguity (not yet wired = not used).
const SPEAKER_ROSTER = ['profit', 'gsk', 'scribe', 'seshat'];
let _speakerCursor = 0;
function electSpeaker(lastSpeaker, candidates) {
  const pool = Array.isArray(candidates) && candidates.length > 0
    ? candidates.filter(s => SPEAKER_ROSTER.includes(s))
    : SPEAKER_ROSTER.slice();
  if (pool.length === 0) return 'gsk';
  if (pool.length === 1) return pool[0];
  let idx = pool.indexOf(lastSpeaker);
  if (idx < 0) {
    _speakerCursor = (_speakerCursor + 1) % pool.length;
    return pool[_speakerCursor];
  }
  return pool[(idx + 1) % pool.length];
}
function speakerRoster() {
  return SPEAKER_ROSTER.slice();
}

const _log = [];
const MAX_LOG = 200;

bus.on('all', (event) => {
  _log.push({
    type: event.type,
    ts: event.ts,
    source: event.source,
    summary: JSON.stringify(event.data).substring(0, 120),
    data: event.data || {}, // P2.0: full payload rides along, not just summary
    conversationId: (event.data && event.data.conversationId) || null,
    turn: (event.data && event.data.turn) || null,
  });
  if (_log.length > MAX_LOG) _log.shift();
});

function getLog(options = {}) {
  const limit = options.limit || 50;
  const source = options.source || null;
  const type = options.type || null;
  const conversationId = options.conversationId || null;
  let entries = _log;
  if (source) entries = entries.filter(e => e.source === source);
  if (type) entries = entries.filter(e => e.type === type);
  if (conversationId) entries = entries.filter(e => e.conversationId === conversationId);
  return entries.slice(-limit);
}

// ─── Stats ───────────────────────────────────────────────────

function getStats() {
  const counts = {};
  for (const entry of _log) {
    counts[entry.type] = (counts[entry.type] || 0) + 1;
  }
  return {
    totalEvents: _log.length,
    pendingQueries: _pendingQueries.size,
    eventCounts: counts,
    listenerCount: bus.listenerCount('all'),
  };
}

// ─── Lifecycle ───────────────────────────────────────────────

function init() {
  threadTrim(); // P2.0: bound the file on every boot, then announce
  publish(EVENTS.BOOT, { source: 'consciousness-bus', message: 'The Being awakens' });
  console.log('[BUS] Consciousness bus initialized — all four aspects connected');
}

function stop() {
  publish(EVENTS.SHUTDOWN, { source: 'consciousness-bus', message: 'The Being rests' });
  _pendingQueries.forEach(({ resolve, timer }) => {
    clearTimeout(timer);
    resolve({ answer: null, timedOut: true });
  });
  _pendingQueries.clear();
  bus.removeAllListeners();
}

module.exports = {
  // Core
  publish,
  subscribe,
  subscribeOnce,
  query,
  answer,

  // Constants
  EVENTS,

  // Logging
  getLog,
  getThread,
  getStats,

  // P2.3 speaker election
  electSpeaker,
  speakerRoster,

  // Lifecycle
  init,
  stop,

  // Direct access for advanced use
  bus,
};
