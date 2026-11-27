const path = require('path');
const fs = require('fs');
const express = require('express');
const router = express.Router();
const date = require('date-and-time');

const momentTZ = require('moment-timezone');
const { client, ensureRedisConnection } = require('../lib/redis');
const {
  VIEW_MODES,
  normalizeView,
  boolFlag,
  get_short_hash,
  parseDuration,
  validateMeetingPayload
} = require('../lib/meetings');
const { requireAuth, optionalAuth, getUserEmail, getUserMeetingKey, getPublicMeetingKey, isUserMeetingOwner } = require('../config/auth');

function getDataFromRedis(redis_meeting)
{
  console.log("=== Data from Redis ===");
  console.log(redis_meeting);
  console.log("=======================\n");

  // Let's start with some easy - the background color - if it's not set, we default to blue since
  // this blue is used by OBS for the Chroma Key to overlay the timeline easily over you from your browser
  let background = "0047BB";
  if( redis_meeting.background != null )
  {
    background = redis_meeting.background.replace("#","");
  }

  let icon = "cat.png";
  if( redis_meeting.icon != null )
  {
    icon = redis_meeting.icon;
  }

  // Configuration options with defaults
  const config = {
    titleFontSize: parseInt(redis_meeting.titleFontSize) || 24,
    blockFontSize: parseInt(redis_meeting.blockFontSize) || 11,
    timeLabelFontSize: parseInt(redis_meeting.timeLabelFontSize) || 10,
    showDebug: boolFlag(redis_meeting.showDebug, false),
    showProgressBars: boolFlag(redis_meeting.showProgressBars, true),
    showStatusIcons: boolFlag(redis_meeting.showStatusIcons, true),
    showTimeLabels: boolFlag(redis_meeting.showTimeLabels, true),
    animationSpeed: parseFloat(redis_meeting.animationSpeed) || 1.0,
    segmentHeight: parseInt(redis_meeting.segmentHeight) || 50,
    colors: {
      completed: redis_meeting.completedColor || "404040",
      current: redis_meeting.currentColor || "FF6600", 
      upcoming: redis_meeting.upcomingColor || "0099CC",
      completedAlpha: parseFloat(redis_meeting.completedAlpha) || 0.6,
      currentAlpha: parseFloat(redis_meeting.currentAlpha) || 0.9,
      upcomingAlpha: parseFloat(redis_meeting.upcomingAlpha) || 0.4
    },
    missionControlTheme: boolFlag(redis_meeting.missionControlTheme, true),
    timeMarker: {
      primaryColor: redis_meeting.markerPrimaryColor || "FF0000",
      secondaryColor: redis_meeting.markerSecondaryColor || "FFAA00",
      lineWidth: parseInt(redis_meeting.markerLineWidth) || 3,
      circleSize: parseInt(redis_meeting.markerCircleSize) || 8,
      height: parseInt(redis_meeting.markerHeight) || 100,
      glowIntensity: parseFloat(redis_meeting.markerGlowIntensity) || 0.3,
      pulseSpeed: parseInt(redis_meeting.markerPulseSpeed) || 200,
      style: redis_meeting.markerStyle || "modern", // modern, classic, minimal, arrow
      showGlow: boolFlag(redis_meeting.markerShowGlow, false),
      showCircle: boolFlag(redis_meeting.markerShowCircle, false),
      showLine: boolFlag(redis_meeting.markerShowLine, false),
      textStyle: {
        fontSize: parseInt(redis_meeting.markerTextSize) || 14,
        color: redis_meeting.markerTextColor || "FFFFFF",
        backgroundColor: redis_meeting.markerTextBg || "000000",
        backgroundAlpha: parseFloat(redis_meeting.markerTextBgAlpha) || 0.7,
        showBackground: boolFlag(redis_meeting.markerTextShowBg, false),
        fontFamily: redis_meeting.markerTextFont || "monospace"
      }
    }
  };


  // To keep things simple, we only ask for the time, and we use the current day as the date
  const now = new Date();
  const now_date = date.format(now, "YYYY-MM-DD");


  // If we get 1:00PM, pad with a zero to 01:00PM
  // Guard against legacy/malformed records with no start_time so one bad
  // meeting can't crash list rendering
  let start_time = redis_meeting.start_time || "09:00 AM";
  let timezone = redis_meeting.timezone;

  if( start_time.split(":")[0].length == 1 )
  {
    start_time = "0" + start_time;
  }

  // We start with the time we were given for when the meeting starts
  const start = now_date + " " + start_time;

  // We then add the timezone that was given
  // Now the person using the page will see this in their timezone, but it will be altered by the TZ selected
  // let startTime = momentTZ.tz(start, "YYYY-MM-DD hh:mm A", timezone).toDate();
  let startTime = momentTZ.tz(start, "YYYY-MM-DD hh:mm A", timezone).toDate();


  let topics = [];
  let total_duration = 0;

  if( Array.isArray(redis_meeting.topic) )
  {
    let counter = 0;
    redis_meeting.topic.forEach(element => {
      let duration = parseDuration(redis_meeting.duration[counter]);

      topics.push({
        "person" : redis_meeting.person[counter],
        "topic" : element,
        "time" : duration
      });
      total_duration += duration;
      counter++;
    });
  }
  else
  {
    topics.push({
      "person" : redis_meeting.person,
      "topic" : redis_meeting.topic,
      "time" : parseDuration(redis_meeting.duration)
    });
    total_duration += parseDuration(redis_meeting.duration);
  }


  // Calculate end time based on the durations from the topics
  const additional_minutes_for_padding_at_end = 2;
  var end = date.addMinutes(startTime, total_duration + additional_minutes_for_padding_at_end);

  meeting = {
    "meeting_id": redis_meeting.meeting_id,
    "title": redis_meeting.title,
    "start": startTime,
    "end": end,
    "duration": total_duration,
    "num_topics": topics.length,
    "topics": topics,
    "background": background,
    "timezone": redis_meeting.timezone,
    "icon": icon,
    "config": config,
    "is_public": redis_meeting.is_public || false,
    "owner_email": redis_meeting.owner_email || null,
    "default_view": normalizeView(redis_meeting.default_view),
    "preset": redis_meeting.preset || null
  }

  console.log("=== Normalized Data to Pass to General Parser ===");
  console.log(meeting);
  console.log("==================================================");

  return getData(meeting);
}

function getData(meeting){
  // Ensure start and end are proper Date objects
  const startDate = meeting.start instanceof Date ? meeting.start : new Date(meeting.start);
  const endDate = meeting.end instanceof Date ? meeting.end : new Date(meeting.end);
  
  totalTime_seconds = date.subtract(endDate, startDate).toSeconds();
  totalTime_mins = date.subtract(endDate, startDate).toMinutes();

  // Width of display should handle 1 hour meetings easily
  let windowWidth = 950;

  // We need to calulate how fast the marker should be moving relative to the width and total_time
  meeting.movement_rate = totalTime_seconds / windowWidth;
  
  // Update meeting object with proper Date objects
  meeting.start = startDate;
  meeting.end = endDate;

  let location = 0;
  let counter = 0;
  let initial_offset = 10;
  let prev_width = 0;
  let prev_time = 0;

  meeting.topics.forEach(element => {
   element.id = counter;
   percent_of_total_width = Math.round(((element.time / totalTime_mins) * windowWidth),1);


   if( counter == 0 )
   {
     location = 0;
     element.startTime = startDate;
   }
   else {
     location += prev_width;
     element.startTime = date.addMinutes(startDate,prev_time);
   }

   element.width = percent_of_total_width;
   element.location = location;
   element.endTime = date.addMinutes(startDate, prev_time + element.time);
   element.startTimeISO = element.startTime.toISOString();
   element.endTimeISO = element.endTime.toISOString();

   prev_width = percent_of_total_width;
   prev_time += element.time;

   counter++;
  });

  // ISO timestamps for the client-side time engine. contentEnd is the end of
  // the last topic, WITHOUT the +2 minute display padding baked into meeting.end.
  meeting.startISO = startDate.toISOString();
  meeting.contentEndISO = date.addMinutes(startDate, prev_time).toISOString();

  // Ensure config object exists with defaults
  if (!meeting.config) {
    meeting.config = {
      showDebug: false,
      showProgressBars: true,
      showStatusIcons: true,
      showTimeLabels: true,
      titleFontSize: 24,
      blockFontSize: 11,
      timeLabelFontSize: 10,
      animationSpeed: 1.0,
      segmentHeight: 50,
      colors: {
        completed: "404040",
        current: "FF6600", 
        upcoming: "0099CC",
        completedAlpha: 0.6,
        currentAlpha: 0.9,
        upcomingAlpha: 0.4
      },
      missionControlTheme: true,
      timeMarker: {
        primaryColor: "FF0000",
        secondaryColor: "FFAA00",
        lineWidth: 3,
        circleSize: 8,
        height: 100,
        glowIntensity: 0.3,
        pulseSpeed: 200,
        style: "modern",
        showGlow: true,
        showCircle: true,
        showLine: true,
        textStyle: {
          fontSize: 14,
          color: "FFFFFF",
          backgroundColor: "000000",
          backgroundAlpha: 0.7,
          showBackground: true,
          fontFamily: "monospace"
        }
      }
    };
  }

  return meeting;
}


// Build the normalized JSON payload consumed by the client-side time engine
// and view renderers (window.MEETING). All times are ISO 8601 strings so the
// client needs no timezone math beyond native Date parsing.
function buildClientPayload(data, opts)
{
  return {
    id: opts.id,
    view: opts.view,
    chrome: opts.chrome,
    preview: !!opts.preview,
    transparent: !!opts.transparent,
    is_owner: !!opts.is_owner,
    title: data.title,
    icon: data.icon,
    background: data.background,
    config: data.config,
    time: {
      startISO: data.startISO,
      endISO: data.contentEndISO,
      timezone: data.timezone,
      totalMinutes: data.duration
    },
    topics: data.topics
      .filter(t => t.topic)
      .map(t => ({
        id: t.id,
        person: t.person || '',
        topic: t.topic,
        minutes: t.time,
        startISO: t.startTimeISO,
        endISO: t.endTimeISO
      }))
  };
}

// Serialize the payload for embedding inside a <script> tag. Escaping '<'
// prevents topic text like "</script><script>..." from breaking out of the tag.
function serializePayload(payload)
{
  return JSON.stringify(payload).replace(/</g, '\\u003c');
}

router.get('/list', requireAuth, async (req, res) => {
  console.log("/list called for user:", getUserEmail(req));

  var recent_meeting_ids = [];

  try {
    await ensureRedisConnection();
    const userEmail = getUserEmail(req);
    const keys = await client.keys(`meeting_${userEmail}_*`);

    if( keys.length == 0 )
    {
      return res.json([]);
    }

    // Get more details from redis for each key
    const meeting_infos = await client.mGet(keys);

    meeting_infos.forEach((item, i) => {
      if (item) {
        // One malformed record must not break the whole list
        try {
          const meeting_details = JSON.parse(item);
          const pretty_meeting_details = getDataFromRedis(meeting_details);
          recent_meeting_ids.push(pretty_meeting_details);
        } catch (parseErr) {
          console.error('Skipping malformed meeting record', keys[i], parseErr.message);
        }
      }
    });

    res.json(recent_meeting_ids);
  } catch (err) {
    console.error('Redis error:', err);
    res.status(500).json({error: 'Internal Server Error'});
  }
});

router.get('/edit/:meetingId', requireAuth, async (req, res) => {
    const meeting_id = req.params.meetingId;
    const userEmail = getUserEmail(req);
    const meeting_id_for_redis = getUserMeetingKey(userEmail, meeting_id);
    const public_meeting_key = getPublicMeetingKey(meeting_id);

    console.log("~~ GET /edit/meetingId REQUEST ID: " + meeting_id + " for user: " + userEmail);

    try {
      await ensureRedisConnection();
      
      // 1. First try to get user's private meeting
      let redis_data = await client.get(meeting_id_for_redis);
      let meeting = null;
      
      if (redis_data) {
        meeting = JSON.parse(redis_data);
      } else {
        // 2. If not found, check if it's a public meeting
        redis_data = await client.get(public_meeting_key);
        if (redis_data) {
          const publicMeeting = JSON.parse(redis_data);
          
          // Check if user is the owner of the public meeting
          if (!isUserMeetingOwner(userEmail, meeting_id, publicMeeting)) {
            return res.status(403).send('Access denied: You can only edit meetings you created');
          }
          meeting = publicMeeting;
        }
      }

      if (!meeting) {
        return res.status(404).send('Meeting not found');
      }

      // Reconstruct config object from form data (which is stored flat in Redis)
      // This handles both old nested config format and new flat form submission format
      meeting.config = {
        titleFontSize: parseInt(meeting.titleFontSize) || (meeting.config && meeting.config.titleFontSize) || 24,
        blockFontSize: parseInt(meeting.blockFontSize) || (meeting.config && meeting.config.blockFontSize) || 11,
        timeLabelFontSize: parseInt(meeting.timeLabelFontSize) || (meeting.config && meeting.config.timeLabelFontSize) || 10,
        showDebug: meeting.showDebug === 'on' || meeting.showDebug === true || (meeting.config && meeting.config.showDebug) || false,
        showProgressBars: meeting.showProgressBars === 'on' || meeting.showProgressBars === true || (meeting.config && meeting.config.showProgressBars !== false) || true,
        showStatusIcons: meeting.showStatusIcons === 'on' || meeting.showStatusIcons === true || (meeting.config && meeting.config.showStatusIcons !== false) || true,
        showTimeLabels: meeting.showTimeLabels === 'on' || meeting.showTimeLabels === true || (meeting.config && meeting.config.showTimeLabels !== false) || true,
        animationSpeed: parseFloat(meeting.animationSpeed) || (meeting.config && meeting.config.animationSpeed) || 1.0,
        segmentHeight: parseInt(meeting.segmentHeight) || (meeting.config && meeting.config.segmentHeight) || 50,
        colors: {
          completed: meeting.completedColor || (meeting.config && meeting.config.colors && meeting.config.colors.completed) || "404040",
          current: meeting.currentColor || (meeting.config && meeting.config.colors && meeting.config.colors.current) || "FF6600", 
          upcoming: meeting.upcomingColor || (meeting.config && meeting.config.colors && meeting.config.colors.upcoming) || "0099CC",
          completedAlpha: parseFloat(meeting.completedAlpha) || (meeting.config && meeting.config.colors && meeting.config.colors.completedAlpha) || 0.6,
          currentAlpha: parseFloat(meeting.currentAlpha) || (meeting.config && meeting.config.colors && meeting.config.colors.currentAlpha) || 0.9,
          upcomingAlpha: parseFloat(meeting.upcomingAlpha) || (meeting.config && meeting.config.colors && meeting.config.colors.upcomingAlpha) || 0.4
        },
        missionControlTheme: meeting.missionControlTheme === 'on' || meeting.missionControlTheme === true || (meeting.config && meeting.config.missionControlTheme !== false) || true,
        timeMarker: {
          primaryColor: meeting.markerPrimaryColor || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.primaryColor) || "FF0000",
          secondaryColor: meeting.markerSecondaryColor || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.secondaryColor) || "FFAA00",
          lineWidth: parseInt(meeting.markerLineWidth) || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.lineWidth) || 3,
          circleSize: parseInt(meeting.markerCircleSize) || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.circleSize) || 8,
          height: parseInt(meeting.markerHeight) || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.height) || 100,
          glowIntensity: parseFloat(meeting.markerGlowIntensity) || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.glowIntensity) || 0.3,
          pulseSpeed: parseInt(meeting.markerPulseSpeed) || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.pulseSpeed) || 200,
          style: meeting.markerStyle || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.style) || "modern",
          showGlow: meeting.markerShowGlow === 'on' || meeting.markerShowGlow === true || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.showGlow !== false) || true,
          showCircle: meeting.markerShowCircle === 'on' || meeting.markerShowCircle === true || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.showCircle !== false) || true,
          showLine: meeting.markerShowLine === 'on' || meeting.markerShowLine === true || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.showLine !== false) || true,
          textStyle: {
            fontSize: parseInt(meeting.markerTextSize) || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.textStyle && meeting.config.timeMarker.textStyle.fontSize) || 14,
            color: meeting.markerTextColor || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.textStyle && meeting.config.timeMarker.textStyle.color) || "FFFFFF",
            backgroundColor: meeting.markerTextBg || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.textStyle && meeting.config.timeMarker.textStyle.backgroundColor) || "000000",
            backgroundAlpha: parseFloat(meeting.markerTextBgAlpha) || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.textStyle && meeting.config.timeMarker.textStyle.backgroundAlpha) || 0.7,
            showBackground: meeting.markerTextShowBg === 'on' || meeting.markerTextShowBg === true || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.textStyle && meeting.config.timeMarker.textStyle.showBackground !== false) || true,
            fontFamily: meeting.markerTextFont || (meeting.config && meeting.config.timeMarker && meeting.config.timeMarker.textStyle && meeting.config.timeMarker.textStyle.fontFamily) || "monospace"
          }
        }
      };

      console.log("=== Reconstructed config for edit page ===");
      console.log("titleFontSize:", meeting.config.titleFontSize);
      console.log("blockFontSize:", meeting.config.blockFontSize);
      console.log("timeLabelFontSize:", meeting.config.timeLabelFontSize);
      console.log("timeMarker primaryColor:", meeting.config.timeMarker.primaryColor);
      console.log("==========================================");

      // Normalize fields the editor binds to directly
      meeting.default_view = normalizeView(meeting.default_view) || 'overlay';
      meeting.is_public = meeting.is_public === true || meeting.is_public === 'on';

      res.render('edit_meeting',{
        id: meeting_id,
        all_timezones: momentTZ.tz.names(),
        view_modes: VIEW_MODES,
        meeting: meeting
      });
    } catch (err) {
      console.error('Redis error:', err);
      res.status(500).send('Internal Server Error');
    }
});


// Public meetings render without login so shared links just work; private
// meetings still require authentication (logged-out visitors are sent to login).
router.get('/:meetingId', optionalAuth, async (req, res) => {
    const meeting_id = req.params.meetingId;
    const userEmail = getUserEmail(req); // null when logged out
    const public_meeting_key = getPublicMeetingKey(meeting_id);
    console.log("~~ GET /meetingId REQUEST ID: " + meeting_id + " for user: " + userEmail);

    try {
      await ensureRedisConnection();

      let redis_data = null;
      let meeting = null;
      let isPublicAccess = false;

      // 1. Logged-in users get their private copy first
      if (userEmail) {
        redis_data = await client.get(getUserMeetingKey(userEmail, meeting_id));
        if (redis_data) {
          meeting = JSON.parse(redis_data);
        }
      }

      // 2. Fall back to the public copy (works logged out)
      if (!meeting) {
        redis_data = await client.get(public_meeting_key);
        if (redis_data) {
          meeting = JSON.parse(redis_data);
          isPublicAccess = true;
        }
      }

      // 3. No meeting found: logged-out visitors may just need to log in to
      // see a private meeting; logged-in users get a proper 404
      if (!meeting) {
        if (!userEmail) {
          const encodedReturnTo = encodeURIComponent(req.originalUrl);
          return res.redirect(`/auth/login?returnTo=${encodedReturnTo}`);
        }
        return res.status(404).render('meeting_not_found', {
          meetingId: meeting_id,
          userEmail: userEmail
        });
      }

      // Parse and pass data into refinement stage
      const data = getDataFromRedis(meeting);

      // A private-key hit is ownership by construction; public hits check owner_email
      const is_owner = !isPublicAccess || isUserMeetingOwner(userEmail, meeting_id, meeting);

      // Resolve the view mode: explicit ?view= wins, then the stored default
      const view = normalizeView(req.query.view) || data.default_view || 'overlay';
      // "chrome" = on-page UI (view switcher, help hints). Overlay defaults to
      // chrome-off since it's designed for OBS capture; ?chrome=0/1 overrides.
      const preview = req.query.preview === '1';
      const chrome = preview
        ? false
        : (req.query.chrome !== undefined ? req.query.chrome !== '0' : view !== 'overlay');
      const transparent = req.query.transparent === '1';

      const payload = buildClientPayload(data, {
        id: meeting_id, view, chrome, preview, transparent, is_owner
      });

      res.render('meeting_views/' + view, {
        id: meeting_id,
        title: data.title,
        background: data.background,
        config: data.config,
        view: view,
        view_modes: VIEW_MODES,
        chrome: chrome,
        preview: preview,
        transparent: transparent,
        payload_json: serializePayload(payload),
        is_public_access: isPublicAccess,
        is_owner: is_owner
      });
    } catch (err) {
      console.error('Redis error:', err);
      res.status(500).send('Internal Server Error');
    }
});




router.post('/:meetingId', requireAuth, async (req, res) => {
  const meeting_id = req.params.meetingId;
  const userEmail = getUserEmail(req);

  if (!/^[A-Za-z0-9]{1,32}$/.test(meeting_id)) {
    return res.status(400).send('Invalid meeting id');
  }
  const meeting_id_for_redis = getUserMeetingKey(userEmail, meeting_id);
  const public_meeting_key = getPublicMeetingKey(meeting_id);

  try {
    await ensureRedisConnection();

    const { ok, errors, meetingData } = validateMeetingPayload(req.body);
    if (!ok) {
      if (req.xhr) {
        return res.status(400).json({ ok: false, errors });
      }
      return res.status(400).send('Invalid meeting data: ' + Object.values(errors).join('; '));
    }

    // The public copy is shared namespace: refuse to touch one that belongs to
    // someone else (legacy copies without owner_email are treated as unowned).
    const existing_public_raw = await client.get(public_meeting_key);
    if (existing_public_raw) {
      try {
        const existing_public = JSON.parse(existing_public_raw);
        if (existing_public.owner_email && existing_public.owner_email !== userEmail) {
          if (req.xhr) {
            return res.status(403).json({ ok: false, errors: { meeting: 'This meeting id belongs to someone else' } });
          }
          return res.status(403).send('Access denied: this meeting id belongs to someone else');
        }
      } catch (parseErr) {
        console.error('Malformed public meeting record for', meeting_id, parseErr.message);
      }
    }

    meetingData.meeting_id = meeting_id;
    meetingData.owner_email = userEmail;
    meetingData.is_public = req.body.is_public === 'on' || req.body.is_public === true;

    // Always save to user's private space
    await client.set(meeting_id_for_redis, JSON.stringify(meetingData));

    // Mirror to / remove from the public space
    if (meetingData.is_public) {
      await client.set(public_meeting_key, JSON.stringify(meetingData));
    } else {
      await client.del(public_meeting_key);
    }

    if (req.xhr) {
      return res.json({ ok: true, is_public: meetingData.is_public });
    }
    res.redirect("/meeting/edit/" + meeting_id);
  } catch (err) {
    console.error('Redis error:', err);
    if (req.xhr) {
      return res.status(500).json({ ok: false, errors: { server: 'Internal Server Error' } });
    }
    res.status(500).send('Internal Server Error');
  }
});

router.get('/', requireAuth, async (req, res) => {
  var recent_meeting_ids = [];
  
  try {
    await ensureRedisConnection();
    const userEmail = getUserEmail(req);
    const keys = await client.keys(`meeting_${userEmail}_*`);
    
    for(var i = 0, len = keys.length; i < len; i++) {
      recent_meeting_ids.push(keys[i]);
    }

    var all_timezones = momentTZ.tz.names();
    var timezone_selection = [];
    const popular_timezones = ["US/Pacific", "America/Phoenix", "US/Eastern", "Asia/Kolkata"];
    Array.prototype.push.apply(timezone_selection, popular_timezones);

    all_timezones.forEach((item, i) => {
      if( !popular_timezones.includes(item) )
      {
        timezone_selection.push(item);
      }
    });

    res.render('create_meeting',{
      id: get_short_hash(),
      all_timezones: timezone_selection,
      recent_meetings: recent_meeting_ids
    });
  } catch (err) {
    console.error('Redis error:', err);
    res.status(500).send('Internal Server Error');
  }
});


module.exports = router;
