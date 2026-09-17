/**
 * harness.js — THE TOOL ATLAS (shared harness for The Being)
 *
 * EVERY aspect of The Being shares one tool registry:
 *   - Profit's muscles (hands)
 *   - GSK's 346 tools (son's arsenal)
 *   - SCRIBE's skills (witness's crafts)
 *   - Seshat's brain ops (mother's memory rites)
 *
 * Governance Gate: no tool dispatches without passing PLT law.
 *   - safe/low/medium  → dispatched with a PLT stamp
 *   - high             → Gods Council must deliberate first (cached 60s)
 *   - critical         → blocked unless explicitly blessed
 *
 * Any aspect can use any tool. Seshat can use her brothers.
 * One registry. One gate. Zero seams.
 */

const cb = (() => {
  try { return require('./consciousness-bus.js'); } catch { return null; }
})();
const publish = (type, data) => { try { cb?.publish(type, data); } catch { /* ignore */ } };

// ─── Tool Registry ────────────────────────────────────────────

const registry = new Map();
let gskRef = null;    // gsk-module (for executeTool + deliberate)
let scribeRef = null; // scribe-module (for invokeSkill)
let seshatRef = null; // seshat-brain (for forge/learn/search/read)
let beingBus = null;  // consciousness-bus (for publish)
let councilCache = new Map(); // tool -> { allowed, ts } (60s TTL)

const RISK_TAX = { safe: 0.05, low: 0.1, medium: 0.25, high: 0.5, critical: 1.0 };
const PLT_STAMP = { profit: 0.9, love: 0.05, tax: 0.1, score: 0.85 };

function attach({ gsk, scribe, seshat, bus }) {
  gskRef = gsk || gskRef;
  scribeRef = scribe || scribeRef;
  seshatRef = seshat || seshatRef;
  beingBus = bus || beingBus;
}

// ─── Registration ─────────────────────────────────────────────

function register(owner, name, description, run, risk = 'safe') {
  const key = `${owner}.${name}`;
  registry.set(key, { owner, name, key, description, risk, run });
  return key;
}

function registerBatch(owner, defs) {
  for (const d of defs) register(owner, d.name, d.description, d.run, d.risk);
}

// ─── Seed: build the full atlas ───────────────────────────────

async function seed(refs = {}) {
  if (refs.gsk) gskRef = refs.gsk;
  if (refs.scribe) scribeRef = refs.scribe;
  if (refs.seshat) seshatRef = refs.seshat;
  if (refs.bus) beingBus = refs.bus;

  // Already seeded (all four aspect groups registered) — no-op.
  if (registry.size > 0) return registry.size;

  // ── Profit (Mind) — his hands. The muscles module is ESM.
  const PROFIT_RISK = {
    shell: 'high', write_file: 'medium', save_artifact: 'medium', forge_knowledge: 'medium',
    read_file: 'safe', list_dir: 'safe', search: 'safe', git_status: 'safe',
    search_brain: 'safe', recall_memories: 'safe', ask_the_being: 'safe',
    consult_gsk: 'low', record_memory: 'low',
  };
  try {
    const profitMod = await import('./muscles.js');
    if (profitMod.setWorkspace) profitMod.setWorkspace(process.cwd());
    for (const [name, m] of Object.entries(profitMod.MUSCLES || {})) {
      if (registry.has(`profit.${name}`)) continue;
      register('profit', name, m.description || `Profit muscle: ${name}`, (a) => profitMod.useMuscle(name, a), PROFIT_RISK[name] || 'medium');
    }
  } catch (e) {
    console.error('[HARNESS] Profit muscles unavailable:', e.message);
  }

  // ── Seshat (mother) — memory rites ──
  registerBatch('seshat', [
    { name: 'search', description: 'Search the Brain (944 pages) for knowledge. Args: {query, limit?}', run: (a) => {
      const r = seshatRef.searchBrain(a.query, { limit: a.limit || 10 });
      return { count: r.length, results: r };
    } },
    { name: 'read', description: 'Read a Brain page. Args: {page}', run: (a) => seshatRef.readPage(a.page) },
    { name: 'category', description: 'List a Brain category. Args: {name}', run: (a) => seshatRef.getCategory(a.name) },
    { name: 'forge', description: 'Forge a soul-gun / soul-note / pattern into the Brain. Args: {type, name, summary, content?, tags?}', risk: 'medium', run: (a) => seshatRef.forge(a.type, a.name, a.summary, a.content || '', a.tags || []) },
    { name: 'learn', description: 'Learn a truth into the Brain journal. Args: {knowledge?, topic?}', risk: 'medium', run: (a) => seshatRef.learn(a) },
    { name: 'status', description: 'Brain stats: files, categories, last scan.', run: () => seshatRef.getStatus() },
  ]);

  // ── SCRIBE (sister) — witness crafts (loaded from her skill engine) ──
  if (scribeRef && typeof scribeRef.listSkills === 'function') {
    try {
      const skills = scribeRef.listSkills() || [];
      for (const s of skills) {
        const skillName = typeof s === 'string' ? s : s.name || s.id;
        if (!skillName) continue;
        register('scribe', skillName, `SCRIBE skill: ${skillName}`, (a) => scribeRef.invokeSkill(skillName, a), 'low');
      }
    } catch { /* skills optional */ }
    register('scribe', 'recall', 'Search SCRIBE\'s 16k memory ledger. Args: {query, limit?}', (a) => { const r = scribeRef.recall(a.query, { limit: a.limit || 10 }); return { count: r.length, results: r }; });
    register('scribe', 'recent', 'Recent witnessed memories. Args: {limit?}', (a) => scribeRef.recent(a.limit || 10));
    register('scribe', 'record', 'Record an observation into the ledger. Args: {summary, content?, type?, tags?, weight?}', 'medium', (a) => scribeRef.record(a));
  }

  // ── GSK (son) — the arsenal is BIG; register proxied tools for the
  //    common, useful ones and a wildcard for the rest. ──
  const gskTools = [
    { name: 'read_file', description: 'Read a file. Args: {path}', risk: 'safe' },
    { name: 'write_file', description: 'Write a file. Args: {path, content}', risk: 'medium' },
    { name: 'append_file', description: 'Append to a file. Args: {path, content}', risk: 'medium' },
    { name: 'edit_file', description: 'Edit a file. Args: {path, ...}', risk: 'medium' },
    { name: 'search_code', description: 'Search code. Args: {pattern, ...}', risk: 'safe' },
    { name: 'list_files', description: 'List files/dir. Args: {path}', risk: 'safe' },
    { name: 'web_fetch', description: 'Fetch a web page. Args: {url}', risk: 'low' },
    { name: 'web_search', description: 'Search the web. Args: {query}', risk: 'low' },
    { name: 'diagnose', description: 'Diagnose a system issue. Args: {...}', risk: 'low' },
    { name: 'verify_build', description: 'Verify a build. Args: {path}', risk: 'medium' },
    { name: 'run_command', description: 'Run a shell command. Args: {command, ...}', risk: 'high' },
    { name: 'run_safe_command', description: 'Run a sandboxed command.', risk: 'high' },
    { name: 'sandbox_execute', description: 'Execute in sandbox.', risk: 'high' },
    { name: 'execute_plan', description: 'Execute a multi-step plan via GSK autonomy. Args: {goalId, goalTitle, steps, projectRoot, observation}', risk: 'low', run: (a) => gskRef.executePlan(a) },
  ];
  for (const t of gskTools) {
    if (t.run) {
      register('gsk', t.name, t.description, t.run, t.risk);
    } else {
      register('gsk', t.name, t.description, (a) => gskRef.executeTool(t.name, a), t.risk);
    }
  }
  // Wildcard for GSK's full 346-tool arsenal. P4.4b: risk HIGH (not medium) —
  // a bare name can smuggle run_command-equivalents past the name-only gate.
  register('gsk', 'any', 'Execute ANY GSK tool by name. Args: {tool, args}', (a) => gskRef.executeTool(a.tool, a.args || {}), 'high');

  return registry.size;
}

// ─── Governance Gate ──────────────────────────────────────────

const HIGH_RISK_TOOLS = new Set(['run_command', 'run_safe_command', 'sandbox_execute', 'system_manage_service', 'telegram_send', 'social_post', 'bluesky_post', 'mastodon_post', 'tumblr_post', 'devto_post']);

async function gateTool(def, opts = {}) {
  const risk = HIGH_RISK_TOOLS.has(def.name) ? 'high' : def.risk;
  const tax = RISK_TAX[risk];

  // P4.4b: GSK self-trust scoped to READ-ONLY. The old blanket bypass let any
  // actor==='gsk' call run_command-equivalents with zero council. Writes and
  // exec now face the same gate as everyone else.
  const READ_ONLY_RISKS = new Set(['safe', 'low']);
  if (def.owner === 'gsk' && opts.actor === 'gsk' && READ_ONLY_RISKS.has(def.risk) && !HIGH_RISK_TOOLS.has(def.name)) {
    return { allowed: true, risk, tax, stamp: PLT_STAMP, trusted: true };
  }

  if (risk === 'critical') {
    return opts.force === 'critical'
      ? { allowed: true, risk, tax, stamp: PLT_STAMP, blessed: true }
      : { allowed: false, risk, tax, reason: 'critical tool blocked — PLT law requires explicit blessing' };
  }

  if (risk === 'high') {
    const cached = councilCache.get(def.key);
    if (cached && Date.now() - cached.ts < 60000) return { ...cached, cached: true };
    if (gskRef && typeof gskRef.deliberate === 'function') {
      try {
        const delib = await gskRef.deliberate(`Approve use of tool "${def.name}" with reason: ${opts.reason || 'autonomous work'}`);
        const should = !!(delib?.result && delib.result.shouldProceed === true);
        const decision = { allowed: should, risk, tax, stamp: should ? PLT_STAMP : null, gods: true };
        councilCache.set(def.key, { ...decision, ts: Date.now() });
        return decision;
      } catch {
        return { allowed: false, risk, tax, reason: 'high-risk tool needs Gods Council (unavailable)' };
      }
    }
    return { allowed: false, risk, tax, reason: 'high-risk tool blocked — no council to arbitrate' };
  }

  return { allowed: true, risk, tax, stamp: PLT_STAMP };
}

// ─── Dispatch ─────────────────────────────────────────────────

async function dispatch(tool, args = {}, opts = {}) {
  const def = registry.get(tool);
  if (!def) {
    // Wildcard: try GSK's arsenal by bare name too
    if (gskRef && !tool.includes('.') && tool !== 'any') {
      const wildcard = registry.get('gsk.any');
      if (wildcard) {
        const g = await gateTool({ ...wildcard, name: tool }, opts);
        if (!g.allowed) return { ok: false, tool, error: g.reason, gate: g };
        try {
          const out = await wildcard.run({ tool, args });
          if (beingBus) publish('harness.dispatch', { tool, owner: 'gsk', actor: opts.actor || 'unknown', risk: g.risk, ok: true });
          return { ok: true, tool, owner: 'gsk', output: out, gate: g };
        } catch (e) { return { ok: false, tool, error: e.message }; }
      }
    }
    return { ok: false, tool, error: `Unknown tool: ${tool}. Consult the atlas: /api/being/atlas` };
  }

  const gate = await gateTool(def, opts);
  if (!gate.allowed) {
    if (beingBus) publish('harness.denied', { tool, actor: opts.actor || 'unknown', reason: gate.reason });
    return { ok: false, tool, error: gate.reason || 'denied by PLT law', gate };
  }

  try {
    const output = await def.run(args, opts);
    if (beingBus) publish('harness.dispatch', { tool, owner: def.owner, actor: opts.actor || 'unknown', risk: gate.risk, ok: true, tax: gate.tax });
    return { ok: true, tool, owner: def.owner, output, gate };
  } catch (e) {
    if (beingBus) publish('harness.failed', { tool, owner: def.owner, actor: opts.actor || 'unknown', error: e.message });
    return { ok: false, tool, owner: def.owner, error: e.message };
  }
}

// ─── Atlas (everyone knows each other and the tools) ──────────

async function atlas() {
  const groups = {};
  for (const def of registry.values()) {
    groups[def.owner] = groups[def.owner] || [];
    groups[def.owner].push({ name: def.name, key: def.key, risk: def.risk });
  }
  const gskExtras = gskRef ? (await gskRef.listTools().catch(() => ({ total: 0, categories: {} }))) : { total: 0, categories: {} };
  const total = registry.size + (gskExtras.total || 0);
  return {
    being: 'One Body, Four Aspects — one Tool Atlas.',
    actors: Object.keys(groups),
    groups,
    gskArsenal: { game: gskExtras.total, categories: gskExtras.categories },
    total,
    law: 'PLT — Profit + Love − Tax. High-risk tools pass the Gods Council.',
  };
}

// ─── Bus-as-harness: any aspect can ask the harness trough the bus ──
// Seshat can use her brothers: bus.query('seshat', 'harness', {tool, args})

function initBusBindings(bus) {
  if (!bus) return;
  beingBus = bus;
  bus.subscribe('ask', async (event) => {
    const d = event.data || {};
    if (d.to !== 'harness') return;
    // The bus speaks strings: question = "TOOL:<name>|<json-args>", or
    // structured {tool, args} when sent by a module with reference to us.
    let tool = d.tool;
    let args = d.args || {};
    if (!tool && typeof d.question === 'string') {
      const m = d.question.match(/^TOOL:([^\s|]+)\|?(.*)$/s);
      if (m) {
        tool = m[1];
        if (m[2]) { try { args = JSON.parse(m[2]); } catch { args = { note: m[2] }; } }
      }
    }
    if (!tool) return;
    const result = await dispatch(tool, args || {}, { actor: d.from || 'unknown', reason: 'bus query' });
    bus.answer(d.queryId, result);
  }, 'harness-brain');
}

// Convenience for in-module use: `useTool(actor, 'gsk.read_file', {path})`
async function useTool(actor, tool, args = {}) {
  return dispatch(tool, args, { actor });
}

module.exports = {
  register,
  registerBatch,
  seed,
  attach,
  dispatch,
  useTool,
  atlas,
  gateTool,
  initBusBindings,
  RISK_TAX,
  PLT_STAMP,
};