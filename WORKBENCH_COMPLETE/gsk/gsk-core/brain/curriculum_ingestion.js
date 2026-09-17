'use strict';

const fs = require('fs');
const path = require('path');

/**
 * CURRICULUM INGESTION — Structured learning paths from curated sources.
 *
 * Currently ingests the PKUFlyingPig/cs-self-learning mkdocs.yml nav structure
 * (74.8k stars) as a structured CS curriculum. Each nav entry becomes a
 * learning topic that AutonomousLearning._determineTopics() can pull from.
 *
 * DeepAgents pattern: "Skills — reusable behaviors the agent can load on demand"
 * Hive pattern: "Graph-based execution DAG" — courses become nodes in the DAG
 *
 * The curriculum provides STRUCTURE that GSK's current ad-hoc topic generation
 * lacks. Instead of random topics like "AI agent frameworks 2025", topics
 * come from a verified, community-curated learning path.
 */
class CurriculumIngestion {
    constructor(dataDir) {
        this.dataDir = dataDir || path.join(__dirname, '../../data/gsk');
        this.curriculumPath = path.join(this.dataDir, 'cs_curriculum.json');
        this.navUrl = 'https://raw.githubusercontent.com/PKUFlyingPig/cs-self-learning/master/mkdocs.yml';
        this.lastFetch = 0;
        this.fetchInterval = 7 * 24 * 3600 * 1000; // 7 days
    }

    /**
     * Get structured learning topics for a given module/submodule.
     * Returns topics formatted as: "Course Name — Module: submodule"
     */
    getTopicsForModule(modulePrefix) {
        const curriculum = this._loadCurriculum();
        if (!curriculum || !curriculum.nav) return [];

        const modules = this._extractModules(curriculum.nav);
        const topics = [];
        for (const mod of modules) {
            if (modulePrefix && !mod.name.toLowerCase().includes(modulePrefix.toLowerCase())) continue;
            for (const course of mod.courses) {
                topics.push(`${this._courseToTopic(course.name)} — CS Self-Learning`);
            }
            for (const sub of mod.submodules) {
                for (const course of sub.courses) {
                    topics.push(`${this._courseToTopic(course.name)} — CS Self-Learning (${mod.name})`);
                }
            }
        }
        return topics;
    }

    /**
     * Get ALL curriculum topics, optionally filtered by interests.
     */
    getAllTopics(interests = []) {
        const curriculum = this._loadCurriculum();
        if (!curriculum || !curriculum.nav) return [];

        const modules = this._extractModules(curriculum.nav);
        const topics = [];
        for (const mod of modules) {
            if (interests.length > 0 && !interests.some(i => mod.name.toLowerCase().includes(i.toLowerCase()))) continue;
            for (const course of mod.courses) {
                topics.push(`${this._courseToTopic(course.name)} — CS Self-Learning (${mod.name})`);
            }
            for (const sub of mod.submodules) {
                for (const course of sub.courses) {
                    topics.push(`${this._courseToTopic(course.name)} — CS Self-Learning (${mod.name}/${sub.name})`);
                }
            }
        }
        return topics;
    }

    _extractModules(nav) {
        if (!nav) return [];
        if (Array.isArray(nav)) return nav;
        if (nav.modules) return nav.modules;
        return [];
    }

    /**
     * Fetch and cache the latest curriculum from cs-self-learning repo.
     * Uses the same _fetchSource pattern as AutonomousLearning.
     */
    async refreshCurriculum(fetchProvider) {
        const now = Date.now();
        // P3.4: an empty-modules cache is POISON, not fresh — a failed parse
        // once cached itself for 7 days. Re-fetch regardless of age.
        const cached = this._loadCurriculum();
        const cachedCount = cached && cached.nav ? this._countTopics(cached.nav) : 0;
        if (now - this.lastFetch < this.fetchInterval && cachedCount > 0) {
            return { status: 'cached', age_ms: now - this.lastFetch };
        }

        try {
            const result = await this._rawFetch(this.navUrl);
            if (!result?.ok || !result.text) {
                if (fetchProvider) {
                    const fbResult = await fetchProvider(this.navUrl);
                    if (fbResult?.ok && fbResult.text) {
                        const nav = this._parseMkdocsNav(fbResult.text);
                        if (this._countTopics(nav) === 0) return { status: 'error', error: 'empty_parse_no_cache_write' };
                        const curriculum = {
                            source: 'cs-self-learning',
                            url: 'https://github.com/PKUFlyingPig/cs-self-learning',
                            nav,
                            fetchedAt: new Date().toISOString(),
                            moduleCount: nav.modules.length
                        };
                        fs.mkdirSync(this.dataDir, { recursive: true });
                        fs.writeFileSync(this.curriculumPath, JSON.stringify(curriculum, null, 2));
                        this.lastFetch = now;
                        return { status: 'success', modules: nav.modules.length, topics: this._countTopics(nav) };
                    }
                }
                return { status: 'error', error: 'fetch_failed' };
            }

            const nav = this._parseMkdocsNav(result.text);
            if (this._countTopics(nav) === 0) return { status: 'error', error: 'empty_parse_no_cache_write' };
            const curriculum = {
                source: 'cs-self-learning',
                url: 'https://github.com/PKUFlyingPig/cs-self-learning',
                nav,
                fetchedAt: new Date().toISOString(),
                moduleCount: nav.modules.length
            };

            fs.mkdirSync(this.dataDir, { recursive: true });
            fs.writeFileSync(this.curriculumPath, JSON.stringify(curriculum, null, 2));
            this.lastFetch = now;

            return { status: 'success', modules: curriculum.moduleCount, topics: this._countTopics(nav) };
        } catch (e) {
            return { status: 'error', error: e.message };
        }
    }

    /**
     * Parse mkdocs.yml nav section into structured object.
     * Extracts module hierarchy + course titles + URLs.
     */
    _parseMkdocsNav(yamlText) {
        const navSection = yamlText.split('\nnav:')[1];
        if (!navSection) return { modules: [], _meta: {} };

        const lines = navSection.split('\n');
        const nav = { modules: [], _meta: {} };
        let currentModule = null;
        let currentSubmodule = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            // Indentation level: 0 = top-level (- ), 4+ = sub-item
            const indent = line.match(/^(\s*)-/) ? line.match(/^(\s*)-/)[1].length : 0;
            const isTopLevel = indent <= 2;
            const isSubLevel = indent >= 4;

            // Module with sub-items: "- Module Name:" (no path value)
            const moduleHeaderMatch = trimmed.match(/^-\s+(.+?):$/);
            if (moduleHeaderMatch && isTopLevel) {
                currentModule = { name: moduleHeaderMatch[1].trim(), courses: [], submodules: [] };
                nav.modules.push(currentModule);
                currentSubmodule = null;
                continue;
            }

            // Sub-module header: "- Submodule Name:" (has indent, no path value)
            const submoduleMatch = trimmed.match(/^-\s+(.+?):$/);
            if (submoduleMatch && isSubLevel) {
                currentSubmodule = { name: submoduleMatch[1].trim(), courses: [] };
                if (currentModule) currentModule.submodules.push(currentSubmodule);
                continue;
            }

            // Course entry: "- "Course Name": "path/to/file.md""
            const courseMatch = trimmed.match(/^-\s+["']?(.+?)["']?\s*:\s*["']?(.+?)["']?$/);
            if (courseMatch) {
                const course = { name: courseMatch[1].trim(), path: courseMatch[2].trim() };
                if (isSubLevel && currentSubmodule) {
                    currentSubmodule.courses.push(course);
                } else if (isTopLevel) {
                    // Top-level entry with file path — create a single-course module
                    currentModule = { name: course.name, courses: [course], submodules: [] };
                    nav.modules.push(currentModule);
                    currentSubmodule = null;
                } else if (currentModule) {
                    currentModule.courses.push(course);
                }
            }
        }

        // P3.4 FALLBACK: cs-self-learning ships i18n nav_translations with CJK
        // keys — the strict shape above yields 0 courses on it. Sweep every
        // `- Name: path.md` line grouped under its nearest header instead.
        let total = 0;
        for (const mod of nav.modules) {
            total += mod.courses.length;
            for (const sub of mod.submodules) total += sub.courses.length;
        }
        if (total === 0) {
            let bucket = null;
            for (const rawLine of lines) {
                const trimmed = rawLine.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const head = trimmed.match(/^-\s+(.+?):$/);
                if (head && !/\.md/i.test(head[1])) {
                    bucket = { name: head[1].replace(/^["']|["']$/g, '').trim().substring(0, 80) || 'CS', courses: [], submodules: [] };
                    nav.modules.push(bucket);
                    continue;
                }
                const course = trimmed.match(/^-\s+["']?(.+?)["']?\s*:\s*["']?(.+?\.md)["']?$/i);
                if (course) {
                    if (!bucket) {
                        bucket = { name: 'CS Self-Learning', courses: [], submodules: [] };
                        nav.modules.push(bucket);
                    }
                    bucket.courses.push({ name: course[1].trim(), path: course[2].trim() });
                }
            }
        }

        return nav;
    }

    _countTopics(nav) {
        let count = 0;
        for (const mod of nav.modules) {
            count += mod.courses.length;
            for (const sub of mod.submodules) count += sub.courses.length;
        }
        return count;
    }

    _loadCurriculum() {
        try {
            const content = fs.readFileSync(this.curriculumPath, 'utf-8');
            return JSON.parse(content);
        } catch (e) { return null; }
    }

    /**
     * Map a course name to a searchable topic string.
     * e.g., "UCB CS61B: Data Structures and Algorithms" →
     *   "UCB CS61B Data Structures and Algorithms"
     */
    _courseToTopic(courseName) {
        return courseName
            .replace(/[:：].*$/, '')
            .replace(/\s*\([^)]*\)/g, '')
            .trim();
    }

    /**
     * Raw fetch without HTML stripping — needed for YAML files.
     */
    async _rawFetch(url) {
        const https = require('https');
        const http = require('http');
        return new Promise(resolve => {
            let parsed;
            try { parsed = new URL(url); } catch { return resolve({ ok: false, error: 'invalid_url' }); }
            if (!['http:', 'https:'].includes(parsed.protocol)) return resolve({ ok: false, error: 'bad_protocol' });
            const transport = parsed.protocol === 'https:' ? https : http;
            const req = transport.get(parsed, {
                timeout: 15000,
                headers: { 'User-Agent': 'GSK-Curriculum/1.0', 'Accept': 'text/yaml,application/x-yaml,text/plain,*/*' }
            }, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const next = new URL(res.headers.location, parsed).toString();
                    this._rawFetch(next).then(resolve);
                    res.resume();
                    return;
                }
                let data = '';
                res.on('data', chunk => { if (data.length < 500000) data += chunk; });
                res.on('end', () => {
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, text: data });
                });
            });
            req.on('error', error => resolve({ ok: false, error: error.message }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
        });
    }
}

module.exports = { CurriculumIngestion };
