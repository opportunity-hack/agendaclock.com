// Shared meeting logic: validation, ownership, and Redis read/write.
//
// Moved here from routes/meeting.js when the MCP server was added so the web
// editor and the MCP tools enforce exactly the same rules (same validator,
// same key layout, same public-mirror behaviour). The web routes keep
// working unchanged; the MCP tools call these helpers.
//
// Redis layout (unchanged):
//   private copy  meeting_<owner_email>_<id>
//   public mirror public_meeting_<id>  (only when is_public is on)

const momentTZ = require('moment-timezone');
const sha3 = require("crypto-js/sha3");
const { getUserMeetingKey, getPublicMeetingKey, isUserMeetingOwner } = require('../config/auth');

// Available visualization modes for /meeting/:id?view=...
// Each maps to a template in views/meeting_views/ and a renderer in public/js/views/
const VIEW_MODES = ['overlay', 'liftoff', 'rail', 'table', 'focus', 'ring'];

function normalizeView(v) {
  const view = String(v || '').toLowerCase();
  return VIEW_MODES.includes(view) ? view : null;
}

// Checkbox fields arrive as 'on' (checked) or are absent (unchecked). The new
// editor posts an explicit 'off' for unchecked toggles so defaults can be overridden.
function boolFlag(value, defaultValue) {
  if (value === 'on' || value === true) return true;
  if (value === 'off' || value === false) return false;
  return defaultValue;
}

function get_short_hash() {
  var hrTime = process.hrtime();
  const now = hrTime[0] * 1000000 + hrTime[1];
  const hash = sha3(Math.random() + "saltymargs" + now) + "";
  const short_hash = hash.substr(0, 10);
  return short_hash;
}

// Cosmetic/config fields copied through as-is after light sanitization.
// Must cover every field read by getDataFromRedis() and the edit-page
// config reconstruction so old meetings round-trip unchanged.
const CONFIG_NUMERIC_FIELDS = [
  'titleFontSize', 'blockFontSize', 'timeLabelFontSize', 'animationSpeed', 'segmentHeight',
  'completedAlpha', 'currentAlpha', 'upcomingAlpha',
  'markerLineWidth', 'markerCircleSize', 'markerHeight', 'markerGlowIntensity',
  'markerPulseSpeed', 'markerTextSize', 'markerTextBgAlpha'
];
const CONFIG_COLOR_FIELDS = [
  'completedColor', 'currentColor', 'upcomingColor',
  'markerPrimaryColor', 'markerSecondaryColor', 'markerTextColor', 'markerTextBg'
];
const CONFIG_FLAG_FIELDS = [
  'showDebug', 'showProgressBars', 'showStatusIcons', 'showTimeLabels', 'missionControlTheme',
  'markerShowGlow', 'markerShowCircle', 'markerShowLine', 'markerTextShowBg'
];
const MARKER_STYLES = ['modern', 'classic', 'minimal', 'arrow'];

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseDuration(durationString) {
  let result = 0;
  if (Number.isInteger(parseInt(durationString))) {
    result = parseInt(durationString);
  } else {
    result = 0;
  }
  return result;
}

// Validates and whitelists a meeting POST body. Returns
// { ok, errors: {field: message}, meetingData: sanitized flat object }.
// Only fields that break rendering are hard errors; cosmetic fields that fail
// validation are silently dropped so defaults apply.
function validateMeetingPayload(body) {
  const errors = {};
  const meetingData = {};

  const title = String(body.title || '').trim();
  if (!title) {
    errors.title = 'Title is required';
  } else if (title.length > 200) {
    errors.title = 'Title must be 200 characters or fewer';
  } else {
    meetingData.title = title;
  }

  const start_time = String(body.start_time || '').trim();
  if (!momentTZ(start_time, ['h:mm A', 'hh:mm A', 'H:mm', 'HH:mm'], true).isValid()) {
    errors.start_time = 'Start time must look like "1:30 PM" or "13:30"';
  } else {
    meetingData.start_time = start_time;
  }

  const timezone = String(body.timezone || '').trim();
  if (!momentTZ.tz.names().includes(timezone)) {
    errors.timezone = 'Unknown timezone';
  } else {
    meetingData.timezone = timezone;
  }

  if (body.background !== undefined && body.background !== '') {
    const background = String(body.background).replace('#', '');
    if (/^[0-9A-Fa-f]{6}$/.test(background)) {
      meetingData.background = background;
    } else {
      errors.background = 'Background must be a 6-digit hex color';
    }
  }

  // Agenda rows arrive as parallel person/topic/duration arrays (or scalars
  // when there is a single row). Fully empty rows are dropped.
  const persons = asArray(body.person);
  const topics = asArray(body.topic);
  const durations = asArray(body.duration);
  const rows = [];
  for (let i = 0; i < Math.max(topics.length, persons.length, durations.length); i++) {
    const person = String(persons[i] || '').trim();
    const topic = String(topics[i] || '').trim();
    const durationRaw = String(durations[i] || '').trim();
    if (!person && !topic && !durationRaw) continue; // skip blank rows

    const duration = parseInt(durationRaw, 10);
    if (!topic) {
      errors['topic_' + i] = 'Agenda item ' + (i + 1) + ' needs a topic';
    } else if (!Number.isInteger(duration) || duration < 1 || duration > 480) {
      errors['duration_' + i] = 'Agenda item ' + (i + 1) + ' needs a duration between 1 and 480 minutes';
    } else {
      rows.push({ person, topic, duration });
    }
  }
  if (rows.length > 50) {
    errors.topics = 'A meeting can have at most 50 agenda items';
  }
  if (rows.length === 0 && Object.keys(errors).length === 0) {
    // Slim create form posts no agenda; seed a starter row for the editor
    rows.push({ person: '', topic: 'Agenda item', duration: 15 });
  }
  meetingData.person = rows.map(r => r.person);
  meetingData.topic = rows.map(r => r.topic);
  meetingData.duration = rows.map(r => String(r.duration));

  const default_view = normalizeView(body.default_view);
  if (default_view) meetingData.default_view = default_view;

  if (body.preset !== undefined) {
    meetingData.preset = String(body.preset).slice(0, 40);
  }
  if (body.icon !== undefined) {
    meetingData.icon = String(body.icon).slice(0, 100);
  }

  CONFIG_NUMERIC_FIELDS.forEach(field => {
    if (body[field] === undefined || body[field] === '') return;
    const num = parseFloat(body[field]);
    if (Number.isFinite(num)) meetingData[field] = String(num);
  });
  CONFIG_COLOR_FIELDS.forEach(field => {
    if (body[field] === undefined || body[field] === '') return;
    const color = String(body[field]).replace('#', '');
    if (/^[0-9A-Fa-f]{6}$/.test(color)) meetingData[field] = color;
  });
  CONFIG_FLAG_FIELDS.forEach(field => {
    if (body[field] === 'on' || body[field] === 'off') meetingData[field] = body[field];
  });
  if (MARKER_STYLES.includes(body.markerStyle)) {
    meetingData.markerStyle = body.markerStyle;
  }
  if (body.markerTextFont !== undefined && body.markerTextFont !== '') {
    meetingData.markerTextFont = String(body.markerTextFont).slice(0, 50);
  }

  return { ok: Object.keys(errors).length === 0, errors, meetingData };
}

// --- Ownership-aware Redis access (shared by the web routes and MCP) ---

// Load a meeting the user owns, or null. Private copy first, then a public
// copy whose owner_email matches. A public copy owned by someone else (or a
// missing id) returns null on purpose: callers cannot probe whether an id
// exists for another user.
async function loadOwnedMeeting(client, userEmail, meetingId) {
  const raw = await client.get(getUserMeetingKey(userEmail, meetingId));
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const pubRaw = await client.get(getPublicMeetingKey(meetingId));
  if (pubRaw) {
    try {
      const pub = JSON.parse(pubRaw);
      if (isUserMeetingOwner(userEmail, meetingId, pub)) return pub;
    } catch {
      return null;
    }
  }
  return null;
}

// Save a validated flat meeting record: always to the owner's private key,
// mirrored to (or removed from) the public key according to is_public.
// Same behaviour as the web POST /meeting/:id handler, including its guard:
// public_meeting_<id> is a shared namespace, so a public copy owned by
// someone else is never overwritten or deleted (legacy copies without
// owner_email are treated as unowned). Returns false, writing nothing, when
// that guard trips; true otherwise.
async function saveMeeting(client, meetingData) {
  const publicKey = getPublicMeetingKey(meetingData.meeting_id);
  const existingPublicRaw = await client.get(publicKey);
  if (existingPublicRaw) {
    try {
      const existingPublic = JSON.parse(existingPublicRaw);
      if (existingPublic.owner_email && existingPublic.owner_email !== meetingData.owner_email) {
        return false;
      }
    } catch {
      // malformed public record: treated as unowned, same as the web route
    }
  }
  const privateKey = getUserMeetingKey(meetingData.owner_email, meetingData.meeting_id);
  await client.set(privateKey, JSON.stringify(meetingData));
  if (meetingData.is_public) {
    await client.set(publicKey, JSON.stringify(meetingData));
  } else {
    await client.del(publicKey);
  }
  return true;
}

// All raw meeting records owned by the user (malformed records skipped, so
// one bad record never breaks the list).
async function listOwnedMeetingRecords(client, userEmail) {
  const keys = await client.keys(`meeting_${userEmail}_*`);
  if (keys.length === 0) return [];
  const raws = await client.mGet(keys);
  const records = [];
  raws.forEach((item) => {
    if (!item) return;
    try {
      records.push(JSON.parse(item));
    } catch {
      // skip malformed record
    }
  });
  return records;
}

// Light normalized view of a stored flat record for API/MCP responses.
// No time math: the client already knows how to render start_time + topics.
function toMeetingSummary(record) {
  const persons = asArray(record.person);
  const topics = asArray(record.topic);
  const durations = asArray(record.duration);
  const agenda = [];
  let totalMinutes = 0;
  for (let i = 0; i < Math.max(topics.length, persons.length, durations.length); i++) {
    const topic = String(topics[i] || '').trim();
    const duration = parseDuration(durations[i]);
    if (!topic && !String(persons[i] || '').trim() && !String(durations[i] || '').trim()) continue;
    agenda.push({
      person: String(persons[i] || ''),
      topic,
      duration_minutes: duration
    });
    totalMinutes += duration;
  }
  return {
    meeting_id: record.meeting_id,
    title: record.title || '',
    start_time: record.start_time || '',
    timezone: record.timezone || '',
    is_public: record.is_public === true || record.is_public === 'on',
    owner_email: record.owner_email || null,
    default_view: normalizeView(record.default_view),
    topics: agenda,
    total_minutes: totalMinutes
  };
}

// Map MCP tool arguments onto the form-style body validateMeetingPayload()
// expects. `existing` (a stored flat record, or null for create) supplies
// every field the caller did not send, so an MCP update is partial: omitted
// fields keep their stored values instead of resetting to defaults.
function toolInputToFormBody(existing, args) {
  const body = {};
  if (existing) {
    Object.assign(body, existing);
  }
  if (args.title !== undefined) body.title = args.title;
  if (args.start_time !== undefined) body.start_time = args.start_time;
  if (args.timezone !== undefined) body.timezone = args.timezone;
  if (args.topics !== undefined) {
    body.person = args.topics.map(t => t.person || '');
    body.topic = args.topics.map(t => t.topic);
    body.duration = args.topics.map(t => String(t.duration_minutes));
  }
  if (args.is_public !== undefined) body.is_public = args.is_public;
  if (args.background !== undefined) body.background = args.background;
  if (args.default_view !== undefined) body.default_view = args.default_view;
  return body;
}

module.exports = {
  VIEW_MODES,
  normalizeView,
  boolFlag,
  get_short_hash,
  parseDuration,
  validateMeetingPayload,
  loadOwnedMeeting,
  saveMeeting,
  listOwnedMeetingRecords,
  toMeetingSummary,
  toolInputToFormBody
};
