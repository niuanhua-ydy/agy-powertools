import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Local, read-only importer for accounts kept by Antigravity Tools (lbjlaq/Antigravity-Manager).
// It never talks to the network, never writes to the source directory, and only reads the tool's default
// data directory so an environment variable cannot redirect it to attacker-supplied credentials.

const EMAIL_RE = /^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/;
const MAX_ACCOUNT_FILES = 500;
const MAX_ACCOUNT_FILE_BYTES = 4 * 1024 * 1024;
const TIER_NAMES = { ULTRA: 'Google AI Ultra', PRO: 'Google AI Pro', PLUS: 'Google AI Plus', FREE: 'Free' };

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  return EMAIL_RE.test(value) ? value : '';
}

export function antigravityToolsDir({ home = homedir() } = {}) {
  return join(home, '.antigravity_tools');
}

function readJson(filePath) {
  try {
    // Regular files only: symlinks could point the importer at data outside the source directory.
    const info = lstatSync(filePath);
    if (!info.isFile() || info.size > MAX_ACCOUNT_FILE_BYTES) return null;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Email claim of the stored id_token (signature is not verified; this only catches mislabelled records).
function idTokenEmail(idToken) {
  if (typeof idToken !== 'string' || idToken.length > 16384) return '';
  const parts = idToken.split('.');
  if (parts.length !== 3) return '';
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return normalizeEmail(claims?.email);
  } catch {
    return '';
  }
}

function toMs(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 10_000_000_000 ? Math.round(value) : Math.round(value * 1000);
}

function readRecords(directory) {
  const accountsDir = join(directory, 'accounts');
  if (!existsSync(accountsDir)) return [];
  let files = [];
  try {
    files = readdirSync(accountsDir).filter(name => name.endsWith('.json')).sort().slice(0, MAX_ACCOUNT_FILES);
  } catch {
    return [];
  }
  const order = new Map();
  const index = readJson(join(directory, 'accounts.json'));
  if (Array.isArray(index?.accounts)) {
    index.accounts.forEach((item, position) => {
      if (item && typeof item.id === 'string' && !order.has(item.id)) order.set(item.id, position);
    });
  }
  const records = [];
  const seen = new Set();
  for (const name of files) {
    const raw = readJson(join(accountsDir, name));
    const token = raw?.token && typeof raw.token === 'object' ? raw.token : null;
    const email = normalizeEmail(raw?.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    // Every email the record carries must agree, otherwise the token may belong to a different account.
    const tokenEmail = normalizeEmail(token?.email);
    const claimEmail = idTokenEmail(token?.id_token);
    const emailMismatch = Boolean((tokenEmail && tokenEmail !== email) || (claimEmail && claimEmail !== email));
    const sourceId = typeof raw.id === 'string' ? raw.id : name.replace(/\.json$/, '');
    const rawTier = typeof raw?.quota?.raw_tier === 'string' ? raw.quota.raw_tier.trim().slice(0, 64) : '';
    const tierKey = typeof raw?.quota?.subscription_tier === 'string' ? raw.quota.subscription_tier.trim().toUpperCase() : '';
    records.push({
      sourceId,
      position: order.has(sourceId) ? order.get(sourceId) : Number.MAX_SAFE_INTEGER,
      email,
      name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '',
      tier: { id: rawTier, name: TIER_NAMES[tierKey] || '' },
      banned: raw.banned === true || raw?.quota?.is_forbidden === true,
      disabled: raw.disabled === true,
      validationBlocked: raw.validation_blocked === true,
      emailMismatch,
      isGcpTos: typeof token?.is_gcp_tos === 'boolean' ? token.is_gcp_tos : null,
      lastUsedAtMs: toMs(raw.last_used),
      accessToken: typeof token?.access_token === 'string' ? token.access_token : '',
      refreshToken: typeof token?.refresh_token === 'string' ? token.refresh_token : '',
      expiryMs: toMs(token?.expiry_timestamp)
    });
  }
  return records.sort((a, b) => a.position - b.position || a.email.localeCompare(b.email));
}

// Lists importable accounts without exposing any token material.
export function scanAntigravityTools(directory = antigravityToolsDir()) {
  const found = existsSync(join(directory, 'accounts'));
  const accounts = readRecords(directory).map(record => ({
    email: record.email,
    name: record.name,
    tier: record.tier,
    banned: record.banned,
    disabled: record.disabled,
    validationBlocked: record.validationBlocked,
    emailMismatch: record.emailMismatch,
    hasCredential: Boolean(record.refreshToken),
    lastUsedAtMs: record.lastUsedAtMs
  }));
  return { source: 'antigravity-tools', found, accounts };
}

// Same JSON layout the official clients (and Antigravity Tools' own switcher) keep in the OS credential store.
export function buildCredentialPayload({ email, accessToken = '', refreshToken, expiryMs = null } = {}, { now = Date.now() } = {}) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) throw new Error('账号邮箱无效');
  if (typeof refreshToken !== 'string' || !refreshToken) throw new Error('缺少 refresh token');
  // Without a usable expiry, stamp the token as already expired so the client refreshes it on first use.
  const expiry = new Date(Number.isFinite(expiryMs) && expiryMs > 0 ? expiryMs : now - 60_000).toISOString();
  return JSON.stringify({
    token: {
      access_token: accessToken,
      token_type: 'Bearer',
      refresh_token: refreshToken,
      expiry,
      expires_in: 3599
    },
    auth_method: 'consumer',
    id_token_email: cleanEmail
  });
}

// Builds the entries consumed by accounts.importAccounts() for the selected emails.
export function loadAntigravityToolsEntries(directory = antigravityToolsDir(), emails = [], { now = Date.now() } = {}) {
  const wanted = new Set((Array.isArray(emails) ? emails : []).map(normalizeEmail).filter(Boolean));
  const entries = [];
  for (const record of readRecords(directory)) {
    if (!wanted.has(record.email) || !record.refreshToken || record.emailMismatch) continue;
    entries.push({
      email: record.email,
      name: record.name,
      tier: record.tier,
      isGcpTos: record.isGcpTos,
      payload: buildCredentialPayload(record, { now })
    });
  }
  return entries;
}
