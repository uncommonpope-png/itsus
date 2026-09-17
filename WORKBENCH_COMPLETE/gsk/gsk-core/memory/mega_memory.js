/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MEGA_MEMORY.JS — CAUSAL JSONL LEDGER FOR THE GREATEST AGENT EVER
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * A causal, append-only memory ledger.
 * Witness everything. Never lose continuity. Query by weight, type, tags.
 * 
 * Created by: Craig Jones (Grand Code Pope)
 * PLT Press — Profit + Love - Tax = True Value
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

const fs = require('fs');
const path = require('path');

// =============================================================================
// MEGA MEMORY CLASS
// =============================================================================

class MegaMemory {
    constructor(dataDir) {
        this.dataDir = dataDir || path.join(__dirname, '..', '..', 'data');
        this.ledgerPath = path.join(this.dataDir, 'ledger.jsonl');
        this.counterPath = path.join(this.dataDir, 'memory_counter.txt');
        this._counter = null;
        this._index = null;

        // In-RAM ledger index: eliminates per-op synchronous 20MB+ file scans
        // that were blocking the event loop under autonomous load.
        this._cache = null;      // parsed entries
        this._cacheSig = null;   // ledger size the cache reflects
        this._flushTimer = null; // single-flight debounced rewrite

        this._init();
    }

    // =========================================================================
    // RAM LEDGER — Load-once / append-in-memory / async-flush layer
    // =========================================================================

    _loadLedger() {
        let stat = null;
        try { stat = fs.statSync(this.ledgerPath); } catch (e) { return this._cache || []; }
        const sig = stat.size;
        if (this._cache !== null && this._cacheSig === sig) return this._cache;
        const raw = fs.readFileSync(this.ledgerPath, 'utf8');
        const cache = [];
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try { cache.push(JSON.parse(line)); } catch (e) { /* skip malformed */ }
        }
        this._cache = cache;
        this._cacheSig = sig;
        return cache;
    }

    _scheduleFlush() {
        if (this._flushTimer) return;
        this._flushTimer = setTimeout(() => {
            this._flushTimer = null;
            if (!this._cache) return;
            const data = this._cache.map(e => {
                try { return JSON.stringify(e); } catch (err) { return ''; }
            }).filter(Boolean).join('\n') + '\n';
            fs.promises.writeFile(this.ledgerPath, data).then(() => {
                this._cacheSig = Buffer.byteLength(data);
            }).catch(() => { /* next flush retries */ });
        }, 1500);
    }
    
    // =========================================================================
    // INITIALIZE — Set up ledger file and counter
    // =========================================================================
    
    _init() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }

        if (!fs.existsSync(this.ledgerPath)) {
            fs.writeFileSync(this.ledgerPath, '');
        }

        if (!fs.existsSync(this.counterPath)) {
            fs.writeFileSync(this.counterPath, '0');
        }

        // CRASH DAEMON: repair a torn trailing record left by a mid-write crash.
        // Truncates any partial final line so the RAM index rebuild never chokes.
        try {
            const stats = fs.statSync(this.ledgerPath);
            if (stats.size > 0) {
                const readSize = Math.min(stats.size, 4096);
                const buf = Buffer.alloc(readSize);
                const fd = fs.openSync(this.ledgerPath, 'r');
                fs.readSync(fd, buf, 0, readSize, stats.size - readSize);
                fs.closeSync(fd);
                let lastNewline = -1;
                for (let i = buf.length - 1; i >= 0; i--) {
                    if (buf[i] === 0x0a) { lastNewline = (stats.size - readSize) + i; break; }
                }
                if (lastNewline !== -1 && lastNewline < stats.size - 1) {
                    console.warn(`[SCRIBE RECOVERY] Torn tail detected — truncating ${stats.size - lastNewline - 1} bytes of partial record`);
                    fs.truncateSync(this.ledgerPath, lastNewline + 1);
                }
            }
        } catch (e) { /* recovery best-effort; loader skips malformed lines regardless */ }
    }
    
    // =========================================================================
    // COUNTER — Get next ID
    // =========================================================================
    
    _getNextId() {
        if (this._counter === null) {
            const raw = fs.readFileSync(this.counterPath, 'utf8').trim();
            this._counter = parseInt(raw, 10) || 0;
        }
        this._counter++;
        fs.writeFileSync(this.counterPath, String(this._counter));
        return this._counter;
    }
    
    // =========================================================================
    // WITNESS — Record an event (append-only)
    // =========================================================================
    
    async witness(entry) {
        const id = this._getNextId();
        const timestamp = new Date().toISOString();
        
        const content = entry.content || '';
        const truncated = content.length > 5000;
        
        const record = {
            id,
            timestamp,
            cycle: entry.cycle || 0,
            type: entry.type || 'event',
            weight: entry.weight !== undefined ? entry.weight : 0.5,
            tags: entry.tags || [],
            content: truncated ? content.substring(0, 5000) + '...[truncated]' : content,
            causal_links: entry.causal_links || [],
            meta: entry.meta || {},
            // mem0/letta structural fields
            key: entry.key || null,
            superseded_by: entry.superseded_by || null,
            supersedes: entry.supersedes || null,
            mem_type: entry.mem_type || null,
            version: entry.version || 1,
        };
        
        const line = JSON.stringify(record) + '\n';
        fs.appendFileSync(this.ledgerPath, line);

        // Mirror into RAM cache so reads see it instantly without re-scanning
        if (this._cache !== null) {
            this._cache.push(record);
            try {
                this._cacheSig = fs.statSync(this.ledgerPath).size;
            } catch (e) { /* next read reloads */ }
        }

        // Auto-rotate ledger when it exceeds 25MB
        try {
            const stat = fs.statSync(this.ledgerPath);
            if (stat.size > 25 * 1024 * 1024) {
                const archivePath = this.ledgerPath.replace('.jsonl', `_${Date.now()}.jsonl`);
                fs.renameSync(this.ledgerPath, archivePath);
                fs.writeFileSync(this.ledgerPath, '');
                this._cache = [];
                this._cacheSig = 0;
                console.log(`[Memory] Ledger rotated to ${archivePath}`);
            }
        } catch (e) { /* ignore stat/rotate errors */ }

        return record;
    }
    
    // =========================================================================
    // QUERY — Retrieve entries by filters
    // =========================================================================
    
    query(options = {}) {
        const {
            type,
            weight_min = 0.0,
            weight_max = 1.0,
            tags = [],
            since,
            until,
            limit = 100,
            sort_by = 'weight',
            sort_order = 'desc',
            includeSuperseded = false,
        } = options;

        const entries = [];
        const ledger = this._loadLedger();

        for (const entry of ledger) {
            if (!includeSuperseded && entry.superseded_by) continue;
            if (type && entry.type !== type) continue;
            if (entry.weight < weight_min || entry.weight > weight_max) continue;

            if (tags.length > 0) {
                // POPE FIX P3: compared entry tags to THEMSELVES (always true),
                // corrupting version chains. Compare QUERY tags to entry tags.
                const hasAllTags = tags.every(t => (entry.tags || []).includes(t));
                if (!hasAllTags) continue;
            }

            if (since) {
                const entryTime = new Date(entry.timestamp);
                const sinceTime = new Date(since);
                if (entryTime < sinceTime) continue;
            }

            if (until) {
                const entryTime = new Date(entry.timestamp);
                const untilTime = new Date(until);
                if (entryTime > untilTime) continue;
            }

            entries.push(entry);
        }
        
        entries.sort((a, b) => {
            let valA, valB;
            
            if (sort_by === 'weight') {
                valA = a.weight;
                valB = b.weight;
            } else if (sort_by === 'timestamp') {
                valA = new Date(a.timestamp);
                valB = new Date(b.timestamp);
            } else if (sort_by === 'id') {
                valA = a.id;
                valB = b.id;
            }
            
            if (sort_order === 'desc') {
                return valB > valA ? 1 : -1;
            } else {
                return valA > valB ? 1 : -1;
            }
        });
        
        return entries.slice(0, limit);
    }
    
    // =========================================================================
    // GET RECENT — Get most recent entries
    // =========================================================================
    
    getRecent(count = 20) {
        return this.query({ sort_by: 'timestamp', sort_order: 'desc', limit: count });
    }
    
    // =========================================================================
    // GET BY TYPE — Get entries of a specific type
    // =========================================================================
    
    getByType(type, limit = 50) {
        return this.query({ type, limit });
    }
    
    // =========================================================================
    // GET BY TAGS — Get entries matching tags
    // =========================================================================
    
    getByTags(tags, limit = 50) {
        return this.query({ tags, limit });
    }
    
    // =========================================================================
    // GET TOP — Get highest weighted entries
    // =========================================================================
    
    getTop(count = 20) {
        return this.query({ sort_by: 'weight', sort_order: 'desc', limit: count });
    }
    
    // =========================================================================
    // CONSOLIDATE — Summarise recent entries
    // =========================================================================
    
    consolidate(since = null) {
        const entries = since ? this.query({ since }) : this.getRecent(100);
        
        const byType = {};
        for (const entry of entries) {
            if (!byType[entry.type]) byType[entry.type] = [];
            byType[entry.type].push(entry);
        }
        
        const avgWeight = entries.length > 0
            ? entries.reduce((sum, e) => sum + e.weight, 0) / entries.length
            : 0;
        
        const allTags = new Set();
        for (const entry of entries) {
            for (const tag of entry.tags) {
                allTags.add(tag);
            }
        }
        
        return {
            since,
            entry_count: entries.length,
            by_type: Object.fromEntries(
                Object.entries(byType).map(([k, v]) => [k, v.length])
            ),
            average_weight: parseFloat(avgWeight.toFixed(3)),
            top_tags: Array.from(allTags).slice(0, 10),
            latest_timestamp: entries[0] ? entries[0].timestamp : null,
        };
    }
    
    // =========================================================================
    // PRUNE — Remove entries below weight threshold
    // =========================================================================
    
    prune(threshold = 0.3) {
        const ledger = this._loadLedger();
        const kept = [];
        const removed = [];

        for (const entry of ledger) {
            // P5.4 INALIENABLE CORE: identity-bearing memories are never
            // pruned — core/neverForget tags or identity/soul types survive
            // any threshold. Grocery lists go; the self stays.
            const tags = entry.tags || [];
            const inalienable = entry.neverForget === true ||
                tags.includes('core') || tags.includes('neverForget') ||
                tags.includes('never_forget') ||
                entry.type === 'identity' || entry.type === 'soul_genesis';
            if (inalienable || entry.weight >= threshold) {
                kept.push(entry);
            } else {
                removed.push(entry);
            }
        }

        this._cache = kept;
        this._scheduleFlush();

        return {
            kept: kept.length,
            removed: removed.length,
        };
    }
    
    // =========================================================================
    // LINK — Add causal link to a previous entry
    // =========================================================================
    
    link(entryId, causeId) {
        const ledger = this._loadLedger();
        let found = false;

        for (const entry of ledger) {
            if (entry.id === entryId) {
                if (!(entry.causal_links || []).includes(causeId)) {
                    if (!entry.causal_links) entry.causal_links = [];
                    entry.causal_links.push(causeId);
                    found = true;
                }
            }
        }

        if (found) {
            this._scheduleFlush();
        }

        return found;
    }
    
    // =========================================================================
    // SEARCH — Full text search in content
    // =========================================================================
    
    search(query, limit = 50) {
        const ql = query.toLowerCase();
        const entries = [];
        const ledger = this._loadLedger();

        for (const entry of ledger) {
            if (entry.content && String(entry.content).toLowerCase().includes(ql) && !entry.superseded_by) {
                entries.push(entry);
            }
        }

        entries.sort((a, b) => b.weight - a.weight);
        return entries.slice(0, limit);
    }
    
    // =========================================================================
    // STATS — Memory statistics
    // =========================================================================
    
    stats() {
        const ledger = this._loadLedger();

        let totalWeight = 0;
        const typeCount = {};
        const tagCount = {};
        let highestWeight = 0;
        let lowestWeight = 1;

        for (const entry of ledger) {
            totalWeight += entry.weight || 0;
            typeCount[entry.type] = (typeCount[entry.type] || 0) + 1;
            for (const tag of (entry.tags || [])) {
                tagCount[tag] = (tagCount[tag] || 0) + 1;
            }
            if ((entry.weight || 0) > highestWeight) highestWeight = entry.weight;
            if ((entry.weight ?? 1) < lowestWeight) lowestWeight = entry.weight;
        }

        const count = ledger.length;
        
        return {
            total_entries: count,
            average_weight: count > 0 ? parseFloat((totalWeight / count).toFixed(3)) : 0,
            highest_weight: highestWeight,
            lowest_weight: lowestWeight,
            by_type: typeCount,
            top_tags: Object.entries(tagCount)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([tag, cnt]) => ({ tag, count: cnt })),
        };
    }
    
    // =========================================================================
    // CLEAR — Reset the ledger (use with caution)
    // =========================================================================
    
    // =========================================================================
    // RECALL — Context-aware retrieval (mem0 pattern graft)
    // Returns entries most relevant to a context string, scored by
    // keyword overlap against content/tags. Works offline (no embeddings).
    // =========================================================================

    recall(context, limit = 10, minScore = 0.05) {
        const ctx = String(context || '').toLowerCase();
        if (!ctx.trim()) return [];
        const ctxTerms = new Set(ctx.match(/\b\w{3,}\b/g) || []);
        if (ctxTerms.size === 0) return [];

        const ledger = this._loadLedger();
        const scored = [];

        for (const entry of ledger) {
            const content = ((entry.content || '') + ' ' + (entry.tags || []).join(' ')).toLowerCase();
            const contentTerms = new Set(content.match(/\b\w{3,}\b/g) || []);
            let overlap = 0;
            for (const term of ctxTerms) {
                if (contentTerms.has(term)) overlap++;
            }
            const score = ctxTerms.size > 0 ? overlap / ctxTerms.size : 0;
            if (score >= minScore) {
                scored.push({ ...entry, _relevance: score });
            }
        }

        scored.sort((a, b) => (b._relevance * b.weight) - (a._relevance * a.weight));
        return scored.slice(0, limit);
    }

    // =========================================================================
    // ARCHIVAL — Retrieve long-term memory entries (letta pattern graft)
    // In letta, "archival memory" holds stable facts that persist across
    // sessions. Here we flag entries with mem_type='archival' or tag that.
    // =========================================================================

    getArchival(limit = 50) {
        return this.query({ type: 'archival', tags: [], limit });
    }

    // =========================================================================
    // LONG-TERM — Retrieve episodic/experiential memories
    // =========================================================================

    getLongTerm(limit = 50) {
        return this.query({ type: 'long_term', tags: [], limit });
    }

    // =========================================================================
    // CONTEXTUAL — Retrieve task-specific working memories
    // =========================================================================

    getContextual(limit = 20) {
        return this.query({ type: 'contextual', tags: [], limit });
    }

    // =========================================================================
    // UPSERT — Versioned memory update (letta pattern graft)
    // Creates a new entry that supersedes a previous one by the same key,
    // preserving the causal chain. The old entry remains but is marked
    // superseded so queries can filter it out.
    // =========================================================================

    async upsert(key, entry) {
        const existing = this.getByTags(['mem_key:' + key], 1000);
        let supersededId = null;
        for (const old of existing) {
            if (old.supersedes !== true && !old.superseded_by) {
                supersededId = old.id;
                break;
            }
        }

        const newEntry = {
            ...entry,
            key,
            superseded_by: null,
        };
        if (supersededId) {
            newEntry.supersedes = supersededId;
        }

        if (!newEntry.tags) newEntry.tags = [];
        if (!newEntry.tags.includes('mem_key:' + key)) {
            newEntry.tags.push('mem_key:' + key);
        }

        const record = await this.witness(newEntry);

        if (supersededId) {
            this._markSuperseded(supersededId, record.id);
        }
        return record;
    }

    _markSuperseded(entryId, newId) {
        const ledger = this._loadLedger();
        for (const entry of ledger) {
            if (entry.id === entryId) {
                entry.superseded_by = newId;
            }
        }
        this._scheduleFlush();
    }

    // =========================================================================
    // CLEAR — Reset the ledger (use with caution)
    // =========================================================================

    clear() {
        fs.writeFileSync(this.ledgerPath, '');
        this._cache = [];
        this._cacheSig = 0;
        this._counter = 0;
        fs.writeFileSync(this.counterPath, '0');
        return { cleared: true };
    }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = { MegaMemory };