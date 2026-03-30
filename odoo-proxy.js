// ─── Odoo CRM Proxy Module ─────────────────────────────────────────
// Provides pipeline data from EconoWind's Odoo CRM for Paperclip AI agents.
// Uses Odoo JSON-RPC API (standard on Odoo Online / SaaS).
//
// Endpoints:
//   GET  /odoo/pipeline-snapshot   — Current state of all active opportunities
//   GET  /odoo/pipeline-report     — Weekly report with WoW comparison + stale detection
//   POST /odoo/snapshot/save       — Persist current snapshot for WoW comparison
//   GET  /odoo/status              — Health check / connectivity test
//
// Environment variables:
//   ODOO_URL       — e.g. https://econowind.odoo.com
//   ODOO_DB        — e.g. econowind
//   ODOO_LOGIN     — e.g. piet.jr.coelewij@econowind.nl
//   ODOO_API_KEY   — API key from Account Security > API Keys
// ────────────────────────────────────────────────────────────────────

const ODOO_URL    = process.env.ODOO_URL    || 'https://econowind.odoo.com';
const ODOO_DB     = process.env.ODOO_DB     || 'econowind';
const ODOO_LOGIN  = process.env.ODOO_LOGIN  || '';
const ODOO_API_KEY = process.env.ODOO_API_KEY || '';

// Pipeline stages considered "active" (everything except Won and Lost)
const ACTIVE_STAGES = [
  'New',
  'Prospecting / Qualification',
  'Needs Analysis',
  'Proposal',
  'Negotiation',
  'Verbal Agreement'
];

// Stage order for movement tracking (lower = earlier in pipeline)
const STAGE_ORDER = {
  'New': 1,
  'Prospecting / Qualification': 2,
  'Needs Analysis': 3,
  'Proposal': 4,
  'Negotiation': 5,
  'Verbal Agreement': 6,
  'Won': 7,
  'Lost': 0
};

// Stale threshold in days
const STALE_THRESHOLD_DAYS = 30;

// ─── Odoo JSON-RPC Client ──────────────────────────────────────────

async function odooJsonRpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: method,
      params: params
    })
  });

  if (!response.ok) {
    throw new Error(`Odoo HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  if (data.error) {
    const err = data.error.data || data.error;
    throw new Error(`Odoo RPC error: ${err.message || JSON.stringify(err)}`);
  }

  return data.result;
}

/**
 * Authenticate with Odoo and get session UID.
 * With API keys, the key is used in place of the password.
 */
async function odooAuthenticate() {
  const uid = await odooJsonRpc(
    `${ODOO_URL}/jsonrpc`,
    'call',
    {
      service: 'common',
      method: 'authenticate',
      args: [ODOO_DB, ODOO_LOGIN, ODOO_API_KEY, {}]
    }
  );

  if (!uid) {
    throw new Error('Odoo authentication failed — check ODOO_LOGIN and ODOO_API_KEY');
  }

  console.log(`[odoo] Authenticated as UID ${uid}`);
  return uid;
}

/**
 * Execute an Odoo model method (search_read, read, etc.)
 */
async function odooExecute(uid, model, method, args = [], kwargs = {}) {
  return odooJsonRpc(
    `${ODOO_URL}/jsonrpc`,
    'call',
    {
      service: 'object',
      method: 'execute_kw',
      args: [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs]
    }
  );
}

// ─── Pipeline Data Fetching ────────────────────────────────────────

/**
 * Fetch all active opportunities from Odoo CRM.
 * Returns structured data for each opportunity.
 */
async function fetchActiveOpportunities(uid) {
  // First, get stage IDs for active stages
  const stages = await odooExecute(uid, 'crm.stage', 'search_read',
    [[['name', 'in', ACTIVE_STAGES]]],
    { fields: ['id', 'name', 'sequence'] }
  );

  const activeStageIds = stages.map(s => s.id);
  const stageMap = {};
  stages.forEach(s => { stageMap[s.id] = s.name; });

  // Fetch all opportunities in active stages
  const opportunities = await odooExecute(uid, 'crm.lead', 'search_read',
    [[
      ['type', '=', 'opportunity'],
      ['stage_id', 'in', activeStageIds]
    ]],
    {
      fields: [
        'id', 'name', 'partner_id', 'contact_name', 'email_from',
        'phone', 'expected_revenue', 'probability', 'stage_id',
        'user_id', 'create_date', 'write_date', 'date_deadline',
        'date_last_stage_update', 'priority',
        'message_last_post',        // last chatter activity
        'activity_date_deadline',    // next scheduled activity
        'x_chance_of_order',         // custom: Chance of Order %
        'x_chance_of_econowind',     // custom: Chance of EconoWind %
        'x_vessel_type',             // custom: Vessel type
        'x_number_of_vessels',       // custom: Number of vessels
        'x_expected_delivery_date',  // custom: Expected Delivery Date
        'x_product_id',              // custom: VentoFoil product
      ],
      order: 'expected_revenue desc'
    }
  );

  return opportunities.map(opp => ({
    id: opp.id,
    name: opp.name,
    company: opp.partner_id ? opp.partner_id[1] : null,
    contact: opp.contact_name,
    email: opp.email_from,
    phone: opp.phone,
    expected_revenue: opp.expected_revenue,
    probability: opp.probability,
    stage: stageMap[opp.stage_id[0]] || opp.stage_id[1],
    stage_id: opp.stage_id[0],
    salesperson: opp.user_id ? opp.user_id[1] : 'Unassigned',
    salesperson_id: opp.user_id ? opp.user_id[0] : null,
    created: opp.create_date,
    last_modified: opp.write_date,
    expected_closing: opp.date_deadline,
    last_stage_update: opp.date_last_stage_update,
    last_activity: opp.message_last_post || opp.write_date,
    next_activity: opp.activity_date_deadline,
    priority_stars: parseInt(opp.priority) || 0,
    chance_of_order: opp.x_chance_of_order,
    chance_of_econowind: opp.x_chance_of_econowind,
    vessel_type: opp.x_vessel_type,
    number_of_vessels: opp.x_number_of_vessels,
    expected_delivery: opp.x_expected_delivery_date,
    product: opp.x_product_id ? opp.x_product_id[1] : null,
    days_since_activity: daysSince(opp.message_last_post || opp.write_date),
    is_stale: daysSince(opp.message_last_post || opp.write_date) > STALE_THRESHOLD_DAYS
  }));
}

/**
 * Fetch recent stage changes from the chatter log for WoW comparison.
 * Queries mail.tracking.value for stage field changes in the last 14 days.
 */
async function fetchRecentStageChanges(uid, sinceDays = 14) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - sinceDays);
  const sinceDateStr = sinceDate.toISOString().split('T')[0];

  // Get the field ID for stage_id on crm.lead
  const fields = await odooExecute(uid, 'ir.model.fields', 'search_read',
    [[['model', '=', 'crm.lead'], ['name', '=', 'stage_id']]],
    { fields: ['id'], limit: 1 }
  );

  if (!fields.length) {
    console.log('[odoo] Could not find stage_id field definition, falling back to snapshot comparison');
    return [];
  }

  const fieldId = fields[0].id;

  // Query tracking values for stage changes
  const trackingValues = await odooExecute(uid, 'mail.tracking.value', 'search_read',
    [[
      ['field_id', '=', fieldId],
      ['create_date', '>=', sinceDateStr]
    ]],
    {
      fields: ['mail_message_id', 'old_value_char', 'new_value_char', 'create_date'],
      order: 'create_date desc',
      limit: 200
    }
  );

  // For each tracking value, get the associated opportunity via the message
  const messageIds = [...new Set(trackingValues.map(tv => tv.mail_message_id[0]))];

  if (!messageIds.length) return [];

  const messages = await odooExecute(uid, 'mail.message', 'search_read',
    [[['id', 'in', messageIds], ['model', '=', 'crm.lead']]],
    { fields: ['id', 'res_id'] }
  );

  const msgToOpp = {};
  messages.forEach(m => { msgToOpp[m.id] = m.res_id; });

  return trackingValues.map(tv => ({
    opportunity_id: msgToOpp[tv.mail_message_id[0]] || null,
    from_stage: tv.old_value_char,
    to_stage: tv.new_value_char,
    changed_at: tv.create_date,
    direction: getMovementDirection(tv.old_value_char, tv.new_value_char)
  })).filter(m => m.opportunity_id !== null);
}

// ─── Report Generation ─────────────────────────────────────────────

/**
 * Generate the full weekly pipeline report.
 */
async function generateWeeklyReport(uid, pool) {
  const opportunities = await fetchActiveOpportunities(uid);
  const stageChanges = await fetchRecentStageChanges(uid, 7);

  // Get last week's snapshot for comparison (if available)
  let lastSnapshot = null;
  if (pool) {
    try {
      const result = await pool.query(
        `SELECT snapshot_data FROM pipeline_snapshots
         ORDER BY created_at DESC LIMIT 1`
      );
      if (result.rows.length) {
        lastSnapshot = result.rows[0].snapshot_data;
      }
    } catch (e) {
      console.log('[odoo] No previous snapshot found:', e.message);
    }
  }

  // ── Section 1: Active Opportunities Summary ──
  const byStage = {};
  ACTIVE_STAGES.forEach(s => { byStage[s] = { count: 0, revenue: 0, opps: [] }; });

  opportunities.forEach(opp => {
    const stage = opp.stage;
    if (byStage[stage]) {
      byStage[stage].count++;
      byStage[stage].revenue += opp.expected_revenue || 0;
      byStage[stage].opps.push(opp);
    }
  });

  const totalRevenue = opportunities.reduce((sum, o) => sum + (o.expected_revenue || 0), 0);
  const weightedRevenue = opportunities.reduce((sum, o) =>
    sum + ((o.expected_revenue || 0) * (o.probability || 0) / 100), 0);

  // ── Section 2: Priority Classification ──
  const prioritized = opportunities.map(opp => ({
    ...opp,
    priority_label: classifyPriority(opp)
  }));

  const p1 = prioritized.filter(o => o.priority_label === 'P1');
  const p2 = prioritized.filter(o => o.priority_label === 'P2');
  const p3 = prioritized.filter(o => o.priority_label === 'P3');
  const p4 = prioritized.filter(o => o.priority_label === 'P4');

  // ── Section 3: Week-over-Week Movements ──
  let movements = [];
  if (stageChanges.length) {
    // Enrich stage changes with opportunity names
    const changedOppIds = [...new Set(stageChanges.map(sc => sc.opportunity_id))];
    const oppNames = {};
    opportunities.forEach(o => { oppNames[o.id] = o.name; });

    // For any IDs not in active opps, fetch them
    const missingIds = changedOppIds.filter(id => !oppNames[id]);
    if (missingIds.length) {
      const missingOpps = await odooExecute(uid, 'crm.lead', 'read',
        [missingIds],
        { fields: ['id', 'name'] }
      );
      missingOpps.forEach(o => { oppNames[o.id] = o.name; });
    }

    movements = stageChanges.map(sc => ({
      ...sc,
      opportunity_name: oppNames[sc.opportunity_id] || `Opportunity #${sc.opportunity_id}`
    }));
  } else if (lastSnapshot) {
    // Fallback: compare current vs last snapshot
    movements = compareSnapshots(lastSnapshot, opportunities);
  }

  // ── Section 4: Stale Opportunities ──
  const stale = opportunities
    .filter(o => o.is_stale)
    .sort((a, b) => b.days_since_activity - a.days_since_activity);

  // ── Section 5: By Salesperson ──
  const bySalesperson = {};
  opportunities.forEach(opp => {
    const sp = opp.salesperson;
    if (!bySalesperson[sp]) {
      bySalesperson[sp] = { count: 0, revenue: 0, stale: 0 };
    }
    bySalesperson[sp].count++;
    bySalesperson[sp].revenue += opp.expected_revenue || 0;
    if (opp.is_stale) bySalesperson[sp].stale++;
  });

  return {
    generated_at: new Date().toISOString(),
    report_week: getWeekLabel(),
    summary: {
      total_active: opportunities.length,
      total_revenue: totalRevenue,
      weighted_revenue: weightedRevenue,
      by_stage: byStage
    },
    priorities: {
      p1: p1.map(briefOpp),
      p2: p2.map(briefOpp),
      p3: p3.map(briefOpp),
      p4_count: p4.length
    },
    movements: movements.slice(0, 50),
    stale_opportunities: stale.map(o => ({
      id: o.id,
      name: o.name,
      company: o.company,
      stage: o.stage,
      salesperson: o.salesperson,
      expected_revenue: o.expected_revenue,
      days_since_activity: o.days_since_activity,
      last_activity: o.last_activity
    })),
    by_salesperson: bySalesperson,
    all_opportunities: prioritized.map(briefOpp)
  };
}

/**
 * Format the report as an HTML email body.
 */
function formatReportEmail(report) {
  const fmt = (n) => new Intl.NumberFormat('en-EU', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0
  }).format(n || 0);

  const stageRows = ACTIVE_STAGES.map(stage => {
    const data = report.summary.by_stage[stage] || { count: 0, revenue: 0 };
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${stage}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${data.count}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${fmt(data.revenue)}</td>
    </tr>`;
  }).join('');

  const movementRows = report.movements.length
    ? report.movements.slice(0, 20).map(m => `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;">${m.opportunity_name || ''}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;">${m.from_stage} → ${m.to_stage}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;">${m.direction === 'forward' ? '🟢 Forward' : m.direction === 'backward' ? '🔴 Backward' : '⚪ Lateral'}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;">${formatDate(m.changed_at)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" style="padding:12px;color:#888;">No stage movements this week</td></tr>';

  const staleRows = report.stale_opportunities.length
    ? report.stale_opportunities.map(o => `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;">${o.name}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;">${o.salesperson}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;">${o.stage}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">${fmt(o.expected_revenue)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center;color:#e74c3c;font-weight:bold;">${o.days_since_activity}d</td>
      </tr>`).join('')
    : '<tr><td colspan="5" style="padding:12px;color:#27ae60;">No stale opportunities — great!</td></tr>';

  const salespersonRows = Object.entries(report.by_salesperson)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([name, data]) => `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;">${name}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center;">${data.count}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">${fmt(data.revenue)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center;${data.stale > 0 ? 'color:#e74c3c;font-weight:bold;' : ''}">${data.stale}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#333;max-width:800px;margin:0 auto;padding:20px;">

  <div style="background:linear-gradient(135deg,#1a5276,#2e86c1);color:white;padding:24px 32px;border-radius:12px;margin-bottom:24px;">
    <h1 style="margin:0 0 4px 0;font-size:24px;">EconoWind Pipeline Report</h1>
    <p style="margin:0;opacity:0.85;font-size:14px;">Week of ${report.report_week} · Generated ${formatDate(report.generated_at)}</p>
  </div>

  <!-- KPI Cards -->
  <div style="display:flex;gap:16px;margin-bottom:24px;">
    <div style="flex:1;background:#f8f9fa;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:bold;color:#2e86c1;">${report.summary.total_active}</div>
      <div style="font-size:12px;color:#888;text-transform:uppercase;">Active Opportunities</div>
    </div>
    <div style="flex:1;background:#f8f9fa;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:bold;color:#27ae60;">${fmt(report.summary.total_revenue)}</div>
      <div style="font-size:12px;color:#888;text-transform:uppercase;">Total Pipeline</div>
    </div>
    <div style="flex:1;background:#f8f9fa;border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:bold;color:#8e44ad;">${fmt(report.summary.weighted_revenue)}</div>
      <div style="font-size:12px;color:#888;text-transform:uppercase;">Weighted Revenue</div>
    </div>
    <div style="flex:1;background:${report.stale_opportunities.length > 5 ? '#fdf2f2' : '#f8f9fa'};border-radius:8px;padding:16px;text-align:center;">
      <div style="font-size:28px;font-weight:bold;color:${report.stale_opportunities.length > 5 ? '#e74c3c' : '#f39c12'};">${report.stale_opportunities.length}</div>
      <div style="font-size:12px;color:#888;text-transform:uppercase;">Stale (30d+)</div>
    </div>
  </div>

  <!-- Section 1: Pipeline by Stage -->
  <h2 style="color:#1a5276;border-bottom:2px solid #2e86c1;padding-bottom:8px;">1. Active Opportunities by Stage</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
    <thead>
      <tr style="background:#f1f8fe;">
        <th style="padding:10px 12px;text-align:left;">Stage</th>
        <th style="padding:10px 12px;text-align:center;">Count</th>
        <th style="padding:10px 12px;text-align:right;">Revenue</th>
      </tr>
    </thead>
    <tbody>
      ${stageRows}
      <tr style="font-weight:bold;background:#f8f9fa;">
        <td style="padding:10px 12px;">Total</td>
        <td style="padding:10px 12px;text-align:center;">${report.summary.total_active}</td>
        <td style="padding:10px 12px;text-align:right;">${fmt(report.summary.total_revenue)}</td>
      </tr>
    </tbody>
  </table>

  <!-- Section 2: Priority Classification -->
  <h2 style="color:#1a5276;border-bottom:2px solid #2e86c1;padding-bottom:8px;">2. Priority Classification</h2>
  ${renderPrioritySection('P1 — Hot', report.priorities.p1, '#e74c3c', fmt)}
  ${renderPrioritySection('P2 — Warm', report.priorities.p2, '#f39c12', fmt)}
  ${renderPrioritySection('P3 — Nurture', report.priorities.p3, '#3498db', fmt)}
  <p style="color:#888;font-size:13px;">P4 — Long-term: ${report.priorities.p4_count} opportunities (not shown)</p>

  <!-- Section 3: Pipeline Movements -->
  <h2 style="color:#1a5276;border-bottom:2px solid #2e86c1;padding-bottom:8px;">3. Pipeline Movements (This Week)</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
    <thead>
      <tr style="background:#f1f8fe;">
        <th style="padding:8px 12px;text-align:left;">Opportunity</th>
        <th style="padding:8px 12px;text-align:left;">Movement</th>
        <th style="padding:8px 12px;text-align:left;">Direction</th>
        <th style="padding:8px 12px;text-align:left;">Date</th>
      </tr>
    </thead>
    <tbody>${movementRows}</tbody>
  </table>

  <!-- Section 4: Stale Opportunities -->
  <h2 style="color:#1a5276;border-bottom:2px solid #e74c3c;padding-bottom:8px;">4. Stale Opportunities (30+ Days Inactive)</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
    <thead>
      <tr style="background:#fdf2f2;">
        <th style="padding:8px 12px;text-align:left;">Opportunity</th>
        <th style="padding:8px 12px;text-align:left;">Salesperson</th>
        <th style="padding:8px 12px;text-align:left;">Stage</th>
        <th style="padding:8px 12px;text-align:right;">Revenue</th>
        <th style="padding:8px 12px;text-align:center;">Days Idle</th>
      </tr>
    </thead>
    <tbody>${staleRows}</tbody>
  </table>

  <!-- Section 5: By Salesperson -->
  <h2 style="color:#1a5276;border-bottom:2px solid #2e86c1;padding-bottom:8px;">5. Pipeline by Salesperson</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
    <thead>
      <tr style="background:#f1f8fe;">
        <th style="padding:8px 12px;text-align:left;">Salesperson</th>
        <th style="padding:8px 12px;text-align:center;">Deals</th>
        <th style="padding:8px 12px;text-align:right;">Revenue</th>
        <th style="padding:8px 12px;text-align:center;">Stale</th>
      </tr>
    </thead>
    <tbody>${salespersonRows}</tbody>
  </table>

  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#aaa;">
    Generated by Scala Auxilium Pipeline Reporter · Powered by Paperclip AI<br>
    Data source: EconoWind Odoo CRM · ${report.summary.total_active} opportunities analyzed
  </div>

</body>
</html>`;
}

function renderPrioritySection(label, opps, color, fmt) {
  if (!opps || !opps.length) {
    return `<p style="color:#888;font-size:13px;">${label}: None</p>`;
  }
  const rows = opps.map(o => `<tr>
    <td style="padding:6px 12px;border-bottom:1px solid #eee;">${o.name}</td>
    <td style="padding:6px 12px;border-bottom:1px solid #eee;">${o.salesperson}</td>
    <td style="padding:6px 12px;border-bottom:1px solid #eee;">${o.stage}</td>
    <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">${fmt(o.expected_revenue)}</td>
    <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center;">${o.probability}%</td>
  </tr>`).join('');

  return `<div style="margin-bottom:16px;">
    <h3 style="color:${color};margin-bottom:8px;">${label} (${opps.length})</h3>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#fafafa;">
        <th style="padding:6px 12px;text-align:left;">Opportunity</th>
        <th style="padding:6px 12px;text-align:left;">Salesperson</th>
        <th style="padding:6px 12px;text-align:left;">Stage</th>
        <th style="padding:6px 12px;text-align:right;">Revenue</th>
        <th style="padding:6px 12px;text-align:center;">Prob.</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ─── Priority Classification ───────────────────────────────────────

/**
 * Classify opportunity priority based on stage, revenue, and probability.
 * Adapted from EconoWind's P1-P4 model.
 */
function classifyPriority(opp) {
  const revenue = opp.expected_revenue || 0;
  const probability = opp.probability || 0;
  const stageWeight = STAGE_ORDER[opp.stage] || 1;

  // Revenue score (0-50): based on deal size
  let revenueScore = 0;
  if (revenue >= 2000000) revenueScore = 50;
  else if (revenue >= 1000000) revenueScore = 40;
  else if (revenue >= 500000) revenueScore = 30;
  else if (revenue >= 200000) revenueScore = 20;
  else if (revenue >= 50000) revenueScore = 10;
  else revenueScore = 5;

  // Conversion score (0-50): based on probability + stage advancement
  let conversionScore = (probability / 100) * 30 + (stageWeight / 6) * 20;

  const totalScore = revenueScore + conversionScore;

  if (revenueScore >= 30 && conversionScore >= 25) return 'P1';
  if (revenueScore >= 30 || conversionScore >= 25) return 'P2';
  if (totalScore >= 25) return 'P3';
  return 'P4';
}

// ─── Snapshot Comparison ───────────────────────────────────────────

function compareSnapshots(lastSnapshot, currentOpps) {
  const movements = [];
  const lastMap = {};

  if (Array.isArray(lastSnapshot)) {
    lastSnapshot.forEach(o => { lastMap[o.id] = o; });
  }

  currentOpps.forEach(opp => {
    const prev = lastMap[opp.id];
    if (prev && prev.stage !== opp.stage) {
      movements.push({
        opportunity_id: opp.id,
        opportunity_name: opp.name,
        from_stage: prev.stage,
        to_stage: opp.stage,
        changed_at: opp.last_stage_update || opp.last_modified,
        direction: getMovementDirection(prev.stage, opp.stage)
      });
    }
  });

  return movements;
}

// ─── Helper Functions ──────────────────────────────────────────────

function daysSince(dateStr) {
  if (!dateStr) return 999;
  const then = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

function getMovementDirection(fromStage, toStage) {
  const fromOrder = STAGE_ORDER[fromStage] || 0;
  const toOrder = STAGE_ORDER[toStage] || 0;
  if (toOrder > fromOrder) return 'forward';
  if (toOrder < fromOrder) return 'backward';
  return 'lateral';
}

function getWeekLabel() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - start.getDay() + 1); // Monday
  return start.toISOString().split('T')[0];
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric'
    });
  } catch { return dateStr; }
}

function briefOpp(opp) {
  return {
    id: opp.id,
    name: opp.name,
    company: opp.company,
    stage: opp.stage,
    salesperson: opp.salesperson,
    expected_revenue: opp.expected_revenue,
    probability: opp.probability,
    priority_label: opp.priority_label,
    days_since_activity: opp.days_since_activity,
    is_stale: opp.is_stale,
    expected_closing: opp.expected_closing
  };
}

// ─── Email Sending ─────────────────────────────────────────────────

async function sendReportEmail(report, htmlBody) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.NOTIFY_FROM || 'onboarding@resend.dev';
  const TO = process.env.PIPELINE_REPORT_TO || process.env.NOTIFY_TO || 'petrusc@adsum-auxilio.com';

  if (!RESEND_API_KEY) {
    console.log('[odoo] RESEND_API_KEY not set, skipping email');
    return { sent: false, reason: 'No RESEND_API_KEY' };
  }

  const staleCount = report.stale_opportunities.length;
  const subject = `[EconoWind Pipeline] Week ${report.report_week} — ${report.summary.total_active} active, ${staleCount} stale`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM,
      to: [TO],
      subject: subject,
      html: htmlBody
    })
  });

  const result = await response.json();
  console.log(`[odoo] Report email sent:`, result);
  return { sent: true, email_id: result.id, to: TO };
}

// ─── Route Registration ────────────────────────────────────────────

function registerRoutes(app, pool) {

  // Health check / connectivity test
  app.get('/odoo/status', async (req, res) => {
    try {
      if (!ODOO_LOGIN || !ODOO_API_KEY) {
        return res.json({
          status: 'not_configured',
          message: 'ODOO_LOGIN and ODOO_API_KEY environment variables required'
        });
      }
      const uid = await odooAuthenticate();
      res.json({ status: 'connected', uid, odoo_url: ODOO_URL, db: ODOO_DB });
    } catch (e) {
      res.status(500).json({ status: 'error', message: e.message });
    }
  });

  // Current pipeline snapshot (raw data)
  app.get('/odoo/pipeline-snapshot', async (req, res) => {
    try {
      const uid = await odooAuthenticate();
      const opportunities = await fetchActiveOpportunities(uid);

      res.json({
        generated_at: new Date().toISOString(),
        total: opportunities.length,
        opportunities
      });
    } catch (e) {
      console.error('[odoo] Snapshot error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // Full weekly report (JSON)
  app.get('/odoo/pipeline-report', async (req, res) => {
    try {
      const uid = await odooAuthenticate();
      const report = await generateWeeklyReport(uid, pool);

      // Optionally send email
      if (req.query.email === 'true') {
        const html = formatReportEmail(report);
        const emailResult = await sendReportEmail(report, html);
        report.email = emailResult;
      }

      res.json(report);
    } catch (e) {
      console.error('[odoo] Report error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // Full weekly report (HTML preview)
  app.get('/odoo/pipeline-report/preview', async (req, res) => {
    try {
      const uid = await odooAuthenticate();
      const report = await generateWeeklyReport(uid, pool);
      const html = formatReportEmail(report);
      res.set('Content-Type', 'text/html');
      res.send(html);
    } catch (e) {
      console.error('[odoo] Report preview error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // Save current snapshot for future WoW comparison
  app.post('/odoo/snapshot/save', async (req, res) => {
    try {
      const uid = await odooAuthenticate();
      const opportunities = await fetchActiveOpportunities(uid);

      await pool.query(
        `INSERT INTO pipeline_snapshots (week_label, snapshot_data, opportunity_count, total_revenue)
         VALUES ($1, $2, $3, $4)`,
        [
          getWeekLabel(),
          JSON.stringify(opportunities),
          opportunities.length,
          opportunities.reduce((s, o) => s + (o.expected_revenue || 0), 0)
        ]
      );

      res.json({
        saved: true,
        week: getWeekLabel(),
        opportunities: opportunities.length
      });
    } catch (e) {
      console.error('[odoo] Snapshot save error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // Initialize database table
  if (pool) {
    pool.query(`
      CREATE TABLE IF NOT EXISTS pipeline_snapshots (
        id SERIAL PRIMARY KEY,
        week_label TEXT NOT NULL,
        snapshot_data JSONB NOT NULL,
        opportunity_count INTEGER,
        total_revenue NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).then(() => {
      console.log('[odoo] pipeline_snapshots table ready');
    }).catch(e => {
      console.error('[odoo] Failed to create pipeline_snapshots table:', e.message);
    });
  }

  console.log('[odoo] Odoo CRM proxy routes registered');
}

module.exports = { registerRoutes };
