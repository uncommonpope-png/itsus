/**
 * token-store.js
 * Canonical Medium token getter/writer for Allie-better.
 *
 * Resolution order (strict):
 *   1. env MEDIUM_TOKEN          — highest priority (process environment)
 *   2. ~/.allie-memory           — canonical on-disk store (ALLIE_MEMORY_DIR override supported)
 *   3. ~/.allie-brain-v2         — LEGACY fallback; logs a warning when used
 *
 * Hard rules (secret-scan enforced):
 *   - NEVER log the token value. Logs only presence/absence and source.
 *   - Never write tokens into .env files (banned).
 *   - Canonical store written with 0600 permissions (best-effort; no-op on Windows).
 *   - Empty or whitespace tokens are refused on write and skipped on read.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const ALLIE_MEMORY_DIR = process.env.ALLIE_MEMORY_DIR || HOME;
const CANONICAL_PATH = path.join(ALLIE_MEMORY_DIR, '.allie-memory');
const LEGACY_PATH = path.join(HOME, '.allie-brain-v2');

/** Normalize a raw token value. */
function formatToken(raw) {
  return String(raw == null ? '' : raw).trim();
}

/** Read canonical store; returns '' on missing/unreadable. */
function readCanonical() {
  try {
    return formatToken(fs.readFileSync(CANONICAL_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[token-store] could not read canonical store: ${err.code}`);
    }
    return '';
  }
}

/** Read legacy store; returns '' on missing/unreadable. */
function readLegacy() {
  try {
    return formatToken(fs.readFileSync(LEGACY_PATH, 'utf8'));
  } catch (err) {
    return '';
  }
}

/**
 * getToken() — returns the Medium token string, or null if none found.
 * NEVER logs the token value.
 */
function getToken() {
  // 1. environment first
  if (process.env.MEDIUM_TOKEN && process.env.MEDIUM_TOKEN.trim()) {
    console.log('[token-store] token source: environment (MEDIUM_TOKEN)');
    return process.env.MEDIUM_TOKEN.trim();
  }

  // 2. canonical on-disk store
  const canonical = readCanonical();
  if (canonical) {
    console.log('[token-store] token source: canonical .allie-memory');
    return canonical;
  }

  // 3. legacy fallback with warning
  const legacy = readLegacy();
  if (legacy) {
    console.warn('[token-store] WARNING: using legacy .allie-brain-v2 token store. Migrate to .allie-memory.');
    console.log('[token-store] token source: legacy .allie-brain-v2 (fallback)');
    return legacy;
  }

  console.warn('[token-store] no Medium token found (MEDIUM_TOKEN, .allie-memory, .allie-brain-v2 all empty/missing)');
  return null;
}

/**
 * setToken(token) — writes the token to the canonical store.
 * Returns true on success, false otherwise. NEVER logs the token value.
 */
function setToken(token) {
  const clean = formatToken(token);
  if (!clean) {
    console.warn('[token-store] refusing to write empty token');
    return false;
  }

  try {
    fs.mkdirSync(ALLIE_MEMORY_DIR, { recursive: true });
    fs.writeFileSync(CANONICAL_PATH, clean + '\n', { encoding: 'utf8', mode: 0o600 });
    // best-effort permission tightening (no-op on Windows)
    try { fs.chmodSync(CANONICAL_PATH, 0o600); } catch (_) { /* ignore */ }
    console.log(`[token-store] token written to canonical store (${CANONICAL_PATH})`);
    return true;
  } catch (err) {
    console.error(`[token-store] failed to write canonical store: ${err.code || err.message}`);
    return false;
  }
}

/** hasToken() — presence check without revealing the value. */
function hasToken() {
  return getToken() !== null;
}

module.exports = { getToken, setToken, hasToken, CANONICAL_PATH, LEGACY_PATH };