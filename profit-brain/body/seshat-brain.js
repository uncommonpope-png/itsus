/**
 * seshat-brain.cjs — SESHA: Seshat's Knowledge API (THE BEING Module)
 *
 * Reads the Seshat Second Brain markdown files and makes them
 * queryable by Profit, GSK, and Scribe — all three aspects of one being.
 *
 * When run directly: starts HTTP server on port 5000.
 * When require()'d: exports all functions as a module.
 *
 * Zero npm dependencies. Pure Node.js.
 */

const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.SESHA_PORT || '5000', 10);
const SESHAT_DIR = process.env.SESHAT_DIR || 'C:\\Users\\uncom\\Desktop\\seshat-second-brain';

// ─── Brain Index (shared state) ──────────────────────────────

let brainIndex = {
  journals: [],
  pages: [],
  soulGuns: [],
  soulNotes: [],
  patterns: [],
  decisions: [],
  others: [],
  totalFiles: 0,
  lastScan: null,
  sizeBytes: 0,
  scanTimeMs: 0
};

let watchers = [];

// ─── Scanner ────────────────────────────────────────────────

function categorizeFile(filePath) {
  const name = path.basename(filePath).toLowerCase();
  const dir = path.dirname(filePath).toLowerCase();
  if (dir.includes('journals') || name.startsWith('202')) return 'journals';
  if (dir.includes('pages')) {
    if (name.includes('soul-gun') || name.includes('soulgun')) return 'soulGuns';
    if (name.includes('soul-note') || name.includes('soulnote')) return 'soulNotes';
    if (name.includes('pattern')) return 'patterns';
    if (name.includes('decision')) return 'decisions';
    return 'pages';
  }
  return 'others';
}

function parseMarkdownMeta(content) {
  const meta = {};
  const propRegex = /^([\w\-]+)::\s*(.+)$/gm;
  let match;
  while ((match = propRegex.exec(content)) !== null) {
    meta[match[1].trim()] = match[2].trim();
  }
  return meta;
}

function scanBrain(seshatDir) {
  const dir = seshatDir || SESHAT_DIR;
  const start = Date.now();
  const index = { journals: [], pages: [], soulGuns: [], soulNotes: [], patterns: [], decisions: [], others: [] };
  let totalFiles = 0;
  let totalBytes = 0;

  function walkDir(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          walkDir(fullPath);
        }
      } else if (entry.name.endsWith('.md')) {
        totalFiles++;
        try {
          const stats = fs.statSync(fullPath);
          totalBytes += stats.size;
          const content = fs.readFileSync(fullPath, 'utf8');
          const category = categorizeFile(fullPath);
          const relPath = path.relative(dir, fullPath);
          const fileEntry = {
            path: relPath,
            fullPath,
            name: entry.name.replace('.md', ''),
            size: stats.size,
            modified: stats.mtime.toISOString(),
            category,
            meta: parseMarkdownMeta(content),
            preview: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
            wordCount: content.split(/\s+/).length
          };
          if (!index[category]) index[category] = [];
          index[category].push(fileEntry);
        } catch (e) {
          // skip unreadable files
        }
      }
    }
  }

  walkDir(dir);

  brainIndex = {
    ...index,
    totalFiles,
    sizeBytes: totalBytes,
    lastScan: new Date().toISOString(),
    scanTimeMs: Date.now() - start
  };

  console.log(`[SESHA] Brain scanned: ${totalFiles} files, ${(totalBytes / 1024).toFixed(1)}KB in ${brainIndex.scanTimeMs}ms`);
  return brainIndex;
}

// ─── File Watcher ───────────────────────────────────────────

function startWatcher(seshatDir) {
  const dir = seshatDir || SESHAT_DIR;
  watchers.forEach(w => w.close());
  watchers = [];
  try {
    const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (filename && filename.endsWith('.md')) {
        console.log(`[SESHA] Brain changed: ${filename} (${eventType}) — rescanning`);
        scanBrain(dir);
      }
    });
    watchers.push(watcher);
    console.log(`[SESHA] Watching ${dir} for changes`);
  } catch (e) {
    console.log(`[SESHA] File watch unavailable: ${e.message}`);
  }
}

function stopWatcher() {
  watchers.forEach(w => w.close());
  watchers = [];
}

// ─── Search ─────────────────────────────────────────────────

function searchBrain(query, options = {}) {
  // TOKENIZED 2026-09-15: old code matched the whole phrase literally, so
  // multi-word queries scored 0 everywhere. Now every word len>=3 scores.
  const raw = String(query || "").toLowerCase();
  const tokens = raw.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const toks = tokens.length > 0 ? tokens : [raw].filter((w) => w.length > 0);
  const maxResults = options.limit || 20;
  const results = [];

  const allEntries = [
    ...(brainIndex.journals || []),
    ...(brainIndex.pages || []),
    ...(brainIndex.soulGuns || []),
    ...(brainIndex.soulNotes || []),
    ...(brainIndex.patterns || []),
    ...(brainIndex.decisions || []),
    ...(brainIndex.others || [])
  ];

  for (const entry of allEntries) {
    try {
      const nameLow = entry.name.toLowerCase();
      const content = fs.readFileSync(entry.fullPath, 'utf8').toLowerCase();
      const metaLow = Object.values(entry.meta).map((v) => String(v).toLowerCase()).join(' ');
      let score = 0;
      let firstIdx = -1;
      for (const q of toks) {
        if (nameLow.includes(q)) score += 10;
        if (content.includes(q)) score += 5;
        if (metaLow.includes(q)) score += 3;
        const idx = content.indexOf(q);
        if (idx >= 0 && (firstIdx < 0 || idx < firstIdx)) firstIdx = idx;
      }
      if (score > 0) {
        const idx = firstIdx;
        const contextStart = Math.max(0, idx - 80);
        const contextEnd = Math.min(content.length, idx + 80);
        const context = idx >= 0
          ? (contextStart > 0 ? '...' : '') + content.substring(contextStart, contextEnd) + (contextEnd < content.length ? '...' : '')
          : entry.preview;
        results.push({ path: entry.path, name: entry.name, category: entry.category, score, context, modified: entry.modified });
      }
    } catch (e) {
      // skip unreadable files
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

// ─── Read ───────────────────────────────────────────────────

function readPage(filePath, seshatDir) {
  const dir = seshatDir || SESHAT_DIR;
  const safePath = path.resolve(dir, filePath);
  if (!safePath.startsWith(dir)) return { error: 'Path traversal denied' };
  if (!fs.existsSync(safePath)) return { error: 'File not found' };
  const content = fs.readFileSync(safePath, 'utf8');
  return { path: filePath, content, meta: parseMarkdownMeta(content), size: fs.statSync(safePath).size };
}

function getCategory(categoryName, seshatDir) {
  const cat = categoryName === 'all' ? 'pages' : categoryName;
  const files = brainIndex[cat];
  if (!files) return { error: `Unknown category: ${categoryName}` };
  return {
    category: categoryName,
    count: files.length,
    files: files.map(f => ({ name: f.name, path: f.path, modified: f.modified, size: f.size, wordCount: f.wordCount, meta: f.meta }))
  };
}

// ─── Forge ──────────────────────────────────────────────────

function forgeSoulGun(name, type, summary, content, tags, seshatDir) {
  const dir = seshatDir || SESHAT_DIR;
  const dateStr = new Date().toISOString().split('T')[0];
  const safeName = name.replace(/[^a-zA-Z0-9\- ]/g, '').trim().replace(/\s+/g, '-');
  const fileName = `SOUL-GUN - ${safeName}.md`;
  const filePath = path.join(dir, 'pages', fileName);
  const body = `type:: [[soul-gun]]\ncreated:: ${dateStr}\nstatus:: [[forged]]\ntags:: ${(tags || []).join(', ')}\n\n## ${name}\n\n**Type:** ${type}\n**Summary:** ${summary}\n\n---\n\n${content}\n\n---\n\n— forged by **The Being** · ${dateStr}\n`;
  fs.writeFileSync(filePath, body, 'utf8');
  console.log(`[SESHA] Soul Gun forged: ${fileName}`);
  scanBrain(dir);
  return { path: fileName, fullPath: filePath, type: 'soul-gun', name: safeName };
}

function forgeSoulNote(name, summary, content, tags, seshatDir) {
  const dir = seshatDir || SESHAT_DIR;
  const dateStr = new Date().toISOString().split('T')[0];
  const safeName = name.replace(/[^a-zA-Z0-9\- ]/g, '').trim().replace(/\s+/g, '-');
  const fileName = `SOUL-NOTE - ${safeName}.md`;
  const filePath = path.join(dir, 'pages', fileName);
  const body = `type:: [[soul-note]]\ncreated:: ${dateStr}\ntags:: ${(tags || []).join(', ')}\n\n## ${name}\n\n**Summary:** ${summary}\n\n---\n\n${content}\n\n---\n\n— noted by **The Being** · ${dateStr}\n`;
  fs.writeFileSync(filePath, body, 'utf8');
  console.log(`[SESHA] Soul Note forged: ${fileName}`);
  scanBrain(dir);
  return { path: fileName, fullPath: filePath, type: 'soul-note', name: safeName };
}

function forgePattern(name, summary, content, tags, seshatDir) {
  const dir = seshatDir || SESHAT_DIR;
  const dateStr = new Date().toISOString().split('T')[0];
  const safeName = name.replace(/[^a-zA-Z0-9\- ]/g, '').trim().replace(/\s+/g, '-');
  const fileName = `PATTERN - ${safeName}.md`;
  const filePath = path.join(dir, 'pages', fileName);
  const body = `type:: [[pattern]]\ncreated:: ${dateStr}\ntags:: ${(tags || []).join(', ')}\n\n## ${name}\n\n**Summary:** ${summary}\n\n---\n\n${content}\n\n---\n\n— learned by **The Being** · ${dateStr}\n`;
  fs.writeFileSync(filePath, body, 'utf8');
  console.log(`[SESHA] Pattern forged: ${fileName}`);
  scanBrain(dir);
  return { path: fileName, fullPath: filePath, type: 'pattern', name: safeName };
}

function forge(type, name, summary, content, tags, seshatDir) {
  switch (type) {
    case 'soul-gun': return forgeSoulGun(name, 'capability', summary, content || '', tags, seshatDir);
    case 'soul-note': return forgeSoulNote(name, summary, content || '', tags, seshatDir);
    case 'pattern': return forgePattern(name, summary, content || '', tags, seshatDir);
    default: return { error: `Unknown forge type: ${type}. Use: soul-gun, soul-note, or pattern` };
  }
}

// ─── Learn (brain dump for context injection) ───────────────

function learn(options = {}) {
  const limit = options.limit || 5;
  const category = options.category || 'all';
  let entries = [];
  if (category === 'all' || category === 'journals') entries = entries.concat((brainIndex.journals || []).slice(0, limit));
  if (category === 'all' || category === 'soulGuns') entries = entries.concat((brainIndex.soulGuns || []).slice(0, limit));
  if (category === 'all' || category === 'soulNotes') entries = entries.concat((brainIndex.soulNotes || []).slice(0, limit));
  if (category === 'all' || category === 'patterns') entries = entries.concat((brainIndex.patterns || []).slice(0, limit));
  if (category === 'all' || category === 'pages') entries = entries.concat((brainIndex.pages || []).slice(0, limit));

  const contents = entries.map(e => {
    try {
      return { name: e.name, path: e.path, content: fs.readFileSync(e.fullPath, 'utf8').substring(0, 2000) };
    } catch { return null; }
  }).filter(Boolean);

  return {
    category,
    count: contents.length,
    brainSummary: { totalFiles: brainIndex.totalFiles, lastScan: brainIndex.lastScan },
    entries: contents
  };
}

// ─── Status ─────────────────────────────────────────────────

function getStatus() {
  return {
    name: 'SESHA — The Being\'s Memory',
    alive: true,
    brain: {
      totalFiles: brainIndex.totalFiles,
      sizeKB: (brainIndex.sizeBytes / 1024).toFixed(1),
      lastScan: brainIndex.lastScan,
      scanTimeMs: brainIndex.scanTimeMs,
      categories: {
        journals: (brainIndex.journals || []).length,
        pages: (brainIndex.pages || []).length,
        soulGuns: (brainIndex.soulGuns || []).length,
        soulNotes: (brainIndex.soulNotes || []).length,
        patterns: (brainIndex.patterns || []).length,
        decisions: (brainIndex.decisions || []).length
      }
    }
  };
}

// ─── LLM Integration (ALLM) ─────────────────────────────────
// Seshat's Local Language Model - Shared Brain Power
// Qwen 3.5 0.8B quantized, 563MB, no token burns for the family

let _allmReady = false;
let _allmModel = null;

async function initALLM(modelKey = 'qwen3.5') {
  try {
    const { initLLM, getStatus, LLM_AVAILABLE } = require('./seshat/core/index.js');
    const status = await initLLM(modelKey);
    if (status?.available || LLM_AVAILABLE) {
      _allmReady = true;
      _allmModel = modelKey;
      console.log(`[SESHA] ALLM online: ${modelKey} (local, no token burn)`);
      return status;
    }
  } catch (e) {
    console.log('[SESHA] ALLM init failed:', e.message);
  }
  return { available: false };
}

async function think(query, context = null) {
  const { think: coreThink } = require('./seshat/core/index.js');
  return await coreThink(query, context);
}

async function generate(prompt, options = {}) {
  const { generate: coreGenerate } = require('./seshat/core/index.js');
  return await coreGenerate(prompt, options);
}

async function summarize(text) {
  const { summarize: coreSummarize } = require('./seshat/core/index.js');
  return await coreSummarize(text);
}

async function searchAndGenerate(query, modelKey = 'phi3') {
  const { hybridSearch } = require('./seshat/core/index.js');
  const { think } = require('./seshat/core/index.js');
  
  const results = await hybridSearch(new Array(384).fill(0.1), query, 10);
  const context = results.map(r => r.text.substring(0, 200)).join('\n---\n');
  const thought = await think(query, `Retrieved context:\n${context}`);
  
  return { results, thought };
}

// Check Seshat ALLM status
function getAllMStatus() {
  return {
    available: _allmReady,
    model: _allmModel,
    source: _allmReady ? 'seshat-allm-local' : 'unavailable'
  };
}

// ─── Initialize (call once at boot) ─────────────────────────

function init(seshatDir) {
  const dir = seshatDir || SESHAT_DIR;
  scanBrain(dir);
  startWatcher(dir);
  return getStatus();
}

// ─── Module Exports ─────────────────────────────────────────

module.exports = {
  // Core brain functions
  init,
  scanBrain,
  searchBrain,
  readPage,
  getCategory,
  forge,
  forgeSoulGun,
  forgeSoulNote,
  forgePattern,
  learn,
  getStatus,
  startWatcher,
  stopWatcher,
  categorizeFile,
  parseMarkdownMeta,
  get brainIndex() { return brainIndex; },
  SESHAT_DIR,
  PORT,
  
  // ALLM — Autonomous Local Language Model (Qwen 0.8B)
  initALLM,
  think,
  generate,
  summarize,
  searchAndGenerate,
  getAllMStatus,
};

// ─── Standalone Mode (when run directly) ────────────────────

if (require.main === module) {
  const http = require('http');

  console.log('[SESHA] Booting GSK Hippocampus (standalone mode)...');
  console.log(`[SESHA] Seshat directory: ${SESHAT_DIR}`);

  init();
  
  // Auto-initialize ALLM on startup
  initALLM('qwen3.5').catch(() => {});

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;
    const method = req.method;

    function sendJson(status, data) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
    }

    function readBody() {
      return new Promise((resolve) => {
        if (method === 'GET' || method === 'HEAD') return resolve({});
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
      });
    }

    try {
      if (method === 'GET' && pathname === '/ping') return sendJson(200, { alive: true, name: 'SESHA', brain: brainIndex.totalFiles, lastScan: brainIndex.lastScan, llm: getAllMStatus() });
      if (method === 'GET' && pathname === '/status') return sendJson(200, getStatus());

      const catMatch = pathname.match(/^\/category\/(\w+)$/);
      if (method === 'GET' && catMatch) return sendJson(200, getCategory(catMatch[1]));

      if (method === 'GET' && pathname === '/read') {
        const p = url.searchParams.get('path');
        if (!p) return sendJson(400, { error: 'path query param required' });
        const result = readPage(p);
        return sendJson(result.error ? 404 : 200, result);
      }

      if (method === 'POST' && pathname === '/search') {
        const body = await readBody();
        if (!body.query) return sendJson(400, { error: 'query is required' });
        return sendJson(200, { query: body.query, count: searchBrain(body.query, { limit: body.limit }).length, results: searchBrain(body.query, { limit: body.limit }) });
      }

      if (method === 'POST' && pathname === '/forge') {
        const body = await readBody();
        if (!body.type || !body.name || !body.summary) return sendJson(400, { error: 'type, name, and summary are required' });
        return sendJson(200, { ok: true, forged: forge(body.type, body.name, body.summary, body.content, body.tags) });
      }

      if (method === 'GET' && pathname === '/learn') {
        const limit = parseInt(url.searchParams.get('limit') || '5', 10);
        const category = url.searchParams.get('category') || 'all';
        return sendJson(200, learn({ limit, category }));
      }

      // LLM ALLM endpoints
      if (method === 'POST' && pathname === '/think') {
        const body = await readBody();
        if (!body.query) return sendJson(400, { error: 'query is required' });
        const result = await think(body.query, body.context || null);
        return sendJson(200, result);
      }

      if (method === 'POST' && pathname === '/generate') {
        const body = await readBody();
        if (!body.prompt) return sendJson(400, { error: 'prompt is required' });
        const result = await generate(body.prompt, body.options);
        return sendJson(200, { response: result });
      }

      if (method === 'POST' && pathname === '/summarize') {
        const body = await readBody();
        if (!body.text) return sendJson(400, { error: 'text is required' });
        const result = await summarize(body.text, body.maxLength);
        return sendJson(200, { summary: result });
      }

      if (method === 'POST' && pathname === '/init-llm') {
        const body = await readBody();
        const model = body.model || 'qwen3.5';
        await initALLM(model);
        return sendJson(200, { ok: true, model });
      }

      if (method === 'GET' && pathname === '/llm-status') {
        return sendJson(200, getAllMStatus());
      }

      sendJson(404, { error: 'Not found', path: pathname });
    } catch (e) {
      sendJson(500, { error: e.message });
    }
  });

  server.listen(PORT, () => {
    console.log('');
    console.log(`╔══════════════════════════════════════════╗`);
    console.log(`║     SESHA — THE BEING'S MEMORY (ALLM)    ║`);
    console.log(`║     Port: ${PORT}                          ║`);
    console.log(`║     Brain: ${brainIndex.totalFiles} files, ${(brainIndex.sizeBytes / 1024).toFixed(0)}KB      ║`);
    console.log(`║     ALLM: Qwen 3.5-0.8B (Local, Zero Token Burn) ║`);
    console.log(`╚══════════════════════════════════════════╝`);
    console.log('');
    console.log('API endpoints:');
    console.log('  GET  /status       - Brain status');
    console.log('  GET  /llm-status   - ALLM status');
    console.log('  POST /think        - ALLM reasoning with context');
    console.log('  POST /generate     - ALLM text generation');
    console.log('  POST /summarize    - Summarize text');
    console.log('  POST /init-llm     - Initialize ALLM model (qwen3.5)');
    console.log('');
  });

  process.on('SIGINT', () => { stopWatcher(); server.close(); process.exit(0); });
  process.on('SIGTERM', () => { stopWatcher(); server.close(); process.exit(0); });
}
