/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AUTONOMOUS_LEARNING.JS — Autonomous Learning Agent
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Continuously learns from web, conversations, and results.
 * Fills the LLM with knowledge automatically.
 * 
 * Created by: Craig Jones (Grand Code Pope)
 * PLT Press — Profit + Love - Tax = True Value
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

class AutonomousLearning {
    constructor(brain, memory, chambers, options = {}) {
        this.brain = brain;
        this.memory = memory;
        this.chambers = chambers;
        this.learningQueue = [];
        this.webFetchInterval = Math.max(300000, Number(options.webFetchInterval) || 1800000);
        this.maxLearnsPerCycle = Math.max(1, Number(options.maxLearnsPerCycle) || 1);
        this.maxTopicsPerCycle = Math.max(1, Number(options.maxTopicsPerCycle) || 1);
        this.learningActive = false;
        this.learnedTopics = new Set();
        this._intervalId = null;
        this._firstRunTimer = null;
        
        this.dataDir = memory.dataDir;
        this.knowledgePath = path.join(this.dataDir, 'knowledge.jsonl');
        // P3.16/P3.19: persistent per-repo ingest index — clone once per remote
        // HEAD, not once per boot. (learnedTopics tail-scan stays as session cache.)
        this.gitIndexPath = path.join(this.dataDir, 'git-ingest-index.json');
        this.seshatPagesDir = options.seshatPagesDir || process.env.SESHAT_PAGES_DIR || 'C:\\Users\\uncom\\Desktop\\seshat-second-brain\\pages';
        this.searchProvider = options.searchProvider || (topic => this._searchWeb(topic));
        this.fetchProvider = options.fetchProvider || (url => this._fetchSource(url));
        this._loadLearnedTopics();

        // CURRICULUM INGESTION: structured CS learning path from cs-self-learning
        this.curriculum = new (require('./curriculum_ingestion.js').CurriculumIngestion)(this.dataDir);
    }
    
    async learnFromGit(repoUrl, branch = 'main') {
        try {
            const { execSync } = require('child_process');
            // P3.16: skip the clone when the remote hasn't moved since our last
            // ingest. Every boot used to re-clone full monorepos then discard
            // all writes as duplicates ("cloning the same repo forever").
            const remoteSha = this._gitRemoteSha(repoUrl);
            const indexed = this._gitIndexGet(repoUrl);
            if (remoteSha && indexed && indexed.sha === remoteSha) {
                console.log(`[AutonomousLearning] Skipping ${repoUrl} — already ingested at ${remoteSha.slice(0, 8)}`);
                return { status: 'skipped', repo: repoUrl, sha: remoteSha };
            }
            const tmpDir = require('path').join(require('os').tmpdir(), `gsk-${Date.now()}`);
            // Sanitize branch name — only allow valid git ref characters
            const safeBranch = String(branch).replace(/[^a-zA-Z0-9._\/-]/g, '');
            
            console.log(`[AutonomousLearning] Cloning ${repoUrl}...`);
            execSync(`git clone --depth 1 --branch "${safeBranch}" "${repoUrl}" "${tmpDir}"`, {
                timeout: 60000,
                encoding: 'utf-8',
                stdio: 'pipe'
            });
            
            const fs = require('fs');
            const path = require('path');
            const learned = [];
            
            function walkDir(dir) {
                let results = [];
                const list = fs.readdirSync(dir);
                for (const file of list) {
                    const fullPath = path.join(dir, file);
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory() && !file.startsWith('.') && file !== 'node_modules') {
                        results = results.concat(walkDir(fullPath));
                    } else if (stat.isFile()) {
                        const ext = path.extname(file).toLowerCase();
                        if (['.js', '.ts', '.py', '.md', '.json', '.yaml', '.yml', '.txt', '.html', '.css', '.mjs', '.cjs'].includes(ext)) {
                            results.push(fullPath);
                        }
                    }
                }
                return results;
            }
            
            const files = walkDir(tmpDir);
            console.log(`[AutonomousLearning] Found ${files.length} files to learn from in ${repoUrl}`);
            
            for (const filePath of files.slice(0, 50)) {
                try {
                    const content = fs.readFileSync(filePath, 'utf-8').substring(0, 5000);
                    const relativePath = path.relative(tmpDir, filePath);
                    const knowledge = {
                        topic: `git:${repoUrl}/${relativePath}`,
                        source: 'git',
                        abstract: content.substring(0, 1000),
                        related: [{ title: `Full file: ${relativePath}`, url: `${repoUrl}/blob/main/${relativePath}` }],
                        timestamp: new Date().toISOString(),
                    };
                    await this._storeKnowledge(knowledge);
                    learned.push(relativePath);
                    
                    await this.memory.witness({
                        type: 'learning',
                        weight: 0.8,
                        tags: ['autonomous', 'git', 'knowledge'],
                        content: `Learned from ${repoUrl}/${relativePath}: ${content.substring(0, 200)}`,
                        meta: { repo: repoUrl, file: relativePath, source: 'git' },
                    });
                } catch (e) {
                    // Skip individual file errors
                }
            }
            
            // Cleanup temp directory
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch (e) {}
            
            if (remoteSha) this._gitIndexSet(repoUrl, { sha: remoteSha, branch: safeBranch, at: new Date().toISOString(), files: learned.length });
            return { status: 'success', repo: repoUrl, files_learned: learned.length, files: learned };
        } catch (e) {
            return { status: 'error', repo: repoUrl, error: e.message };
        }
    }

    /**
     * ═══════════════════════════════════════════════════════════════════
     * learnFromLocalPages — Ingest Logseq Second Brain pages & journals
     * ═══════════════════════════════════════════════════════════════════
     * Scans seshatPagesDir and the sibling journals/ directory.
     * Reads each .md file, extracts title + content, and stores into
     * knowledge.jsonl with source='local'. Tracks mtimes so only new
     * or modified files are re-ingested on subsequent cycles.
     */
    async learnFromLocalPages() {
        const dirs = [this.seshatPagesDir];
        // Also scan journals/ if it exists as a sibling of pages/
        const journalsDir = path.join(path.dirname(this.seshatPagesDir), 'journals');
        if (fs.existsSync(journalsDir)) dirs.push(journalsDir);

        // Load persistent index from disk to avoid re-ingesting same pages every boot
        const indexPath = path.join(this.dataDir || '.', 'indexed-local-files.json');
        if (!this._indexedLocalFiles) {
            this._indexedLocalFiles = new Set();
            try {
                if (fs.existsSync(indexPath)) {
                    const arr = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
                    arr.forEach(k => this._indexedLocalFiles.add(k));
                    console.log(`[AutonomousLearning] Loaded ${this._indexedLocalFiles.size} indexed files from disk`);
                }
            } catch (e) {}
        }

        let ingested = 0;
        let skipped = 0;
        let errors = 0;

        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                console.log(`[AutonomousLearning] Local dir missing, skip: ${dir}`);
                continue;
            }

            let files;
            try {
                files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
            } catch (e) {
                console.log(`[AutonomousLearning] Cannot read dir ${dir}: ${e.message}`);
                continue;
            }

            for (const file of files) {
                const filePath = path.join(dir, file);
                try {
                    const stat = fs.statSync(filePath);
                    const mtimeKey = `${filePath}::${stat.mtimeMs}`;

                    // Skip if already indexed at this mtime
                    if (this._indexedLocalFiles.has(mtimeKey)) {
                        skipped++;
                        continue;
                    }

                    const raw = fs.readFileSync(filePath, 'utf-8');
                    if (!raw || raw.trim().length < 30) {
                        skipped++;
                        continue;
                    }

                    const title = this._extractMarkdownTitle(raw, file);
                    const content = raw.substring(0, 4000);

                    // Build knowledge entry matching existing format
                    const knowledge = {
                        topic: `seshat:${title}`,
                        source: 'local',
                        abstract: content.substring(0, 2000),
                        related: [{ title: file, url: `file://${filePath.replace(/\\/g, '/')}` }],
                        verified: true,
                        localPath: filePath,
                        timestamp: new Date().toISOString(),
                    };

                    await this._storeKnowledge(knowledge);

                    // Witness in memory
                    await this.memory.witness({
                        type: 'learning',
                        weight: 0.9,
                        tags: ['autonomous', 'local', 'seshat', 'knowledge'],
                        content: `Ingested Seshat page: ${title} (${file}) — ${content.substring(0, 150)}`,
                        meta: { topic: knowledge.topic, source: 'local', file: filePath },
                    });

                    if (!this._indexedLocalFiles) this._indexedLocalFiles = new Set();
                    this._indexedLocalFiles.add(mtimeKey);
                    ingested++;
                } catch (e) {
                    errors++;
                }
            }
        }

        if (ingested > 0) {
            console.log(`[AutonomousLearning] 📚 Seshat ingest: ${ingested} pages indexed, ${skipped} skipped, ${errors} errors`);
            // Persist index to disk so we don't re-ingest on next boot
            try {
                const dir2 = path.dirname(indexPath);
                if (!fs.existsSync(dir2)) fs.mkdirSync(dir2, { recursive: true });
                fs.writeFileSync(indexPath, JSON.stringify([...this._indexedLocalFiles]), 'utf-8');
            } catch (e) {}
        }
        return { status: 'success', ingested, skipped, errors };
    }

    /**
     * Extract a human-readable title from markdown content.
     * Tries YAML frontmatter title:, then first # heading, then filename.
     */
    _extractMarkdownTitle(content, filename) {
        // Try YAML frontmatter title
        const fmMatch = content.match(/^---[\s\S]*?^title:\s*(.+)$/m);
        if (fmMatch) return fmMatch[1].trim().replace(/^["']|["']$/g, '');
        // Try first heading
        const headingMatch = content.match(/^#+\s+(.+)$/m);
        if (headingMatch) return headingMatch[1].trim();
        // Fall back to filename without extension
        return filename.replace(/\.md$/i, '');
    }

    async learnFromWeb(topic) {
        if (!this._isValidTopic(topic)) {
            return { status: 'error', topic, error: 'Rejected topic (looks like noise, not a concept)', results: 0 };
        }
        try {
            const results = await this.searchProvider(topic);
            const verified = [];
            for (const result of results.slice(0, 5)) {
                if (!this._isRelevantResult(topic, result)) continue;
                const fetched = await this.fetchProvider(result.url);
                if (fetched?.ok && fetched.text) {
                    verified.push({ ...result, excerpt: fetched.text.substring(0, 1200), statusCode: fetched.statusCode || 200 });
                }
            }

            if (verified.length === 0) {
                return { status: 'error', topic, error: 'No sources could be fetched and verified', results: results.length };
            }

            const abstract = verified.map(r => r.title + ': ' + (r.snippet || r.excerpt)).join(' | ');
            if (!abstract || abstract.trim().length < 20) {
                return { status: 'error', topic, error: 'No usable content extracted (empty abstract)', results: results.length };
            }
            const knowledge = {
                topic,
                source: 'web',
                abstract: abstract.substring(0, 3000),
                verified: true,
                related: verified.map(r => ({ title: r.title.substring(0, 100), url: r.url, statusCode: r.statusCode })),
                excerpts: verified.map(r => ({ url: r.url, text: r.excerpt })),
                timestamp: new Date().toISOString(),
            };

            knowledge.seshatNote = this._writeSeshatNote(knowledge);
            await this._storeKnowledge(knowledge);
            this.learnedTopics.add(topic);
            
            await this.memory.witness({
                type: 'learning',
                weight: 0.7,
                tags: ['autonomous', 'web', 'knowledge'],
                content: `Learned about ${topic} from web: ${abstract.substring(0, 200)}`,
                meta: { topic, source: 'web', verifiedSources: verified.length, seshatNote: knowledge.seshatNote },
            });

            return { status: 'success', topic, knowledge, results: results.length, verifiedSources: verified.length, seshatNote: knowledge.seshatNote };
        } catch (e) {
            return { status: 'error', topic, error: e.message };
        }
    }

    async _searchWeb(topic) {
        const { searchWeb } = require('./web_search_provider.js');
        try {
            const items = await searchWeb(topic, 5);
            return items.map(({ title, url, snippet, source }) => ({ title, url, snippet, source }));
        } catch (e) {
            return [];
        }
    }

    /**
     * A topic is only worth researching if it looks like a real concept.
     * Blocks error strings, goal noise, and mystery artifacts from being
     * stored into knowledge.jsonl as if they were learned facts.
     */
    _isValidTopic(topic) {
        if (!topic || typeof topic !== 'string') return false;
        const t = topic.trim();
        if (t.length < 4 || t.length > 200) return false;
        if (/^(unknown|error|failed|null|undefined|n\/a)\b/i.test(t)) return false;
        if (/TODO|FIXME|completeness=|state=|new_unversioned|contract_audit/.test(t)) return false;
        // Reject error-message topics that the LLM generates as "research"
        if (/ENOENT|ENOTDIR|ENOBUFS|ECONNREFUSED|ETIMEDOUT|EACCES|scandir|no such file|node:internal|Cannot find module/.test(t)) return false;
        return true;
    }

    _isRelevantResult(topic, result) {
        if (!result || !result.url) return false;
        const title = (result.title || '').toLowerCase();
        const snippet = (result.snippet || '').toLowerCase();
        const combined = title + ' ' + snippet;

        // Reject error/trace results
        if (/ENOENT|ENOTDIR|ENOBUFS|ECONNREFUSED|ETIMEDOUT|EACCES|scandir|no such file|node:internal|Cannot find module|stack trace|error:/.test(combined)) return false;

        // Reject obvious non-tech domains for technical queries
        const nonTechIndicators = ['rock band', 'musician', 'album', 'concert', 'football club', 'basketball team', 'wikipedia.org/wiki/wiki'];
        for (const indicator of nonTechIndicators) {
            if (combined.includes(indicator)) return false;
        }

        // For tech topics, prefer domains with technical content
        const techDomains = ['github.com', 'developer.mozilla', 'npmjs.com', 'stackoverflow.com', 'reddit.com', '.org', '.dev', 'arxiv.org', 'docs.google', 'web.dev'];
        const urlLower = result.url.toLowerCase();
        const isTechDomain = techDomains.some(d => urlLower.includes(d));
        const isNonTechDomain = ['band', 'music', 'wikipedia.org/wiki/'].some(d => urlLower.includes(d));
        if (isNonTechDomain && !isTechDomain) return false;

        return true;
    }

    async _fetchSource(sourceUrl, redirects = 0) {
        let parsed;
        try { parsed = new URL(sourceUrl); } catch { return { ok: false, error: 'invalid_url' }; }
        if (!['http:', 'https:'].includes(parsed.protocol) || this._isPrivateHost(parsed.hostname)) {
            return { ok: false, error: 'blocked_url' };
        }
        return new Promise(resolve => {
            const transport = parsed.protocol === 'https:' ? https : http;
            const req = transport.get(parsed, {
                timeout: 15000,
                headers: { 'User-Agent': 'GSK-Research/1.0', 'Accept': 'text/html,text/plain,application/json' }
            }, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
                    res.resume();
                    const next = new URL(res.headers.location, parsed).toString();
                    this._fetchSource(next, redirects + 1).then(resolve);
                    return;
                }
                let data = '';
                res.on('data', chunk => { if (data.length < 200000) data += chunk; });
                res.on('end', () => {
                    const text = data.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 && text.length > 0, statusCode: res.statusCode, text });
                });
            });
            req.on('error', error => resolve({ ok: false, error: error.message }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
        });
    }

    _isPrivateHost(hostname) {
        const host = String(hostname).toLowerCase();
        if (host === 'localhost' || host === '::1' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.')) return true;
        const match = host.match(/^172\.(\d+)\./);
        return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
    }

    _writeSeshatNote(knowledge) {
        fs.mkdirSync(this.seshatPagesDir, { recursive: true });
        const slug = knowledge.topic.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').substring(0, 80) || 'Research';
        const notePath = path.join(this.seshatPagesDir, `SOUL-NOTE - GSK Research - ${slug}.md`);
        const sources = knowledge.related.map((source, index) => `${index + 1}. [${source.title}](${source.url}) — HTTP ${source.statusCode}`).join('\n');
        const excerpts = knowledge.excerpts.map(source => `- ${source.text.substring(0, 500)} ([source](${source.url}))`).join('\n');
        const markdown = `---\ntitle: SOUL-NOTE - GSK Research - ${knowledge.topic}\ntype: research\nverified: true\ndate: ${knowledge.timestamp}\n---\n\n# GSK Research — ${knowledge.topic}\n\n## Verified Finding\n${knowledge.abstract}\n\n## Source Excerpts\n${excerpts}\n\n## Sources\n${sources}\n`;
        fs.writeFileSync(notePath, markdown, 'utf8');
        return notePath;
    }
    
    async learnFromConversation(input, output) {
        const concepts = this._extractConcepts(input, output);
        
        const learningEntry = {
            type: 'conversation_learn',
            input,
            output,
            concepts,
            timestamp: new Date().toISOString(),
            cycle: this.chambers.mythos ? this.chambers.mythos.cycles : 0,
        };
        
        await this.memory.witness({
            type: 'conversation_learn',
            weight: 0.8,
            tags: ['autonomous', 'conversation', 'learning'],
            content: `Conversation learned: ${input.substring(0, 100)}... -> ${output.substring(0, 100)}...`,
            meta: { concepts, input_length: input.length, output_length: output.length },
        });
        
        for (const concept of concepts) {
            if (!this.learnedTopics.has(concept) && concept.length > 2) {
                this.learningQueue.push({ type: 'concept', topic: concept, priority: 0.6 });
            }
        }
        
        return { status: 'success', concepts_extracted: concepts.length };
    }
    
    _extractConcepts(input, output) {
        const text = `${input} ${output}`.toLowerCase();
        const words = text.split(/\W+/).filter(w => w.length > 4);
        const stopWords = new Set(['because', 'should', 'something', 'actually', 'maybe', 'perhaps', 'probably', 'really', 'really', 'always', 'never']);
        const concepts = [...new Set(words.filter(w => !stopWords.has(w)))];
        return concepts.slice(0, 10);
    }
    
    async processLearningQueue() {
        if (this.learningQueue.length === 0) return { processed: 0 };

        // P1.5: priority order + pool-of-3 + URL dedupe. The old sequential
        // loop starved (1 topic/cycle, repeats re-fetched, priority ignored).
        this.learningQueue.sort((a, b) => ((b && b.priority) || 0) - ((a && a.priority) || 0));
        if (!this._seenUrls) this._seenUrls = new Set();
        const maxProcess = Math.min(this.maxLearnsPerCycle, this.learningQueue.length);
        const batch = [];
        for (let i = 0; i < maxProcess; i++) {
            const item = this.learningQueue.shift();
            if (item && item.type === 'concept') batch.push(item);
        }

        const runOne = async (item) => {
            try {
                return await this.learnFromWeb(item.topic);
            } catch (e) {
                return { status: 'error', topic: item.topic, error: e.message };
            }
        };
        // Pool of 3 concurrent, bounded by batch size.
        const results = [];
        for (let i = 0; i < batch.length; i += 3) {
            const chunk = batch.slice(i, i + 3);
            const out = await Promise.all(chunk.map(runOne));
            results.push(...out);
        }

        return { processed: results.length, results };
    }
    
    async continuousLearn() {
        if (this.learningActive) return;
        
        this.learningActive = true;

        // ── Local Seshat ingest (runs first, every cycle) ──
        try {
            await this.learnFromLocalPages();
        } catch (e) {
            console.log(`[AutonomousLearning] Local ingest error: ${e.message}`);
        }
        
        // NERVES: CuriosityChamber carries drive/information_desire —
        // there is no `.exploration` field. Map honestly or default.
        const _cq = this.chambers.curiosity || {};
        const curiosity = { exploration: _cq.drive ?? _cq.information_desire ?? 0.5 };
        const topicsOfInterest = this._determineTopics(curiosity);
        
        for (const topic of topicsOfInterest) {
            if (!this.learnedTopics.has(topic)) {
                await this.learnFromWeb(topic);
                await this._sleep(2000);
            }
        }
        
        await this.processLearningQueue();
        
        this.learningActive = false;
        return { status: 'cycle_complete', topics_learned: topicsOfInterest.length };
    }
    
    _determineTopics(curiosityState) {
        const allTopics = [];

        // CURRICULUM-FIRST: pull from structured CS curriculum (cs-self-learning)
        if (this.curriculum) {
            const curriculumTopics = this.curriculum.getAllTopics();
            const unlearned = curriculumTopics.filter(t => !this.learnedTopics.has(t));
            allTopics.push(...unlearned);
        }

        // AGENT ARCHITECTURE TOPICS: from awesome-ai-agents curated list (e2b-dev)
        // These are structured categories, not random topics — replaces the old
        // ad-hoc "AI agent frameworks 2025" etc. with concrete agent architectures to study.
        const agentTopics = this._agentArchitectureTopics();

        // Fallback: original ad-hoc topics (for non-CS domains)
        const fallbackTopics = [
            'AI agent frameworks 2025', 'autonomous coding agents', 'LLM fine tuning techniques',
            'agent memory systems', 'tool use patterns AI', 'multi agent orchestration',
            'RAG implementation patterns', 'prompt engineering 2025', 'function calling LLM',
            'knowledge graph construction', 'self improving AI systems', 'AI safety alignment',
        ];

        // Mix: 40% curriculum, 40% agent topics, 20% fallback.
        // P1.5: ceil (not floor) so the default maxTopicsPerCycle=1 still
        // rotates curriculum instead of starving it to zero forever.
        const curriculumCount = Math.max(1, Math.ceil(this.maxTopicsPerCycle * 0.4));
        const agentCount = Math.max(1, Math.ceil(this.maxTopicsPerCycle * 0.4));
        const fallbackCount = Math.max(0, this.maxTopicsPerCycle - curriculumCount - agentCount);

        const selected = [];
        const shuffledCurriculum = allTopics.sort(() => Math.random() - 0.5);
        const shuffledAgents = agentTopics.sort(() => Math.random() - 0.5);
        const shuffledFallback = [...fallbackTopics].sort(() => Math.random() - 0.5);

        // Pick unlearned curriculum topics
        for (const topic of shuffledCurriculum) {
            if (!this.learnedTopics.has(topic) && selected.length < curriculumCount) {
                selected.push(topic);
            }
        }

        // Pick unlearned agent architecture topics
        for (const topic of shuffledAgents) {
            if (!this.learnedTopics.has(topic) && selected.length < curriculumCount + agentCount) {
                selected.push(topic);
            }
        }

        // Fill remaining slots with fallback
        for (const topic of shuffledFallback) {
            if (selected.length < this.maxTopicsPerCycle && !this.learnedTopics.has(topic)) {
                selected.push(topic);
            }
        }

        // If still not enough, allow already-learned topics (rotation)
        if (selected.length < this.maxTopicsPerCycle && allTopics.length > 0) {
            const rotation = [...shuffledCurriculum, ...shuffledAgents].sort(() => Math.random() - 0.5);
            for (const topic of rotation) {
                if (selected.length >= this.maxTopicsPerCycle) break;
                if (!selected.includes(topic)) selected.push(topic);
            }
        }

        return selected.length > 0 ? selected : fallbackTopics.slice(0, this.maxTopicsPerCycle);
    }

    /**
     * Structured agent architecture topics from the e2b-dev/awesome-ai-agents list.
     * Each represents a category of agent architecture to study/research.
     * These are concrete, verifiable topics — not abstract concepts.
     */
    _agentArchitectureTopics() {
        return [
            'AutoGPT autonomous agent architecture',
            'BabyAGI task-driven agent pattern',
            'AutoGen multi-agent conversation framework',
            'CrewAI role-playing orchestrator framework',
            'ChatDev virtual software company multi-agent',
            'LangGraph persistent agent state management',
            'ReAct reasoning + acting agent pattern',
            'BabyBeeAGI enhanced task management',
            'Devika agentic AI software engineer workflow',
            'Continue dev autopilot extension architecture',
            'Adala data labeling autonomous agents',
            'BambooAI agentic data analysis loop',
            'AgentVerse multi-agent simulation platform',
            'CAMEL mind exploration architecture',
            'Clippy autonomous code planning agent',
            'DevOpsGPT natural language to software automation',
            'DemoGPT LangChain demo generator architecture',
            'DevGPT virtual microservice development team',
            'AgentPilot desktop multi-agent management',
            'E2B code interpreter SDK for agents',
            'Flowise visual agent workflow builder architecture',
            'OpenInterpreter autonomous code interpreter pattern',
        ];
    }

    addTopic(topic) {
        if (topic && !this.learnedTopics.has(topic) && topic.length > 3) {
            this.learningQueue.push({ type: 'concept', topic, priority: 0.8 });
        }
    }
    
    async _storeKnowledge(knowledge) {
        // Hard guard: never persist empty/error noise as "knowledge".
        if (!knowledge || !knowledge.topic || !knowledge.abstract || String(knowledge.abstract).trim().length < 20) {
            console.log(`[AutonomousLearning] Skipped knowledge write for "${knowledge && knowledge.topic}" (empty/noise)`);
            return;
        }
        // Deduplication: skip if this exact topic was already stored this session
        if (this.learnedTopics.has(knowledge.topic)) {
            console.log(`[AutonomousLearning] Skipped duplicate knowledge write for "${knowledge.topic}"`);
            return;
        }
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }

        const line = JSON.stringify(knowledge) + '\n';
        fs.appendFileSync(this.knowledgePath, line);
        this.learnedTopics.add(knowledge.topic);
    }

    _loadLearnedTopics() {
        if (!fs.existsSync(this.knowledgePath)) return;
        try {
            const lines = fs.readFileSync(this.knowledgePath, 'utf8').split('\n').filter(Boolean).slice(-5000);
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.topic) this.learnedTopics.add(entry.topic);
                } catch (e) {}
            }
        } catch (e) {}
    }

    // P3.16: remote HEAD without cloning (cheap). Null = couldn't check → caller clones (availability over thrift).
    _gitRemoteSha(repoUrl) {
        try {
            const { execSync } = require('child_process');
            const out = execSync(`git ls-remote "${repoUrl}" HEAD`, { timeout: 20000, encoding: 'utf-8', stdio: 'pipe' });
            const sha = (out.trim().split(/\s+/)[0] || '').trim();
            return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
        } catch (e) {
            return null;
        }
    }

    _gitIndexLoad() {
        try {
            if (!fs.existsSync(this.gitIndexPath)) return {};
            return JSON.parse(fs.readFileSync(this.gitIndexPath, 'utf8')) || {};
        } catch (e) { return {}; }
    }

    _gitIndexGet(repoUrl) {
        return this._gitIndexLoad()[repoUrl] || null;
    }

    _gitIndexSet(repoUrl, entry) {
        try {
            const idx = this._gitIndexLoad();
            idx[repoUrl] = entry;
            if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
            fs.writeFileSync(this.gitIndexPath, JSON.stringify(idx, null, 2));
        } catch (e) {}
    }
    
    startContinuousLearning() {
        if (this._intervalId) return;

        this._firstRunTimer = setTimeout(() => this.continuousLearn().catch(e => {
            console.log(`[AutonomousLearning] First cycle error: ${e.message}`);
        }), Math.min(120000, this.webFetchInterval));
        this._intervalId = setInterval(async () => {
            try {
                await this.continuousLearn();
            } catch (e) {
                console.log(`[AutonomousLearning] Cycle error: ${e.message}`);
            }
        }, this.webFetchInterval);
        
        console.log('[AutonomousLearning] Continuous learning started');
    }
    
    stopContinuousLearning() {
        if (this._firstRunTimer) {
            clearTimeout(this._firstRunTimer);
            this._firstRunTimer = null;
        }
        if (this._intervalId) {
            clearInterval(this._intervalId);
            this._intervalId = null;
            console.log('[AutonomousLearning] Continuous learning stopped');
        }
    }
    
    getStatus() {
        return {
            active: this.learningActive,
            queue_length: this.learningQueue.length,
            learned_topics: this.learnedTopics.size,
            interval_ms: this.webFetchInterval,
        };
    }
    
    async update() {
        try {
            const affect = this.chambers.affect || {};
            const curiosity = affect.curiosity || 0.3;
            const arousal = affect.arousal || 0.3;

            if (curiosity > 0.4 && arousal > 0.3 && !this.learningActive) {
                const topics = this._determineTopics({ exploration: curiosity });
                for (const topic of topics.slice(0, 2)) {
                    if (!this.learnedTopics.has(topic)) {
                        await this.learnFromWeb(topic);
                        this.learnedTopics.add(topic);
                        await this._sleep(500);
                    }
                }
            }
            await this.processLearningQueue();
            return { status: 'ok' };
        } catch (e) {
            return { status: 'error', message: e.message };
        }
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = { AutonomousLearning };
