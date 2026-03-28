/**
 * Scala Auxilium — TidyCal Integration Module
 *
 * Proxy endpoints for Retell AI agents to check availability
 * and book meetings via TidyCal API during live calls.
 *
 * TidyCal API docs: https://tidycal.com/api/docs
 *
 * Environment variables:
 *   TIDYCAL_API_TOKEN         – TidyCal API token (from Settings → API)
 *   TIDYCAL_BOOKING_PAGE_ROGIER – Booking page slug for Rogier (e.g., "rogier-sendsteps-demo")
 *   TIDYCAL_BOOKING_PAGE_MIKE   – Booking page slug for Mike
 *
 * Retell Custom Function integration:
 *   These endpoints are called from Retell agent flow nodes via
 *   the "Custom Function" (webhook) action during a live call.
 */

const TIDYCAL_API_BASE = "https://tidycal.com/api";
const TIDYCAL_API_TOKEN = process.env.TIDYCAL_API_TOKEN || null;

// Booking page mapping — Sendsteps demo specialists
const BOOKING_PAGES = {
  rogier: {
    slug: process.env.TIDYCAL_BOOKING_PAGE_ROGIER || null,
    name: "Rogier",
    fallback_url: process.env.TIDYCAL_FALLBACK_URL_ROGIER || "https://tidycal.com/sendsteps/rogier-demo",
  },
  mike: {
    slug: process.env.TIDYCAL_BOOKING_PAGE_MIKE || null,
    name: "Mike",
    fallback_url: process.env.TIDYCAL_FALLBACK_URL_MIKE || "https://tidycal.com/sendsteps/mike-demo",
  },
};

// Default specialist assignment (can be made smarter later)
function getDefaultSpecialist(language) {
  // Route NL calls to Rogier (Dutch speaker), EN calls to Mike
  if (language && language.toLowerCase().includes("nl")) return "rogier";
  return "mike";
}

// ─── TidyCal API helpers ──────────────────────────────────────────────────────

async function tidycalFetch(endpoint, options = {}) {
  if (!TIDYCAL_API_TOKEN) {
    throw new Error("TIDYCAL_API_TOKEN not configured. Ask Piet to set it in Railway env vars.");
  }

  const url = `${TIDYCAL_API_BASE}${endpoint}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${TIDYCAL_API_TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => "Unknown error");
    throw new Error(`TidyCal API ${resp.status}: ${err}`);
  }

  return resp.json();
}

/**
 * Get available time slots for a booking page.
 *
 * @param {string} bookingPageSlug - TidyCal booking page slug
 * @param {string} startDate - ISO date string (YYYY-MM-DD), defaults to tomorrow
 * @param {number} days - Number of days to look ahead (default: 5)
 * @returns {Object} Available slots grouped by date
 */
async function getAvailability(bookingPageSlug, startDate, days = 5) {
  if (!bookingPageSlug) {
    throw new Error("Booking page slug not configured");
  }

  // Default to tomorrow
  if (!startDate) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    startDate = tomorrow.toISOString().split("T")[0];
  }

  // Calculate end date
  const end = new Date(startDate);
  end.setDate(end.getDate() + days);
  const endDate = end.toISOString().split("T")[0];

  // TidyCal API: GET /bookings/available_slots?booking_page={slug}&start_date={date}&end_date={date}
  const data = await tidycalFetch(
    `/bookings/available_slots?booking_page=${encodeURIComponent(bookingPageSlug)}&start_date=${startDate}&end_date=${endDate}`
  );

  return data;
}

/**
 * Create a booking on TidyCal.
 *
 * @param {string} bookingPageSlug - TidyCal booking page slug
 * @param {Object} bookingDetails - { name, email, start_time, timezone }
 * @returns {Object} Booking confirmation
 */
async function createBooking(bookingPageSlug, bookingDetails) {
  if (!bookingPageSlug) {
    throw new Error("Booking page slug not configured");
  }

  const payload = {
    booking_page: bookingPageSlug,
    name: bookingDetails.name || "Prospect",
    email: bookingDetails.email,
    starts_at: bookingDetails.start_time, // ISO 8601
    timezone: bookingDetails.timezone || "Europe/Amsterdam",
    ...(bookingDetails.notes ? { notes: bookingDetails.notes } : {}),
  };

  const data = await tidycalFetch("/bookings", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return data;
}

/**
 * Format available slots into a human-readable list for Aria to read aloud.
 * Returns the 3 nearest available slots as a conversational string.
 *
 * @param {Object} availabilityData - Raw TidyCal API response
 * @param {string} timezone - Display timezone (default: Europe/Amsterdam)
 * @returns {Object} { slots: Array, spoken: string, count: number }
 */
function formatSlotsForVoice(availabilityData, timezone = "Europe/Amsterdam") {
  // Extract and flatten all available slots
  const allSlots = [];

  // TidyCal returns { data: [ { date: "2026-04-01", slots: ["09:00", "09:30", ...] } ] }
  // or similar structure — adapt based on actual API response
  const days = availabilityData.data || availabilityData.available_slots || availabilityData || [];

  if (Array.isArray(days)) {
    for (const day of days) {
      if (day.slots && Array.isArray(day.slots)) {
        for (const slot of day.slots) {
          allSlots.push({
            date: day.date,
            time: typeof slot === "string" ? slot : slot.time || slot.starts_at,
            iso: typeof slot === "object" && slot.starts_at ? slot.starts_at : `${day.date}T${slot}`,
          });
        }
      } else if (day.starts_at) {
        // Flat list of slots
        const dt = new Date(day.starts_at);
        allSlots.push({
          date: dt.toISOString().split("T")[0],
          time: dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone }),
          iso: day.starts_at,
        });
      }
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

  // Format for voice — e.g. "Tuesday April 1st at 10 AM, Wednesday April 2nd at 2 PM, or Thursday April 3rd at 11 AM"
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
    const dt = new Date(s.iso);
    const dayStr = dateFormatter.format(dt);
    const timeStr = dt.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: timezone });
    return `${dayStr} at ${timeStr}`;
  });

  const spokenPartsNL = topSlots.map((s) => {
    const dt = new Date(s.iso);
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
    slots: topSlots,
    spoken,
    spoken_nl,
    count: topSlots.length,
  };
}

// ─── Express route handlers ──────────────────────────────────────────────────

function registerRoutes(app) {
  /**
   * GET /tidycal/availability
   *
   * Called by Retell Custom Function during a live call.
   * Returns available time slots formatted for voice.
   *
   * Query params:
   *   specialist - "rogier" or "mike" (optional, defaults based on language)
   *   language   - "en" or "nl" (for specialist routing + voice format)
   *   start_date - YYYY-MM-DD (optional, defaults to tomorrow)
   *   days       - number of days to look ahead (default: 5)
   */
  app.get("/tidycal/availability", async (req, res) => {
    try {
      const { specialist, language, start_date, days } = req.query;

      // Determine which booking page to check
      const specKey = specialist || getDefaultSpecialist(language);
      const page = BOOKING_PAGES[specKey];

      if (!page) {
        return res.status(400).json({ error: `Unknown specialist: '${specKey}'. Use: ${Object.keys(BOOKING_PAGES).join(", ")}` });
      }

      if (!page.slug) {
        // TidyCal not configured yet — return fallback
        console.log(`[TIDYCAL] Booking page not configured for ${specKey}, returning fallback URL`);
        return res.json({
          available: false,
          fallback: true,
          fallback_url: page.fallback_url,
          spoken: `I'll send you a calendar link by email so you can pick a time that suits you best.`,
          spoken_nl: `Ik stuur u een agenda-link per e-mail zodat u zelf het beste moment kunt kiezen.`,
          specialist: page.name,
        });
      }

      console.log(`[TIDYCAL] Checking availability for ${page.name} (${page.slug})...`);
      const availability = await getAvailability(page.slug, start_date, parseInt(days) || 5);
      const formatted = formatSlotsForVoice(availability);

      res.json({
        available: formatted.count > 0,
        fallback: formatted.count === 0,
        fallback_url: formatted.count === 0 ? page.fallback_url : null,
        specialist: page.name,
        ...formatted,
      });
    } catch (err) {
      console.error("[TIDYCAL] Availability check failed:", err.message);
      // On error, fall back to email-based booking
      const specKey = req.query.specialist || getDefaultSpecialist(req.query.language);
      const page = BOOKING_PAGES[specKey] || BOOKING_PAGES.mike;
      res.json({
        available: false,
        fallback: true,
        fallback_url: page.fallback_url,
        spoken: `I'll send you a calendar link by email so you can pick a time that suits you best.`,
        spoken_nl: `Ik stuur u een agenda-link per e-mail zodat u zelf het beste moment kunt kiezen.`,
        specialist: page.name,
        error: err.message,
      });
    }
  });

  /**
   * POST /tidycal/book
   *
   * Called by Retell Custom Function to confirm a booking.
   *
   * Body:
   *   specialist  - "rogier" or "mike"
   *   start_time  - ISO 8601 datetime selected by prospect
   *   name        - Prospect name
   *   email       - Prospect email
   *   timezone    - Prospect timezone (default: Europe/Amsterdam)
   *   notes       - Optional notes
   *   language    - "en" or "nl" (for voice response)
   */
  app.post("/tidycal/book", async (req, res) => {
    try {
      const { specialist, start_time, name, email, timezone, notes, language } = req.body;

      if (!start_time) {
        return res.status(400).json({ error: "Missing start_time" });
      }
      if (!email) {
        return res.status(400).json({ error: "Missing email" });
      }

      const specKey = specialist || getDefaultSpecialist(language);
      const page = BOOKING_PAGES[specKey];

      if (!page || !page.slug) {
        // Can't book without configured page — return fallback
        return res.json({
          booked: false,
          fallback: true,
          fallback_url: (page || BOOKING_PAGES.mike).fallback_url,
          spoken: `I wasn't able to book that slot directly. I'll send you a calendar link by email instead.`,
          spoken_nl: `Het is mij niet gelukt om dat tijdslot direct te boeken. Ik stuur u een agenda-link per e-mail.`,
        });
      }

      console.log(`[TIDYCAL] Booking ${name} with ${page.name} at ${start_time}...`);
      const booking = await createBooking(page.slug, {
        name: name || "Prospect",
        email,
        start_time,
        timezone: timezone || "Europe/Amsterdam",
        notes: notes || `Booked by Aria (AI SDR) during outbound call`,
      });

      const dt = new Date(start_time);
      const dateStr = dt.toLocaleDateString("en-GB", { weekday: "long", month: "long", day: "numeric", timeZone: timezone || "Europe/Amsterdam" });
      const timeStr = dt.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: timezone || "Europe/Amsterdam" });
      const dateStrNL = dt.toLocaleDateString("nl-NL", { weekday: "long", month: "long", day: "numeric", timeZone: timezone || "Europe/Amsterdam" });
      const timeStrNL = dt.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: timezone || "Europe/Amsterdam" });

      res.json({
        booked: true,
        booking_id: booking.id || booking.data?.id,
        specialist: page.name,
        datetime: start_time,
        spoken: `You're all set. I've booked your demo with ${page.name} for ${dateStr} at ${timeStr}. You'll receive a calendar invite at ${email} shortly.`,
        spoken_nl: `Het is geregeld. Ik heb uw demo met ${page.name} ingepland op ${dateStrNL} om ${timeStrNL}. U ontvangt binnenkort een agenda-uitnodiging op ${email}.`,
      });
    } catch (err) {
      console.error("[TIDYCAL] Booking failed:", err.message);
      const specKey = req.body.specialist || getDefaultSpecialist(req.body.language);
      const page = BOOKING_PAGES[specKey] || BOOKING_PAGES.mike;
      res.json({
        booked: false,
        fallback: true,
        fallback_url: page.fallback_url,
        spoken: `I wasn't able to book that slot directly. I'll send you a calendar link by email instead.`,
        spoken_nl: `Het is mij niet gelukt om dat tijdslot direct te boeken. Ik stuur u een agenda-link per e-mail.`,
        error: err.message,
      });
    }
  });

  /**
   * GET /tidycal/status
   *
   * Health/config check for TidyCal integration.
   */
  app.get("/tidycal/status", (_req, res) => {
    res.json({
      configured: !!TIDYCAL_API_TOKEN,
      booking_pages: Object.entries(BOOKING_PAGES).map(([key, val]) => ({
        key,
        name: val.name,
        slug_configured: !!val.slug,
        fallback_url: val.fallback_url,
      })),
    });
  });
}

module.exports = {
  registerRoutes,
  getAvailability,
  createBooking,
  formatSlotsForVoice,
  getDefaultSpecialist,
  BOOKING_PAGES,
};
