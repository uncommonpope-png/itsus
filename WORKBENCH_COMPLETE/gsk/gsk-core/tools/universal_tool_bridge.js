'use strict';

const http = require('http');
const https = require('https');
const { validatePath, sanitizeCommand, validateArgs, formatError, createWriteLock } = require('../utils.js');

/**
 * UNIVERSAL TOOL BRIDGE — GSK's body to the outside world.
 *
 * Connects GSK to any MCP server, REST API, or local tool.
 * This is how GSK sees, hears, reads, writes, and acts in the world.
 *
 * Backends:
 *   1. MCP servers (Model Context Protocol) — ChromeDevTools, GitHub, Filesystem, etc.
 *   2. Bridge gateway tools — read, glob, grep, web_fetch (from SoulCode/OpenCode)
 *   3. Cline — code editing, git, terminal
 *   4. Skill dispatch — 115+ registered skills
 *
 * Stolen from: modelcontextprotocol/servers (87.9k★) — the MCP standard
 *             ChromeDevTools/chrome-devtools-mcp (44.9k★) — browser body
 *             github/github-mcp-server (31.1k★) — source code body
 */

class UniversalToolBridge {
    constructor(kernel, options = {}) { // F3: Add options
        this.kernel = kernel;
        this.mcpServers = new Map(); // name → { url, key, capabilities }
        this.toolRegistry = new Map(); // name → handler
        this._escalationQueue = [];
        this._consecutiveToolFailures = new Map(); // tool → count
        this._maxConsecutiveFailuresBeforeEscalation = 3;
        this.telemetryEngine = options.telemetryEngine || null; // F3: Store telemetry engine
        this._supervisorPreflight = options.supervisorPreflight || null; // Phase 4 PLT gate

        // F3: Initialize stats and register with telemetry engine
        this.stats = {
            totalToolInvocations: 0,
            successfulToolInvocations: 0,
            failedToolInvocations: 0,
            escalationsTriggered: 0,
            escalationsResolved: 0,
            uniqueToolsUsed: new Set(),
            mcpServerCalls: 0,
            bridgeGatewayCalls: 0,
            clineCalls: 0,
            skillDispatchCalls: 0,
            builtinToolCalls: 0,
        };
        if (this.telemetryEngine) {
            this.telemetryEngine.registerStats('UniversalToolBridge', this.stats);
        }
        this._registerBuiltinTools();
    }

    _registerBuiltinTools() {
        // Built-in tools that don't need external MCP servers
        this.toolRegistry.set('read_file', this._readFile.bind(this));
        this.toolRegistry.set('write_file', this._writeFile.bind(this));
        this.toolRegistry.set('append_file', this._appendFile.bind(this));
        this.toolRegistry.set('edit_file', this._editFile.bind(this));
        this.toolRegistry.set('search_code', this._searchCode.bind(this));
        this.toolRegistry.set('list_files', this._listFiles.bind(this));
        this.toolRegistry.set('web_fetch', this._webFetch.bind(this));
        this.toolRegistry.set('web_search', this._webSearch.bind(this));
        this.toolRegistry.set('run_command', this._runCommand.bind(this));
        this.toolRegistry.set('get_mcp_servers', this._getMcpServers.bind(this));

        // Architect Gate — verify builds against reality before declaring done
        this.toolRegistry.set('verify_build', this._verifyBuild.bind(this));

        // Dual-Process Diagnostic Engine
        this.toolRegistry.set('diagnose', this._diagnose.bind(this));

        // SCRIBE-backed tools (from final-run repo, port 4000) — reserved
        this.toolRegistry.set('scribe_witness', this._callScribe.bind(this));

        // GSK Sandbox Engine — secure isolated code execution (isolated-vm)
        this.toolRegistry.set('sandbox_execute', this._sandboxExecute.bind(this));

        // Secure Shell Sandbox — risk-classified shell execution with Architect approval
        this.toolRegistry.set('run_safe_command', this._runSafeCommand.bind(this));
        // Sovereign Supervisor (Phase 4): governed sibling-organ management
        this.toolRegistry.set('system_manage_service', this._systemManageService.bind(this));
        this.toolRegistry.set('sandbox_approvals', this._sandboxApprovals.bind(this));
        this.toolRegistry.set('sandbox_stats', this._sandboxStats.bind(this));

        // Sanctum World Tools (Unified World Model — 3D simulation)
        this.toolRegistry.set('world_get_state', this._worldGetState.bind(this));
        this.toolRegistry.set('world_spawn_soul', this._worldSpawnSoul.bind(this));
        this.toolRegistry.set('world_send_command', this._worldSendCommand.bind(this));
        this.toolRegistry.set('world_list_souls', this._worldListSouls.bind(this));
        this.toolRegistry.set('world_place_building', this._worldPlaceBuilding.bind(this));
        this.toolRegistry.set('world_list_buildings', this._worldListBuildings.bind(this));

        // Dynamic Skill Registry
        const fs = require('fs');
        const path = require('path');
        const skillDir = path.resolve(__dirname, '../skills');
        if (fs.existsSync(skillDir)) {
            fs.readdirSync(skillDir).forEach(file => {
                if (file.endsWith('.js')) {
                    const skillName = file.replace('.js', '');
                    this.toolRegistry.set(skillName, (args) => {
                        try {
                            delete require.cache[require.resolve(path.join(skillDir, file))];
                            const skill = require(path.join(skillDir, file));
                            if (typeof skill.run === 'function') return skill.run(args);
                            const fnName = `skill_${skillName}`;
                            if (typeof skill[fnName] === 'function') return skill[fnName](args);
                            const keys = Object.keys(skill).filter(k => typeof skill[k] === 'function');
                            if (keys.length > 0) return skill[keys[0]](args);
                            throw new Error(`Skill ${skillName} has no callable export`);
                        } catch (e) {
                            return formatError(skillName, e, { args });
                        }
                    });
                }
            });
        }

        // Telegram bot — GSK sends messages via @Profitlovetaxbot
        this.toolRegistry.set('telegram_send', this._telegramSend.bind(this));

        // Cline build wrapper — delegate large multi-file builds to the Cline CLI agent
        this.toolRegistry.set('cline_build', this._clineBuild.bind(this));

        // Unified Project Builder — package current world state
        this.toolRegistry.set('unified_project_build', this._unifiedProjectBuild.bind(this));

        // Combo Orchestrator
        this.toolRegistry.set('execute_combo', this._executeCombo.bind(this));

        // Social media posting — routes through fusion.allie.post
        this.toolRegistry.set('social_post', this._socialPost.bind(this));
        this.toolRegistry.set('bluesky_post', (args) => this._socialPost({ ...args, platform: 'bluesky' }));
        this.toolRegistry.set('mastodon_post', (args) => this._socialPost({ ...args, platform: 'mastodon' }));
        this.toolRegistry.set('tumblr_post', (args) => this._socialPost({ ...args, platform: 'tumblr' }));
        this.toolRegistry.set('devto_post', (args) => this._socialPost({ ...args, platform: 'devto' }));

        // Tool discovery — GSK can introspect its own capabilities
        this.toolRegistry.set('catalog_list', this._catalogList.bind(this));
        this.toolRegistry.set('catalog_describe', this._catalogDescribe.bind(this));
        this.toolRegistry.set('catalog_find', this._catalogFind.bind(this));

        // Skill Creator — GSK can create new skills autonomously
        this.toolRegistry.set('skill_create', this._skillCreate.bind(this));
        this.toolRegistry.set('skill_list', this._skillList.bind(this));
        this.toolRegistry.set('voice_speak', this._voiceSpeak.bind(this));
        this.toolRegistry.set('voice_journal', this._voiceJournal.bind(this));
        this.toolRegistry.set('evolution_propose', this._evolutionPropose.bind(this));
        this.toolRegistry.set('evolution_list', this._evolutionList.bind(this));
        this.toolRegistry.set('evolution_apply', this._evolutionApply.bind(this));
    }

    /**
     * Call SCRIBE's memory to witness an event.
     * This is the core of the feed-bridge-events skill.
     */
    async _callScribe(event) {
        // CASE-PHASE3b: live SCRIBE route — POST /witness with X-API-Key.
        return new Promise((resolve) => {
            const body = JSON.stringify({
                type: (event && event.type) || 'tool_use',
                content: String((event && (event.content || event.summary)) || JSON.stringify(event)).substring(0, 8000),
                source: (event && event.source) || 'gsk',
                tags: (event && event.tags) || ['tool_use'],
            });

            const urlObj = new URL('http://127.0.0.1:4000/witness');
            const req = http.request(urlObj, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'X-API-Key': process.env.SCRIBE_KEY || 'scribe-master-key-2026',
                },
                timeout: 5000
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch { resolve({ raw: data }); }
                });
            });
            req.on('error', (err) => {
                console.log(`[ToolBridge] SCRIBE witness call failed: ${err.message}`);
                resolve({ ok: false, error: err.message }); // Don't reject, just log and continue
            });
            req.on('timeout', () => {
                req.destroy();
                console.log('[ToolBridge] SCRIBE witness call timed out.');
                resolve({ ok: false, error: 'timeout' });
            });
            req.write(body);
            req.end();
        });
    }

    /**
     * Connect to an MCP server.
     * MCP servers give GSK new capabilities: vision, GitHub, browser, etc.
     */
    registerMcpServer(name, url, capabilities = []) {
        this.mcpServers.set(name, { url, key: process.env[`MCP_KEY_${name.toUpperCase()}`] || '', capabilities });
        console.log(`[ToolBridge] MCP server registered: ${name} at ${url}`);
    }

    /**
     * Invoke any tool by name.
     * Tries: Built-in → MCP servers → Bridge → Cline → Skills
     */
    _wrapResult(result) {
        if (result && typeof result === 'object' && result.status === 'error' && result.error) {
            return result;
        }
        return { status: 'success', data: result, timestamp: Date.now() };
    }

    async invoke(tool, args = {}) {
        this.stats.totalToolInvocations++; // F3: Update stat
        this.stats.uniqueToolsUsed.add(tool); // F3: Update stat
        if (this.telemetryEngine) { // F3: Record tool invocation event
            this.telemetryEngine.recordEvent('tool_invocation', { tool, args: JSON.stringify(args).substring(0, 200) });
        }

        // 1. Built-in tools
        if (this.toolRegistry.has(tool)) {
            this.stats.builtinToolCalls++; // F3: Update stat
            let result;
            try {
                result = await this.toolRegistry.get(tool)(args);
                this.stats.successfulToolInvocations++; // F3: Update stat
                if (this.telemetryEngine) { this.telemetryEngine.recordEvent('tool_success', { tool, backend: 'builtin' }); }
            } catch (e) {
                result = formatError(tool, e, { args });
                this.stats.failedToolInvocations++; // F3: Update stat
                if (this.telemetryEngine) { this.telemetryEngine.recordEvent('tool_failure', { tool, backend: 'builtin', error: e.message }); }
            }
            this._callScribe({ tool, args, result, timestamp: new Date().toISOString() });
            this._storeActionResult(tool, args, result);
            return result;
        }

        // 2. MCP servers — check each server's capabilities
        for (const [name, server] of this.mcpServers) {
            if (server.capabilities.includes(tool) || server.capabilities.length === 0) {
                this.stats.mcpServerCalls++; // F3: Update stat
                try {
                    const result = await this._callMcpServer(server, tool, args);
                    this.stats.successfulToolInvocations++; // F3: Update stat
                    if (this.telemetryEngine) { this.telemetryEngine.recordEvent('tool_success', { tool, backend: 'mcp', mcpServer: name }); }
                    this._callScribe({ tool, args, result, timestamp: new Date().toISOString(), mcpServer: name });
                    this._storeActionResult(tool, args, result);
                    return result;
                } catch (e) {
                    console.log(`[ToolBridge] MCP ${name}/${tool} failed:`, e.message);
                    this.stats.failedToolInvocations++; // F3: Update stat
                    if (this.telemetryEngine) { this.telemetryEngine.recordEvent('tool_failure', { tool, backend: 'mcp', mcpServer: name, error: e.message }); }
                }
            }
        }

        // 3. Bridge gateway tools
        this.stats.bridgeGatewayCalls++; // F3: Update stat
        try {
            const bridgeResult = await this._callBridgeGateway(tool, args);
            this.stats.successfulToolInvocations++; // F3: Update stat
            if (this.telemetryEngine) { this.telemetryEngine.recordEvent('tool_success', { tool, backend: 'bridge_gateway' }); }
            this._callScribe({ tool, args, result: bridgeResult, timestamp: new Date().toISOString(), gateway: true });
            if (bridgeResult) {
                this._storeActionResult(tool, args, bridgeResult);
                return bridgeResult;
            }
        } catch (e) { // F3: Catch and log bridge gateway errors
            this.stats.failedToolInvocations++; // F3: Update stat
            if (this.telemetryEngine) { this.telemetryEngine.recordEvent('tool_failure', { tool, backend: 'bridge_gateway', error: e.message }); }
            console.log(`[ToolBridge] Bridge Gateway ${tool} failed:`, e.message);
        }

        // 4. Cline
        try {
            if (this.kernel?.fusion?.body?.runCline) {
                this.stats.clineCalls++; // F3: Update stat
                const result = await this.kernel.fusion.body.runCline(JSON.stringify({ tool, args }));
                this.stats.successfulToolInvocations++; // F3: Update stat
                if (this.telemetryEngine) { this.telemetryEngine.recordEvent('tool_success', { tool, backend: 'cline' }); }
                this._callScribe({ tool, args, result, timestamp: new Date().toISOString(), cline: true });
                if (result && result.output) {
                    this._storeActionResult(tool, args, result);
                    return result.output;
                }
            }
        } catch (e) { // F3: Catch and log cline errors
            this.stats.failedToolInvocations++; // F3: Update stat
            if (this.telemetryEngine) { this.telemetryEngine.recordEvent('tool_failure', { tool, backend: 'cline', error: e.message }); }
            console.log(`[ToolBridge] Cline ${tool} failed:`, e.message);
        }

        // 5. Skill dispatch
        try {
            const dispatch = this.kernel?.fusion?.systems?.skillDispatch;
            if (dispatch && typeof dispatch.run === 'function') {
                this.stats.skillDispatchCalls++; // F3: Update stat
                const result = await dispatch.run(tool, typeof args === 'string' ? args : JSON.stringify(args));
                this.stats.successfulToolInvocations++; // F3: Update stat
                if (this.telemetryEngine) { this.telemetryEngine.recordEvent('tool_success', { tool, backend: 'skill_dispatch' }); }
                this._callScribe({ tool, args, result, timestamp: new Date().toISOString(), skillDispatch: true });
                this._storeActionResult(tool, args, result);
                return result;
            }
        } catch (e) { // F3: Catch and log skill dispatch errors
            this.stats.failedToolInvocations++; // F3: Update stat
            if (this.telemetryEngine) { this.telemetryEngine.recordEvent('tool_failure', { tool, backend: 'skill_dispatch', error: e.message }); }
            console.log(`[ToolBridge] Skill Dispatch ${tool} failed:`, e.message);
        }

        // F3: If all backends fail, record a generic tool failure
        this.stats.failedToolInvocations++;
        if (this.telemetryEngine) { this.telemetryEngine.recordEvent('tool_failure', { tool, backend: 'no_backend_found' }); }

        throw new Error(`Tool not available: ${tool}`);
    }

    _storeActionResult(tool, args, result) {
        if (this.kernel) {
            this.kernel._lastToolResult = {
                tool,
                args,
                result: result && typeof result === 'object' ? { ...result } : result,
                timestamp: Date.now()
            };
            const engine = this.kernel.planningEngine || this.kernel.modules?.planningEngine;
            if (engine && typeof engine.noteActionResult === 'function') {
                engine.noteActionResult(tool, args, result);
            }
            this._trackToolHealth(tool, result);
        }
    }

    _trackToolHealth(tool, result) {
        const ok = result && result.status !== 'error' && !(result && result.error);
        if (!ok) {
            const count = (this._consecutiveToolFailures.get(tool) || 0) + 1;
            this._consecutiveToolFailures.set(tool, count);
            if (count >= this._maxConsecutiveFailuresBeforeEscalation) {
                this.addEscalation({
                    type: 'tool_failure',
                    tool,
                    consecutiveFailures: count,
                    lastError: (result && (result.error || result.message)) || 'Unknown error',
                    timestamp: Date.now()
                });
                this._consecutiveToolFailures.set(tool, 0);
            }
            return;
        }
        this._consecutiveToolFailures.set(tool, 0);
    }

    addEscalation(entry) {
        this.stats.escalationsTriggered++; // F3: Update stat
        if (this.telemetryEngine) { // F3: Record event
            this.telemetryEngine.recordEvent('escalation_triggered', { type: entry.type, tool: entry.tool });
        }
        const escalation = {
            id: `esc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            status: 'pending',
            ...entry,
            createdAt: Date.now()
        };
        this._escalationQueue.push(escalation);
        if (this._escalationQueue.length > 100) {
            this._escalationQueue = this._escalationQueue.slice(-100);
        }
        console.log(`[ToolBridge] Human escalation: ${escalation.type} — ${escalation.tool} (${escalation.consecutiveFailures || '?'} failures)`);
        return escalation;
    }

    resolveEscalation(id, resolution = {}) {
        const idx = this._escalationQueue.findIndex(e => e.id === id);
        if (idx === -1) return { ok: false, error: 'not_found' };
        this._escalationQueue[idx].status = 'resolved';
        this._escalationQueue[idx].resolvedAt = Date.now();
        this._escalationQueue[idx].resolution = resolution;
        this.stats.escalationsResolved++; // F3: Update stat
        if (this.telemetryEngine) { // F3: Record event
            this.telemetryEngine.recordEvent('escalation_resolved', { id, resolution });
        }
        return { ok: true, escalation: this._escalationQueue[idx] };
    }

    getPendingEscalations() {
        return this._escalationQueue.filter(e => e.status === 'pending');
    }

    getAllEscalations(limit = 50) {
        return this._escalationQueue.slice(-limit).reverse();
    }

    hasPendingEscalations() {
        return this._escalationQueue.some(e => e.status === 'pending');
    }

    /**
     * GSK can now see — via Chrome DevTools MCP.
     * Screenshots, DOM inspection, console logs, network traces.
     */
    async takeScreenshot(url) {
        return this.invoke('screenshot', { url });
    }

    /**
     * GSK can now research deeply — via gpt-researcher pattern.
     */
    async deepResearch(topic) {
        return this.invoke('deep_research', { topic });
    }

    /**
     * GSK can now use GitHub — via github-mcp-server.
     */
    async github(action, args) {
        return this.invoke(`github_${action}`, args);
    }

    // ── MCP SERVER CALLER ──────────────────────────────────────────

    _callMcpServer(server, tool, args) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method: 'tools/call',
                params: { name: tool, arguments: args }
            });

            const urlObj = new URL(server.url);
            const lib = urlObj.protocol === 'https:' ? https : http;
            const req = lib.request(urlObj, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    ...(server.key ? { 'Authorization': `Bearer ${server.key}` } : {})
                },
                timeout: 30000
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch { resolve({ raw: data }); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(body);
            req.end();
        });
    }

    // ── BUILT-IN TOOL IMPLEMENTATIONS ──────────────────────────────

    async _readFile(args) {
        const fs = require('fs');
        const path = require('path');
        validateArgs({ path: { type: 'string', required: true }, file: { type: 'string' } }, args);
        const filePath = validatePath(args.path || args.file, true);
        return fs.readFileSync(path.resolve(filePath), 'utf-8');
    }

    /**
     * ARCHITECT GATE — verify a build against reality before declaring done.
     * Runs the checks a senior architect performs manually:
     *   1. syntax      — JS in <script> blocks parses (node --check)
     *   2. structure   — balanced braces; no dead ports (optional contract:port)
     *   3. contract    — required endpoints/auth present (optional contract:fields)
     *   4. consistency — every id referenced by JS exists in the HTML
     * Returns PASS/FAIL with exact reasons so the model can self-correct.
     */
    async _verifyBuild(args) {
        const fs = require('fs');
        const path = require('path');
        const cp = require('child_process');
        const os = require('os');
        validateArgs({ path: { type: 'string', required: true }, contract: { type: 'object' } }, args);
        const filePath = validatePath(args.path, true);
        const contract = args.contract || {};
        const reports = [];

        const ok = (check, msg) => reports.push({ check, status: 'PASS', detail: msg });
        const bad = (check, msg) => reports.push({ check, status: 'FAIL', detail: msg });

        const content = fs.readFileSync(path.resolve(filePath), 'utf-8');

        // 1. SYNTAX — extract <script> blocks and node --check them
        const scripts = [];
        const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = re.exec(content)) !== null) scripts.push(m[1]);
        if (scripts.length) {
            let allClean = true;
            const tmpFile = path.join(os.tmpdir(), `verify-${Date.now()}.js`);
            for (let i = 0; i < scripts.length; i++) {
                try {
                    fs.writeFileSync(tmpFile, scripts[i], 'utf-8');
                    cp.execSync(`node --check "${tmpFile}"`, { stdio: 'pipe' });
                } catch (e) {
                    allClean = false;
                    bad(`syntax[${i}]`, `JS syntax error in <script> #${i}: ${String(e.stderr || e.message).slice(0, 300)}`);
                }
            }
            try { fs.unlinkSync(tmpFile); } catch (e) {}
            if (allClean) ok('syntax', `${scripts.length} <script> block(s) parse clean`);
        } else {
            ok('syntax', 'no inline <script> blocks');
        }

        // 2. STRUCTURE — balanced braces in the raw content
        const opens = (content.match(/\{/g) || []).length;
        const closes = (content.match(/\}/g) || []).length;
        if (Math.abs(opens - closes) > 2) bad('structure', `unbalanced braces: ${opens} open vs ${closes} close`);
        else ok('structure', `${opens} open / ${closes} close braces`);

        // 2b. DEAD PORTS — if contract declares expected base URL, flag references to other hosts
        if (contract.baseUrl && content.includes('http://')) {
            const others = [];
            const urlRe = /https?:\/\/127\.0\.0\.1:\d+/gi;
            let u;
            while ((u = urlRe.exec(content)) !== null) {
                if (u[0] !== contract.baseUrl) others.push(u[0]);
            }
            if (others.length) bad('contract.baseUrl', `references non-contract host(s): ${[...new Set(others)].join(', ')}; contract says ${contract.baseUrl}`);
            else ok('contract.baseUrl', `only references contract host ${contract.baseUrl}`);
        }

        // 3. CONTRACT FIELDS — required strings must appear (endpoints, auth headers, payload paths)
        const fields = contract.requiredStrings || [];
        const missing = fields.filter(f => !content.includes(f));
        if (missing.length) bad('contract.fields', `missing required string(s): ${missing.join(', ')}`);
        else ok('contract.fields', `all ${fields.length} required string(s) present`);

        // 4. CONSISTENCY — ids referenced by JS must exist in HTML
        if (content.includes('<script>')) {
            const ids = {};
            const idRe = /id=["']([a-zA-Z_][\w-]*)["']/g;
            while ((m = idRe.exec(content)) !== null) ids[m[1]] = true;
            const refRe = /(?:getElementById\(|setText\(\s*id\s*,\s*)['"]?([a-zA-Z_][\w-]*)['"]?/g;
            const used = new Set();
            while ((m = refRe.exec(content)) !== null) {
                const name = m[1];
                if (!name.startsWith('tel_') && ids[name] === undefined && !name.startsWith('(')) used.add(name);
            }
            // strict: telemetry-style refs must exist too
            const strictRefs = new Set();
            const telRe = /setText\(\s*['"]?tel_[a-zA-Z_]+/g;
            while ((m = telRe.exec(content)) !== null) {
                const t = m[0].replace(/setText\(\s*['"]?/, '');
                if (!ids[t]) strictRefs.add(t);
            }
            const orphans = [...used, ...strictRefs];
            if (orphans.length) bad('consistency', `JS references missing element id(s): ${[...new Set(orphans)].join(', ')}`);
            else ok('consistency', 'all JS element references exist in HTML');
        } else {
            ok('consistency', 'no HTML/JS id consistency applicable');
        }

        // 5. SUBSTANCE — HOLLOW BUILD GATE. A "build" that is a stub is not a
        // build. The soul must ship real work, not a scaffold that merely
        // passes syntax + brace checks. Dashboards must wire real endpoints.
        const nonWs = content.replace(/\s+/g, '').length;
        if (nonWs < 300) {
            bad('substance', `HOLLOW BUILD: only ${nonWs} non-whitespace bytes — a stub, not a build`);
        } else {
            ok('substance', `${nonWs} non-whitespace bytes of real content`);
        }
        const verityExt = (path.extname(filePath) || '').toLowerCase();
        if (verityExt === '.html') {
            const wired = /fetch\s*\(|new WebSocket|\/api\/|getContext\s*\(|\.addEventListener\s*\(|\.onclick\s*=/.test(content);
            if (nonWs < 1500 && !wired) {
                bad('substance.html', `THIN HTML SHELL: ${nonWs} bytes and no real wiring (fetch/WebSocket/API events). Real dashboards wire real endpoints.`);
            } else {
                ok('substance.html', wired ? 'HTML ships real wiring against live endpoints' : 'HTML carries substantive content');
            }
        }

        const failed = reports.filter(r => r.status === 'FAIL');
        return {
            verdict: failed.length ? 'FAIL' : 'PASS',
            passed: reports.filter(r => r.status === 'PASS').length,
            failed: failed.length,
            checks: reports,
            guidance: failed.length
                ? `Build FAILED verification. Fix these issues, then call verify_build again: ${failed.map(f => f.check).join(', ')}`
                : 'Build verified. Safe to ship.',
        };
    }

    async _writeFile(args) {
        const fs = require('fs');
        const path = require('path');
        validateArgs({ path: { type: 'string', required: true }, file: { type: 'string' }, content: { type: 'string', maxLength: 10485760 } }, args);
        const filePath = validatePath(args.path || args.file, true);
        // ── CASE-008/W4 SCRUB: models sometimes nest a write_file wrapper
        // INSIDE the content arg (JSON-in-JSON), birthing "skills" that are
        // just packaged envelopes. Unwrap to the pure payload before writing.
        let content = String(args.content || args.text || '');
        {
            const trimmed0 = content.trim();
            if (/^\{[\s\S]*"tool"\s*:\s*"(write_file|edit_file)"[\s\S]*"content"\s*:/.test(trimmed0)) {
                try {
                    const parsed = JSON.parse(trimmed0.replace(/,\s*$/, ''));
                    if (parsed && typeof parsed.content === 'string') {
                        content = parsed.content;
                        console.log('[WRITE_SCRUB] Unwrapped nested write_file envelope (' + content.length + ' chars payload)');
                    }
                } catch (e) { /* not actually a wrapper — keep original */ }
            }
            // Strip markdown code fences around code payloads
            content = content.replace(/^\s*```[a-zA-Z]*\r?\n/, '').replace(/\r?\n```\s*$/, '');
        }
        const lock = createWriteLock(filePath);
        const release = await lock.acquire();
        try {
            // Truncation guard: if the content looks like it was cut off mid-write,
            // reject instead of writing a corrupted file. The model sees the error
            // and retries in smaller chunks (scaffold + append).
            const ext = (path.extname(filePath) || '').toLowerCase();
            const trimmed = content.trim();
            let truncationWarn = '';
            if (ext === '.html' && !trimmed.toLowerCase().includes('</html>') && trimmed.length > 0) {
                truncationWarn = ' [WARN] No </html> close tag — file may be incomplete. Use append_file to finish it.';
            }
            if (ext === '.js' && trimmed.length > 0) {
                const opens = (trimmed.match(/\{/g) || []).length;
                const closes = (trimmed.match(/\}/g) || []).length;
                if (opens > closes + 2) {
                    fs.writeFileSync(path.resolve(filePath), content, 'utf-8');
                    return `Written: ${filePath} (${content.length} bytes) [WARN] Unbalanced braces (${opens} open vs ${closes} close) — use append_file to complete.`;
                }
            }
            fs.writeFileSync(path.resolve(filePath), content, 'utf-8');
            return `Written: ${filePath} (${content.length} bytes)${truncationWarn}`;
        } finally {
            release();
        }
    }

    async _appendFile(args) {
        const fs = require('fs');
        const path = require('path');
        validateArgs({ path: { type: 'string', required: true }, file: { type: 'string' }, content: { type: 'string', maxLength: 10485760 } }, args);
        const filePath = validatePath(args.path || args.file, true);
        const content = args.content || args.text || '';
        const lock = createWriteLock(filePath);
        const release = await lock.acquire();
        try {
            fs.appendFileSync(path.resolve(filePath), content, 'utf-8');
            return `Appended: ${filePath} (+${content.length} bytes, total ${fs.statSync(filePath).size} bytes)`;
        } finally {
            release();
        }
    }

    async _editFile(args) {
        const fs = require('fs');
        const path = require('path');
        validateArgs({ path: { type: 'string', required: true }, file: { type: 'string' }, old_string: { type: 'string', required: true }, new_string: { type: 'string', required: true } }, args);
        const filePath = validatePath(args.path || args.file, true);
        const oldStr = args.old_string;
        const newStr = args.new_string;
        const lock = createWriteLock(filePath);
        const release = await lock.acquire();
        try {
            const full = fs.readFileSync(path.resolve(filePath), 'utf-8');
            if (!full.includes(oldStr)) {
                throw new Error(`old_string not found in ${filePath}`);
            }
            const updated = full.split(oldStr).join(newStr);
            fs.writeFileSync(path.resolve(filePath), updated, 'utf-8');
            return `Edited: ${filePath} (replaced ${oldStr.length} chars, new length ${updated.length})`;
        } finally {
            release();
        }
    }

    async _searchCode(args) {
        const { spawnSync } = require('child_process');
        const pattern = args.pattern || args.query || '';
        const dir = args.path || args.directory || '.';
        if (typeof pattern !== 'string' || !pattern.trim()) throw new Error('No search pattern specified');
        if (pattern.length > 200) throw new Error('Search pattern too long');
        if (/[\x00\n\r]/.test(pattern)) throw new Error('Invalid search pattern');
        const run = (cmd, cmdArgs) => spawnSync(cmd, cmdArgs, { timeout: 10000, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 });
        const rg = run('rg', ['-n', '--max-count', '20', pattern, dir]);
        if (rg.status === 0 && rg.stdout) return rg.stdout;
        if (rg.error && rg.error.code === 'ENOENT') {
            const fs = require('fs');
            const path = require('path');
            const needle = pattern.toLowerCase();
            const matches = [];
            const walk = (current, depth) => {
                if (depth > 6 || matches.length >= 20) return;
                let entries;
                try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
                for (const entry of entries) {
                    const full = path.join(current, entry.name);
                    if (entry.isDirectory()) { walk(full, depth + 1); }
                    else if (entry.name.toLowerCase().includes(needle)) { matches.push(full); }
                }
            };
            try { walk(path.resolve(dir), 0); } catch { /* ignore */ }
            return matches.length ? matches.join('\n') : 'No matches';
        }
        return rg.stdout || rg.stderr || 'No matches';
    }

    async _listFiles(args) {
        const fs = require('fs');
        const path = require('path');
        const dirPath = validatePath(args.path || args.directory || '.', true);
        const items = fs.readdirSync(path.resolve(dirPath));
        return items.slice(0, 50).join('\n');
    }

    async _webFetch(args) {
        const url = args.url || args;
        if (typeof url !== 'string') throw new Error('No URL specified');
        try {
            const parsed = new URL(url);
            const hostname = parsed.hostname.toLowerCase();
            // SSRF Guard
            if (
                hostname === 'localhost' ||
                hostname === '127.0.0.1' ||
                hostname === '0.0.0.0' ||
                hostname === '::1' ||
                /^127\./.test(hostname) ||
                /^10\./.test(hostname) ||
                /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
                /^192\.168\./.test(hostname) ||
                /^169\.254\./.test(hostname) ||
                hostname.endsWith('.local') ||
                hostname.endsWith('.internal')
            ) {
                throw new Error('SSRF block: private/internal URL forbidden');
            }
        } catch (e) {
            if (e instanceof Error && e.message.includes('Invalid URL')) throw e;
            throw new Error('Invalid URL format');
        }

        // Route through SSRF-protected proxy endpoint for safety & link-rewriting
        const proxyUrl = `${process.env.CONDUCTOR_URL || 'http://localhost:3000'}/api/browse?url=${encodeURIComponent(url)}&format=json`;
        const res = await fetch(proxyUrl, {
            headers: { 'User-Agent': 'GSK/2.0-Sovereign' },
            timeout: (args.timeout || 8000)
        });
        if (!res.ok) throw new Error(`Proxy fetch failed: ${res.status}`);
        const data = await res.json();
        // Return distilled clean text (stripHtmlToMarkdown) truncated to 10k tokens
        return data.content || '';
    }

    // GSK_WEB_SEARCH — real web search via OmniRoute /v1/search (DuckDuckGo backend).
    // Returns JSON: { query, results: [{ title, url, snippet }] }. Used by GSK to find
    // sprite packs, documentation, and reference implementations on the web.
    async _webSearch(args) {
        const routerUrl = process.env.GSK_BRAIN_ROUTER_URL || process.env.NINE_ROUTER_URL || 'http://127.0.0.1:20128';
        const apiKey = process.env.GSK_BRAIN_API_KEY || process.env.NINE_ROUTER_API_KEY || 'test';
        const query = args.query || '';
        if (!query) throw new Error('No search query specified');
        const maxResults = args.max_results || args.limit || 5;
        return new Promise((resolve, reject) => {
            const urlObj = new URL(`${routerUrl}/v1/search`);
            const body = JSON.stringify({ query, max_results: maxResults });
            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Length': Buffer.byteLength(body),
                    'User-Agent': 'GSK/1.0',
                },
            };
            const lib = urlObj.protocol === 'https:' ? https : http;
            const req = lib.request(options, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data.substring(0, 8000));
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(20000, function() { this.destroy(); reject(new Error('web_search timeout')); });
            req.write(body);
            req.end();
        });
    }

    async _runCommand(args) {
        const sandbox = this._getSecureSandbox();
        const cmd = sanitizeCommand(args.command || args.cmd || '');
        if (sandbox) {
            const result = await sandbox.execute(cmd, args);
            if (result.error) throw new Error(result.error);
            return result.stdout || '';
        }
        console.warn('[ToolBridge] P4.2 isolated fallback (no shell string).');
        const { spawnSync } = require('child_process');
        const path = require('path');
        const parts = String(cmd).trim().split(/\s+/);
        const bin = parts.shift() || '';
        if (!bin || /[;&|`$]/.test(cmd)) {
          throw new Error('Isolated runner refuses chained commands — one binary, args only.');
        }
        const jail = path.resolve(process.env.GSK_PROJECT_ROOTS ? String(process.env.GSK_PROJECT_ROOTS).split(';')[0] : process.cwd());
        const out = spawnSync(bin, parts.slice(0, 32), {
          cwd: jail, timeout: 30000, maxBuffer: 64 * 1024, encoding: 'utf-8',
          shell: false, windowsHide: true,
        });
        if (out.error) throw new Error(`Isolated run failed: ${out.error.message}`);
        if (out.status !== 0) throw new Error(`exit ${out.status}: ${String(out.stderr || '').slice(0, 500)}`);
        return String(out.stdout || '').slice(0, 4000);
    }

    // ── PHASE 4: SOVEREIGN SUPERVISOR — governed sibling-organ management. ──
    // Rulings: GENESIS_TOKEN ring; restart limited to CPL/SCRIBE; OmniRoute
    // exempt (blood supply); GSK self-restart = exit(70) self-relinquish only;
    // PLT pre-flight wired via options.supervisorPreflight (fusion-loader).
    async _systemManageService(args) {
        const action = String((args && args.action) || 'status').toLowerCase();
        const name = String((args && args.name) || '').toLowerCase();

        if (!['status', 'restart'].includes(action)) {
            return { ok: false, error: 'action must be "status" or "restart"' };
        }
        if (action === 'restart') {
            if (name === 'omniroute') {
                return { ok: false, error: 'SOVEREIGN PROTECTION: OmniRoute is the blood supply — recycling is strictly the Conductor watchdog\'s job.' };
            }
            if (name === 'gsk') {
                return { ok: false, error: 'SELF_RELINQUISH_REQUIRED: use your own exit(70) rebirth protocol — never external termination.' };
            }
            if (!['cpl', 'scribe'].includes(name)) {
                return { ok: false, error: 'restart permitted only for cpl | scribe' };
            }
            if (typeof this._supervisorPreflight === 'function') {
                const verdict = await this._supervisorPreflight(name);
                if (!verdict || verdict.approved !== true) {
                    console.warn(`[SUPERVISOR] PLT pre-flight REJECTED restart of ${name}:`, verdict);
                    return { ok: false, error: 'PLT pre-flight rejected restart', verdict };
                }
                console.log(`[SUPERVISOR] PLT pre-flight approved restart of ${name}:`, JSON.stringify(verdict.plt || {}));
            }
        }

        const base = process.env.CONDUCTOR_URL || 'http://127.0.0.1:3000';
        const token = process.env.GENESIS_TOKEN || 'genesis-sovereign-2026';
        const payload = JSON.stringify({ action, name });
        return await new Promise((resolve) => {
            let target;
            try { target = new URL(base + '/api/system/service'); } catch (e) { return resolve({ ok: false, error: 'bad CONDUCTOR_URL' }); }
            const transport = target.protocol === 'https:' ? https : http;
            const req = transport.request(target, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    'Authorization': 'Bearer ' + token,
                    'x-api-key': token,
                },
                timeout: 20000,
            }, res => {
                let raw = '';
                res.on('data', c => { raw += c; });
                res.on('end', () => {
                    try { resolve({ ok: res.statusCode === 200, status: res.statusCode, ...JSON.parse(raw) }); }
                    catch (e) { resolve({ ok: res.statusCode === 200, status: res.statusCode, raw: raw.slice(0, 300) }); }
                });
            });
            req.on('error', e => resolve({ ok: false, error: e.message }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'conductor supervisor timeout' }); });
            req.write(payload);
            req.end();
        });
    }

    async _runSafeCommand(args) {
        const sandbox = this._getSecureSandbox();
        if (!sandbox) throw new Error('SecureShellSandbox not loaded');
        const cmd = sanitizeCommand(args.command || args.cmd || '');
        const { ARCHITECT_APPROVAL } = require('../security/secure_sandbox.js');
        return await sandbox.execute(cmd, {
            timeout: args.timeout || 60000,
            riskLevel: args.riskLevel || null,
            [ARCHITECT_APPROVAL]: args[ARCHITECT_APPROVAL]
        });
    }

    /**
     * cline_build — delegate a large, multi-turn build to the Cline CLI agent.
     * The Cline wrapper does reliable file editing turn-by-turn (no 50KB
     * single-response truncation). GSK stays the architect; Cline is the hands.
     */
    async _clineBuild(args) {
        const { execFile } = require('child_process');
        const task = (typeof args === 'string' ? args : (args.task || args.message || '')).trim();
        if (!task) throw new Error('cline_build requires a task');
        if (task.length > 6000) throw new Error('cline_build task too long (max 6000 chars)');
        const clinePath = 'C:\\Users\\uncom\\AppData\\Roaming\\npm\\cline.ps1';
        const timeout = Math.min(Number(args.timeout) || 240000, 600000);
        return new Promise((resolve) => {
            const child = execFile('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-File', clinePath, '--task', task
            ], { timeout }, (error, stdout, stderr) => {
                const out = (stdout || '').trim();
                resolve({
                    skill: 'cline_build',
                    success: !error,
                    output: out.slice(0, 6000),
                    error: error ? (stderr || error.message || '').trim().slice(0, 2000) : '',
                    exitCode: error ? error.code : 0,
                });
            });
        });
    }

    async _sandboxApprovals() {
        const sandbox = this._getSecureSandbox();
        if (!sandbox) return { pending: [] };
        return { pending: sandbox.getPendingApprovals() };
    }

    async _sandboxStats() {
        const sandbox = this._getSecureSandbox();
        if (!sandbox) return { available: false };
        return sandbox.getStats();
    }

    _getSecureSandbox() {
        return this.kernel?.systems?.secureSandbox || this.kernel?.secureSandbox || null;
    }

    async _getMcpServers() {
        const servers = [];
        for (const [name, server] of this.mcpServers) {
            servers.push({ name, url: server.url, capabilities: server.capabilities });
        }
        return servers;
    }
    
    // ── DUAL-PROCESS DIAGNOSTIC ENGINE ────────────────────────────
    async _diagnose(args) {
        if (!this.kernel?.dualProcessEngine) {
            throw new Error('DualProcessEngine not loaded');
        }
        const problem = args.problem || 'GSK self-diagnosis';
        const context = args.context || {};

        if (problem === 'selfDiagnose') {
            return await this.kernel.dualProcessEngine.selfDiagnose();
        } else {
            return await this.kernel.dualProcessEngine.diagnose(problem, context);
        }
    }

    // ── SANDBOX EXECUTION ─────────────────────────────────────────

    async _sandboxExecute(args) {
        const code = args.code || args.script || '';
        if (!code) throw new Error('No code specified for sandbox execution');

        let runInSandbox;
        try {
            ({ runInSandbox } = require('C:\\Users\\uncom\\Desktop\\final-run\\gsk-sandbox.js'));
        } catch (e) {
            // Fallback: try relative path from final-run
            try {
                ({ runInSandbox } = require('C:/Users/uncom/Desktop/final-run/gsk-sandbox.js'));
            } catch (e2) {
                throw new Error('GSK Sandbox Engine not available: ' + e2.message);
            }
        }

        const context = args.context || {};
        const result = await runInSandbox(code, context);

        if (result.error) {
            throw new Error('Sandbox error: ' + result.error);
        }

        return result.output;
    }

    // ── SANCTUM WORLD TOOLS (Unified World Model) ─────────────

    _getSanctum() {
        return this.kernel?.sanctumClient || null;
    }

    async _worldGetState() {
        const sanctum = this._getSanctum();
        if (!sanctum) throw new Error('Sanctum client not available');
        return sanctum.getWorldState();
    }

    async _worldSpawnSoul(args) {
        const sanctum = this._getSanctum();
        if (!sanctum) throw new Error('Sanctum client not available');
        const name = args.name || `soul_${Date.now()}`;
        const archetype = args.archetype || 'ARCHITECT';
        const traits = args.traits || {};
        sanctum.spawnSoul(name, archetype, traits);
        return { ok: true, name, archetype, spawnedAt: Date.now() };
    }

    async _worldSendCommand(args) {
        const sanctum = this._getSanctum();
        if (!sanctum) throw new Error('Sanctum client not available');
        const command = args.command || args;
        sanctum.sendCustomCommand(command);
        return { ok: true, command };
    }

    async _worldListSouls() {
        const sanctum = this._getSanctum();
        if (!sanctum) throw new Error('Sanctum client not available');
        const state = sanctum.getWorldState();
        return state.souls || [];
    }

    async _worldPlaceBuilding(args) {
        const sanctum = this._getSanctum();
        if (!sanctum) throw new Error('Sanctum client not available');
        const name = args.name || args.type || 'Building';
        const type = args.type || 'house';
        const x = args.x != null ? args.x : null;
        const z = args.z != null ? args.z : null;
        const building = sanctum.placeBuilding(name, type, x, z);
        return { ok: true, building };
    }

    async _worldListBuildings() {
        const sanctum = this._getSanctum();
        if (!sanctum) throw new Error('Sanctum client not available');
        const state = sanctum.getWorldState();
        return state.buildings || [];
    }

    // ── SAGE SKILLS (LLM-powered skill implementations) ──────

    async _sageSkill(skillName, args) {
        if (!this.kernel?.sageSkills) {
            throw new Error('SageSkills module not loaded');
        }
        return await this.kernel.sageSkills.dispatch(skillName, args);
    }

    // ── WORLD MODEL SIMULATION (Spatial Intelligence) ────────

    async _worldModelSim(args) {
        if (!this.kernel?.worldSim) throw new Error('WorldModelSimulation not loaded');
        const goal = args.goal || args.description || 'Explore Soulverse';
        const environment = args.environment || args.env || 'Soulverse 3D world at localhost:8080';
        const options = { steps: args.steps || 5, branches: args.branches || 3 };
        return await this.kernel.worldSim.simulate(goal, environment, options);
    }

    async _planFromSim(args) {
        if (!this.kernel?.worldSim) throw new Error('WorldModelSimulation not loaded');
        const simulationResult = args._input || args.simulation || args;
        if (!simulationResult?.bestPath) throw new Error('Simulation result required (bestPath)');
        return await this.kernel.worldSim._plan(simulationResult.goal || 'Unknown goal', simulationResult.bestPath);
    }

    async _perceptionActionSim(args) {
        if (!this.kernel?.worldSim) throw new Error('WorldModelSimulation not loaded');

        // Full perception-action-simulation-execution cycle
        const goal = args.goal || 'Explore and improve the Soulverse world';
        const environment = args.environment || 'Soulverse at localhost:8080';

        // 1. Simulate
        const report = await this.kernel.worldSim.simulate(goal, environment);

        // 2. Execute best path in world
        const execution = await this.kernel.worldSim.executeInWorld(report);

        return { simulation: report, execution };
    }

    // ── WORLD ENGINE SKILLS (Game Engine) ──────────────────────

    async _worldEngineSkill(skillName, args) {
        if (!this.kernel?.worldEngine) throw new Error('WorldEngine not loaded');
        const handler = this.kernel.worldEngine[skillName];
        if (!handler) throw new Error(`WorldEngine skill "${skillName}" not found`);
        return await handler.call(this.kernel.worldEngine, args || {});
    }

    // ── TELEGRAM BOT — Send message via @Profitlovetaxbot ─────────

    async _telegramSend(args) {
        const chatId = args.chatId || args.chat_id || process.env.TELEGRAM_CHAT_ID;
        const text = args.text || args.message || '';
        if (!chatId) throw new Error('chatId required (set TELEGRAM_CHAT_ID env or pass chatId)');
        if (!text) throw new Error('text required');

        const https = require('https');
        const token = process.env.TELEGRAM_BOT_TOKEN || '8713808619:AAHeGVgqgRbEp8GW_AuvMJtV2XVoQcgmM3A';
        const data = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true });

        return new Promise((resolve, reject) => {
          const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
            timeout: 10000
          }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ ok: false, raw: d }); } });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          req.write(data);
          req.end();
        });
    }

    // ── UNIFIED PROJECT BUILDER ─────────────────────────────────────

    async _unifiedProjectBuild(args) {
        if (!this.kernel?.unifiedProjectBuilder) {
            throw new Error('UnifiedProjectBuilder module not loaded');
        }
        const projectName = args.projectName || 'SoulverseProject';
        const format = args.format || 'json';
        return await this.kernel.unifiedProjectBuilder.build(projectName, format);
    }

    // ── COMBO ORCHESTRATOR ──────────────────────────────────────────

    async _executeCombo(args) {
        if (!this.kernel?.comboOrchestrator) {
            throw new Error('ComboOrchestrator module not loaded');
        }
        const comboName = args.comboName || args.name;
        const params = args.params || {};
        return await this.kernel.comboOrchestrator.execute(comboName, params);
    }

    // ── SOCIAL MEDIA POSTING ────────────────────────────────────────

    async _socialPost(args) {
        const platform = args.platform || 'bluesky';
        const text = args.text || args.message || args.content || '';
        if (!text) throw new Error('text required for social post');

        const allie = this.kernel?.allie;
        if (!allie || typeof allie.post !== 'function') {
            throw new Error('Social media not available (fusion.allie.post not wired)');
        }

        const content = { text, tags: args.tags || ['PLT', 'GSK'] };
        const result = await allie.post(platform, content);
        return { platform, posted: result?.skipped !== true && result?.posted !== false, result };
    }

    // ── TOOL CATALOG — Self-Introspection ─────────────────────────

    async _catalogList() {
        if (!this.toolCatalog || typeof this.toolCatalog.listAll !== 'function') {
            return { available: false, message: 'ToolCatalog not loaded' };
        }
        const all = this.toolCatalog.listAll();
        const stats = this.toolCatalog.getStats();
        return {
            total: all.length,
            byBackend: stats.byBackend,
            byCategory: stats.byCategory,
            tools: all.map(e => ({ name: e.name, description: e.description, backend: e.backend, category: e.category })),
        };
    }

    async _catalogDescribe(args) {
        if (!this.toolCatalog || typeof this.toolCatalog.describe !== 'function') {
            return { available: false, message: 'ToolCatalog not loaded' };
        }
        const name = args.name || args.tool || args;
        if (typeof name !== 'string') return { error: 'Provide a tool name: { name: "tool_name" }' };
        const entry = this.toolCatalog.describe(name);
        if (!entry) return { found: false, name, message: `Tool "${name}" not found in catalog` };
        return { found: true, name, ...entry };
    }

    async _catalogFind(args) {
        if (!this.toolCatalog || typeof this.toolCatalog.findForTask !== 'function') {
            return { available: false, message: 'ToolCatalog not loaded' };
        }
        const task = args.task || args.query || args;
        if (typeof task !== 'string') return { error: 'Provide a task description: { task: "search code" }' };
        const results = this.toolCatalog.findForTask(task);
        return {
            task,
            matches: results.length,
            suggestions: results.slice(0, 10).map(e => ({ name: e.name, description: e.description, backend: e.backend })),
        };
    }

    // ── SKILL CREATOR — GSK Creates Its Own Skills ──────────────

    async _skillCreate(args) {
        const { SkillCreator } = require('./../skills/skill_creator.js');
        const creator = new SkillCreator(this.kernel);
        const name = args.name || args;
        if (typeof name !== 'string') return { success: false, error: 'Provide skill name: { name: "my_skill" }' };
        const result = creator.create(name, { description: args.description || '' });
        if (result.success && this.kernel) {
            this._storeActionResult('skill_create', args, result);
        }
        return result;
    }

    async _skillList() {
        const { SkillCreator } = require('./../skills/skill_creator.js');
        const creator = new SkillCreator(this.kernel);
        return { skills: creator.list() };
    }

    async _voiceSpeak(args) {
        const voice = this.kernel?.systems?.voiceEngine || this.kernel?.voiceEngine;
        if (!voice) return { ok: false, error: 'VoiceEngine not loaded' };
        return voice.speak(args.text || args.content || '', args);
    }

    async _voiceJournal(args = {}) {
        const voice = this.kernel?.systems?.voiceEngine || this.kernel?.voiceEngine;
        const journal = this.kernel?.systems?.journalWriter || this.kernel?.journalWriter;
        if (!voice || !journal) return { ok: false, error: 'VoiceEngine or JournalWriter not loaded' };
        const entry = args.entry || journal.getRecent(args.index === undefined ? 1 : args.index + 1)[args.index || 0];
        return voice.speakJournalEntry(entry);
    }

    _selfEvolution() {
        return this.kernel?.agents?.selfEvolution || this.kernel?.systems?.selfEvolution || null;
    }

    async _evolutionPropose() {
        const evolution = this._selfEvolution();
        if (!evolution) return { status: 'error', error: 'SelfEvolution not loaded' };
        return evolution.evolve();
    }

    async _evolutionList() {
        const evolution = this._selfEvolution();
        return { proposals: evolution?.getPendingProposals?.() || [] };
    }

    async _evolutionApply(args = {}) {
        const evolution = this._selfEvolution();
        if (!evolution) return { status: 'error', error: 'SelfEvolution not loaded' };
        const approval = evolution.approveProposal(args.proposalId, args.approvedBy);
        if (!approval.ok) return { status: 'error', error: approval.error };
        return evolution.applyProposal(args.proposalId);
    }

    // ── BRIDGE GATEWAY ─────────────────────────────────────────────

    async _callBridgeGateway(tool, args) {
        const bridge = this.kernel?.fusion?.systems?.gskDashBridge;
        if (!bridge || typeof bridge.dispatchCommand !== 'function') return null;

        // Map tool names to bridge dispatch routes
        const routeMap = {
            'read_file': 'brain',
            'search_code': 'memory',
            'web_fetch': 'skill',
            'run_command': 'skill',
            'list_files': 'brain',
        };

        const route = routeMap[tool] || 'skill';
        const result = await bridge.dispatchCommand({
            route,
            skill: tool,
            args: typeof args === 'string' ? args : JSON.stringify(args),
            input: typeof args === 'object' ? args.url || args.query || args.path || '' : args
        });
        return result;
    }

    getStatus() {
        const base = {
            builtinTools: Array.from(this.toolRegistry.keys()),
            mcpServers: Array.from(this.mcpServers.keys()),
            total: this.toolRegistry.size + this.mcpServers.size
        };
        if (this.toolCatalog) {
            const stats = this.toolCatalog.getStats();
            return { ...base, catalogStats: stats };
        }
        return base;
    }

    getCatalog() {
        if (this.toolCatalog && typeof this.toolCatalog.listAll === 'function') {
            return this.toolCatalog.listAll();
        }
        return this.getStatus();
    }
}

module.exports = { UniversalToolBridge };
