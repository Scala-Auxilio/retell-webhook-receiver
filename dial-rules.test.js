// node dial-rules.test.js  — no dependencies
const assert = require("assert");
const r = require("./dial-rules");
const at = iso => new Date(iso);
// Time zones
assert.strictEqual(r.timeZoneForPhone("+15037254000"), "America/Los_Angeles"); // Portland State
assert.strictEqual(r.timeZoneForPhone("+14357971000"), "America/Denver");      // Utah State
assert.strictEqual(r.timeZoneForPhone("+18042898000"), "America/New_York");    // Richmond
assert.strictEqual(r.timeZoneForPhone("+17136935000"), "America/Chicago");     // Houston
assert.strictEqual(r.timeZoneForPhone("+447863759619"), "Europe/London");
// Utah State, 19 Oct 13:05 UTC = 07:05 MDT -> blocked; 21:05 UTC = 15:05 MDT -> ok
assert.strictEqual(r.callingWindowCheck("+14357971000", at("2026-10-19T13:05:00Z")).ok, false);
assert.strictEqual(r.callingWindowCheck("+14357971000", at("2026-10-19T21:05:00Z")).ok, true);
// Richmond 13:05 UTC = 09:05 EDT -> ok
assert.strictEqual(r.callingWindowCheck("+18042898000", at("2026-10-19T13:05:00Z")).ok, true);
// Weekend, Thanksgiving + Friday, Christmas week, UK bank holiday (25 May 2026)
assert.strictEqual(r.callingWindowCheck("+18042898000", at("2026-10-24T15:00:00Z")).ok, false);
assert.strictEqual(r.callingWindowCheck("+18042898000", at("2026-11-26T16:00:00Z")).ok, false);
assert.strictEqual(r.callingWindowCheck("+18042898000", at("2026-11-27T16:00:00Z")).ok, false);
assert.strictEqual(r.callingWindowCheck("+18042898000", at("2026-12-28T16:00:00Z")).ok, false);
assert.strictEqual(r.callingWindowCheck("+441132431751", at("2026-05-25T10:00:00Z")).ok, false);
assert.strictEqual(r.callingWindowCheck("+441132431751", at("2026-05-26T10:00:00Z")).ok, true);
// Holidays computed correctly
assert.ok(r.usHolidays(2026).has("2026-01-19") && r.usHolidays(2026).has("2026-07-03") && r.usHolidays(2026).has("2026-09-07"));
assert.ok(r.ukHolidays(2026).has("2026-04-03") && r.ukHolidays(2026).has("2026-04-06") && r.ukHolidays(2026).has("2026-08-31"));
assert.ok(r.ukHolidays(2027).has("2027-03-26") && r.ukHolidays(2027).has("2027-03-29"));
// Variables
assert.deepStrictEqual(r.variableProblems({ university_name: "Leeds", first_name: "Fiona", lead_owner_name: "Petrus" }, "aria_en_uk"), []);
assert.ok(r.variableProblems({ university_name: "Leeds", first_name: "{{prospect_first_name}}", lead_owner_name: "Petrus" }, "aria_en").length === 1);
assert.ok(r.variableProblems({ university_name: "Leeds", first_name: "Fiona", lead_owner_name: "" }, "aria_en").length === 1);
assert.deepStrictEqual(r.variableProblems({ university_name: "Portland State University", contact_name: "" }, "scout_us"), []);
assert.ok(r.variableProblems({ university_name: "" }, "scout_us").length === 1);
// Dead ends
const menu = { call_analysis: { custom_analysis_data: { scout_outcome: "no_person" } } };
const ok = { call_analysis: { custom_analysis_data: { scout_outcome: "confirmed" } } };
assert.deepStrictEqual(r.deadEndVerdict([menu, menu, ok]), { deadEnds: 2, blocked: false });
assert.deepStrictEqual(r.deadEndVerdict([menu, menu, menu]), { deadEnds: 3, blocked: true });
assert.strictEqual(r.isDeadEndCall({ disconnection_reason: "max_duration_reached" }), true);
console.log("dial-rules: all tests passed");
