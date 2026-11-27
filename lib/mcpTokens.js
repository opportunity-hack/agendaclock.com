// MCP access tokens.
//
// A signed-in user (Google OAuth, see config/auth.js) creates a token on
// /mcp/tokens and pastes it into their MCP client as a Bearer token. The
// token is bound to that user's email, lives 7 or 30 days (chosen at
// creation), and is the only credential an MCP client ever needs - no Google
// session is involved at call time.
//
// Storage (Redis):
//   mcp_token:<sha256(secret)>  HASH { email, name, createdAt, expiresAt, lastUsedAt }
//                               with a native TTL, so expiry is enforced by
//                               Redis itself (a missing key = expired).
//   mcp_tokens:<email>          SET of sha256 hex digests, so a user can
//                               list and revoke their own tokens.
// Only the SHA-256 digest is stored. The secret itself is shown once at
// creation and never stored, logged, or shown again.

const crypto = require('crypto');

const DAY_SECONDS = 24 * 60 * 60;
const ALLOWED_TTL_DAYS = [7, 30];
const TOKEN_PREFIX = 'acmcp_';

function tokenKey(digest) {
  return `mcp_token:${digest}`;
}

function userTokensKey(email) {
  return `mcp_tokens:${email}`;
}

function sha256(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

// Create a token for the user. Returns the record plus the secret, which is
// only available in this return value - callers must show it once and drop it.
async function createToken(client, email, name, ttlDays) {
  if (!ALLOWED_TTL_DAYS.includes(ttlDays)) {
    throw new Error('Token lifetime must be 7 or 30 days');
  }
  const cleanName = String(name || '').trim().slice(0, 80);
  if (!cleanName) {
    throw new Error('Token name is required');
  }
  const secret = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const digest = sha256(secret);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * DAY_SECONDS * 1000);
  const record = {
    email,
    name: cleanName,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    lastUsedAt: ''
  };
  // One transaction: a token hash must never exist without its TTL.
  await client.multi()
    .hSet(tokenKey(digest), record)
    .expire(tokenKey(digest), ttlDays * DAY_SECONDS)
    .sAdd(userTokensKey(email), digest)
    .exec();
  return {
    id: digest.slice(0, 12),
    secret,
    name: record.name,
    email,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ttlDays
  };
}

// Verify a presented secret. Returns the token record (email, name, id,
// expiresAt) or null when unknown/expired. Updates lastUsedAt; the HSET does
// not touch the key's TTL, so use never extends the lifetime.
async function verifyToken(client, secret) {
  if (typeof secret !== 'string' || !secret.startsWith(TOKEN_PREFIX)) return null;
  const digest = sha256(secret);
  const record = await client.hGetAll(tokenKey(digest));
  if (!record || !record.email) return null;
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return null;
  // A failed last-used write must not fail auth, but the call is cheap and
  // awaited so tests see a stable value. If the key expired between the read
  // and this write, HSET would recreate it with no TTL: drop that orphan.
  try {
    await client.hSet(tokenKey(digest), 'lastUsedAt', new Date().toISOString());
    if ((await client.ttl(tokenKey(digest))) === -1) {
      await client.del(tokenKey(digest));
      return null;
    }
  } catch {
    // last-used tracking is best-effort; auth already succeeded
  }
  return {
    id: digest.slice(0, 12),
    email: record.email,
    name: record.name || '',
    createdAt: record.createdAt || '',
    expiresAt: record.expiresAt || ''
  };
}

// All tokens a user owns, newest first. Stale set members (hash already
// expired away) are skipped and pruned so the set does not grow forever.
async function listTokens(client, email) {
  const digests = await client.sMembers(userTokensKey(email));
  if (digests.length === 0) return [];
  const tokens = [];
  for (const digest of digests) {
    const record = await client.hGetAll(tokenKey(digest));
    if (!record || !record.email) {
      await client.sRem(userTokensKey(email), digest);
      continue;
    }
    tokens.push({
      id: digest.slice(0, 12),
      name: record.name || '',
      createdAt: record.createdAt || '',
      expiresAt: record.expiresAt || '',
      lastUsedAt: record.lastUsedAt || ''
    });
  }
  tokens.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return tokens;
}

// Revoke one of the user's tokens by its 12-char display id. Returns true
// when a token was removed, false when no token matched.
async function revokeToken(client, email, idPrefix) {
  const digests = await client.sMembers(userTokensKey(email));
  const match = digests.filter(d => d.startsWith(idPrefix));
  if (match.length !== 1) return false;
  await client.del(tokenKey(match[0]));
  await client.sRem(userTokensKey(email), match[0]);
  return true;
}

module.exports = {
  ALLOWED_TTL_DAYS,
  TOKEN_PREFIX,
  createToken,
  verifyToken,
  listTokens,
  revokeToken
};
