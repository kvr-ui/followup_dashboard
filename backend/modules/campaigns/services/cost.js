/**
 * What a campaign costs.
 *
 * Meta bills per 24-hour CONVERSATION, not per message, and the price depends on the
 * template's category. In India a marketing conversation is roughly 7x a utility one,
 * which is why `templateCategory` is a real field and not a label: sending a utility
 * template where a marketing one would do is the single biggest lever on the bill.
 *
 * These are list prices, not your prices — WATI resells at its own rate and Meta
 * revises the card periodically. Override them in .env rather than editing this file,
 * and treat every number here as an ESTIMATE. `Campaign.actualCost` is the same
 * arithmetic applied to messages that really went out; neither is an invoice.
 */

const RATES = {
  MARKETING: Number(process.env.WA_RATE_MARKETING || 0.78),
  UTILITY: Number(process.env.WA_RATE_UTILITY || 0.115),
  AUTHENTICATION: Number(process.env.WA_RATE_AUTH || 0.115),
  SERVICE: Number(process.env.WA_RATE_SERVICE || 0), // user-initiated: free tier
};

const CURRENCY = process.env.WA_CURRENCY || 'INR';

function rateFor(category) {
  const key = String(category || 'MARKETING').toUpperCase();
  return RATES[key] !== undefined ? RATES[key] : RATES.MARKETING;
}

/** Per-message cost. One template send opens one billable conversation. */
function costPerMessage(category) {
  return rateFor(category);
}

function estimate(category, recipientCount) {
  return Math.round(rateFor(category) * recipientCount * 100) / 100;
}

/**
 * Cost per outcome. This is the number that should actually drive spend decisions,
 * and the reason we bother storing cost at all: a campaign with a 60% read rate and
 * a ₹900 cost-per-reply is a worse campaign than one with a 20% read rate and a ₹40
 * cost-per-reply, and no engagement-rate dashboard will ever tell you that.
 *
 * Returns null (not 0, not Infinity) where the denominator is zero — "no replies yet"
 * is not the same fact as "each reply was free".
 */
function efficiency({ cost, delivered, read, clicked, replied }) {
  const per = (n) => (n > 0 ? Math.round((cost / n) * 100) / 100 : null);
  return {
    currency: CURRENCY,
    cost: Math.round(cost * 100) / 100,
    costPerDelivered: per(delivered),
    costPerRead: per(read),
    costPerClick: per(clicked),
    costPerReply: per(replied),
  };
}

module.exports = { RATES, CURRENCY, rateFor, costPerMessage, estimate, efficiency };
