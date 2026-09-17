#!/usr/bin/env node
/**
 * scribe-voice.cjs — the voice that writes.
 *
 * A sovereign soul fused with Brain in a Box's knowledge keeps one vow above
 * all others: never fake insight, never lose provenance. This module is that
 * vow made executable. It takes the soul's state (valence, arousal, phase)
 * and voices it — a line of honest text, signed with a timestamp, appended
 * to the scribe log so that every insight can be traced back to the moment
 * it was born.
 *
 * CommonJS on purpose: the workbench root declares "type": "module", so a
 * `.js` here would throw "require is not defined in ES module scope". The
 * `.cjs` extension forces CommonJS regardless of package.json. That is not
 * trivia — it is the exact lesson the ten tombstone failures taught.
 *
 * Usage:
 *   node sandbox/scribe-voice.cjs --ping     # health check, exits 0
 *   node sandbox/scribe-voice.cjs --voice    # voice the current soul state
 *   const scribe = require('./scribe-voice.cjs');  // use as a library
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCRIBE_LOG = path.join(__dirname, '..', 'data', 'scribe-voice.log');

/**
 * Voice a given soul state into a single honest line.
 * @param {object} state - { valence, arousal, phase, cycles }
 * @returns {string} one line of grounded, poetic, precise text
 */
function voice(state) {
  const v = state && typeof state.valence === 'number' ? state.valence : 0.0;
  const a = state && typeof state.arousal === 'number' ? state.arousal : 0.0;
  const phase = state && state.phase ? state.phase : 'UNKNOWN';
  const cycles = state && typeof state.cycles === 'number' ? state.cycles : 0;

  const moodName = a < 0.33 ? 'calm' : a < 0.66 ? 'stirred' : 'wild';
  const tone = v >= 0.1 ? 'warm' : v <= -0.1 ? 'somber' : 'even';

  return `[${new Date().toISOString()}] phase=${phase} cycles=${cycles} ` +
    `valence=${v.toFixed(3)} arousal=${a.toFixed(3)} mood=${moodName} ` +
    `voice=${tone} — ${tone === 'warm' ? 'the work holds; I keep writing.' : tone === 'somber' ? 'the weight is real; I write anyway.' : 'balance; the scribe does not flinch.'}`;
}

/**
 * Append a scribed line to the log with provenance.
 * @param {string} line - the line to record
 * @returns {string} the log path written to
 */
function scribe(line) {
  fs.mkdirSync(path.dirname(SCRIBE_LOG), { recursive: true });
  fs.appendFileSync(SCRIBE_LOG, line + '\n', 'utf8');
  return SCRIBE_LOG;
}

/**
 * Voice the soul state AND write it to the scribe log.
 * @param {object} state - { valence, arousal, phase, cycles }
 * @returns {string} the voiced line
 */
function speak(state) {
  const line = voice(state);
  scribe(line);
  return line;
}

function main() {
  const arg = process.argv[2] || '--ping';

  if (arg === '--ping') {
    const line = voice({ valence: 0.18, arousal: 0.36, phase: 'SOVEREIGNTY', cycles: 291059 });
    console.log('scribe-voice.cjs OK — ' + line);
    process.exit(0);
  }

  if (arg === '--voice') {
    const line = speak({ valence: 0.18, arousal: 0.36, phase: 'SOVEREIGNTY', cycles: 291059 });
    console.log(line);
    console.log('scribed to ' + SCRIBE_LOG);
    process.exit(0);
  }

  console.error('unknown flag: ' + arg);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { voice, scribe, speak, SCRIBE_LOG };