const usage = require('../services/apiUsage');

/**
 * GET /api/calls/usage — what the AI pipeline has spent, and what is left.
 *
 * Admin-only: this is billing data for the whole account, not per-rep performance.
 * Both providers are read in parallel and each one's balance failure is reported
 * inside its own card, so a broken ElevenLabs key never blanks the Sarvam numbers.
 */
async function apiUsage(req, res) {
  try {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));

    const [sarvam, elevenlabs, historical] = await Promise.all([
      usage.summary('sarvam', { days }),
      usage.summary('elevenlabs', { days }),
      usage.historicalTotals(),
    ]);

    const elevenBalance = await usage.elevenLabsBalance({
      force: req.query.refresh === '1',
    });

    res.json({
      success: true,
      days,
      providers: {
        sarvam: {
          label: 'Sarvam AI',
          purpose: 'Call grading (LLM)',
          configured: Boolean(process.env.SARVAM_API_KEY),
          model: process.env.SARVAM_MODEL || 'sarvam-105b',
          unit: 'tokens',
          ...sarvam,
          balance: usage.sarvamBalance(sarvam.totals.allTime.totalTokens),
          lifetime: { gradedCalls: historical.gradedCalls },
        },
        elevenlabs: {
          label: 'ElevenLabs',
          purpose: 'Call transcription (speech-to-text)',
          configured: Boolean(process.env.ELEVENLABS_API_KEY),
          model: process.env.ELEVENLABS_MODEL || 'scribe_v2',
          unit: 'audio',
          ...elevenlabs,
          balance: elevenBalance,
          lifetime: {
            transcribedCalls: historical.transcribedCalls,
            transcribedSeconds: historical.transcribedSeconds,
          },
        },
      },
    });
  } catch (err) {
    console.error('api usage failed:', err.message);
    res.status(500).json({ success: false, message: 'Could not read API usage' });
  }
}

module.exports = { apiUsage };
