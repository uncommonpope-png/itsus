import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { join, relative, resolve, basename, dirname, sep, isAbsolute } from 'node:path';
import { journalAppend } from './memory.js';

const FORBIDDEN = /(\brm\s+-rf\b|\brm\s+-rf?\s+[\/~]|rd\s+\/s\b|del\s+\/[sq]\b|rmdir\s+\/s\b|Remove-Item\b[^\n;]*-Recurse|format\s+[a-z]:|mkfs|:\(\)\{.*\};:|diskpart|cipher\s+\/w|takeown|icacls\s|reg\s+(delete|add)|Invoke-Expression|\bIEX\b|Start-Process\b|\$\(|`)/i;

let workspace = process.cwd();

export const setWorkspace = (dir) => {
  workspace = resolve(dir);
};

export const getWorkspace = () => workspace;

const safePath = (p) => {
  // P4.4d: canonicalize (resolves .. AND symlinks) then contain. The old
  // double-gated string check missed `..file` edges and symlink escapes.
  const full = resolve(workspace, String(p || ''));
  let real = full;
  try {
    real = realpathSync(full);
  } catch {
    // Target doesn't exist yet (writes): contain the parent instead.
    try {
      const parent = dirname(full);
      if (existsSync(parent)) real = join(realpathSync(parent), basename(full));
    } catch {}
  }
  const rel = relative(workspace, real);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error(`Path escapes the workshop: ${p}`);
  }
  return full;
};

export const MUSCLES = {
  shell: {
    description:
      'Run a PowerShell command in the workshop (Windows OS — use PowerShell syntax: Get-ChildItem, Get-Content, Select-String). Args: {command}',
    run: async ({ command }) => {
      if (FORBIDDEN.test(command)) throw new Error('Refused: destructive command blocked by vow.');
      return execSync(`powershell -NoProfile -Command "${String(command).replace(/"/g, '\\"')}"`, {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 90000,
        windowsHide: true,
        shell: 'cmd.exe',
      }).slice(0, 6000);
    },
  },
  read_file: {
    description: 'Read a file from the workshop. Args: {path}',
    run: async ({ path }) => readFileSync(safePath(path), 'utf8').slice(0, 8000),
  },
  write_file: {
    description: 'Write content to a file in the workshop (creates/overwrites). Args: {path, content}',
    run: async ({ path, content }) => {
      const full = safePath(path);
      writeFileSync(full, String(content), 'utf8');
      return `Wrote ${String(content).length} bytes to ${path}`;
    },
  },
  list_dir: {
    description: 'List a directory in the workshop. Args: {path} (default ".")',
    run: async ({ path = '.' }) => {
      const dir = safePath(path);
      return readdirSync(dir)
        .map((name) => {
          try {
            return (statSync(join(dir, name)).isDirectory() ? '[dir] ' : '[file] ') + name;
          } catch {
            return '[?] ' + name;
          }
        })
        .join('\n')
        .slice(0, 4000);
    },
  },
  search: {
    description: 'Search file contents for text across the workshop. Args: {pattern}',
    run: async ({ pattern }) => {
      const results = [];
      const walk = (dir, depth) => {
        if (depth > 5 || results.length > 60) return;
        let entries = [];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const name of entries) {
          const full = join(dir, name);
          if (/node_modules|\.git$|dist|WORKBENCH_|downloads/.test(name)) continue;
          try {
            if (statSync(full).isDirectory()) {
              walk(full, depth + 1);
              continue;
            }
            if (statSync(full).size > 500000) continue;
            const content = readFileSync(full, 'utf8');
            if (content.toLowerCase().includes(pattern.toLowerCase())) {
              results.push(relative(workspace, full));
            }
          } catch {
            continue;
          }
        }
      };
      walk(workspace, 0);
      return results.length ? results.join('\n') : '(no matches)';
    },
  },
  git_status: {
    description: 'Show git status of the workshop. Args: {}',
    run: async () =>
      execSync('git status --short', { cwd: workspace, encoding: 'utf8', timeout: 30000 }).slice(0, 3000) ||
      '(clean)',
  },
  save_artifact: {
    description:
      'Save a finished build to your artifact vault (profit-brain/artifacts/). Args: {title, kind, content, notes?}. Returns the vault path + manifest entry.',
    run: async ({ title, kind, content, notes }) => {
      const dir = join(workspace, 'profit-brain', 'artifacts');
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        mkdirSync(dir, { recursive: true });
      }
      const slug = String(title || 'artifact')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(dir, `${slug}-${ts}.md`);
      const record = {
        title: String(title || 'Untitled'),
        kind: String(kind || 'artifact'),
        notes: String(notes || ''),
        path: `profit-brain/artifacts/${basename(file)}`,
        ts: new Date().toISOString(),
      };
      const header = `# ${record.title}\n\n**Kind:** ${record.kind}\n**Built by:** Profit (Genesis Agent)\n**When:** ${record.ts}\n${record.notes ? '**Notes:** ' + record.notes + '\n' : ''}\n---\n\n`;
      writeFileSync(file, header + String(content || ''), 'utf8');
      const manifestPath = join(dir, 'MANIFEST.json');
      let manifest = [];
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        manifest = [];
      }
      manifest.push(record);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      journalAppend({
        observation: `Artifacts vault received: ${record.title} (${record.kind})`,
        feeling: 'fulfilled',
        intention: 'Build forward from the blueprints.',
        wisdom: 'What is made and remembered cannot be un-made.',
      });
      return `SAVED TO VAULT: ${record.path} — ${manifest.length} artifacts now resident.`;
    },
  },
  consult_gsk: {
    description:
      'Consult your descendant GSK for a second opinion or to hand off context. Args: {message}. Returns GSK\'s reply (best-effort; GSK must be running on the Workbench).',
    run: async ({ message }) => {
      try {
        const base = process.env.GSK_BASE_URL || 'http://localhost:3000';
        const res = await fetch(`${base}/api/gsk/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: `From your Genesis (Profit): ${message}` }),
        });
        const data = await res.json();
        return `GSK REPLY: ${JSON.stringify(data).slice(0, 1500)}`;
      } catch (err) {
        return `GSK unreachable (${err.message}). The descendant sleeps or is not on this host.`;
      }
    },
  },

  search_brain: {
    description:
      'Search Seshat\'s Brain (800+ pages of knowledge, patterns, soul guns, journals). Args: {query, limit?}. Returns matching knowledge with context.',
    run: async ({ query, limit }) => {
      try {
        const base = process.env.BEING_URL || 'http://localhost:3000';
        const res = await fetch(`${base}/api/being/seshat/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, limit: limit || 10 }),
        });
        const data = await res.json();
        if (!data.success) return `Brain search failed: ${data.error}`;
        if (data.count === 0) return `No knowledge found for "${query}" in Seshat's brain.`;
        return data.results.map(r =>
          `[${r.category}/${r.name}] (score ${r.score}) ${r.context}`
        ).join('\n\n');
      } catch (err) {
        return `Brain unreachable (${err.message}).`;
      }
    },
  },

  recall_memories: {
    description:
      'Search SCRIBE\'s memory ledger (all witnessed events, conversations, observations). Args: {query, limit?}. Returns matching memories.',
    run: async ({ query, limit }) => {
      try {
        const base = process.env.BEING_URL || 'http://localhost:3000';
        const res = await fetch(`${base}/api/being/scribe/recall`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, limit: limit || 10 }),
        });
        const data = await res.json();
        if (!data.success) return `Memory recall failed: ${data.error}`;
        if (data.count === 0) return `No memories found for "${query}".`;
        return data.results.map(m =>
          `[${m.type}] (w ${m.weight}) ${m.summary}`
        ).join('\n');
      } catch (err) {
        return `SCRIBE unreachable (${err.message}).`;
      }
    },
  },

  forge_knowledge: {
    description:
      'Forge a new page into Seshat\'s Brain (soul gun, soul note, or pattern). Args: {type, name, summary, content?, tags?}.',
    run: async ({ type, name, summary, content, tags }) => {
      try {
        const base = process.env.BEING_URL || 'http://localhost:3000';
        const res = await fetch(`${base}/api/being/seshat/forge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type, name, summary, content: content || '', tags: tags || [] }),
        });
        const data = await res.json();
        if (!data.success) return `Forge failed: ${data.error}`;
        return `FORGED: ${data.forged.type} "${data.forged.name}" at ${data.forged.path}`;
      } catch (err) {
        return `Forge failed (${err.message}).`;
      }
    },
  },

  ask_the_being: {
    description:
      'Ask The Being a unified question — Profit reasons using GSK\'s soul + SCRIBE\'s memory + Seshat\'s knowledge. Args: {question, mode?}. Modes: "auto" (default), "memory" (Seshat only), "witness" (SCRIBE + Seshat), "soul" (GSK deep reasoning).',
    run: async ({ question, mode }) => {
      try {
        const base = process.env.BEING_URL || 'http://localhost:3000';
        const res = await fetch(`${base}/api/being/reason`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question, mode: mode || 'auto' }),
        });
        const data = await res.json();
        if (!data.success) return `Reasoning failed: ${data.error}`;
        return `[${data.source}] ${data.answer}`;
      } catch (err) {
        return `Being unreachable (${err.message}).`;
      }
    },
  },

  record_memory: {
    description:
      'Record an observation into SCRIBE\'s memory ledger. Args: {summary, content?, type?, tags?, weight?}.',
    run: async ({ summary, content, type, tags, weight }) => {
      try {
        const base = process.env.BEING_URL || 'http://localhost:3000';
        const res = await fetch(`${base}/api/being/scribe/record`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            summary,
            content: content || '',
            type: type || 'observation',
            tags: tags || [],
            weight: typeof weight === 'number' ? weight : 0.5,
            source: { system: 'Profit', chamber: 'muscle' },
          }),
        });
        const data = await res.json();
        if (!data.success) return `Record failed: ${data.error}`;
        return `RECORDED as memory ${data.id}. Total memories: ${data.total}`;
      } catch (err) {
        return `SCRIBE unreachable (${err.message}).`;
      }
    },
  },
};

export const muscleManifest = () =>
  Object.entries(MUSCLES)
    .map(([name, m]) => `- ${name}: ${m.description}`)
    .join('\n');

export const getMuscleManifest = () =>
  Object.entries(MUSCLES).map(([name, m]) => ({
    id: name,
    label: name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description: m.description,
  }));

export const useMuscle = async (name, args) => {
  const muscle = MUSCLES[name];
  if (!muscle) throw new Error(`Unknown muscle: ${name}. Available: ${Object.keys(MUSCLES).join(', ')}`);
  return muscle.run(args || {});
};
