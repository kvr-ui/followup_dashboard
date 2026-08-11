// One definition of "what channel is this", shared by everything that reads
// Bigin's lead source.
//
// WHY THIS FILE EXISTS
// --------------------
// `Contacts.Lead_Source1` in Bigin is a TEXT field, not a picklist. Nothing stops
// a rep typing whatever they like, and nothing has: the same three channels
// arrive as "Whatsapp" / "WhatsApp DMs" / "Whatsapp Dms" / "WhatsApp", as
// "ig" / "fb" / "Instagram Ads" / "Meta Ads", as "Student Registration" /
// "Student Registrations" / "Student Regsitrations". Reported raw, the biggest
// revenue channel in the business splits four ways and looks like four small ones.
//
// So every consumer canonicalises — and they must all canonicalise IDENTICALLY,
// or the panel, the report and the stored key disagree about what a channel is.
// Hence one function, here, imported by all three.
//
// CONSERVATIVE ON PURPOSE
// -----------------------
// An unrecognised value is passed through VERBATIM rather than swept into
// "Other". A channel nobody has taught this file about should appear as itself
// the first time it sells something, not vanish into a bucket. The cost of that
// choice is a slightly longer list; the cost of the opposite is an invisible
// channel.
//
// The right fix is upstream — make Lead_Source1 a picklist in Bigin — at which
// point this file becomes a thin no-op instead of load-bearing. Until then it is
// the only thing standing between the dashboard and four WhatsApps.

/** Sources with no channel recorded at all. Named, not blank, so it can't hide. */
const NO_SOURCE = '(no source set)';

// Ordered: the first pattern that matches wins, so the narrow rules
// ("whatsapp ads" — a paid Meta placement) must precede the broad ones
// ("whatsapp" — an organic DM). Reversing two lines here silently moves ad
// revenue into the organic column.
const RULES = [
  [/^(ig|fb|instagram ads|facebook ads|meta ads|fb ads|ig ads)$/, 'Meta Ads'],
  [/whatsapp ads/, 'WhatsApp Ads (Meta)'],
  [/whatsapp|wa dm/, 'WhatsApp (organic/DM)'],
  [/instagram dm|ig dm/, 'Instagram DM (organic)'],
  [/student reg/, 'Student Registration'],
  [/refer|reffer/, 'Referral'],
  [/direct call/, 'Direct Call'],
  [/sayl/, 'SAYL'],
  [/upsell/, 'Upsell'],
  [/^kit/, 'Kit form'],
  [/mentor/, 'Mentor session'],
  [/manual/, 'Manual'],
];

/**
 * Merge the spellings of one channel into a single display name.
 * @param {*} raw the value of Contacts.Lead_Source1
 * @returns {string} a canonical channel name, or the raw value if unrecognised
 */
function canonicalSource(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return NO_SOURCE;

  const key = text.toLowerCase();
  for (const [pattern, name] of RULES) {
    if (pattern.test(key)) return name;
  }
  return text;
}

/** Is this channel one we PAY Meta for? Drives the paid/organic split. */
function isPaidMeta(canonical) {
  return canonical === 'Meta Ads' || canonical === 'WhatsApp Ads (Meta)';
}

// Bigin's `leadchain2__Social_Lead_ID` is a text field too, and the team types
// notes into it ("Repeater candidate") — 141 of 1,460 populated values are not
// ids. Only a long run of digits is Meta's lead id; anything else would resolve
// to nothing and quietly inflate the "traceable to a campaign" count.
const META_LEAD_ID = /^\d{6,}$/;

/** @returns {string|null} the Meta lead id, or null if the field holds prose. */
function metaLeadId(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  return META_LEAD_ID.test(text) ? text : null;
}

module.exports = { canonicalSource, isPaidMeta, metaLeadId, NO_SOURCE };
