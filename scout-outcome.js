// Scout v3 (2026-10-14): Scout now records what it learned in the post-call
// field `scout_outcome`. This module maps that value to the Aria_Status
// picklist values Petrus added in Zoho on 14 Oct, and validates captured
// contact details before anything is written to Zoho.
//
// `no_person` (voicemail, no answer, phone-menu dead end) is deliberately NOT
// in the map: it falls through to the existing no-answer retry path.
const SCOUT_OUTCOME_STATUS = {
  confirmed:                "Scout - Confirmed",
  confirmed_interested:     "Scout - Interested",
  confirmed_not_interested: "Scout - Not Interested",
  redirected:               "Scout - Redirected",
  department_only:          "Scout - Department Only",
  refused:                  "Scout - No Contact",
  wrong_department:         "Scout - Wrong Department",
  wrong_org:                "Scout - Wrong Org",
  do_not_call:              "Scout - Do Not Call",
};

// Our own addresses are never a capture (bug seen Sep 2026: Scout logged
// petrus...@sendsteps.com, read out on voicemail, as the contact's email).
const OWN_DOMAIN = /@(?:[a-z0-9-]+\.)*sendsteps\.com$/i;

function cleanEmail(raw) {
  const e = String(raw || "").trim().toLowerCase();
  if (!e) return "";
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) return "";
  if (OWN_DOMAIN.test(e)) return "";
  return e;
}

function cleanPhone(raw) {
  const s = String(raw || "").trim();
  return s.replace(/\D/g, "").length >= 10 ? s : "";
}

function scoutOutcome(cad) {
  return String((cad && cad.scout_outcome) || "").trim().toLowerCase();
}

module.exports = { SCOUT_OUTCOME_STATUS, cleanEmail, cleanPhone, scoutOutcome };
