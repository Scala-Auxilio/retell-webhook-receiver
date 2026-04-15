/**
 * Scala Auxilium — Calendly Integration Module
 *
 * Proxy endpoints for Retell AI agents to check availability
 * and book meetings via Calendly API v2 during live calls.
 *
 * Calendly API docs: https://developer.calendly.com/api-docs
 *
 * Environment variables:
 *   CALENDLY_API_TOKEN           – Personal Access Token (from Integrations → API)
 *   CALENDLY_EVENT_TYPE_ROGIER   – Event type URI for Rogier (e.g., https://api.calendly.com/event_types/XXXXX)
 *   CALENDLY_EVENT_TYPE_MIKE     – Event type URI for Mike
 *   CALENDLY_FALLBACK_URL_ROGIER – Public booking page URL for Rogier (fallback)
 *   CALENDLY_FALLBACK_URL_MIKE   – Public booking page URL for Mike (fallback)
 *
 * Retell Custom Function integration:
 *   These endpoints are called from Retell agent flow nodes via
 *   the "Custom Function" (webhook) action during a live call.
 */

const CALENDLY_API_BASE = "https://api.calendly.com";
const CALENDLY_API_TOKEN = process.env.CALENDLY_API_TOKEN || null;

// ─── Specialist Config ──────────────────────────────────────────────────────

const SPECIALISTS = {
  rogier: {
    name: "Rogier",
    event_type_uri: process.env.CALENDLY_EVENT_TYPE_ROGIER || null,
    fallback_url: process.env.CALENDLY_FALLBACK_URL_ROGIER || "https://calendly.com/rogier-smulders-sendsteps",
  },
  mike: {
    name: "Mike",
    event_type_uri: process.env.CALENDLY_EVENT_TYPE_MIKE || null,
    fallback_url: process.env.CALENDLY_FALLBACK_URL_MIKE || "https://calendly.com/mike-coumans-sendsteps",
  },
};

// Cache for resolved event type URIs (populated on first request or startup)
let _eventTypeCache = null;
let _userUri = null;

// ─── Calendly API helpers ────────────────────────────────────────────────────

async function calendlyFetch(endpoint, options = {}) {
  if (!CALENDLY_API_TOKEN) {
    throw new Error("CALENDLY_API_TOKEN not configured. Set it in Railway env vars.");
  }

  const url = endpoint.startsWith("http") ? endpoint : `${CALENDLY_API_BASE}${endpoint}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${CALENDLY_API_TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => "Unknown error");
    throw new Error(`Calendly API ${resp.status}: ${err}`);
  }

  return resp.json();
}

/**
 * Get current user URI (needed to list event types).
 * Cached after first call.
 */
async function getUserUri() {
  if (_userUri) return _userUri;
  const data = await calendlyFetch("/users/me");
  _userUri = data.resource.uri;
  return _userUri;
}

/**
 * Auto-discover event type URIs by matching on name/slug.
 * Called on first request if env vars aren't set.
 */
async function resolveEventTypes() {
  if (_eventTypeCache) return _eventTypeCache;

  const userUri = await getUserUri();
  const data = await calendlyFetch(`/event_types?user=${encodeURIComponent(userUri)}&active=true`);

  _eventTypeCache = {};
  for (const et of data.collection || []) {
    _eventTypeCache[et.uri] = {
      uri: et.uri,
      name: et.name,
      slug: et.slug,
      duration: et.duration,
      scheduling_url: et.scheduling_url,
    };
  }

  // Try to auto-match specialists by name if env vars not set
  for (const [key, spec] of Object.entries(SPECIALISTS)) {
    if (!spec.event_type_uri) {
      const match = Object.values(_eventTypeCache).find(
        (et) => et.name.toLowerCase().includes(key) || et.slug.toLowerCase().includes(key)
      );
      if (match) {
        spec.event_type_uri = match.uri;
        console.log(`[CALENDLY] Auto-matched ${key} → ${match.name} (${match.uri})`);
      }
    }
  }

  return _eventTypeCache;
}

// ─── Default specialist routing ──────────────────────────────────────────────

function getDefaultSpecialist() {
  // No hardcoded default — specialist must be provided via Retell dynamic variable
  // (derived from Zoho Lead Owner in batch-caller.js → mapOwnerToSpecialist).
  // If neither Retell nor the caller provides a specialist, return null so the
  // endpoint can return a clear error instead of silently routing to the wrong person.
  return null;
}

// ─── Availability Check ──────────────────────────────────────────────────────

/**
 * Get available time slots for a specialist's event type.
 *
 * @param {string} eventTypeUri - Calendly event type URI
 * @param {string} startDate - ISO date string (YYYY-MM-DD), defaults to tomorrow
 * @param {number} days - Number of days to look ahead (default: 5, max: 7)
 * @returns {Object} Available slots from Calendly API
 */
async function getAvailability(eventTypeUri, startDate, days = 5) {
  if (!eventTypeUri) {
    throw new Error("Event type URI not configured");
  }

  // Default to tomorrow
  if (!startDate) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    startDate = tomorrow.toISOString().split("T")[0];
  }

  // Calendly allows max 7 days per request
  days = Math.min(days, 7);
  const end = new Date(startDate);
  end.setDate(end.getDate() + days);

  const startTime = `${startDate}T00:00:00Z`;
  const endTime = end.toISOString().split("T")[0] + "T23:59:59Z";

  const data = await calendlyFetch(
    `/event_type_available_times?event_type=${encodeURIComponent(eventTypeUri)}&start_time=${startTime}&end_time=${endTime}`
  );

  return data;
}

/**
 * Format available slots into a human-readable list for Aria to read aloud.
 * Returns the 3 nearest available slots as a conversational string.
 *
 * @param {Object} availabilityData - Calendly API response from event_type_available_times
 * @param {string} timezone - Display timezone (default: Europe/Amsterdam)
 * @returns {Object} { slots: Array, spoken: string, spoken_nl: string, count: number }
 */
function formatSlotsForVoice(availabilityData, timezone = "Europe/Amsterdam") {
  const allSlots = [];

  // Calendly returns { collection: [ { status: "available", start_time: "...", invitees_remaining: N, scheduling_url: "..." } ] }
  const collection = availabilityData.collection || [];

  for (const slot of collection) {
    if (slot.status === "available" && slot.invitees_remaining > 0) {
      allSlots.push({
        start_time: slot.start_time,
        scheduling_url: slot.scheduling_url,
      });
    }
  }

  // Take first 3 slots
  const topSlots = allSlots.slice(0, 3);

  if (topSlots.length === 0) {
    return {
      slots: [],
      spoken: "I don't see any available slots in the next few days. Let me send you a booking link by email instead so you can pick a time that works.",
      spoken_nl: "Ik zie geen beschikbare tijdsloten in de komende dagen. Laat me u een boekingslink per e-mail sturen zodat u zelf een geschikt moment kunt kiezen.",
      count: 0,
    };
  }

  // Format for voice
  const dateFormatter = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  });
  const dateFormatterNL = new Intl.DateTimeFormat("nl-NL", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  });

  const spokenParts = topSlots.map((s) => {
    const dt = new Date(s.start_time);
    const dayStr = dateFormatter.format(dt);
    const timeStr = dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hourCycle: "h12", timeZone: timezone });
    return `${dayStr} at ${timeStr}`;
  });

  const spokenPartsNL = topSlots.map((s) => {
    const dt = new Date(s.start_time);
    const dayStr = dateFormatterNL.format(dt);
    const timeStr = dt.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: timezone });
    return `${dayStr} om ${timeStr}`;
  });

  let spoken, spoken_nl;
  if (spokenParts.length === 1) {
    spoken = `I have ${spokenParts[0]} available. Would that work for you?`;
    spoken_nl = `Ik heb ${spokenPartsNL[0]} beschikbaar. Zou dat schikken?`;
  } else if (spokenParts.length === 2) {
    spoken = `I have ${spokenParts[0]} or ${spokenParts[1]}. Which works better for you?`;
    spoken_nl = `Ik heb ${spokenPartsNL[0]} of ${spokenPartsNL[1]}. Welke past u beter?`;
  } else {
    spoken = `I have ${spokenParts[0]}, ${spokenParts[1]}, or ${spokenParts[2]}. Which works best for you?`;
    spoken_nl = `Ik heb ${spokenPartsNL[0]}, ${spokenPartsNL[1]}, of ${spokenPartsNL[2]}. Welke past u het beste?`;
  }

  return {
    slots: topSlots.map((s) => ({
      start_time: s.start_time,
      scheduling_url: s.scheduling_url,
    })),
    spoken,
    spoken_nl,
    count: topSlots.length,
  };
}

// ─── Booking ─────────────────────────────────────────────────────────────────

/**
 * Create a booking via Calendly Scheduling API (Create Event Invitee).
 *
 * @param {string} eventTypeUri - Calendly event type URI
 * @param {Object} details - { name, email, start_time, timezone, notes }
 * @returns {Object} Booking confirmation from Calendly
 */
async function createBooking(eventTypeUri, details) {
  if (!eventTypeUri) {
    throw new Error("Event type URI not configured");
  }

  const payload = {
    event_type: eventTypeUri,
    start_time: details.start_time, // UTC ISO 8601
    invitee: {
      name: details.name || "Prospect",
      email: details.email,
    },
  };

  // Add timezone if provided
  if (details.timezone) {
    payload.invitee.timezone = details.timezone;
  }

  const data = await calendlyFetch("/invitees", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return data;
}

// ─── Express route handlers ──────────────────────────────────────────────────

function registerRoutes(app, { sendEmail } = {}) {

  // ── Fallback email helper: sends Calendly booking link to prospect ──
  function sendFallbackEmail({ email, name, spec, language }) {
    if (!sendEmail || !email) return;
    const isNL = (language || "").toLowerCase().startsWith("nl");
    const subject = isNL ? "Boek uw Sendsteps Demo" : "Book Your Sendsteps Demo";
    const greeting = isNL ? `Beste ${name || ""}` : `Hi ${name || "there"}`;
    const textBody = isNL
      ? `${greeting},\n\nBedankt voor uw interesse in Sendsteps!\n\nGebruik de link hieronder om een demo van 20 minuten in te plannen op een moment dat u uitkomt:\n${spec.fallback_url}\n\nWe kijken ernaar uit!\n\nMet vriendelijke groet,\n${spec.name} - Sendsteps`
      : `${greeting},\n\nThank you for your interest in Sendsteps!\n\nPlease use the link below to book a 20-minute demo at a time that works for you:\n${spec.fallback_url}\n\nLooking forward to connecting!\n\nBest regards,\n${spec.name} - Sendsteps`;
    const htmlBody = isNL
      ? `<p>${greeting},</p><p>Bedankt voor uw interesse in Sendsteps!</p><p>Gebruik de link hieronder om een demo van 20 minuten in te plannen op een moment dat u uitkomt:</p><p><a href="${spec.fallback_url}" style="display:inline-block;padding:12px 24px;background-color:#2A9D8F;color:white;text-decoration:none;border-radius:6px;">Boek uw Demo</a></p><p>Of kopieer deze link: ${spec.fallback_url}</p><p>We kijken ernaar uit!</p><p>Met vriendelijke groet,<br>${spec.name}<br>Sendsteps</p>`
      : `<p>${greeting},</p><p>Thank you for your interest in Sendsteps!</p><p>Please use the link below to book a 20-minute demo at a time that works for you:</p><p><a href="${spec.fallback_url}" style="display:inline-block;padding:12px 24px;background-color:#2A9D8F;color:white;text-decoration:none;border-radius:6px;">Book Your Demo</a></p><p>Or copy this link: ${spec.fallback_url}</p><p>Looking forward to connecting!</p><p>Best regards,<br>${spec.name}<br>Sendsteps</p>`;

    // Fire-and-forget so it doesn't block the Retell response
    // Uses CALENDLY_FROM_EMAIL so prospect-facing emails come from @sendsteps.com
    // (separate from NOTIFY_FROM which is for internal notifications)
    sendEmail({
      from: process.env.CALENDLY_FROM_EMAIL || "Aria at Sendsteps <aria@sendsteps.com>",
      to: email,
      subject,
      text: textBody,
      html: htmlBody,
    })
      .then(() => console.log(`[CALENDLY] Fallback email sent to ${email} (${isNL ? "NL" : "EN"}) with ${spec.name}'s booking link`))
      .catch(err => console.error(`[CALENDLY] Failed to send fallback email to ${email}:`, err.message));
  }

  /**
   * GET /calendly/availability
   *
   * Called by Retell Custom Function during a live call.
   * Returns available time slots formatted for voice.
   *
   * Query params:
   *   specialist - "rogier" or "mike" (optional, defaults to rogier)
   *   language   - "en" or "nl" (for voice format)
   *   start_date - YYYY-MM-DD (optional, defaults to tomorrow)
   *   days       - number of days to look ahead (default: 5, max: 7)
   */
  const availabilityHandler = async (req, res) => {
    try {
      // Accept params from query string (GET) or body (POST).
      // Retell custom-function tools with args_at_root=false wrap args as { args: { ... } }.
      // Defensive: also merge raw body so manual callers keep working.
      const bodyArgs = (req.body && typeof req.body === "object" && req.body.args && typeof req.body.args === "object")
        ? req.body.args
        : (req.body && typeof req.body === "object" ? req.body : {});
      const params = { ...req.query, ...bodyArgs };
      const { specialist, language, start_date, days } = params;

      // Ensure event types are resolved
      await resolveEventTypes();

      const specKey = specialist || getDefaultSpecialist();

      if (!specKey) {
        // No specialist provided and no default — cannot route to a calendar
        console.error(`[CALENDLY] No specialist provided. Params: ${JSON.stringify(params)}`);
        return res.status(400).json({
          error: "Missing 'specialist' parameter. Must be one of: " + Object.keys(SPECIALISTS).join(", "),
          available: false,
          fallback: true,
          spoken: `I'll send you a calendar link by email so you can pick a time that suits you best.`,
          spoken_nl: `Ik stuur u een agenda-link per e-mail zodat u zelf het beste moment kunt kiezen.`,
        });
      }

      const spec = SPECIALISTS[specKey];

      if (!spec) {
        return res.status(400).json({ error: `Unknown specialist: '${specKey}'. Use: ${Object.keys(SPECIALISTS).join(", ")}` });
      }

      if (!spec.event_type_uri) {
        // Calendly event type not configured — return fallback
        console.log(`[CALENDLY] Event type not configured for ${specKey}, returning fallback URL`);
        return res.json({
          available: false,
          fallback: true,
          fallback_url: spec.fallback_url,
          spoken: `I'll send you a calendar link by email so you can pick a time that suits you best.`,
          spoken_nl: `Ik stuur u een agenda-link per e-mail zodat u zelf het beste moment kunt kiezen.`,
          specialist: spec.name,
        });
      }

      console.log(`[CALENDLY] Checking availability for ${spec.name}...`);
      const availability = await getAvailability(spec.event_type_uri, start_date, parseInt(days) || 5);
      const formatted = formatSlotsForVoice(availability);

      res.json({
        available: formatted.count > 0,
        fallback: formatted.count === 0,
        fallback_url: formatted.count === 0 ? spec.fallback_url : null,
        specialist: spec.name,
        ...formatted,
      });
    } catch (err) {
      console.error("[CALENDLY] Availability check failed:", err.message);
      // On error, fall back to email-based booking
      const fallbackBodyArgs = (req.body && typeof req.body === "object" && req.body.args && typeof req.body.args === "object")
        ? req.body.args
        : (req.body && typeof req.body === "object" ? req.body : {});
      const fallbackParams = { ...req.query, ...fallbackBodyArgs };
      const specKey = fallbackParams.specialist || getDefaultSpecialist() || "rogier";
      const spec = SPECIALISTS[specKey] || SPECIALISTS.rogier;
      res.json({
        available: false,
        fallback: true,
        fallback_url: spec.fallback_url,
        spoken: `I'll send you a calendar link by email so you can pick a time that suits you best.`,
        spoken_nl: `Ik stuur u een agenda-link per e-mail zodat u zelf het beste moment kunt kiezen.`,
        specialist: spec.name,
        error: err.message,
      });
    }
  };

  // Register both GET (current Retell tool config) and POST (defensive, for any
  // future Retell behavior where custom-function tools POST regardless of method).
  app.get("/calendly/availability", availabilityHandler);
  app.post("/calendly/availability", availabilityHandler);

  /**
   * POST /calendly/book
   *
   * Called by Retell Custom Function to confirm a booking.
   *
   * Body:
   *   specialist  - "rogier" or "mike"
   *   start_time  - ISO 8601 datetime (UTC) selected by prospect
   *   name        - Prospect name
   *   email       - Prospect email
   *   timezone    - Prospect timezone (default: Europe/Amsterdam)
   *   notes       - Optional notes
   *   language    - "en" or "nl" (for voice response)
   */
  app.post("/calendly/book", async (req, res) => {
    try {
      // Retell custom-function tools with args_at_root=false send { name, call, args: {...} }
      // Accept both shapes so manual/curl callers still work.
      const payload = (req.body && typeof req.body === "object" && req.body.args && typeof req.body.args === "object")
        ? req.body.args
        : (req.body || {});
      const { specialist, start_time, name, email, timezone, notes, language } = payload;

      if (!start_time) {
        return res.status(400).json({ error: "Missing start_time" });
      }
      if (!email) {
        return res.status(400).json({ error: "Missing email" });
      }

      // Ensure event types are resolved
      await resolveEventTypes();

      const specKey = specialist || getDefaultSpecialist();

      if (!specKey) {
        console.error(`[CALENDLY] No specialist provided for booking. Body: ${JSON.stringify({ specialist, name, email })}`);
        return res.status(400).json({
          error: "Missing 'specialist' parameter. Must be one of: " + Object.keys(SPECIALISTS).join(", "),
          booked: false,
          spoken: `I wasn't able to book that slot directly. I'll send you a calendar link by email instead.`,
          spoken_nl: `Het is mij niet gelukt om dat tijdslot direct te boeken. Ik stuur u een agenda-link per e-mail.`,
        });
      }

      const spec = SPECIALISTS[specKey];

      if (!spec || !spec.event_type_uri) {
        // Can't book without configured event type — return fallback
        const fallbackSpec = spec || SPECIALISTS.rogier;
        res.json({
          booked: false,
          fallback: true,
          fallback_url: fallbackSpec.fallback_url,
          spoken: `I wasn't able to book that slot directly. I'll send you a calendar link by email instead.`,
          spoken_nl: `Het is mij niet gelukt om dat tijdslot direct te boeken. Ik stuur u een agenda-link per e-mail.`,
        });
        sendFallbackEmail({ email, name, spec: fallbackSpec, language });
        return;
      }

      console.log(`[CALENDLY] Booking ${name} with ${spec.name} at ${start_time}...`);
      const booking = await createBooking(spec.event_type_uri, {
        name: name || "Prospect",
        email,
        start_time,
        timezone: timezone || "Europe/Amsterdam",
        notes: notes || `Booked by Aria (AI SDR) during outbound call`,
      });

      // Format confirmation for voice
      const tz = timezone || "Europe/Amsterdam";
      const dt = new Date(start_time);
      const dateStr = dt.toLocaleDateString("en-GB", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
      const timeStr = dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hourCycle: "h12", timeZone: tz });
      const dateStrNL = dt.toLocaleDateString("nl-NL", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
      const timeStrNL = dt.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: tz });

      res.json({
        booked: true,
        booking_uri: booking.resource?.uri || null,
        event_uri: booking.resource?.event || null,
        specialist: spec.name,
        datetime: start_time,
        spoken: `You're all set. I've booked your demo with ${spec.name} for ${dateStr} at ${timeStr}. You'll receive a calendar invite at ${email} shortly.`,
        spoken_nl: `Het is geregeld. Ik heb uw demo met ${spec.name} ingepland op ${dateStrNL} om ${timeStrNL}. U ontvangt binnenkort een agenda-uitnodiging op ${email}.`,
      });
    } catch (err) {
      console.error("[CALENDLY] Booking failed:", err.message);
      const _b = (req.body && req.body.args && typeof req.body.args === "object") ? req.body.args : (req.body || {});
      const specKey = _b.specialist || getDefaultSpecialist() || "rogier";
      const spec = SPECIALISTS[specKey] || SPECIALISTS.rogier;
      res.json({
        booked: false,
        fallback: true,
        fallback_url: spec.fallback_url,
        spoken: `I wasn't able to book that slot directly. I'll send you a calendar link by email instead.`,
        spoken_nl: `Het is mij niet gelukt om dat tijdslot direct te boeken. Ik stuur u een agenda-link per e-mail.`,
        error: err.message,
      });
      sendFallbackEmail({ email: _b.email, name: _b.name, spec, language: _b.language });
    }
  });

  /**
   * GET /calendly/status
   *
   * Health/config check for Calendly integration.
   */
  app.get("/calendly/status", async (_req, res) => {
    let eventTypes = null;
    try {
      if (CALENDLY_API_TOKEN) {
        await resolveEventTypes();
        eventTypes = Object.values(_eventTypeCache || {}).map((et) => ({
          name: et.name,
          slug: et.slug,
          duration: et.duration,
        }));
      }
    } catch (err) {
      // Non-fatal — just report config status
    }

    res.json({
      configured: !!CALENDLY_API_TOKEN,
      specialists: Object.entries(SPECIALISTS).map(([key, val]) => ({
        key,
        name: val.name,
        event_type_configured: !!val.event_type_uri,
        fallback_url: val.fallback_url,
      })),
      discovered_event_types: eventTypes,
    });
  });
}

module.exports = {
  registerRoutes,
  getAvailability,
  createBooking,
  formatSlotsForVoice,
  resolveEventTypes,
  getDefaultSpecialist,
  SPECIALISTS,
};
