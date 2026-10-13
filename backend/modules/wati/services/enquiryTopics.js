// What a lead asked about on WhatsApp, by keyword. Rules, not AI: free,
// instant, and anyone can read why a message landed in a topic. Add a word to a
// rule when the "Other" bucket shows something it missed.

const TOPICS = [
  // Click-to-WhatsApp ads open the chat with this text already typed, in
  // English, Tamil or Hindi — the lead tapped the ad, they didn't write it.
  {
    key: 'adClick',
    label: 'Ad click (pre-filled "more info")',
    re: /can i get more info|இது குறித்த மேலும்|क्या मुझे इस बारे में/i,
  },
  { key: 'video', label: 'Asked for the video', re: /\b(get video|video)\b/i },
  { key: 'confirm', label: 'Replied "Confirm"', re: /^\s*confirm\b/i },
  { key: 'fees', label: 'Fees / price', re: /\b(fee|fees|price|cost|amount|rs\.?|discount|offer|emi|instal+ment|pay|payment)\b|₹/i },
  { key: 'kit', label: 'Kit / material', re: /\b(kit|material|materials|book|books|notes|question bank|qb|test series|mock)\b/i },
  { key: 'demo', label: 'Sample / demo', re: /\b(demo|sample|trial|free class)\b/i },
  { key: 'classes', label: 'Live / recorded / online classes', re: /\b(live|recorded|online|offline|classes|class|regular)\b/i },
  { key: 'details', label: 'Details / brochure / how to enrol', re: /\b(brochure|details?|enrol+|join|admission|register)\b/i },
  { key: 'schedule', label: 'Batch / timing', re: /\b(batch|timing|timings|time table|timetable|schedule|start date|duration|validity)\b/i },
  {
    key: 'attempt',
    label: 'Level / attempt / group',
    re: /\b(attempt|g1|g2|group ?(1|2|i|ii)|both groups|first time|repeater|foundation|inter|intermediate|final|finalist|cma|direct entry|semi qualified|jan|may|sep|sept|nov)\b/i,
  },
  { key: 'language', label: 'Language', re: /\b(tamil|telugu|hindi|english|malayalam|kannada|language)\b/i },
  { key: 'faculty', label: 'Faculty / mentor', re: /\b(faculty|mentor|mentoring|mentorship|teacher|tutor|doubt|doubts|counsel+ing)\b/i },
  { key: 'callMe', label: 'Asked for a call', re: /\b(speak|call me|contact me|talk to)\b|didn'?t (receive|get)\w* any call/i },
];

const GREETING_RE = /^\s*(hi+|hello+|hey+|hai+|ok+|okay|k|thanks?|thank you|yes|no|\.|👍\S*)\s*[.!]*\s*$/i;

/** Is this lead message only a greeting / acknowledgement? */
const isGreeting = (text) => !text || GREETING_RE.test(text);

/** The topic keys a set of lead messages touch. Empty when none match. */
function topicsOf(texts) {
  const found = new Set();
  for (const t of texts) {
    if (!t) continue;
    for (const topic of TOPICS) if (topic.re.test(t)) found.add(topic.key);
  }
  return [...found];
}

module.exports = { TOPICS, topicsOf, isGreeting };
