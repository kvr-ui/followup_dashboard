const mongoose = require('mongoose');

// What we have spent at each AI provider, rolled up per calendar day.
//
// WHY A COUNTER AND NOT A DERIVED NUMBER
// The obvious way to answer "how many Sarvam tokens have we burned?" is to sum a field
// on the Call documents. It undercounts, badly: a call that was graded three times pays
// three times but stores one grade, a call whose transcript came back unparseable pays
// full price and stores nothing at all, and a re-transcribed recording is billed twice.
// The provider bills per REQUEST, so the only honest ledger is one we write per request.
//
// A day is a LOCAL calendar day. The container runs TZ=Asia/Kolkata, so a grade at
// 11pm IST belongs to that day and not to the UTC day after it — the same convention
// the ads sync and the call stats already use.
const apiUsageSchema = new mongoose.Schema(
  {
    // 'openai' is the ask-the-data agent (modules/agent). It bills per token like
    // Sarvam does, so it shares the token columns below rather than needing its own.
    provider: { type: String, enum: ['sarvam', 'elevenlabs', 'openai'], required: true },
    day: { type: String, required: true }, // 'YYYY-MM-DD', local

    requests: { type: Number, default: 0 },
    failures: { type: Number, default: 0 }, // requests that returned an error

    // Sarvam (chat completions). completionTokens includes the model's hidden reasoning.
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },

    // ElevenLabs (speech-to-text) bills by audio length, not by tokens.
    audioSeconds: { type: Number, default: 0 },

    lastAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One row per provider per day — the upsert key in services/apiUsage.js.
apiUsageSchema.index({ provider: 1, day: 1 }, { unique: true });

module.exports = mongoose.model('ApiUsage', apiUsageSchema);
