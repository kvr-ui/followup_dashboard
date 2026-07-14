const Deal = require('../models/Deal');
const { ownerScope } = require('../services/ownerScope');

/** Median, not mean: one ₹12,500 discount shouldn't drag a course's going rate down. */
function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * What a course normally sells for: the median amount of WON, NON-upsold deals
 * carrying that product, keyed by product name.
 *
 * Deliberately built from the whole company, not the caller's own deals: a rep with
 * three sales has no meaningful "going rate" of their own, and the price of a course
 * isn't a per-rep fact anyway.
 */
async function baselineByProduct() {
  const rows = await Deal.aggregate([
    { $match: { outcome: 'won', upScale: null } },
    { $unwind: '$products' },
    { $match: { 'products.name': { $ne: null }, amount: { $gt: 0 } } },
    { $group: { _id: '$products.name', amounts: { $push: '$amount' } } },
  ]);

  const map = new Map();
  rows.forEach((r) => map.set(r._id, { typical: median(r.amounts), n: r.amounts.length }));
  return map;
}

/**
 * GET /api/upsells — every won lead who was upsold, and what it actually earned.
 *
 * Upsold = Bigin's `Up_Scale` picklist is set ("Inter G1 - Closed with Sale -
 * (Upsell - Inter G2)"). Unlike the instalments view this ignores payment state:
 * a lead who was upsold and paid in full still belongs here.
 *
 * On "revenue gained" — Bigin does NOT record what the lead was going to pay before
 * the upsell, so the gain cannot be read off the deal. What we CAN do is compare the
 * deal against what that course normally sells for:
 *
 *   uplift = amount - median(amount of won, non-upsold deals for the same product)
 *
 * That makes a real failure visible instead of hiding it: if a rep ticks the Up_Scale
 * picklist but never raises the Amount or attaches the upsold product, the uplift is
 * ₹0 — the upsell earned nothing, and this view says so rather than quietly counting
 * the base course price as upsell revenue.
 *
 * `uplift: null` means we have no baseline (no products on the deal, or that product
 * has never been sold un-upsold) — unknown, which is not the same as zero.
 */
async function listUpsells(req, res) {
  try {
    const scope = ownerScope(req);
    if (!scope) {
      return res.json({
        success: true, count: 0, wonCount: 0, upsellRate: 0,
        totalValue: 0, totalUplift: 0, pendingValue: 0, noUpliftCount: 0, data: [],
      });
    }

    const [deals, wonCount, baseline] = await Promise.all([
      // Newest upsells first — this is a "what did we just do" list, not a chase list.
      Deal.find({ ...scope, outcome: 'won', upScale: { $ne: null } })
        .sort({ closingDate: -1 })
        .lean(),
      Deal.countDocuments({ ...scope, outcome: 'won' }),
      baselineByProduct(),
    ]);

    const data = deals.map((d) => {
      const amount = Number(d.amount) || 0;
      const pending = Number(d.installment) || 0;
      // The deal's own product is the base we price against. Deals carry one product
      // in practice; if there are several, the priciest line is the course they bought.
      const products = (d.products || []).filter((p) => p.name);
      const base = products.slice().sort((a, b) => (b.total || 0) - (a.total || 0))[0];
      const hit = base ? baseline.get(base.name) : null;
      const typical = hit && hit.typical != null ? hit.typical : null;

      return {
        id: d.zohoId,
        dealName: d.name,
        contactName: d.contactName,
        contactPhone: d.contactPhone,
        ownerName: d.ownerName,
        ownerEmail: d.ownerEmail,
        closingDate: d.closingDate,
        upScale: d.upScale,
        products: products.map((p) => p.name),
        amount,
        pending,
        paid: Math.max(amount - pending, 0),
        // Null (unknown) and 0 (booked nothing extra) are different answers.
        typical,
        uplift: typical == null ? null : Math.round(amount - typical),
      };
    });

    const totalUplift = data.reduce((a, d) => a + (d.uplift || 0), 0);

    res.json({
      success: true,
      count: data.length,
      wonCount,
      upsellRate: wonCount ? Math.round((data.length / wonCount) * 100) : 0,
      totalValue: Math.round(data.reduce((a, d) => a + d.amount, 0)),
      totalUplift: Math.round(totalUplift),
      pendingValue: Math.round(data.reduce((a, d) => a + d.pending, 0)),
      // Upsells that booked no extra money — almost always a data-entry miss in Bigin.
      noUpliftCount: data.filter((d) => d.uplift !== null && d.uplift <= 0).length,
      data,
    });
  } catch (err) {
    console.error('Upsells failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to build upsells' });
  }
}

module.exports = { listUpsells };
