'use strict';
/**
 * token-store.js — ONE canonical Medium token source for Allie.
 *
 * Replaces medium-token.js .. medium-token5.js (5 Playwright retry forks).
 * Priority: env MEDIUM_TOKEN > canonical .allie-memory/medium-creds.json
 *           > legacy .allie-brain-v2/medium-creds.json (read-only fallback).
 *
 * Never logs the token. Never hardcodes secrets. Scraper writes via
 * saveMediumToken() only to the canonical path.
 */
const fs = require('fs');
const path = require('path');

function allieRoot() {
  return process.env.ALLIE_ROOT || 'C:\\Users\\uncom\\Desktop\\allie';
}

function canonicalPath(root) {
  return path.join(root || allieRoot(), '.allie-memory', 'medium-creds.json');
}

function legacyPath(root) {
  return path.join(root || allieRoot(), '.allie-brain-v2', 'medium-creds.json');
}

function readJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** One getter. Returns { token, userId, source } or null. */
function getMediumToken(root) {
  if (process.env.MEDIUM_TOKEN) {
    return { token: process.env.MEDIUM_TOKEN, userId: '', source: 'env:MEDIUM_TOKEN' };
  }
  const canon = readJsonIfExists(canonicalPath(root));
  if (canon && canon.token) return { token: canon.token, userId: canon.userId || '', source: 'canonical:.allie-memory/medium-creds.json' };
  const leg = readJsonIfExists(legacyPath(root));
  if (leg && leg.token) {
    console.warn('[token-store] using LEGACY .allie-brain-v2 creds — run scripts/migrate-memory.js to converge.');
    return { token: leg.token, userId: leg.userId || '', source: 'legacy:.allie-brain-v2/medium-creds.json' };
  }
  return null;
}

/** One writer. Always canonical. Never prints the token. */
function saveMediumToken(token, userId, root) {
  if (!token || typeof token !== 'string' || token.length < 10) {
    throw new Error('refusing to save empty/short token');
  }
  const dest = canonicalPath(root);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify({ token, userId: userId || '', updatedAt: new Date().toISOString() }, null, 2));
  return dest;
}

module.exports = { getMediumToken, saveMediumToken, canonicalPath, legacyPath, allieRoot };
