// Reading a lead form's `fieldData` — the one place that knows its shapes.
//
// Meta sends `[{ name, values: [] }]`; migrated and hand-made rows sometimes carry
// `key` or `field` for the name and a bare `value`. The linker (phone lookup) and
// the acquisition view (qualification answers) both walk these entries, and they
// must agree on which entry is which: a field matched under one spelling of the
// name and missed under another is an answer that shows in one panel and not
// the other. Names are compared with normalizeName, the same rule as campaigns.

const { normalizeName } = require('./normalizeName');

/** The entry's normalised field name, or '' when there is none. */
function entryName(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return normalizeName(entry.name != null ? entry.name : entry.key != null ? entry.key : entry.field);
}

/** Every value on the entry as an array, whichever of `values` / `value` it uses. */
function entryValues(entry) {
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry.values)) return entry.values;
  if (entry.values != null) return [entry.values];
  if (Array.isArray(entry.value)) return entry.value;
  if (entry.value != null) return [entry.value];
  return [];
}

module.exports = { entryName, entryValues };
