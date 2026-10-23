// Who has had a CONNECTED call — shared by Ad Performance (its MQL) and the UTM
// Report (its "demo completed"), so the two tabs agree on what "connected" means.

const Call = require('../../calls/models/Call');
const { isRealPhoneKey } = require('../../../utils/phone');

const talkSeconds = (c) => Math.max(Number(c.duration) || 0, Number(c.biginDurationSec) || 0);

/**
 * The phone keys and Bigin contact ids, out of those given, with at least one
 * connected call — any talk time at all, whenever it happened (decision: no time
 * window). Connect = max(duration, biginDurationSec) > 0, the Rep Lifecycle
 * tab's rule. The $or is the same rule as a Mongo prefilter.
 *
 * @returns {Promise<{connectedPhones: Set<string>, connectedContactIds: Set<string>}>}
 */
async function loadConnectedSets({ phoneKeys = [], contactIds = [] }) {
  const connectedPhones = new Set();
  const connectedContactIds = new Set();
  if (!phoneKeys.length && !contactIds.length) return { connectedPhones, connectedContactIds };

  const calls = await Call.find(
    {
      $and: [
        { $or: [{ duration: { $gt: 0 } }, { biginDurationSec: { $gt: 0 } }] },
        {
          $or: [
            ...(phoneKeys.length ? [{ phoneKeys: { $in: phoneKeys } }] : []),
            ...(contactIds.length ? [{ biginContactId: { $in: contactIds } }] : []),
          ],
        },
      ],
    },
    { phoneKeys: 1, biginContactId: 1, duration: 1, biginDurationSec: 1 }
  ).lean();

  for (const call of calls) {
    if (!(talkSeconds(call) > 0)) continue;
    for (const k of call.phoneKeys || []) {
      if (isRealPhoneKey(k)) connectedPhones.add(k);
    }
    if (call.biginContactId) connectedContactIds.add(String(call.biginContactId));
  }
  return { connectedPhones, connectedContactIds };
}

module.exports = { loadConnectedSets };
