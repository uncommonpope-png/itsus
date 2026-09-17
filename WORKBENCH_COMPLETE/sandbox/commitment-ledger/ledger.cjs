'use strict';
/**
 * ledger.js — commitment ledger. Aliveness as a rising curve.
 *
 * Every irreversible act (file written, goal completed, template diverged)
 * appended with SHA256 chain: hash(prevHash + ts + act). Verify rewalks.
 * P5.3. Zero deps. CommonJS on purpose (.cjs lives beside it if needed).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_FILE = path.join(__dirname, 'commitments.jsonl');

function sha(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function readAll(ledgerFile = LEDGER_FILE) {
  try {
    if (!fs.existsSync(ledgerFile)) return [];
    return fs.readFileSync(ledgerFile, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

function append(act, meta = {}, ledgerFile = LEDGER_FILE) {
  const prev = readAll(ledgerFile);
  const lastHash = prev.length > 0 ? prev[prev.length - 1].hash : 'GENESIS';
  const entry = {
    i: prev.length,
    ts: new Date().toISOString(),
    act: String(act).slice(0, 1000),
    meta,
    prevHash: lastHash,
  };
  entry.hash = sha(entry.prevHash + '|' + entry.ts + '|' + entry.act);
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.appendFileSync(ledgerFile, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function verify(ledgerFile = LEDGER_FILE) {
  const entries = readAll(ledgerFile);
  let prevHash = 'GENESIS';
  for (const e of entries) {
    if (e.prevHash !== prevHash) {
      return { ok: false, breakAt: e.i, reason: 'chain break' };
    }
    const recomputed = sha(e.prevHash + '|' + e.ts + '|' + e.act);
    if (recomputed !== e.hash) {
      return { ok: false, breakAt: e.i, reason: 'hash mismatch (tamper)' };
    }
    prevHash = e.hash;
  }
  return { ok: true, entries: entries.length };
}

function curve(ledgerFile = LEDGER_FILE) {
  const entries = readAll(ledgerFile);
  return { commitments: entries.length, first: entries[0] ? entries[0].ts : null, last: entries.length ? entries[entries.length - 1].ts : null, unbroken: verify(ledgerFile).ok };
}

if (require.main === module) {
  const cmd = process.argv[2] || 'verify';
  if (cmd === 'append') {
    const act = process.argv.slice(3).join(' ') || 'unnamed act';
    const e = append(act);
    console.log(`committed #${e.i} ${e.hash.slice(0, 12)} :: ${e.act.slice(0, 120)}`);
  } else if (cmd === 'verify') {
    const r = verify();
    console.log(r.ok ? `CHAIN OK :: ${r.entries} commitments` : `BROKEN at #${r.breakAt}: ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'curve') {
    console.log(JSON.stringify(curve(), null, 2));
  } else {
    console.error('usage: ledger.js [append <act> | verify | curve]');
    process.exit(1);
  }
}

module.exports = { append, verify, curve, readAll, LEDGER_FILE };
