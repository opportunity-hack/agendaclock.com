// MCP server + token management for AgendaClock.
//
// What this is:
//   POST /mcp          - Streamable HTTP MCP endpoint (official SDK,
//                        stateless: one McpServer per request, no sessions).
//                        Auth is a Bearer MCP token (see lib/mcpTokens.js),
//                        issued to a signed-in user on /mcp/tokens.
//   GET  /mcp/tokens   - signed-in page: list your tokens, create one
//                        (7 or 30 days), revoke one. The secret is shown
//                        once at creation and never stored.
//   POST /mcp/tokens   - create a token (name + 7/30-day lifetime).
//   POST /mcp/tokens/:id/revoke - revoke one of your tokens.
//
// Tools (all scoped to the token owner's own meetings):
//   list_timelines  - the caller's meetings
//   get_timeline    - one of the caller's meetings
//   create_timeline - new meeting owned by the caller
//   update_timeline - edit one of the caller's meetings (partial: omitted
//                     fields keep their stored values)
// There is deliberately NO delete tool. Deleting is not part of the web app
// either, and MCP must not gain a capability the product does not have.
//
// Ownership: a meeting counts as yours when your private key
// meeting_<email>_<id> exists, or when the public copy's owner_email is you.
// Anything else (including another user's public meeting) looks like
// "not found" - callers cannot probe whether an id exists for someone else.
//
// Nothing here is indexed or linked from SEO pages: the tokens page is an
// authenticated account page (X-Robots-Tag: noindex, robots.txt disallows
// /mcp/), and /mcp is an API endpoint, not content.

const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { client, ensureRedisConnection } = require('../lib/redis');
const {
  loadOwnedMeeting,
  saveMeeting,
  listOwnedMeetingRecords,
  toMeetingSummary,
  toolInputToFormBody,
  validateMeetingPayload,
  get_short_hash
} = require('../lib/meetings');
const { createToken, verifyToken, listTokens, revokeToken, ALLOWED_TTL_DAYS } = require('../lib/mcpTokens');
const { requireAuth, getUserEmail } = require('../config/auth');

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://agendaclock.com').replace(/\/$/, '');

// MCP + token pages must never appear in search results.
router.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

function meetingUrl(meetingId) {
  return `${PUBLIC_BASE_URL}/meeting/${meetingId}`;
}

function okResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errResult(message, details) {
  const text = details ? `${message}: ${JSON.stringify(details)}` : message;
  return { content: [{ type: 'text', text }], isError: true };
}

// --- MCP tools -------------------------------------------------------------

const TOPIC_SHAPE = z.object({
  person: z.string().max(200).optional(),
  topic: z.string().min(1).max(500),
  duration_minutes: z.number().int().min(1).max(480)
});

function registerTools(server, ownerEmail) {
  server.tool(
    'list_timelines',
    'List the meeting timelines you own (newest first is not guaranteed; each entry has meeting_id, title, start_time, timezone, topics and total_minutes).',
    {},
    async () => {
      await ensureRedisConnection();
      const records = await listOwnedMeetingRecords(client, ownerEmail);
      return okResult({ timelines: records.map(toMeetingSummary) });
    }
  );

  server.tool(
    'get_timeline',
    'Get one meeting timeline you own, by meeting id. Returns the full agenda (topics with person, topic and duration_minutes).',
    { meeting_id: z.string().min(1).max(32) },
    async ({ meeting_id }) => {
      await ensureRedisConnection();
      const record = await loadOwnedMeeting(client, ownerEmail, meeting_id);
      if (!record) return errResult(`No meeting with id ${meeting_id} belongs to you`);
      return okResult({ timeline: toMeetingSummary(record), url: meetingUrl(meeting_id) });
    }
  );

  server.tool(
    'create_timeline',
    'Create a new meeting timeline owned by you. start_time looks like "1:30 PM" or "13:30"; timezone is an IANA name like America/Phoenix. Returns the new meeting id and its URL. You cannot delete timelines through MCP.',
    {
      title: z.string().min(1).max(200),
      start_time: z.string().min(1),
      timezone: z.string().min(1),
      topics: z.array(TOPIC_SHAPE).min(1).max(50),
      is_public: z.boolean().optional(),
      background: z.string().optional(),
      default_view: z.enum(['overlay', 'liftoff', 'rail', 'table', 'focus', 'ring']).optional()
    },
    async (args) => {
      await ensureRedisConnection();
      const meetingId = get_short_hash();
      const body = toolInputToFormBody(null, args);
      const { ok, errors, meetingData } = validateMeetingPayload(body);
      if (!ok) return errResult('Invalid meeting data', errors);
      meetingData.meeting_id = meetingId;
      meetingData.owner_email = ownerEmail;
      meetingData.is_public = args.is_public === true;
      await saveMeeting(client, meetingData);
      return okResult({
        timeline: toMeetingSummary(meetingData),
        url: meetingUrl(meetingId)
      });
    }
  );

  server.tool(
    'update_timeline',
    'Edit a meeting timeline you own. Only the fields you send change; everything else keeps its stored value. To change the agenda, send the full new topics list. You cannot delete timelines through MCP.',
    {
      meeting_id: z.string().min(1).max(32),
      title: z.string().min(1).max(200).optional(),
      start_time: z.string().min(1).optional(),
      timezone: z.string().min(1).optional(),
      topics: z.array(TOPIC_SHAPE).min(1).max(50).optional(),
      is_public: z.boolean().optional(),
      background: z.string().optional(),
      default_view: z.enum(['overlay', 'liftoff', 'rail', 'table', 'focus', 'ring']).optional()
    },
    async (args) => {
      await ensureRedisConnection();
      const { meeting_id, ...changes } = args;
      if (Object.keys(changes).length === 0) {
        return errResult('Nothing to update: send at least one field besides meeting_id');
      }
      const existing = await loadOwnedMeeting(client, ownerEmail, meeting_id);
      if (!existing) return errResult(`No meeting with id ${meeting_id} belongs to you`);
      const body = toolInputToFormBody(existing, changes);
      const { ok, errors, meetingData } = validateMeetingPayload(body);
      if (!ok) return errResult('Invalid meeting data', errors);
      meetingData.meeting_id = meeting_id;
      meetingData.owner_email = ownerEmail;
      meetingData.is_public = changes.is_public !== undefined
        ? changes.is_public === true
        : (existing.is_public === true || existing.is_public === 'on');
      await saveMeeting(client, meetingData);
      return okResult({
        timeline: toMeetingSummary(meetingData),
        url: meetingUrl(meeting_id)
      });
    }
  );
}

// --- MCP endpoint (Streamable HTTP, stateless) -----------------------------

router.post('/', async (req, res) => {
  let tokenRecord = null;
  try {
    await ensureRedisConnection();
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    tokenRecord = match ? await verifyToken(client, match[1].trim()) : null;
  } catch (err) {
    console.error('MCP auth error:', err.message);
    return res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
      id: (req.body && req.body.id) || null
    });
  }
  if (!tokenRecord) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Missing or invalid MCP token. Create one at /mcp/tokens while signed in.' },
      id: (req.body && req.body.id) || null
    });
  }

  try {
    const server = new McpServer(
      { name: 'agendaclock', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    registerTools(server, tokenRecord.email);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: (req.body && req.body.id) || null
      });
    }
  }
});

// GET on the endpoint is not part of the stateless transport: tell clients
// plainly instead of letting them hang on an SSE stream that never comes.
router.get('/', (req, res) => {
  res.status(405).json({
    error: 'Method not allowed. This is the AgendaClock MCP endpoint: POST a JSON-RPC request with a Bearer MCP token. Create a token at /mcp/tokens while signed in.'
  });
});

// --- Token management pages (Google session auth) --------------------------

router.get('/tokens', requireAuth, async (req, res) => {
  try {
    await ensureRedisConnection();
    const tokens = await listTokens(client, getUserEmail(req));
    res.render('mcp_tokens', {
      user: req.user,
      tokens,
      newToken: null,
      error: null,
      endpoint: `${PUBLIC_BASE_URL}/mcp`,
      allowedTtlDays: ALLOWED_TTL_DAYS
    });
  } catch (err) {
    console.error('MCP tokens page error:', err);
    res.status(500).send('Internal Server Error');
  }
});

router.post('/tokens', requireAuth, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const ttlDays = parseInt(req.body.ttl_days, 10);
  try {
    await ensureRedisConnection();
    const tokens = await listTokens(client, getUserEmail(req));
    if (!ALLOWED_TTL_DAYS.includes(ttlDays)) {
      return res.render('mcp_tokens', {
        user: req.user, tokens, newToken: null,
        error: 'Choose a lifetime of 7 or 30 days.',
        endpoint: `${PUBLIC_BASE_URL}/mcp`,
        allowedTtlDays: ALLOWED_TTL_DAYS
      });
    }
    const created = await createToken(client, getUserEmail(req), name, ttlDays);
    const fresh = await listTokens(client, getUserEmail(req));
    res.render('mcp_tokens', {
      user: req.user, tokens: fresh, newToken: created, error: null,
      endpoint: `${PUBLIC_BASE_URL}/mcp`,
      allowedTtlDays: ALLOWED_TTL_DAYS
    });
  } catch (err) {
    console.error('MCP token create error:', err.message);
    try {
      const tokens = await listTokens(client, getUserEmail(req));
      res.render('mcp_tokens', {
        user: req.user, tokens, newToken: null,
        error: err.message || 'Could not create the token.',
        endpoint: `${PUBLIC_BASE_URL}/mcp`,
        allowedTtlDays: ALLOWED_TTL_DAYS
      });
    } catch {
      res.status(500).send('Internal Server Error');
    }
  }
});

router.post('/tokens/:id/revoke', requireAuth, async (req, res) => {
  try {
    await ensureRedisConnection();
    await revokeToken(client, getUserEmail(req), req.params.id);
  } catch (err) {
    console.error('MCP token revoke error:', err.message);
  }
  res.redirect('/mcp/tokens');
});

module.exports = router;
