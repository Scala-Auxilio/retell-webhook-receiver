/**
 * dial-rules.js — when and whether a call may be dialled (2026-10-29).
 *
 * Learning-loop fixes F18-F20 (approved by Petrus 29 Oct):
 *   - D1 Local office hours: dial only Mon-Fri 09:00-16:30 in the DESTINATION's
 *     local time (was: one Europe/Amsterdam window for every country, which put
 *     Mountain/Pacific calls at 06:05-07:05 local, before switchboards open).
 *   - D1 Holidays: skip US federal holidays (+ day after Thanksgiving) and
 *     England bank holidays, plus the Dec 24 - Jan 1 university closure.
 *   - D2 Unresolved variables: never dial when a dynamic variable still holds
 *     "{{...}}" or a field the agent speaks aloud is empty.
 *   - D3 Dead-end switchboards: helper to decide whether a number has hit a
 *     phone-menu dead end / no person often enough to stop redialling it.
 *
 * Time zones for +1 numbers are approximated from the area code (default
 * America/New_York). Pure functions, no network, unit-tested in
 * dial-rules.test.js.
 */

const WINDOW_START_MIN = 9 * 60;      // 09:00 local
const WINDOW_END_MIN = 16 * 60 + 30;  // 16:30 local

// ─── Area code → IANA time zone (US + Canada). Anything not listed = Eastern.
const AREA_TZ = {};
function addCodes(tz, codes) { codes.split(/\s+/).filter(Boolean).forEach(c => { AREA_TZ[c] = tz; }); }
addCodes("America/Los_Angeles", `206 209 213 253 279 310 323 341 350 360 408 415 424 425 442 458 503 509 510 530 541
  559 562 564 619 626 628 650 657 661 669 702 707 714 725 747 760 775 805 818 820 831 840 858 909 916 925 949 951 971
  604 778 236 250 672`);
addCodes("America/Denver", `208 303 307 385 406 435 505 575 719 720 801 915 970 983 986 403 587 780 825 368`);
addCodes("America/Phoenix", `480 520 602 623 928`);
addCodes("America/Chicago", `205 217 218 219 224 225 228 251 254 256 262 270 281 309 312 314 316 318 319 320 325 331 334
  337 346 361 364 402 405 409 414 417 430 432 469 479 501 504 507 512 515 531 534 563 573 580 601 605 608 612 615 618
  620 630 636 641 651 659 660 662 682 701 708 712 713 715 726 731 737 763 769 773 779 785 806 815 816 830 832 847 870
  872 901 903 913 918 920 931 936 938 940 945 952 956 972 979 985 204 431`);
addCodes("America/Regina", `306 639`);
addCodes("America/Anchorage", `907`);
addCodes("Pacific/Honolulu", `808`);

function timeZoneForPhone(phone) {
  const p = String(phone || "");
  if (p.startsWith("+1") && p.length >= 5) return AREA_TZ[p.slice(2, 5)] || "America/New_York";
  if (p.startsWith("+44")) return "Europe/London";
  if (p.startsWith("+353")) return "Europe/Dublin";
  if (p.startsWith("+31")) return "Europe/Amsterdam";
  if (p.startsWith("+32")) return "Europe/Brussels";
  if (p.startsWith("+39")) return "Europe/Rome";
  if (p.startsWith("+49")) return "Europe/Berlin";
  return "Europe/Amsterdam";
}

// Local calendar parts for a time zone.
function localParts(tz, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
    }).formatToParts(now).map(x => [x.type, x.value])
  );
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }[parts.weekday];
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: wd,
  };
}

// ─── Holiday calendars (computed, so they never expire) ─────────────────────
const pad = n => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
function dow(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function nthWeekday(y, m, weekday, n) { // n-th weekday (0=Sun) of month m
  const first = dow(y, m, 1);
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}
function lastWeekday(y, m, weekday) {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lastDow = dow(y, m, last);
  return last - ((lastDow - weekday + 7) % 7);
}
function observedUS(y, m, d) { // Sat -> Fri, Sun -> Mon
  const w = dow(y, m, d);
  const dt = new Date(Date.UTC(y, m - 1, d + (w === 6 ? -1 : w === 0 ? 1 : 0)));
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function easterSunday(y) { // Anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}
function shiftDays(date, n) { const d = new Date(date.getTime() + n * 86400000); return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
function winterClosure(y) { // Dec 24-31 of y, Jan 1 handled as New Year
  const out = []; for (let d = 24; d <= 31; d++) out.push(ymd(y, 12, d)); return out;
}
function usHolidays(y) {
  const thx = nthWeekday(y, 11, 4, 4);
  return new Set([
    observedUS(y, 1, 1), ymd(y, 1, nthWeekday(y, 1, 1, 3)), ymd(y, 2, nthWeekday(y, 2, 1, 3)),
    ymd(y, 5, lastWeekday(y, 5, 1)), observedUS(y, 6, 19), observedUS(y, 7, 4),
    ymd(y, 9, nthWeekday(y, 9, 1, 1)), ymd(y, 11, thx), ymd(y, 11, thx + 1),
    ...winterClosure(y),
  ]);
}
function ukHolidays(y) {
  const easter = easterSunday(y);
  // New Year / Christmas / Boxing substitutes: weekend -> next weekday(s)
  const ny = dow(y, 1, 1) === 6 ? ymd(y, 1, 3) : dow(y, 1, 1) === 0 ? ymd(y, 1, 2) : ymd(y, 1, 1);
  return new Set([
    ny, shiftDays(easter, -2), shiftDays(easter, 1),
    ymd(y, 5, nthWeekday(y, 5, 1, 1)), ymd(y, 5, lastWeekday(y, 5, 1)), ymd(y, 8, lastWeekday(y, 8, 1)),
    ...winterClosure(y),
  ]);
}
function isHoliday(tz, local) {
  if (tz.startsWith("America/") || tz.startsWith("Pacific/")) return usHolidays(local.year).has(local.ymd);
  if (tz === "Europe/London") return ukHolidays(local.year).has(local.ymd);
  return winterClosure(local.year).includes(local.ymd) || local.ymd === ymd(local.year, 1, 1);
}

/** D1: may this number be dialled right now? Returns { ok, reason, tz, local }. */
function callingWindowCheck(phone, now = new Date()) {
  const tz = timeZoneForPhone(phone);
  const local = localParts(tz, now);
  const stamp = `${local.ymd} ${pad(Math.floor(local.minutes / 60))}:${pad(local.minutes % 60)} ${tz}`;
  if (local.weekday === 0 || local.weekday === 6) return { ok: false, reason: `weekend (${stamp})`, tz, local };
  if (isHoliday(tz, local)) return { ok: false, reason: `public holiday or closure (${stamp})`, tz, local };
  if (local.minutes < WINDOW_START_MIN || local.minutes >= WINDOW_END_MIN) return { ok: false, reason: `outside 09:00-16:30 local (${stamp})`, tz, local };
  return { ok: true, reason: null, tz, local };
}

/** D2: problems with the variables the agent will speak. [] = fine. */
function variableProblems(prospect, agentKey) {
  const problems = [];
  for (const [k, v] of Object.entries(prospect || {})) {
    if (typeof v === "string" && /\{\{|\}\}/.test(v)) problems.push(`${k} contains an unresolved template variable`);
  }
  const isAria = String(agentKey || "").startsWith("aria");
  if (!String(prospect?.university_name || "").trim()) problems.push("university_name is empty");
  if (isAria) {
    if (!String(prospect?.first_name || prospect?.contact_name || "").trim()) problems.push("first_name is empty");
    if (!String(prospect?.lead_owner_name || "").trim()) problems.push("lead_owner_name is empty");
  }
  return problems;
}

/** D3: is this a dead-end number, given its recent Scout calls? */
const DEAD_END_LIMIT = 3;          // dead ends within the lookback window
const DEAD_END_LOOKBACK_DAYS = 7;
function isDeadEndCall(call) {
  const cad = (call && call.call_analysis && call.call_analysis.custom_analysis_data) || {};
  const outcome = String(cad.scout_outcome || "").toLowerCase();
  const reason = String(call?.disconnection_reason || "").toLowerCase();
  if (outcome === "no_person") return true;                       // menu / hold / closed, nobody reached
  if (!outcome && reason === "max_duration_reached") return true;  // stuck on hold until the limit
  return false;
}
function deadEndVerdict(calls) {
  const deadEnds = (calls || []).filter(isDeadEndCall).length;
  return { deadEnds, blocked: deadEnds >= DEAD_END_LIMIT };
}

module.exports = {
  timeZoneForPhone, callingWindowCheck, variableProblems, isDeadEndCall, deadEndVerdict,
  usHolidays, ukHolidays, DEAD_END_LIMIT, DEAD_END_LOOKBACK_DAYS, WINDOW_START_MIN, WINDOW_END_MIN,
};
