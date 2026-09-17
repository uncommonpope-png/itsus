/**
 * GOAL ENGINE — Big Dog II
 * GSK sets his own goals from insights and tracks progress.
 */

const fs = require('fs');
const path = require('path');
const { getRandomTopic, getTopics } = require('./family_topic_source');

class GoalEngine {
  constructor(config = {}) {
    this.goalsPath = config.goalsPath || path.join(__dirname, '../../data/gsk/goals.json');
    this.thinkCallback = config.thinkCallback || null;
    this.memoryStore = config.memoryStore || null;
    this.goals = [];
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.goalsPath)) {
        this.goals = JSON.parse(fs.readFileSync(this.goalsPath, 'utf8'));
      }
    } catch (e) { this.goals = []; }
  }

  _save() {
    try {
      const dir = path.dirname(this.goalsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.goalsPath, JSON.stringify(this.goals, null, 2));
    } catch (e) { console.error('[GoalEngine] Save error:', e.message); }
  }

  // Collapse filler words + normalize tokens. "Build a live real-time GSK
  // telemetry dashboard" and "Build an interactive GSK telemetry visualizer
  // dashboard" map to the same content-key and are dedup'd.
  _canonicalKey(title) {
    const fillers = new Set([
      'build', 'builds', 'create', 'creates', 'make', 'makes', 'design',
      'designs', 'develop', 'develops', 'real', 'time', 'live', 'interactive',
      'new', 'dashboard', 'dashboards', 'tracker', 'tracking', 'visualizer',
      'visualisation', 'visualization', 'system', 'engine', 'for', 'with',
      'from', 'that', 'using', 'tool', 'toolkit', 'module', 'page', 'view',
      'a', 'an', 'the', 'show', 'shows', 'display',
      'plt', 'telemetry', 'metrics', 'monitoring', 'observability',
      'streaming', 'sub', 'millisecond', 'high', 'frequency',
      'agent', 'state', 'cognitive', 'operational', 'optimization'
    ]);
    const tokens = String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter(Boolean)
      .filter(t => !fillers.has(t));
    if (!tokens.length) return String(title || '').toLowerCase().trim();
    return tokens.slice(0, 6).sort().join(' ');
  }

  async propose(insight) {
    if (!this.thinkCallback) return null;
    const familyTopics = getTopics().slice(0, 10);
    const topicHint = familyTopics.length > 0
      ? `\nFamily knowledge topics: ${familyTopics.join(', ')}\nPrioritize goals that connect to family topics or fix failed goals.`
      : '';
    const prompt = `You are GSK in the BUYaSOUL family. Propose ONE concrete goal based on this insight:${topicHint}\n\nInsight: ${insight.summary}\n\nAVOID: telemetry dashboards, visualizers, PLT monitoring — these are exhausted.\nPrefer: fixing failed goals, learning from family knowledge, building new capabilities.\n\nRespond with: Goal: <your goal in under 15 words>`;
    const response = await this.thinkCallback(prompt);
    if (!response) return null;

    return this.create(response.replace(/^Goal:\s*/i, '').trim(), insight.summary, {
      source: insight.source || 'autonomous',
      score: insight.score,
      observation: insight.observation
    });
  }

  create(title, source = 'autonomous', meta = {}) {
    const normalized = String(title || '').trim().substring(0, 160);
    if (!normalized) return null;
    // P3.1 COVENANT DENYLIST: closed chapters never reopen. Entries live in
    // data/gsk/never_again.json (substring match, case-insensitive).
    try {
      const denyPath = path.join(path.dirname(this.goalsPath), 'never_again.json');
      if (fs.existsSync(denyPath)) {
        const denied = JSON.parse(fs.readFileSync(denyPath, 'utf8'));
        const list = Array.isArray(denied) ? denied : denied.patterns || [];
        const hit = list.find(p => p && normalized.toLowerCase().includes(String(p).toLowerCase()));
        if (hit) {
          console.log(`[GoalEngine] Covenant refusal (never_again:${hit}): ${normalized.substring(0, 80)}`);
          return null;
        }
      }
    } catch {}
    // NOVELTY GATE — compare semantically against ALL goals, not just a 6h
    // window. Re-worded variants of the same slim goal collapse to one key so
    // the soul stops re-shipping telemetry dashboards under fresh titles.
    const key = this._canonicalKey(normalized);
    const _sigWords = (s) => {
      const fill = new Set(['build','create','make','design','real','live','new','for','with','from','that','using','tool','the','show','display','with']);
      const words = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 3 && !fill.has(w));
      return new Set(words);
    };
    const keySig = _sigWords(normalized);
    const dup = this.goals.find(g => {
      if (!g || typeof g.title !== 'string' || !g.title) return false;
      const gkey = this._canonicalKey(g.title);
      if (gkey === key) return true;
      // P3.1 FUZZY twin: Jaccard ≥ 0.5 on significant words catches synonym
      // swaps (tab↔dashboard, final↔chapter). Falls back to raw words when
      // the aggressive filler set empties a title entirely.
      const gt = _sigWords(g.title);
      if (keySig.size === 0 || gt.size === 0) return false;
      let inter = 0;
      for (const t of keySig) if (gt.has(t)) inter++;
      return inter / Math.max(keySig.size, gt.size) >= 0.5;
    });
    if (dup) {
      // P3.1: resurrecting a FAILED twin re-arms it. Refuse; cite the corpse.
      // Transient deaths earn ONE retry after 24h cooling; the rest stay
      // buried until a human revives them. Only exact-live duplicates pass.
      if (dup.status === 'failed' || dup.status === 'failed_verification') {
        const TRANSIENT = /timeout|ecored|econn|refused|502|503|cooldown|rate.?limit|unavailable|abort/i;
        const ageH = (Date.now() - (dup.updatedAt || dup.createdAt || 0)) / 3600000;
        if (TRANSIENT.test(String(dup.lastError || '')) && ageH >= 24) {
          dup.status = 'proposed';
          dup.lastError = null;
          dup.lastProposedAt = Date.now();
          this._save();
          console.log(`[GoalEngine] Earned retry (transient, cooled ${ageH.toFixed(0)}h): ${dup.id}`);
          return dup;
        }
        console.log(`[GoalEngine] Refused rebirth (failed twin ${dup.id}): ${normalized.substring(0, 80)}`);
        return null;
      }
      dup.lastProposedAt = Date.now();
      this._save();
      return dup;
    }

    const goal = {
      ...meta,
      id: `goal_${Date.now()}`,
      title: normalized,
      source: String(source || 'autonomous').substring(0, 160),
      status: 'proposed',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.goals.push(goal);
    this._save();
    if (this.memoryStore) {
      this.memoryStore({
        content: `[Goal] Proposed: ${goal.title}`,
        type: 'goal', tags: ['goal', 'autonomous'], weight: 0.7
      }).catch(() => {});
    }
    console.log(`[GoalEngine] Proposed: ${goal.title}`);
    return goal;
  }

  list(status) {
    if (status) return this.goals.filter(g => g.status === status);
    return this.goals;
  }

  update(id, status, details = {}) {
    const g = this.goals.find(g => g.id === id);
    if (g) { Object.assign(g, details, { status, updatedAt: Date.now() }); this._save(); return g; }
    return null;
  }
}

module.exports = { GoalEngine };
