// Typed readers for process.env, plus the values that more than one file reads.
//
// Every entry point (server.js and each script) calls dotenv.config() before it
// requires anything, so reading at module load is safe here. Values that only
// one file uses stay in that file — this is for the ones that were being parsed
// in several places with the same default, where a changed default in one copy
// would silently disagree with the others.
//
// Secrets that a service reads lazily at call time (ELEVENLABS_API_KEY,
// SARVAM_API_KEY, META_ACCESS_TOKEN, TELECMI_AGENTS …) are deliberately NOT
// here: freezing them at load would change when the environment is sampled.

const raw = (name) => {
  const v = process.env[name];
  return v == null || v === '' ? undefined : v;
};

/** The variable as a string, or `def` when unset or empty. */
const str = (name, def) => (raw(name) === undefined ? def : String(raw(name)));

/** The variable as a finite number, or `def` when unset, empty or not numeric. */
const num = (name, def) => {
  const v = raw(name);
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/** true for 1 / true / yes / on (any case); `def` when unset or empty. */
const bool = (name, def = false) => {
  const v = raw(name);
  return v === undefined ? def : /^(1|true|yes|on)$/i.test(v);
};

module.exports = {
  str,
  num,
  bool,

  MONGO_URI: str('MONGO_URI', 'mongodb://127.0.0.1:27017/followup_dashboard'),

  // Calls shorter than this are not worth transcribing — and not counted as "connected".
  TELECMI_MIN_DURATION_SEC: num('TELECMI_MIN_DURATION_SEC', 30),

  // The Bigin deal stage that means a sale. (The lost stage is only read by dealStore.)
  BIGIN_WON_STAGE: str('BIGIN_WON_STAGE', 'Closed with Sale'),

  // Which calls we spend money transcribing: won | closed | all.
  TRANSCRIBE_SCOPE: str('TRANSCRIBE_SCOPE', 'won').toLowerCase(),
  TRANSCRIBE_POLL_MINUTES: num('TRANSCRIBE_POLL_MINUTES', 10),
  TRANSCRIBE_BATCH: num('TRANSCRIBE_BATCH', 10),

  SARVAM_MODEL: str('SARVAM_MODEL', 'sarvam-105b'),
  ELEVENLABS_MODEL: str('ELEVENLABS_MODEL', 'scribe_v2'),

  WATI_SYNC_MIN: num('WATI_SYNC_MIN', 30),

  // How long the ads attribution indexes (campaign / adset / ad names) are kept.
  CAMPAIGN_INDEX_TTL_MS: num('CAMPAIGN_INDEX_TTL_MS', 60000),
};
