// The one and only "whose lead is this" in this backend.
//
// A stored Task's `body` is EITHER a single task object OR an array of them
// (one contact, several follow-ups), so every owner test has to handle both.
// That subtlety lived only inside taskController for a while; the moment a
// second reader needed it — the VSL tracking tab, which drops any row the
// logged-in rep does not own — it had to become shared.
//
// Same rule as utils/phone.js states for phone keys: keep a single
// implementation. Two owner-matchers that drift by one character mean a rep sees
// a colleague's lead in one view and a 403 in another, and nobody can tell which
// one is right.

/** The owner email on ONE task object, lowercased. */
function ownerEmailOf(task) {
  return task && task.Owner && task.Owner.email ? String(task.Owner.email).toLowerCase() : null;
}

/** Every owner email on a Task document — the set canAccess() tests against. */
function taskOwnerEmails(doc) {
  if (!doc) return [];
  const body = doc.body;
  const bodies = Array.isArray(body) ? body : [body];
  return bodies.map(ownerEmailOf).filter(Boolean);
}

module.exports = { ownerEmailOf, taskOwnerEmails };
