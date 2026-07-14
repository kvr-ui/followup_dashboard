const Deal = require('../models/Deal');

/**
 * GET /api/installments — won deals the lead hasn't finished paying for.
 *
 * The lead bought the course but is paying in instalments, so the rep records the
 * OUTSTANDING balance in Bigin's `Installment` currency field. That makes the
 * pending list a simple predicate:
 *
 *   outcome = won  AND  installment > 0
 *
 * `installment: 0` is a settled deal and `installment: null` is one nobody has
 * recorded a balance for — neither is money we're chasing, and both are excluded
 * by `$gt: 0` (Mongo never matches null against a numeric range).
 *
 * Unlike the rest of the calls module this is NOT admin-only: it's the rep's own
 * collections list. Sales users are pinned to their own deals server-side — the
 * `owner` query param is honoured for admins only, so a rep can't read a
 * colleague's book by editing the URL.
 */
async function listInstallments(req, res) {
  try {
    const isAdmin = req.user.role === 'admin';
    const mine = (req.user.ownerEmail || '').toLowerCase();

    const q = { outcome: 'won', installment: { $gt: 0 } };

    if (isAdmin) {
      if (req.query.owner) q.ownerEmail = String(req.query.owner).toLowerCase();
    } else {
      // A sales user with no ownerEmail owns no deals — say so, rather than
      // falling through to an unscoped query that would leak the whole pipeline.
      if (!mine) {
        return res.json({ success: true, count: 0, totalPending: 0, totalPaid: 0, data: [] });
      }
      q.ownerEmail = mine;
    }

    // Oldest closing date first: the longest-outstanding balance is the one to chase.
    const deals = await Deal.find(q).sort({ closingDate: 1 }).lean();

    const data = deals.map((d) => {
      const amount = Number(d.amount) || 0;
      const pending = Number(d.installment) || 0;
      return {
        id: d.zohoId,
        dealName: d.name,
        contactName: d.contactName,
        contactPhone: d.contactPhone,
        ownerName: d.ownerName,
        ownerEmail: d.ownerEmail,
        closingDate: d.closingDate,
        // Bigin's `Up_Scale` picklist: set means this lead was upsold to a bigger
        // course than they first asked for. Null is the normal case, not an error.
        upScale: d.upScale || null,
        amount,
        pending,
        // What they've already handed over. Clamped at 0: if a rep types a balance
        // bigger than the deal amount the data is wrong, but a negative "paid"
        // column would make the dashboard look broken rather than the record.
        paid: Math.max(amount - pending, 0),
        products: (d.products || []).map((p) => p.name).filter(Boolean),
      };
    });

    res.json({
      success: true,
      count: data.length,
      totalPending: Math.round(data.reduce((a, d) => a + d.pending, 0)),
      totalPaid: Math.round(data.reduce((a, d) => a + d.paid, 0)),
      upsold: data.filter((d) => d.upScale).length,
      data,
    });
  } catch (err) {
    console.error('Installments failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to build installments' });
  }
}

module.exports = { listInstallments };
