// sendsteps-chat.js
// Chat-Aria V1 EN — handler module for the Sendsteps registration-page chatbot.
//
// Pattern matches existing modules (calendly.js, interaction-scorer.js):
//   - registerRoutes(app, deps) → wires HTTP endpoints into the main Express app
//   - mapRetellToSendstepsChat(flat, transcript) → extracts our normalized payload
//   - processSendstepsChat(lead, deps) → creates Zoho lead + sends Resend email
//
// Used inside /webhooks/retell handler when agent_id matches CHAT_ARIA_AGENT_ID.
// Author: Chat-Aria V1, 2026-05-07

const ZOHO_CRM_BASE      = "https://www.zohoapis.eu/crm/v2";

// ─── Routing — mirrors voice-Aria + Sendsteps lead prioritization framework ──
const SALES_MANAGERS = {
  petrus: {
    name: "Petrus",
    email: "petrusc@adsum-auxilio.com",
    zohoOwnerIdEnv: "ZOHO_OWNER_ID_PETRUS",
    calendlyEventTypeEnv: "CALENDLY_EVENT_TYPE_PETRUS",
    calendlyFallbackUrlEnv: "CALENDLY_FALLBACK_URL_PETRUS",
    handles: ["GB", "ES", "MX", "AR", "CL", "CO", "PE", "VE", "UY", "PY", "BO", "EC", "DO", "GT", "HN", "NI", "CR", "PA", "CU"],
  },
  rogier: {
    name: "Rogier",
    email: "rogier.smulders@sendsteps.com",
    zohoOwnerIdEnv: "ZOHO_OWNER_ID_ROGIER",
    calendlyEventTypeEnv: "CALENDLY_EVENT_TYPE_ROGIER",
    calendlyFallbackUrlEnv: "CALENDLY_FALLBACK_URL_ROGIER",
    handles: ["NL", "BE"],
  },
  mike: {
    name: "Mike",
    email: "mike.coumans@sendsteps.com",
    zohoOwnerIdEnv: "ZOHO_OWNER_ID_MIKE",
    calendlyEventTypeEnv: "CALENDLY_EVENT_TYPE_MIKE",
    calendlyFallbackUrlEnv: "CALENDLY_FALLBACK_URL_MIKE",
    handles: ["US"],
  },
};

function routeByCountry(countryCode) {
  if (!countryCode) return "petrus";
  const cc = String(countryCode).toUpperCase();
  for (const [key, mgr] of Object.entries(SALES_MANAGERS)) {
    if (mgr.handles.includes(cc)) return key;
  }
  return "petrus"; // default fallback per Petrus 2026-05-07
}

// ─── Outcome → Aria_Status mapping (reuses existing Sendsteps Zoho values) ──
// Verified 2026-05-07 against actual Zoho Leads schema (213 fields).
// New picklist value to add manually: "Chat - Abandoned" in Aria_Status.
function mapOutcomeToAriaStatus(outcome, predictedTier) {
  // Tier 4 outbound-handoff → triggers existing voice-Aria dispatch flow
  if (outcome === "outbound-handoff" || (String(predictedTier) === "4" && outcome !== "demo-booked" && outcome !== "demo-link-sent")) {
    return "Ready for Aria EN";
  }
  switch (outcome) {
    case "demo-booked":     return "Completed - Meeting Booked";    // existing
    case "demo-link-sent":  return "Completed - Email Follow-up";   // existing
    case "trial-routed":    return "Completed - Warm Nurture";      // existing
    case "abandoned":       return "Chat - Abandoned";              // NEW — add manually
    case "handoff-human":   return "Completed - Transfer to Human"; // existing
    default:                return "Completed - Warm Nurture";
  }
}

// ─── Build structured Aria_Notes block ──────────────────────────────────────
function buildAriaNotes(payload) {
  const lines = [
    `[Chat-Aria | ${new Date().toISOString().slice(0, 10)} | ${(payload.language || "en").toUpperCase()} | Tier ${payload.predicted_tier} (${payload.tier_confidence})]`,
    `Audience size: ${payload.audience_size_inferred || "unknown"}`,
    `Use case: ${payload.use_case_inferred || "unknown"}`,
    `Outcome: ${payload.outcome}`,
  ];
  if (payload.calendly_event_uri) lines.push(`Calendly: ${payload.calendly_event_uri}`);
  lines.push(`Summary: ${payload.conversation_summary || "(no summary)"}`);
  return lines.join("\n");
}

// ─── Map Retell post-chat analysis → normalized payload ─────────────────────
function mapRetellToSendstepsChat(flatAnalysis, transcript, callId) {
  if (!flatAnalysis) return null;

  const visitor_email = (flatAnalysis.visitor_email || "").trim();
  const visitor_name  = (flatAnalysis.visitor_name  || "").trim();

  // Guard: must have email to create a lead
  if (!visitor_email) {
    console.log("  [chat-aria] No email captured — anonymous chat, no lead created");
    return null;
  }

  return {
    session_id: callId,
    language: "en",
    visitor_email,
    visitor_name,
    institution_name_inferred:    flatAnalysis.institution_name_inferred || "",
    institution_country_inferred: flatAnalysis.institution_country_inferred || "",
    role_inferred:                flatAnalysis.role_inferred || "unknown",
    audience_size_inferred:       flatAnalysis.audience_size_inferred || "unknown",
    use_case_inferred:            flatAnalysis.use_case_inferred || "unknown",
    predicted_tier:               String(flatAnalysis.predicted_tier || "4"),
    tier_confidence:              flatAnalysis.tier_confidence || "low",
    predicted_pql_signal:         parseInt(flatAnalysis.predicted_pql_signal, 10) || 0,
    outcome:                      flatAnalysis.outcome || "abandoned",
    calendly_event_uri:           flatAnalysis.calendly_event_uri || "",
    conversation_summary:         flatAnalysis.conversation_summary || "",
  };
}

// ─── Build a prefilled Zoho CreateLead URL for the alert email ──────────────
// V1 approach: skip auto-create. Sales managers click the button in the email
// → Zoho opens with all fields pre-filled → they review + save in ~20s.
// This avoids needing the ZohoCRM.modules.leads.CREATE OAuth scope.
function buildZohoCreateLeadUrl(payload) {
  const nameParts = (payload.visitor_name || "").trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName  = nameParts.slice(1).join(" ") || "—";

  const params = {
    Email: payload.visitor_email || "",
    First_Name: firstName,
    Last_Name: lastName,
    Company: payload.institution_name_inferred || "",
    Country: payload.institution_country_inferred || "",
    Lead_Source: "Sendsteps Chat — Aria",
    Language: "English",
    Score: String(payload.predicted_pql_signal || 0),
    Aria_Status: mapOutcomeToAriaStatus(payload.outcome, payload.predicted_tier),
    Aria_Notes: buildAriaNotes(payload),
    Description: payload.conversation_summary || "",
  };

  const qs = Object.entries(params)
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  return `https://crm.zoho.eu/crm/CreateLead?${qs}`;
}

// ─── Email template (Resend HTML) ───────────────────────────────────────────
const TIER_COLORS = {
  "1": { bg: "#C00000", label: "TIER 1 — HOT" },
  "2": { bg: "#ED7D31", label: "TIER 2 — WARM" },
  "3": { bg: "#4472C4", label: "TIER 3 — NURTURE" },
  "4": { bg: "#7F7F7F", label: "TIER 4 — OUTBOUND QUEUE" },
};

function buildAlertEmailHtml(payload, mgr) {
  const tier = String(payload.predicted_tier || "4");
  const tc = TIER_COLORS[tier] || TIER_COLORS["4"];
  const calendlyBlock = payload.calendly_event_uri
    ? `<p style="margin:0 0 14px 0;font-size:14px;"><strong>Calendly event:</strong> <a href="${payload.calendly_event_uri}" style="color:#1F3A5F;">${payload.calendly_event_uri}</a></p>`
    : "";
  const createLeadUrl = buildZohoCreateLeadUrl(payload);

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F5F5F5;font-family:Arial,Helvetica,sans-serif;color:#333;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F5F5;padding:30px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#FFF;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
<tr><td style="background:${tc.bg};padding:16px 30px;color:#FFF;font-size:14px;font-weight:bold;letter-spacing:1px;">${tc.label}</td></tr>
<tr><td style="padding:30px 30px 10px 30px;">
<h1 style="margin:0;font-size:24px;color:#1F3A5F;">New Sendsteps Chat Lead</h1>
<p style="margin:8px 0 0 0;font-size:16px;color:#595959;"><strong>${escapeHtml(payload.institution_name_inferred || "—")}</strong> &middot; ${escapeHtml(payload.institution_country_inferred || "—")}</p>
</td></tr>
<tr><td style="padding:0 30px 20px 30px;"><p style="margin:0;font-size:14px;color:#595959;">Routed to <strong>${mgr.name}</strong></p></td></tr>
<tr><td style="padding:0 30px 20px 30px;">
<table width="100%" cellpadding="8" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px;">
<tr><td style="border-top:1px solid #E0E0E0;color:#595959;width:140px;">Visitor</td><td style="border-top:1px solid #E0E0E0;font-weight:bold;">${escapeHtml(payload.visitor_name || "—")}</td></tr>
<tr><td style="border-top:1px solid #E0E0E0;color:#595959;">Email</td><td style="border-top:1px solid #E0E0E0;"><a href="mailto:${escapeHtml(payload.visitor_email)}" style="color:#1F3A5F;">${escapeHtml(payload.visitor_email)}</a></td></tr>
<tr><td style="border-top:1px solid #E0E0E0;color:#595959;">Role</td><td style="border-top:1px solid #E0E0E0;">${escapeHtml(payload.role_inferred || "—")}</td></tr>
<tr><td style="border-top:1px solid #E0E0E0;color:#595959;">Audience size</td><td style="border-top:1px solid #E0E0E0;">${escapeHtml(payload.audience_size_inferred || "—")}</td></tr>
<tr><td style="border-top:1px solid #E0E0E0;color:#595959;">Use case</td><td style="border-top:1px solid #E0E0E0;">${escapeHtml(payload.use_case_inferred || "—")}</td></tr>
<tr><td style="border-top:1px solid #E0E0E0;color:#595959;">Tier confidence</td><td style="border-top:1px solid #E0E0E0;">${escapeHtml(payload.tier_confidence || "—")}</td></tr>
<tr><td style="border-top:1px solid #E0E0E0;color:#595959;">PQL Score</td><td style="border-top:1px solid #E0E0E0;font-weight:bold;">${payload.predicted_pql_signal || 0} / 100</td></tr>
<tr><td style="border-top:1px solid #E0E0E0;color:#595959;">Outcome</td><td style="border-top:1px solid #E0E0E0;">${escapeHtml(payload.outcome || "—")}</td></tr>
</table>
</td></tr>
<tr><td style="padding:0 30px 20px 30px;">
<h3 style="margin:0 0 8px 0;font-size:13px;color:#595959;text-transform:uppercase;letter-spacing:1px;">Conversation summary</h3>
<p style="margin:0;padding:14px 16px;background:#F8F9FA;border-left:4px solid ${tc.bg};font-size:14px;line-height:1.5;border-radius:4px;">${escapeHtml(payload.conversation_summary || "(no summary)")}</p>
</td></tr>
<tr><td style="padding:0 30px 20px 30px;">${calendlyBlock}</td></tr>
<tr><td style="padding:0 30px 8px 30px;">
<a href="${createLeadUrl}" style="display:inline-block;background:#1F3A5F;color:#FFF;padding:14px 28px;text-decoration:none;border-radius:6px;font-size:15px;font-weight:bold;margin-right:8px;margin-bottom:8px;">Create lead in Zoho →</a>
<a href="mailto:${escapeHtml(payload.visitor_email)}" style="display:inline-block;background:#FFF;color:#1F3A5F;padding:14px 28px;text-decoration:none;border:2px solid #1F3A5F;border-radius:6px;font-size:15px;font-weight:bold;margin-bottom:8px;">Email visitor</a>
</td></tr>
<tr><td style="padding:0 30px 24px 30px;font-size:12px;color:#999;line-height:1.5;">
The "Create lead in Zoho" button opens Zoho with all fields pre-filled (visitor details, institution, tier, PQL score, conversation summary). Review and click <strong>Save</strong> to log it in CRM.
</td></tr>
<tr><td style="padding:20px 30px;background:#F8F9FA;border-top:1px solid #E0E0E0;font-size:12px;color:#999;">Chat-Aria V1 &middot; Sendsteps</td></tr>
</table>
</td></tr></table></body></html>`;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ─── Main lead processing ───────────────────────────────────────────────────
// V1: NO auto-create in Zoho. Email alert contains a prefilled "Create lead in
// Zoho" button — sales manager reviews + saves manually (~20 sec). Avoids the
// ZohoCRM.modules.leads.CREATE OAuth scope requirement. All chat data is still
// preserved in the retell_events Postgres table for back-fill if needed.
async function processSendstepsChat(payload, deps) {
  const { sendEmail, NOTIFY_FROM } = deps;
  const routingKey = routeByCountry(payload.institution_country_inferred);
  const mgr = SALES_MANAGERS[routingKey];

  console.log(`  [SS-CHAT] Lead: ${payload.visitor_email} | ${payload.institution_name_inferred || "Unknown Inst"} | Tier ${payload.predicted_tier} | → ${mgr.name}`);

  // Send email alert (skip Tier 4 — voice-Aria handles those via outbound)
  const tier = String(payload.predicted_tier || "4");
  if (tier === "4") {
    console.log(`  [SS-CHAT] Tier 4 → no email alert (queued for voice-Aria outbound)`);
    return { routedTo: routingKey, tier, email: "skipped_tier4" };
  }

  if (!sendEmail) {
    console.warn(`  [WARN] sendEmail not provided — cannot send Tier ${tier} alert`);
    return { routedTo: routingKey, tier, email: "not_configured" };
  }

  const subject = `[Tier ${tier}] New Sendsteps Chat Lead: ${payload.institution_name_inferred || payload.visitor_name || "Unknown"}`;
  const html = buildAlertEmailHtml(payload, mgr);
  const text = `Tier ${tier} - New Sendsteps Chat Lead\n\nInstitution: ${payload.institution_name_inferred}\nVisitor: ${payload.visitor_name} (${payload.visitor_email})\nRole: ${payload.role_inferred}\nOutcome: ${payload.outcome}\nRouted to: ${mgr.name}\n\nSummary: ${payload.conversation_summary}\n\nCreate lead in Zoho: ${buildZohoCreateLeadUrl(payload)}`;

  try {
    await sendEmail({
      from: NOTIFY_FROM || "notifications@adsum-auxilio.com",
      to: [mgr.email],
      subject,
      text,
      html,
    });
    console.log(`  [SS-CHAT] Alert email sent to ${mgr.email}`);
    return { routedTo: routingKey, tier, email: "sent" };
  } catch (err) {
    console.error(`  [ERR] Email send failed:`, err.message);
    return { routedTo: routingKey, tier, email: "failed", error: err.message };
  }
}

// ─── Route registration: book_demo endpoint (called by Aria mid-chat) ───────
function registerRoutes(app, deps) {
  const { sendEmail, NOTIFY_FROM, NOTIFY_SECRET } = deps;

  app.post("/sendsteps-chat/book-demo", async (req, res) => {
    // Auth check (Aria's tool call carries the secret in X-Webhook-Secret header)
    if (NOTIFY_SECRET && req.headers["x-webhook-secret"] !== NOTIFY_SECRET) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { visitor_email, visitor_name, preferred_day, routing_key, institution_name } = req.body || {};
    if (!visitor_email || !visitor_name || !routing_key) {
      return res.status(400).json({ success: false, message: "Missing required fields (visitor_email, visitor_name, routing_key)" });
    }
    const mgr = SALES_MANAGERS[routing_key];
    if (!mgr) {
      return res.status(400).json({ success: false, message: `Invalid routing_key: ${routing_key}` });
    }

    // Build Calendly URL with prefilled name + email
    const eventType = process.env[mgr.calendlyEventTypeEnv];
    const fallbackUrl = process.env[mgr.calendlyFallbackUrlEnv];
    const baseUrl = eventType
      ? `https://calendly.com/${eventType}`
      : (fallbackUrl || `https://calendly.com/${SALES_MANAGERS.petrus.calendlyEventTypeEnv}`);
    const params = new URLSearchParams({
      name: visitor_name,
      email: visitor_email,
    });
    const calendlyUrl = `${baseUrl}?${params.toString()}`;

    // Send confirmation email to visitor
    const firstName = visitor_name.split(" ")[0];
    const subject = `Confirm your Sendsteps demo with ${mgr.name}`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
      <h2 style="color:#1F3A5F;">You're almost booked, ${escapeHtml(firstName)}!</h2>
      <p>Click the link below to lock in your 15-minute Sendsteps demo with <strong>${escapeHtml(mgr.name)}</strong>:</p>
      <p style="text-align:center;margin:30px 0;">
        <a href="${calendlyUrl}" style="background:#1F3A5F;color:#FFF;padding:14px 28px;text-decoration:none;border-radius:6px;font-weight:bold;">Confirm your demo slot</a>
      </p>
      <p style="font-size:13px;color:#666;">If you have any questions before then, just reply to this email.</p>
      <p>— ${escapeHtml(mgr.name)}<br>Sendsteps</p>
    </div>`;

    try {
      await sendEmail({
        from: NOTIFY_FROM || "notifications@adsum-auxilio.com",
        to: [visitor_email],
        subject,
        text: `Confirm your Sendsteps demo: ${calendlyUrl}`,
        html,
      });
      console.log(`  [SS-CHAT] book_demo: confirmation sent to ${visitor_email} (${mgr.name})`);
      return res.json({
        success: true,
        message: `I've sent the confirmation link to ${visitor_email}. Click the button in the email to lock in your slot with ${mgr.name}. Anything else?`,
        calendly_event_uri: calendlyUrl,
      });
    } catch (err) {
      console.error(`  [ERR] book_demo email failed:`, err.message);
      return res.status(500).json({ success: false, message: "Email send failed" });
    }
  });
}

module.exports = {
  CHAT_ARIA_AGENT_ID: "agent_4edb3c94541c725dd1c5c344de",
  mapRetellToSendstepsChat,
  processSendstepsChat,
  registerRoutes,
  routeByCountry,
  mapOutcomeToAriaStatus,
  SALES_MANAGERS,
};
