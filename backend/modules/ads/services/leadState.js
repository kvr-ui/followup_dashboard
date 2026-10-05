// What actually happened to a lead — the one and only derivation.
//
// Used by the Ad Leads tab (GET /api/ads/leads, one row per form fill) and by the
// lead profile header (GET /api/lead-profile/:phoneKey). Two copies of this rule
// that drift would mean the tab calls a lead "won" and its profile calls it
// "pipeline", with no way to tell which one is lying.

const LEAD_STATES = ['won', 'lost', 'pipeline', 'followup', 'none'];

/**
 * The state alone.
 *
 * The Deal answers first because it is the commercial fact: a contact with a
 * "Closed with Sale" deal has bought, whatever their follow-up task still says.
 * The Task answers only when no deal exists at all — "somebody is working it".
 *
 *   won      the deal closed with a sale
 *   lost     the deal closed without one
 *   pipeline a deal exists and is still open
 *   followup a follow-up task exists but no deal does
 *   none     nobody has picked this lead up
 *
 * `outcome` is READ, never re-derived from the stage string: dealStore normalised
 * it at write time (outcomeOf), and recomputing here would mean this tab and the
 * Sources tab could disagree about the same deal.
 *
 * Which deal to pass is the caller's decision — the Ad Leads tab ranks won over
 * lost over open, the profile header takes the newest.
 */
function leadState(task, deal) {
  if (deal) {
    if (deal.outcome === 'won') return 'won';
    if (deal.outcome === 'lost') return 'lost';
    return 'pipeline';
  }
  return task ? 'followup' : 'none';
}

/**
 * The full status object an Ad Leads row carries.
 *
 * `matchedBy` is carried out to the UI because the two joins are not equally
 * strong. 'lead-id' is Meta's own lead id on both sides — a fact. 'phone' is a
 * 10-digit key, which a family or a reused handset can share — an inference. The
 * tab shows the difference rather than flattening a guess into a sale, the same
 * way `resolvedBy` does for campaign attribution.
 */
function leadStatus(task, deal, matchedBy) {
  const taskStatus = (task && task.body && task.body.Status) || null;
  return {
    state: leadState(task, deal),
    stage: deal ? deal.stage || null : null,
    taskStatus,
    amount: deal && deal.outcome === 'won' ? deal.amount || 0 : null,
    closingDate: deal ? deal.closingDate || null : null,
    matchedBy: deal ? matchedBy : null,
  };
}

// ---------------------------------------------------------------------------
// Funnel stage — MQL / SQL / Closed
// ---------------------------------------------------------------------------

const FUNNEL_STAGES = ['mql', 'sql', 'closed'];

// A call must run strictly longer than this to qualify a lead. Anything shorter
// is a missed call, a ring-out or "call me later" — not a sales conversation.
const SQL_MIN_CALL_SEC = 30;

/**
 * Where a lead sits in the funnel.
 *
 *   closed  any deal closed with a sale
 *   sql     a call over SQL_MIN_CALL_SEC (either direction, any attempt — an
 *           early missed call doesn't count against the lead), OR any deal at
 *           all: a deal in Bigin means sales already qualified them, even when
 *           the conversation never reached our call log (WhatsApp, unlogged call)
 *   mql     everyone else — a form fill, Meta lead or follow-up task
 *
 * A lost deal stays sql: the stage is how far the lead got, and the Status
 * column already says "lost".
 */
function funnelStage({ deals, hasQualifyingCall }) {
  const list = deals || [];
  if (list.some((d) => d && d.outcome === 'won')) return 'closed';
  if (list.length || hasQualifyingCall) return 'sql';
  return 'mql';
}

module.exports = {
  LEAD_STATES,
  leadState,
  leadStatus,
  FUNNEL_STAGES,
  SQL_MIN_CALL_SEC,
  funnelStage,
};
