// The one and only phone-normalisation in this backend.
//
// Indian numbers reach us in every shape — +91 98765 43210, 919876543210,
// 09876543210, 9876543210 — so every cross-module join key (call <-> deal,
// task <-> ad lead) is the last 10 digits. Keep a single implementation:
// two normalisers that drift by one character silently stop matching.

// Normalise any phone to its last 10 digits — robust across +91 / 91 / bare formats.
// Lenient: a shorter fragment is returned as-is (used for loose index lookups).
function key10(value) {
  const d = String(value || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d || null;
}

// A *strict* match key for cross-linking records: the last 10 digits, but ONLY
// when the number has 10+ digits. Unlike key10, a shorter fragment is rejected
// (returns null) — so a 6-digit landline (or a malformed number) can't loosely
// match an unrelated number that merely ends the same way. This is the
// cross-link guard the old regex-suffix match lacked.
function phoneKey(value) {
  const d = String(value || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

module.exports = { key10, phoneKey };
