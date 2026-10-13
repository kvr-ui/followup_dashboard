// Reaching a lead's Bigin deal — shared by the Ad Leads list (GET /api/ads/leads)
// and the Ad Performance roll-up (GET /api/ads/performance), so the two tabs can
// never disagree about which deal a lead closed with.

// Enough of a Deal to say what happened, and nothing more — these lists run
// thousands of rows wide and a Deal carries a products subform.
const DEAL_FIELDS = {
  socialLeadId: 1,
  contactId: 1,
  contactPhoneKey: 1,
  stage: 1,
  outcome: 1,
  lostReason: 1,
  amount: 1,
  closingDate: 1,
  modifiedTime: 1,
};

// A contact can carry several deals. Won beats lost beats open — a lead that lost
// one deal and won another HAS bought — and within a rank the newest wins.
const OUTCOME_RANK = { won: 0, lost: 1, open: 2 };

function bestDeal(a, b) {
  if (!a) return b;
  if (!b) return a;
  const rank = (d) => (OUTCOME_RANK[d.outcome] === undefined ? 3 : OUTCOME_RANK[d.outcome]);
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? a : b;
  const at = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
  const bt = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
  return bt > at ? b : a;
}

/** Map of key -> best deal, keyed by whatever `keyOf` reads off a deal. */
function indexDeals(deals, keyOf) {
  const map = new Map();
  for (const deal of deals) {
    const key = keyOf(deal);
    if (!key) continue;
    map.set(String(key), bestDeal(map.get(String(key)), deal));
  }
  return map;
}

module.exports = { DEAL_FIELDS, bestDeal, indexDeals };
