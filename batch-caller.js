/**
 * Scala Auxilium — Retell Batch Call Dispatcher
 *
 * Reads a prospect list (JSON) and dispatches batch calls via Retell API.
 * Designed to be called from a simple upload endpoint or run standalone.
 *
 * Usage (standalone):
 *   node batch-caller.js --file prospects.json --agent aria_en --dry-run
 *   node batch-caller.js --file prospects.json --agent aria_nl --send
 *
 * Usage (as module):
 *   const { createBatchCall, parseProspectList } = require('./batch-caller');
 *   const result = await createBatchCall(prospects, { agent: 'aria_en' });
 */

const fs = require("fs");
const path = require("path");

// ─── Config ─────────────────────────────────────────────────────────────────
const RETELL_API_KEY = process.env.RETELL_API_KEY || null;
const RETELL_API_BASE = "https://api.retellai.com";

// Agent configs — maps friendly names to Retell agent IDs and phone numbers
const AGENTS = {
  aria_en: {
    agent_id: "agent_aa56b68b02f6de4ac5725a829b",
    label: "Aria EN (Sendsteps)",
    from_number: process.env.ARIA_EN_FROM_NUMBER || null, // Set in env, e.g. +312071636XX
  },
  aria_en_uk: {
    agent_id: "agent_aa56b68b02f6de4ac5725a829b",
    label: "Aria EN UK (Sendsteps)",
    from_number: process.env.ARIA_EN_UK_FROM_NUMBER || null, // UK DID: +447863759619
  },
  aria_nl: {
    agent_id: "agent_e1e1f763101db5abe0df281891",
    label: "Aria NL (Sendsteps)",
    from_number: process.env.ARIA_NL_FROM_NUMBER || null,
  },
  // Scout — single-purpose contact-capture agent (captures the right person's
  // email from university switchboards; no pitch, no booking). Reuses the UK DID
  // (same caller ID as Aria UK) unless a dedicated SCOUT_UK_FROM_NUMBER is set.
  scout_uk: {
    agent_id: "agent_0d66a2ab3209717eba1170b76a",
    label: "Scout UK (Sendsteps)",
    from_number: process.env.SCOUT_UK_FROM_NUMBER || process.env.ARIA_EN_UK_FROM_NUMBER || null,
    // Scout reuses Aria's UK DID, which is bound to the ARIA agent for outbound.
    // Retell BATCH calls dispatch using the number's bound agent and IGNORE the
    // payload agent_id — so a batch dispatch on the shared number would run Aria,
    // not Scout. force_agent_override makes createBatchCall dispatch each task via
    // single create-phone-call with override_agent_id, which forces the Scout
    // agent regardless of the number binding. (Remove this once Scout has its own
    // dedicated DID bound to the Scout agent.)
    force_agent_override: true,
  },
  // Scout US — same Scout agent, dials from the US DID (+1 507 577 5551).
  // The US DID is bound to the Aria agent in Retell, so we need the same
  // force_agent_override pattern as scout_uk to ensure Scout runs (not Aria).
  // Promotion from scout_uk → scout_us happens in /zoho/aria-trigger when
  // the lead's Country is United States.
  scout_us: {
    agent_id: "agent_0d66a2ab3209717eba1170b76a",
    label: "Scout US (Sendsteps)",
    from_number: process.env.SCOUT_US_FROM_NUMBER || process.env.ARIA_EN_FROM_NUMBER || null,
    force_agent_override: true,
  },
};

// CET calling window: Mon–Fri 09:00–17:00
const CALLING_WINDOW = {
  timezone: "Europe/Amsterdam",
  windows: [
    { day: 1, start_min: 540, end_min: 1020 }, // Mon 09:00–17:00
    { day: 2, start_min: 540, end_min: 1020 }, // Tue
    { day: 3, start_min: 540, end_min: 1020 }, // Wed
    { day: 4, start_min: 540, end_min: 1020 }, // Thu
    { day: 5, start_min: 540, end_min: 1020 }, // Fri
  ],
};

// ─── Lead Owner → Calendly Specialist mapping ────────────────────────────────
// Maps Zoho CRM Lead Owner to Calendly specialist key.
// Owner field from Zoho is a JSON object: { name, id, email }
// Known owners:
//   Rogier Smulders          (rogier.smulders@sendsteps.com)   → "rogier" (NL)
//   Mike Coumans l Sendsteps (mike.coumans@sendsteps.com)      → "mike"   (NL)
//   Petrus Coelewij          (petrus.coelewij@sendsteps.com)   → "pete"   (UK leads)
const OWNER_TO_SPECIALIST = {
  // Match by Zoho user ID (most reliable, never changes)
  "437076000003563557": "rogier",   // Rogier Smulders
  "437076000003563509": "mike",     // Mike Coumans
  "437076000388674001": "pete",     // Petrus Coelewij (UK)
  // Match by email (fallback)
  "rogier.smulders@sendsteps.com": "rogier",
  "mike.coumans@sendsteps.com": "mike",
  "petrus.coelewij@sendsteps.com": "pete",
};

function mapOwnerToSpecialist(ownerObj) {
  if (!ownerObj) return null;

  // Try by Zoho user ID first (most reliable)
  const byId = OWNER_TO_SPECIALIST[String(ownerObj.id)];
  if (byId) return byId;

  // Try by email
  const email = (ownerObj.email || "").toLowerCase();
  const byEmail = OWNER_TO_SPECIALIST[email];
  if (byEmail) return byEmail;

  // Try by name (partial match on first name)
  const name = (ownerObj.name || "").toLowerCase();
  if (name.includes("rogier")) return "rogier";
  if (name.includes("mike")) return "mike";
  if (name.includes("petrus") || name.includes("pete") || name.includes("coelewij")) return "pete";

  // Unknown owner — log warning, return null (caller decides fallback)
  console.warn(`[OWNER] Unknown lead owner: ${JSON.stringify(ownerObj)} — cannot map to specialist`);
  return null;
}

// ─── Zoho CRM Record → Prospect mapping ─────────────────────────────────────
// Zoho Flow sends record data in Zoho CRM field names. This maps to our format.
//
// Historically only Leads were supported (function was mapZohoLead). As of
// 2026-07-13 the receiver also handles Contacts — the field set is identical
// (Aria_*/Scout_* fields are duplicated across both modules, propagated on
// Lead conversion by explicit conversion mapping). The `module` param is used
// to (a) preserve module identity through the outbound Retell call, and
// (b) route write-back to the correct API endpoint (/Leads vs /Contacts).
//
// Default is "Leads" for backward-compat with any caller that predates
// the multi-module refactor. Also detects Contact-specific fields (e.g.
// Account_Name lookup) and auto-flips module in that case.
function mapZohoRecord(zohoRecord, moduleArg) {
  // Auto-detect module from payload shape if not explicitly provided.
  // Contact records carry Account_Name (lookup) and lack Lead_Source/Company.
  // If caller passes explicit module, trust it. If _module is embedded in the
  // Zoho Flow payload (recommended pattern), use that. Fallback: Leads.
  let module = moduleArg
    || zohoRecord._module
    || zohoRecord.Module
    || (zohoRecord.Account_Name && !zohoRecord.Lead_Source ? "Contacts" : "Leads");

  const firstName = zohoRecord.First_Name || zohoRecord.first_name || "";
  const lastName = zohoRecord.Last_Name || zohoRecord.last_name || "";
  const eduLevel = zohoRecord.Edu_level || zohoRecord.edu_level || "";
  const jobTitle = zohoRecord.Job_Title_Edu || zohoRecord.Job_Title_Business || zohoRecord.Job_Title_Business1 || zohoRecord.job_title_edu || "";

  // Owner shape identical on Leads and Contacts. See legacy notes below.
  // Zoho Flow webhook sends Owner as a plain string (display name) plus separate
  // Owner_Name and Owner_Email fields (when configured in the webhook body).
  // The CRM API sends Owner as a full object { id, name, email }.
  const ownerRaw = zohoRecord.Owner || zohoRecord.owner;
  let ownerObj = null;
  if (ownerRaw && typeof ownerRaw === "object") {
    ownerObj = ownerRaw; // CRM API object — use directly
  } else {
    const ownerName = zohoRecord.Owner_Name || zohoRecord.owner_name || (typeof ownerRaw === "string" ? ownerRaw : "");
    const ownerEmail = zohoRecord.Owner_Email || zohoRecord.owner_email || "";
    if (ownerName || ownerEmail) ownerObj = { name: ownerName, email: ownerEmail };
  }
  const specialist = mapOwnerToSpecialist(ownerObj);

  // university_name resolution: Educational_Institute exists on both modules
  // after the 2026-07-13 field-parity work. Contact.Account_Name is a lookup
  // object { name, id } from the CRM API — use its .name when present as a
  // secondary fallback. Company is Lead-only.
  const accountName = (zohoRecord.Account_Name && typeof zohoRecord.Account_Name === "object")
    ? zohoRecord.Account_Name.name
    : (zohoRecord.Account_Name || "");
  const university = zohoRecord.Educational_Institute
    || zohoRecord.Educational_institute
    || accountName
    || zohoRecord.Company
    || zohoRecord.company
    || "";

  // Record ID resolution: Zoho Flow / Deluge serialises the record ID as "ID"
  // (all-caps); CRM API v2 uses "id" (lowercase). We check every casing variant.
  const recordId = zohoRecord.ID || zohoRecord.id || zohoRecord.Id
    || zohoRecord.record_id || zohoRecord.Record_Id
    || zohoRecord.lead_id || zohoRecord.Lead_Id || zohoRecord.LEADID || zohoRecord.Lead_ID
    || zohoRecord.contact_id || zohoRecord.Contact_Id
    || null;

  return {
    phone_number: normalizePhone(zohoRecord.Phone || zohoRecord.phone || ""),
    university_name: university,
    // Retell agent uses {{prospect_first_name}} — keep first/last split
    first_name: firstName,
    last_name: lastName,
    contact_name: [firstName, lastName].filter(Boolean).join(" "),
    contact_title: jobTitle,
    // Retell agent uses {{persona_type}} — derive from edu_level or job title
    persona_type: derivePersonaType(eduLevel, jobTitle),
    department: zohoRecord.Segment || zohoRecord.segment || "",
    country: zohoRecord.Country || zohoRecord.country || "",
    sendsteps_product: zohoRecord.Sendsteps_Product || zohoRecord.sendsteps_product || "Interactive Presentations",
    notes: zohoRecord.Description || zohoRecord.description || "",
    // ── Zoho record identity (round-trips back in call_ended webhook) ──
    // zoho_module + zoho_record_id are the canonical fields introduced 2026-07-13.
    // zoho_lead_id is kept as a legacy alias so any code path (or in-flight call
    // dispatched before the refactor) that reads zoho_lead_id still finds the id.
    zoho_module: module,
    zoho_record_id: recordId,
    zoho_lead_id: recordId, // legacy alias
    edu_level: eduLevel,
    type_of_plan: zohoRecord.Type_of_Plan || zohoRecord.type_of_plan || "",
    language: zohoRecord.Language || zohoRecord.language || "",
    // Email — used by Retell agent to pre-fill booking invite address
    email: zohoRecord.Email || zohoRecord.email || "",
    // Social proof reference university for pitch node
    reference_university: zohoRecord.Reference_University || zohoRecord.reference_university || "TU Delft",
    // Calendly specialist routing (derived from Lead Owner)
    specialist: specialist,
    lead_owner_name: ownerObj ? (ownerObj.name || zohoRecord.Owner_Name || "") : "",
  };
}

// Legacy alias — many callers still import mapZohoLead by name. New code
// should call mapZohoRecord(record, module) explicitly.
function mapZohoLead(zohoLead) {
  return mapZohoRecord(zohoLead);
}

// Derive persona_type for Retell agent (Opener/Qualify/Pitch branch on this)
// Values used in agent flow: "faculty", "procurement"
function derivePersonaType(eduLevel, jobTitle) {
  const combined = `${eduLevel} ${jobTitle}`;
  if (/procure|purchas|inkoop|buyer|tender/i.test(combined)) return "procurement";
  // "IT" and "ICT" must be uppercase (case-sensitive) to avoid matching "it" in titles
  // tech/system admin/infra are case-insensitive
  if (/\bIT\b|\bICT\b/.test(combined)) return "procurement";
  if (/\btech\b|system\s*admin|infra/i.test(combined)) return "procurement";
  // Default to faculty for educators, professors, lecturers, deans, etc.
  return "faculty";
}

// Determine agent from Zoho lead's Aria_Status field
// Matches: "Ready for Aria EN", "Aria EN", "Retry Aria EN", etc.
function agentFromAriaStatus(ariaStatus) {
  if (!ariaStatus) return null;
  const s = ariaStatus.toLowerCase().trim();
  // Match "aria en" or status ending in " en" (but not words like "pending")
  if (/\baria[_ ]en\b/.test(s) || s === "ready for aria en" || s === "retry aria en") return "aria_en";
  if (/\baria[_ ]nl\b/.test(s) || s === "ready for aria nl" || s === "retry aria nl") return "aria_nl";
  // Scout contact-capture agent — triggered by "Ready for Scout" (or "Retry Scout")
  if (/\bscout\b/.test(s) || s === "ready for scout" || s === "retry scout") return "scout_uk";
  // Fallback: check for isolated "en"/"nl" at end of string (e.g. "Queue EN")
  if (/\ben$/.test(s)) return "aria_en";
  if (/\bnl$/.test(s)) return "aria_nl";
  return null;
}

// ─── Phone normalisation ─────────────────────────────────────────────────────
// Converts local/informal phone numbers to E.164 format before validation.
// Rules applied in order:
//   1. Already E.164 (starts with +) → strip formatting inside, keep as-is
//   2. International dialing prefix 00 → replace with +
//   3. Dutch local format: starts with 0, 9-10 digits → +31 + strip leading 0
//   4. US format: 11 digits starting with 1 → prepend +
//   5. US format: 10 digits (typical US) → prepend +1
//   6. Otherwise return cleaned string (E.164 validation will catch bad numbers)
function normalizePhone(phone) {
  if (!phone) return "";
  // Strip whitespace, dashes, dots, parens (works for both "+1 540-665-4538" and "540-665-4538")
  let p = phone.replace(/[\s\-().]/g, "");
  // Already E.164
  if (p.startsWith("+")) return p;
  // International dialing prefix (e.g. 0031... → +31...)
  if (p.startsWith("00")) return "+" + p.slice(2);
  // Dutch local format: 0 + 8-9 more digits = 9-10 digit total (mobile: 06XXXXXXXX, landline: 0XX...)
  if (p.startsWith("0") && /^\d{9,10}$/.test(p)) return "+31" + p.slice(1);
  // US format: 11 digits starting with country code 1 (e.g. "15551234567")
  if (/^1\d{10}$/.test(p)) return "+" + p;
  // US format: 10-digit local (area code + number, area code cannot start with 0 or 1)
  if (/^[2-9]\d{9}$/.test(p)) return "+1" + p;
  // Return cleaned string; validation will flag remaining issues
  return p;
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateE164(phone) {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

function validateProspect(prospect, index) {
  const errors = [];
  if (!prospect.phone_number) errors.push(`Row ${index}: missing phone_number`);
  else if (!validateE164(prospect.phone_number)) errors.push(`Row ${index}: invalid E.164 format '${prospect.phone_number}' — must be +[country][number]`);
  if (!prospect.university_name && !prospect.contact_name) errors.push(`Row ${index}: need at least university_name or contact_name`);
  return errors;
}

// ─── Build Retell batch call payload ────────────────────────────────────────

function buildBatchPayload(prospects, agentKey, options = {}) {
  const agent = AGENTS[agentKey];
  if (!agent) throw new Error(`Unknown agent: ${agentKey}. Use: ${Object.keys(AGENTS).join(", ")}`);
  if (!agent.from_number) throw new Error(`No from_number configured for ${agentKey}. Set ${agentKey.toUpperCase().replace(/_/g, "_")}_FROM_NUMBER env var.`);

  // Extract first name from prospect data (split contact_name if first_name not set)
  function getFirstName(p) {
    if (p.first_name) return p.first_name;
    if (p.contact_name) return p.contact_name.split(" ")[0];
    return "";
  }

  const tasks = prospects.map((p) => ({
    to_number: p.phone_number,
    retell_llm_dynamic_variables: {
      // ── Variables used by Retell agent flow nodes ──
      prospect_first_name: getFirstName(p),           // Confirm Contact, Opener, Closing
      university_name: p.university_name || "",        // Confirm Contact, Book Meeting CTA
      persona_type: p.persona_type || "faculty",       // Opener, Qualify, Value Pitch
      // ── Calendly specialist routing (derived from Lead Owner) ──
      specialist: p.specialist || "",                  // Used by Retell agent when calling /calendly/availability
      lead_owner_name: p.lead_owner_name || "",        // For agent context (e.g. "You'll be meeting with Rogier")
      // ── Extra context (available to global prompt / knowledge base) ──
      contact_name: p.contact_name || "",
      contact_title: p.contact_title || "",
      department: p.department || "",
      sendsteps_product: p.sendsteps_product || "Interactive Presentations",
      notes: p.notes || "",
      // ── Email (pre-fills invite address so Aria doesn't need to ask) ──
      prospect_email: p.email || "",
      reference_university: p.reference_university || "TU Delft",
      // ── Zoho CRM tracking (round-trips back in call_ended webhook) ──
      // zoho_module + zoho_record_id are the canonical fields (2026-07-13+).
      // zoho_lead_id kept as legacy alias so old handler code still finds the id.
      zoho_module: p.zoho_module || "Leads",
      zoho_record_id: p.zoho_record_id || p.zoho_lead_id || "",
      zoho_lead_id: p.zoho_record_id || p.zoho_lead_id || "",
    },
  }));

  const payload = {
    agent_id: agent.agent_id,
    from_number: agent.from_number,
    tasks,
    name: options.name || `Sendsteps ${agentKey.toUpperCase()} batch — ${new Date().toISOString().split("T")[0]}`,
  };

  // Add calling window
  if (!options.skip_window) {
    payload.call_time_window = {
      timezone: CALLING_WINDOW.timezone,
      windows: CALLING_WINDOW.windows.map((w) => ({
        day: [w.day],
        start: w.start_min,
        end: w.end_min,
      })),
    };
  }

  // Schedule for later if specified
  if (options.scheduled_time) {
    payload.scheduled_timestamp = new Date(options.scheduled_time).getTime();
  }

  return payload;
}

// ─── API call ───────────────────────────────────────────────────────────────

async function createBatchCall(prospects, options = {}) {
  const agentKey = options.agent || "aria_en";

  // Validate all prospects
  const allErrors = [];
  prospects.forEach((p, i) => allErrors.push(...validateProspect(p, i + 1)));
  if (allErrors.length > 0) {
    return { success: false, errors: allErrors };
  }

  const payload = buildBatchPayload(prospects, agentKey, options);

  if (options.dry_run) {
    return {
      success: true,
      dry_run: true,
      agent: AGENTS[agentKey].label,
      total_calls: payload.tasks.length,
      from_number: payload.from_number,
      calling_window: payload.call_time_window ? "Mon-Fri 09:00-17:00 CET" : "None (immediate)",
      scheduled: options.scheduled_time || "Now",
      sample_task: payload.tasks[0],
      full_payload: payload,
    };
  }

  if (!RETELL_API_KEY) {
    throw new Error("RETELL_API_KEY not set. Cannot dispatch calls.");
  }

  // ── Agent-override dispatch path (e.g. Scout) ──────────────────────────────
  // When an agent shares another agent's phone number, the Retell BATCH endpoint
  // would run the number's BOUND agent (it ignores payload.agent_id). To force the
  // intended agent, dispatch each task via single create-phone-call with
  // override_agent_id, which the per-call endpoint honours.
  if (AGENTS[agentKey].force_agent_override) {
    const callIds = [];
    for (const task of payload.tasks) {
      const callResp = await fetch(`${RETELL_API_BASE}/v2/create-phone-call`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RETELL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from_number: payload.from_number,
          to_number: task.to_number,
          override_agent_id: AGENTS[agentKey].agent_id,
          retell_llm_dynamic_variables: task.retell_llm_dynamic_variables,
        }),
      });
      if (!callResp.ok) {
        const err = await callResp.json().catch(() => ({}));
        throw new Error(`Retell API error ${callResp.status}: ${JSON.stringify(err)}`);
      }
      const callData = await callResp.json();
      callIds.push(callData.call_id || callData.id);
    }
    return {
      success: true,
      call_ids: callIds,
      agent: AGENTS[agentKey].label,
      total_calls: payload.tasks.length,
      override_agent_id: AGENTS[agentKey].agent_id,
    };
  }

  const resp = await fetch(`${RETELL_API_BASE}/create-batch-call`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RETELL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Retell API error ${resp.status}: ${JSON.stringify(err)}`);
  }

  const data = await resp.json();
  return {
    success: true,
    batch_call_id: data.batch_call_id || data.id,
    agent: AGENTS[agentKey].label,
    total_calls: payload.tasks.length,
    response: data,
  };
}

// ─── Parse prospect list from JSON file ─────────────────────────────────────

function parseProspectList(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw);
  // Support both array and { prospects: [...] } format
  return Array.isArray(data) ? data : data.prospects || data.tasks || [];
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  const agentIdx = args.indexOf("--agent");
  const dryRun = args.includes("--dry-run");
  const send = args.includes("--send");
  const schedIdx = args.indexOf("--schedule");

  if (fileIdx === -1 || !args[fileIdx + 1]) {
    console.log("Usage: node batch-caller.js --file prospects.json --agent aria_en [--dry-run|--send] [--schedule 2026-04-14T09:00:00]");
    console.log("\nAgents: aria_en, aria_nl");
    console.log("Options:");
    console.log("  --dry-run     Validate and show payload without sending");
    console.log("  --send        Actually dispatch the batch call");
    console.log("  --schedule    Schedule for a specific time (ISO 8601)");
    process.exit(1);
  }

  const filePath = args[fileIdx + 1];
  const agentKey = agentIdx !== -1 ? args[agentIdx + 1] : "aria_en";
  const scheduledTime = schedIdx !== -1 ? args[schedIdx + 1] : null;

  if (!send && !dryRun) {
    console.error("ERROR: Specify --dry-run or --send. Safety measure to prevent accidental calls.");
    process.exit(1);
  }

  console.log(`Loading prospects from ${filePath}...`);
  const prospects = parseProspectList(filePath);
  console.log(`Found ${prospects.length} prospects for ${agentKey}`);

  try {
    const result = await createBatchCall(prospects, {
      agent: agentKey,
      dry_run: dryRun,
      scheduled_time: scheduledTime,
    });
    console.log("\n" + JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("FAILED:", err.message);
    process.exit(1);
  }
}

// Run CLI if called directly
if (require.main === module) {
  main();
}

module.exports = { createBatchCall, parseProspectList, buildBatchPayload, validateProspect, mapZohoLead, mapZohoRecord, mapOwnerToSpecialist, agentFromAriaStatus, derivePersonaType, AGENTS, CALLING_WINDOW, OWNER_TO_SPECIALIST };
