// Display fields off a Meta instant-form answer set.
//
// A Meta lead's answers are an untyped [{name, values}] list whose field names
// are chosen per form, so a display name has to be looked for under several.
// Display only — the PHONE is deliberately not extracted here but taken from
// leadLinker.phoneFromFieldData, so the number shown is the same 10-digit key
// everything else joins on rather than a second, subtly different normaliser.
//
// Shared by the Ad Leads tab and the lead profile, so both name a Meta lead the
// same way.

const NAME_FIELDS = ['fullname', 'name', 'firstname', 'yourname'];
const EMAIL_FIELDS = ['email', 'emailaddress', 'youremail'];

function fieldValue(fieldData, wanted) {
  if (!Array.isArray(fieldData)) return null;
  for (const want of wanted) {
    for (const entry of fieldData) {
      if (!entry || typeof entry !== 'object') continue;
      const name = String(entry.name == null ? '' : entry.name)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      if (name !== want) continue;
      const values = Array.isArray(entry.values) ? entry.values : [entry.values];
      const value = values.find((v) => v != null && String(v).trim() !== '');
      if (value != null) return String(value);
    }
  }
  return null;
}

module.exports = { NAME_FIELDS, EMAIL_FIELDS, fieldValue };
