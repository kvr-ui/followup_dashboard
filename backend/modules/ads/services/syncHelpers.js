// Reference hygiene for the Meta mirror.
//
// Meta can return a child (ad set, ad, lead, insight) whose parent object wasn't
// in our fetch — an archived campaign is the common case. Storing that child with
// a reference to a parent we don't hold would break every join the reporting
// endpoints rely on, and it fails silently: the row is there, the lookup returns
// nothing. So any reference to an object we don't have locally is nulled out.

/** Return the id only if it exists in `known`; otherwise null. */
function keepIfKnown(id, known) {
  if (id === null || id === undefined) return null;
  return known.has(id) ? id : null;
}

/** Load the set of existing `_id`s for a collection (used to validate references). */
async function loadKnownIds(model) {
  const rows = await model.find({}, { _id: 1 }).lean();
  return new Set(rows.map((r) => String(r._id)));
}

module.exports = { keepIfKnown, loadKnownIds };
