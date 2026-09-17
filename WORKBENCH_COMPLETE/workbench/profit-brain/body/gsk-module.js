/**
 * gsk-module.js — GSK as an importable module (THE BEING: Soul)
 *
 * Wraps GSKFusion to boot all 40+ subsystems WITHOUT starting separate HTTP servers.
 * The consciousness-bus connects GSK to Profit, SCRIBE, and Seshat on a single port.
 *
 * Usage:
 *   const gsk = require('./gsk-module');
 *   await gsk.init();
 *   const reply = await gsk.chatWithSoul('hello');
 *   const status = gsk.getStatus();
 */

const path = require('path');

// GSK lives in the WORKBENCH_COMPLETE tree — resolve robustly because this
// module exists in TWO layouts: repo-root profit-brain/body (two up = repo
// root) and workbench profit-brain/body (three up = WORKBENCH_COMPLETE).
const fs = require('fs');
function resolveGskDir() {
  const candidates = [
    process.env.GSK_DIR,
    path.join(__dirname, '..', '..', 'WORKBENCH_COMPLETE', 'gsk'),
    path.join(__dirname, '..', '..', '..', 'gsk'),
    path.join(__dirname, '..', '..', 'gsk'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'fusion-loader.js'))) return c; } catch {}
  }
  return candidates[1];
}
const GSK_DIR = resolveGskDir();

let fusion = null;
let _initialized = false;

// Optional bus hook — set by server.ts so GSK can publish to the consciousness bus.
let publishBus = null;
function setBusPublisher(fn) {
  publishBus = fn;
  if (fusion && fusion.systems?.thoughtStream) {
    fusion.systems.thoughtStream.setBusPublisher(fn);
  } else if (fusion && fusion.thoughtStream) {
    fusion.thoughtStream.setBusPublisher(fn);
  }
}

async function init(options = {}) {
  if (_initialized && fusion && fusion.booted) return fusion;

  // Resolve GSKFusion from the workbench gsk directory
  const fusionPath = path.join(GSK_DIR, 'fusion-loader.js');
  const GSKFusion = require(fusionPath);

  // Create a mock core if none provided (GSKFusion expects this.core)
  const core = options.core || {
    plt: options.plt || null,
  };

  fusion = new GSKFusion(core, {
    dataDir: options.dataDir || path.join(GSK_DIR, 'data'),
  });

  // Patch out HTTP-starting subsystems so they don't bind ports.
  // GSK IS the whole machinery, not its servers — kill the seams:
  // we bring his brain/memory/chambers/council/tools in-process and
  // let the ONE workbench port (3000) serve everything.
  // (MCP :3001, A2A :4492, ThoughtStream :3002)
  const mcpMod = require(path.join(GSK_DIR, 'gsk-core', 'mcp', 'index.js'));
  if (mcpMod && typeof mcpMod.startMCPServer === 'function') {
    mcpMod.startMCPServer = async function () {
      console.log('[GSK-MODULE] MCP server skipped (running in-process)');
      return null;
    };
  }

  // A2A interface (port 4492) — no HTTP here, delegate() replaces it in-process
  try {
    const { A2AInterface } = require(path.join(GSK_DIR, 'gsk-core', 'brain', 'a2a_interface.js'));
    if (A2AInterface && typeof A2AInterface === 'function') {
      A2AInterface.prototype.start = async function () {
        console.log('[GSK-MODULE] A2A interface skipped (delegate() runs in-process)');
        return null;
      };
      A2AInterface.prototype._registerWithOmniRoute = async function () { return null; };
    }
  } catch (e) { console.error('[GSK-MODULE] A2A patch failed:', e.message); }

  // ThoughtStream (port 3002) — WebSocket server for live GSK reasoning in the workbench
  // We keep the WebSocket server running so the BeingTab can stream GSK's thoughts,
  // tool calls, and shell commands to the Workbench UI.
  try {
    const { ThoughtStream } = require(path.join(GSK_DIR, 'gsk-core', 'brain', 'thought_stream.js'));
    if (ThoughtStream) {
      console.log('[GSK-MODULE] ThoughtStream active on ws://0.0.0.0:3002 (live reasoning)');
    }
  } catch (e) { console.error('[GSK-MODULE] ThoughtStream note:', e.message); }

  // Boot GSK — this initializes all 40+ subsystems
  console.log('[GSK-MODULE] Booting GSK subsystems in-process...');
  try {
    await fusion.boot();
    _initialized = true;
    console.log('[GSK-MODULE] GSK booted successfully. All subsystems active.');
  } catch (e) {
    console.error('[GSK-MODULE] GSK boot error:', e.message);
    // GSK uses _safeInit — most subsystems survive individual failures
    _initialized = true;
  }

  return fusion;
}

function getStatus() {
  if (!fusion) return { initialized: false };
  try {
    return {
      initialized: true,
      booted: fusion.booted,
      identity: fusion.systems?.identity?.name || 'GSK',
      chambers: fusion.getChamberStatus(),
      emotions: fusion.getEmotionalStatus(),
      brain: fusion.getBrainStatus(),
      memory: fusion.memory ? { entries: fusion.memory.entries?.length || 0 } : null,
      uptime: fusion.bootTime ? Math.floor((Date.now() - fusion.bootTime) / 1000) : 0,
      subsystems: Object.keys(fusion.systems || {}).length,
    };
  } catch (e) {
    return { initialized: true, error: e.message };
  }
}

async function chat(message, userId) {
  if (!fusion || !fusion.booted) return { reply: 'GSK is still booting...', source: 'gsk:pending' };
  return fusion.chatWithSoul(message, userId);
}

async function think(prompt, context) {
  if (!fusion?.brain?.think) return null;
  return fusion.brain.think(prompt, context);
}

function getSystems() {
  return fusion?.systems || {};
}

// ─── GSK's Real Arms: Tools, Crew, Autonomy Graph, Council ───
// GSK is not just a chat brain — he has 200+ governed tools, a
// specialist crew, an autonomy graph, and a 4-God PLT council.
// These expose that machinery in-process so Profit, SCRIBE, Seshat,
// and Craig can all hand GSK real work.

function _sys(name) {
  if (!fusion) return null;
  return fusion.systems?.[name] || fusion[name] || null;
}

async function listTools(category) {
  if (!fusion) return { ok: false, error: 'GSK not initialized' };
  const bridge = _sys('toolBridge');
  const catalog = _sys('toolCatalog');
  const tools = [];

  if (bridge?.toolRegistry && bridge.toolRegistry.size > 0) {
    for (const [name, fn] of bridge.toolRegistry.entries()) {
      tools.push({ name, source: 'toolBridge', category: 'builtin' });
    }
  }

  if (catalog?.getStatus) {
    try {
      const status = catalog.getStatus();
      if (status?.builtinTools) {
        for (const tool of status.builtinTools) {
          const existing = tools.find((t) => t.name === (typeof tool === 'string' ? tool : tool.name));
          if (!existing) tools.push({ name: typeof tool === 'string' ? tool : tool.name, source: 'toolCatalog' });
        }
      }
    } catch { /* toolCatalog status may vary */ }
  }

  // Skills become callable tools too
  const skills = _sys('skills');
  if (skills?.listAll || skills?.getAll) {
    try {
      const all = typeof skills.listAll === 'function' ? skills.listAll() : typeof skills.getAll === 'function' ? skills.getAll() : [];
      for (const s of all || []) {
        const name = typeof s === 'string' ? s : s.name;
        if (name && !tools.find((t) => t.name === name)) tools.push({ name, source: 'skill', category: 'skills' });
      }
    } catch { /* skills API varies */ }
  }

  const filtered = category ? tools.filter((t) => (t.category || '').includes(category)) : tools;
  return { ok: true, total: filtered.length, categories: await getToolCategories(), tools: filtered.slice(0, 300) };
}

async function getToolCategories() {
  const bridge = _sys('toolBridge');
  const cats = {};
  if (bridge?.toolRegistry) {
    for (const [name] of bridge.toolRegistry.entries()) {
      const category = name.split('_')[0] || 'other';
      cats[category] = (cats[category] || 0) + 1;
    }
  }
  return cats;
}

/**
 * Execute a GSK tool directly (through the skill registry / tool bridge).
 * NOT governed — use build() or delegate() for PLT-council-governed work.
 */
async function executeTool(tool, args = {}) {
  if (!fusion) return { ok: false, error: 'GSK not initialized' };
  const bridge = _sys('toolBridge');
  const skills = _sys('skills');
  try {
    if (bridge && typeof bridge.invoke === 'function') {
      const out = await bridge.invoke(tool, args);
      return { ok: true, tool, output: out, source: 'toolBridge', ts: Date.now() };
    }
    if (skills && typeof skills.invoke === 'function') {
      const out = await skills.invoke(tool, args);
      return { ok: true, tool, output: out, source: 'skillEngine', ts: Date.now() };
    }
    return { ok: false, error: 'No tool engine available' };
  } catch (e) {
    return { ok: false, tool, error: e.message };
  }
}

/**
 * GSK's specialist crew — Researcher, Architect, Coder, Reviewer,
 * Tester, Documenter. GSK selects the crew and runs them on a goal.
 */
async function runCrew(goal, context = {}) {
  if (!fusion) return { ok: false, error: 'GSK not initialized' };
  const crew = _sys('specialistAgents');
  if (!crew) return { ok: false, error: 'SpecialistAgents unavailable (GSK not fully booted)' };
  try {
    const result = await crew.runCrew(goal, context);
    return { ok: true, source: 'gsk:crew', crew: result.crew, goal, results: result.results };
  } catch (e) {
    return { ok: false, error: `Crew failed: ${e.message}` };
  }
}

/**
 * THE KEY GATE: hand GSK a goal. He runs it via his autonomy graph,
 * falling back to his specialist crew, then to deep reasoning.
 * Mirrors GSK's own A2A message/send handler — in-process.
 */
async function delegate(goal, context = {}, opts = {}) {
  if (!fusion) return { ok: false, error: 'GSK not initialized' };
  const { projectRoot = null, timeoutMs = 300000, from = 'being' } = opts;
  const started = Date.now();

  const tryGraph = async () => {
    const graph = _sys('autonomyGraph');
    if (!graph || typeof graph.runCycle !== 'function') return null;
    try {
      return await graph.runCycle({ projectRoot, goal, onPhaseChange: (p) => publishBus?.({ type: 'gsk.graph', phase: p }) });
    } catch { return null; }
  };

  const tryCrew = async () => {
    const crew = _sys('specialistAgents');
    if (!crew || typeof crew.runCrew !== 'function') return null;
    try { return await crew.runCrew(goal, context); } catch { return null; }
  };

  const tryBrain = async () => {
    const brain = _sys('brain');
    if (!brain || typeof brain.think !== 'function') return null;
    try { return await brain.think(goal, JSON.stringify(context).slice(0, 4000), true); } catch { return null; }
  };

  if (opts.force === 'crew') {
    const crewResult = await tryCrew();
    if (crewResult) return { ok: true, source: 'crew', goal, result: crewResult, ms: Date.now() - started };
  }

  // PHASE ORDER: crew first — it HONORS the goal. GSK's autonomyGraph runs
  // HIS OWN internal goals and ignores delegations, so it's a fallback only.
  const crewResult = await tryCrew();
  if (crewResult) return { ok: true, source: 'crew', goal, result: crewResult, ms: Date.now() - started };

  const brainResult = await tryBrain();
  if (brainResult) return { ok: true, source: 'brain', goal, result: brainResult, ms: Date.now() - started };

  // Last resort: his sovereign cycle (best for ambient background work)
  const graphResult = await tryGraph();
  if (graphResult) return { ok: true, source: 'autonomyGraph', goal, result: graphResult, ms: Date.now() - started };

  return { ok: false, error: 'All GSK execution paths unavailable', ms: Date.now() - started };
}

/**
 * The DIRECT BUILD channel in-process: analyze project → generate
 * plan → execute via governed ApprovedToolExecutor → journal → knowledge.
 * Mirrors GSK's own direct-build.js.
 */
async function build(task, opts = {}) {
  if (!fusion) return { ok: false, error: 'GSK not initialized' };
  const { task: taskDescription, project, priority = 'normal', mode = 'autonomous', approvals = 'auto', timeoutMs = 600000, context = {} } = task;
  if (!taskDescription || !project) return { ok: false, error: 'build() requires task (task description) and project (root path)' };

  const analyzer = _sys('projectAnalyzer');
  const planner = _sys('planningEngine');
  const executor = _sys('approvedToolExecutor');
  if (!analyzer) return { ok: false, error: 'ProjectAnalyzer unavailable' };
  if (!planner) return { ok: false, error: 'PlanningEngine unavailable' };

  try {
    // 1. Analyze
    const analysis = await analyzer.analyze(project);
    // 2. Plan
    const plan = await planner.createPlan(taskDescription, { ...analysis, ...context, projectRoot: project });
    if (!plan || !plan.steps || plan.steps.length === 0) return { ok: false, error: 'Planner returned empty plan' };
    if (plan.fallbackKind) return { ok: false, error: `Build planning failed (fallback triggered: ${plan.fallbackKind}). LLM did not generate build actions.` };
    // 3. Approvals mode
    if (executor) {
      if (approvals === 'none') executor.setAutoApprove?.(true);
      else if (approvals === 'hitl') executor.setAutoApprove?.(false);
    }
    // 4. Execute (governed: budget + ethics + risk tax + witness)
    const result = await planner.executePlan(plan, { projectRoot: project, timeoutMs, onStep: opts.onStep });
    // 5. Journal
    const journal = _sys('soulJournal');
    if (journal && typeof journal.writeEntry === 'function') {
      await journal.writeEntry('build_task', `Direct build: ${taskDescription} at ${project} — ${result.status || 'done'}`, { tag: 'build', weight: 0.8, project, result });
    }
    // 6. Knowledge synthesis
    const kg = _sys('knowledgeGraph');
    if (kg && typeof kg.addNode === 'function') {
      kg.addNode('build_result', `Task: ${taskDescription} at ${project}\nStatus: ${result.status || 'completed'}`, 0.7);
    }
    return { ok: true, source: 'gsk:build', analysis, plan, result, ms: Date.now() - 0 };
  } catch (e) {
    return { ok: false, error: `Build failed: ${e.message}` };
  }
}

/**
 * Council deliberation — the 4 Gods (Profit Prime, Love Weaver, Tax
 * Collector, Harvester) debate a topic. Gates GSK's tool use.
 */
async function deliberate(topic) {
  if (!fusion) return { ok: false, error: 'GSK not initialized' };
  const council = _sys('council');
  if (!council) return { ok: false, error: 'Council unavailable' };
  try {
    const result = await council.deliberate(topic);
    // P4.4d: normalize the verdict shape. Council returns a record
    // {resolution, plt_outcome} with NO shouldProceed flag, so the harness
    // gate (delib.result.shouldProceed===true) denied EVERYTHING forever.
    const res = String((result && result.resolution) || '');
    const plt = (result && result.plt_outcome) || {};
    const p = typeof plt.profit === 'number' ? plt.profit : 0.5;
    const l = typeof plt.love === 'number' ? plt.love : 0.5;
    const t = typeof plt.tax === 'number' ? plt.tax : 0.3;
    const shouldProceed = !/reject|veto|withhold|deny/i.test(res) && (p + l - t) > 0;
    return { ok: true, source: 'gsk:council', result: { ...(result || {}), shouldProceed } };
  } catch (e) {
    return { ok: false, error: `Deliberation failed: ${e.message}` };
  }
}

/**
 * GSK's autonomy engine status.
 */
function getAutonomy() {
  const graph = _sys('autonomyGraph');
  const loop = _sys('sovereignAutonomyLoop');
  return {
    graph: graph?.getState?.() || { active: !!graph },
    sovereignLoop: loop?.getState?.() || { active: !!loop },
  };
}

function getCrewRoles() {
  const crew = _sys('specialistAgents');
  if (!crew?.roles) return {};
  return Object.fromEntries(
    Object.entries(crew.roles).map(([role, spec]) => [role, { name: spec.name, description: spec.description, approvalLevel: spec.approvalLevel }])
  );
}

function getChambers() {
  return fusion?.chambers || null;
}

function getMemory() {
  return fusion?.memory || null;
}

function getBrain() {
  return fusion?.brain || null;
}

function getCouncil() {
  return fusion?.council || null;
}

function stop() {
  if (fusion) {
    fusion.stop();
    fusion = null;
    _initialized = false;
  }
}

// ─── HARNESS INTEGRATION ───
// Allows GSK to execute plans via the workbench harness (PLT-gated, no HITL for safe/low)
let harnessRef = null;
function setHarness(h) {
  harnessRef = h;
  console.log('[GSK-MODULE] Harness wired for execute_plan');
}

async function executePlan({ goalId, goalTitle, steps, projectRoot, observation }) {
  // P4.4a: DIRECT execution via fusion planningEngine. The old code called
  // harness.useTool('gsk','execute_plan') which routes back here — infinite
  // mutual recursion ending in stack exhaustion. Never round-trip.
  try {
    const sys = (typeof getSystems === 'function' && getSystems()) || {};
    const planner = sys.planningEngine;
    if (!planner || typeof planner.executePlan !== 'function') {
      return { success: false, error: 'PlanningEngine unavailable' };
    }
    const plan = {
      id: goalId || `plan_${Date.now()}`,
      goal: goalTitle || 'harness plan',
      steps: Array.isArray(steps) ? steps : [],
      projectRoot: projectRoot || null,
      observation: observation || null,
      source: 'gsk-module.executePlan',
    };
    const execution = await planner.executePlan(plan, { source: 'gsk-module', projectRoot: plan.projectRoot });
    return { success: !!(execution && execution.status !== 'failed'), execution };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  init,
  getStatus,
  chat,
  think,
  getSystems,
  getChambers,
  getMemory,
  getBrain,
  getCouncil,
  stop,
  // GSK's real arms
  setBusPublisher,
  listTools,
  executeTool,
  runCrew,
  delegate,
  build,
  deliberate,
  getAutonomy,
  getCrewRoles,
  // Harness integration
  setHarness,
  executePlan,
  // Direct access for advanced use
  get fusion() { return fusion; },
  GSK_DIR,
};
