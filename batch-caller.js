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
    from_number: process.env.ARIA_EN_FROM_NUMBER || null,
  },
  aria_nl: {
    agent_id: "agent_e1e1f763101db5abe0df281891",
    label: "Aria NL (Sendsteps)",
    from_number: process.env.ARIA_NL_FROM_NUMBER || null,
  },
};
// CET calling window: Mon–Fri 09:00–17:00
const CALLING_WINDOW = {
  timezone: "Europe/Amsterdam",
  windows: [
    { day: 1, start_min: 540, end_min: 1020 },
    { day: 2, start_min: 540, end_min: 1020 },
    { day: 3, start_min: 540, end_min: 1020 },
    { day: 4, start_min: 540, end_min: 1020 },
    { day: 5, start_min: 540, end_min: 1020 },
  ],
};
// ─── Lead Owner → Calendly Specialist mapping ────────────────────────────────
const OWNER_TO_SPECIALIST = {
  "437076000003563557": "rogier",
  "437076000003563509": "mike",
  "rogier.smulders@sendsteps.com": "rogier",
  "mike.coumans@sendsteps.com": "mike",
};
function mapOwnerToSpecialist(ownerObj) {
  if (!ownerObj) return null;
  const byId = OWNER_TO_SPECIALIST[String(ownerObj.id)];
  if (byId) return byId;
  const email = (ownerObj.email || "").toLowerCase();
  const byEmail = OWNER_TO_SPECIALIST[email];
  if (byEmail) return byEmail;
  const name = (ownerObj.name || "").toLowerCase();
  if (name.includes("rogier")) return "rogier";
  if (name.includes("mike")) return "mike";
  console.warn(`[OWNER] Unknown lead owner: ${JSON.stringify(ownerObj)} — cannot map to specialist`);
  return null;
}
// ─── Zoho CRM Lead → Prospect mapping ───────────────────────────────────────
function mapZohoLead(zohoLead) {
  const firstName = zohoLead.First_Name || zohoLead.first_name || "";
  const lastName = zohoLead.Last_Name || zohoLead.last_name || "";
  const eduLevel = zohoLead.Edu_level || zohoLead.edu_level || "";
  const jobTitle = zohoLead.Job_Title_Edu || zohoLead.Job_Title_Business || zohoLead.job_title_edu || "";
  const ownerObj = zohoLead.Owner || zohoLead.owner || null;
  const specialist = mapOwnerToSpecialist(ownerObj);
  return {
    phone_number: zohoLead.Phone || zohoLead.phone || "",
    university_name: zohoLead.Educational_Institute || zohoLead.Educational_institute || zohoLead.Company || zohoLead.company || "",
    first_name: firstName,
    last_name: lastName,
    contact_name: [firstName, lastName].filter(Boolean).join(" "),
    contact_title: jobTitle,
    persona_type: derivePersonaType(eduLevel, jobTitle),
    department: zohoLead.Segment || zohoLead.segment || "",
    country: zohoLead.Country || zohoLead.country || "",
    sendsteps_product: zohoLead.Sendsteps_Product || zohoLead.sendsteps_product || "Interactive Presentations",
    notes: zohoLead.Description || zohoLead.description || "",
    zoho_lead_id: zohoLead.ID || zohoLead.id || zohoLead.Id || zohoLead.lead_id || zohoLead.Lead_Id || zohoLead.LEADID || zohoLead.Lead_ID || null, // Zoho Flow Deluge uses "ID" (all-caps); CRM API v2 uses "id"
    edu_level: eduLevel,
    type_of_plan: zohoLead.Type_of_Plan || zohoLead.type_of_plan || "",
    language: zohoLead.Language || zohoLead.language || "",
    // Email — used by Retell agent to pre-fill booking invite address
    email: zohoLead.Email || zohoLead.email || "",
    // Social proof reference university for pitch node
    reference_university: zohoLead.Reference_University || zohoLead.reference_university || "TU Delft",
    // Calendly specialist routing (derived from Lead Owner)
    specialist: specialist,
    lead_owner_name: ownerObj ? (ownerObj.name || "") : "",
  };
}
// Derive persona_type for Retell agent
function derivePersonaType(eduLevel, jobTitle) {
  const combined = `${eduLevel} ${jobTitle}`;
  if (/procure|purchas|inkoop|buyer|tender/i.test(combined)) return "procurement";
  if (/\bIT\b|\bICT\b/.test(combined)) return "procurement";
  if (/\btech\b|system\s*admin|infra/i.test(combined)) return "procurement";
  return "faculty";
}
// Determine agent from Zoho lead's Aria_Status field
function agentFromAriaStatus(ariaStatus) {
  if (!ariaStatus) return null;
  const s = ariaStatus.toLowerCase().trim();
  if (/\baria[_ ]en\b/.test(s) || s === "ready for aria en" || s === "retry aria en") return "aria_en";
  if (/\baria[_ ]nl\b/.test(s) || s === "ready for aria nl" || s === "retry aria nl") return "aria_nl";
  if (/\ben$/.test(s)) return "aria_en";
  if (/\bnl$/.test(s)) return "aria_nl";
  return null;
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
  if (!agent.from_number) throw new Error(`No from_number configured for ${agentKey}.`);
  function getFirstName(p) {
    if (p.first_name) return p.first_name;
    if (p.contact_name) return p.contact_name.split(" ")[0];
    return "";
  }
  const tasks = prospects.map((p) => ({
    to_number: p.phone_number,
    retell_llm_dynamic_variables: {
      prospect_first_name: getFirstName(p),
      university_name: p.university_name || "",
      persona_type: p.persona_type || "faculty",
      specialist: p.specialist || "",
      lead_owner_name: p.lead_owner_name || "",
      contact_name: p.contact_name || "",
      contact_title: p.contact_title || "",
      department: p.department || "",
      sendsteps_product: p.sendsteps_product || "Interactive Presentations",
      notes: p.notes || "",
      // Email (pre-fills invite address so Aria doesn't need to ask)
      prospect_email: p.email || "",
      // Social proof reference university for pitch node
      reference_university: p.reference_university || "TU Delft",
      // Zoho CRM tracking
      zoho_lead_id: p.zoho_lead_id || "",
    },
  }));
  const payload = {
    agent_id: agent.agent_id,
    from_number: agent.from_number,
    tasks,
    name: options.name || `Sendsteps ${agentKey.toUpperCase()} batch — ${new Date().toISOString().split("T")[0]}`,
  };
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
  if (options.scheduled_time) {
    payload.scheduled_timestamp = new Date(options.scheduled_time).getTime();
  }
  return payload;
}
// ─── API call ───────────────────────────────────────────────────────────────
async function createBatchCall(prospects, options = {}) {
  const agentKey = options.agent || "aria_en";
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
if (require.main === module) {
  main();
}
module.exports = { createBatchCall, parseProspectList, buildBatchPayload, validateProspect, mapZohoLead, mapOwnerToSpecialist, agentFromAriaStatus, derivePersonaType, AGENTS, CALLING_WINDOW, OWNER_TO_SPECIALIST };
