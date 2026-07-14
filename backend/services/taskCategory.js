// Work out a task's category.
//
// Bigin has a custom `Task_Category` picklist, but it is brand new — only 2 of the
// 2,000 most recent tasks have it filled in. For years the reps have been typing the
// category into the task SUBJECT instead: "Follow Up", "Call Back", "Followup-NR",
// "See Response". 522 distinct spellings across 2,600 tasks.
//
// So: prefer what Bigin says. Fall back to reading the subject. Always record which,
// because an inferred category must never be mistaken for a recorded one.

// The 7 values that actually exist in Bigin's picklist.
const BIGIN_CATEGORIES = [
  'Call Back',
  'Final Call Back',
  'Final Follow Up',
  'Follow Up',
  'ICAI Not - Foundation',
  'ICAI Not - Intermediate',
  'See Response',
];

// "No Response" is NOT in Bigin's picklist — but ~400 tasks say Followup-NR,
// NR followup, NR follow up, call back-nr... It is plainly a category the team
// uses every day. We surface it so it can be added to the picklist properly.
const NO_RESPONSE = 'No Response (NR)';

const ALL_CATEGORIES = [...BIGIN_CATEGORIES, NO_RESPONSE];

/** Bigin writes an unset picklist as the literal "-None-". That is not a category. */
function cleanCategory(v) {
  if (!v) return null;
  const s = String(v).trim();
  return !s || s === '-None-' ? null : s;
}

/**
 * Read the category out of a task subject.
 *
 * ORDER MATTERS. "Followup-NR" contains both "followup" and "nr" — it must match
 * No Response, not Follow Up, because the NR is the outcome. Likewise "Final Call
 * Back" must be tested before plain "Call Back", or every final call back would be
 * filed as an ordinary one.
 */
function categoryFromSubject(subject) {
  if (!subject) return null;
  const s = String(subject).toLowerCase().trim();

  // 1. No response — the outcome trumps whatever kind of call it was.
  //    Match "nr" only as a whole token, so "inter" / "nrml" don't false-positive.
  if (/(^|[^a-z])nr([^a-z]|$)/.test(s)) return NO_RESPONSE;

  // 2. Final variants, before their non-final counterparts.
  const isFinal = /\b(final|last)\b/.test(s);
  const isCallBack = /call\s*-?\s*back|callback|call back/.test(s) || /\bfinal call\b/.test(s);
  const isFollowUp = /follow\s*-?\s*up|followup|follow up|f\.?\s*up|folloup|followu/.test(s);

  if (isFinal && isCallBack) return 'Final Call Back';
  if (isFinal && isFollowUp) return 'Final Follow Up';

  // 3. See Response (and its many misspellings — "See respoonse").
  if (/see\s+(final\s+)?respo+n?se/.test(s)) return 'See Response';

  // 4. ICAI registration blockers.
  if (/icai/.test(s) && /found/.test(s)) return 'ICAI Not - Foundation';
  if (/icai/.test(s) && /inter/.test(s)) return 'ICAI Not - Intermediate';

  // 5. The plain forms.
  if (isCallBack) return 'Call Back';
  if (isFollowUp) return 'Follow Up';

  // Everything else — "Sale Confirm", "New Lead", "Foundation" — is a real thing the
  // reps do, but it is not one of the categories. Better null than a wrong guess.
  return null;
}

/**
 * The category for one task, and where it came from.
 * @returns {{category: string|null, source: 'bigin'|'subject'|null}}
 */
function resolveCategory(task) {
  const fromBigin = cleanCategory(task && task.Task_Category);
  if (fromBigin) return { category: fromBigin, source: 'bigin' };

  const fromSubject = categoryFromSubject(task && task.Subject);
  if (fromSubject) return { category: fromSubject, source: 'subject' };

  return { category: null, source: null };
}

module.exports = {
  BIGIN_CATEGORIES,
  ALL_CATEGORIES,
  NO_RESPONSE,
  cleanCategory,
  categoryFromSubject,
  resolveCategory,
};
