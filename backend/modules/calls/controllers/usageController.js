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

    const [sarvam, elevenlabs, openai, historical] = await Promise.all([
      usage.summary('sarvam', { days }),
      usage.summary('elevenlabs', { days }),
      usage.summary('openai', { days }),
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
        // The ask-the-data agent. Unlike the two above it is driven by people
        // asking questions rather than by a worker draining a queue, so its
        // spend moves in bursts — which is exactly why it belongs on this tab
        // instead of being invisible.
        openai: {
          label: 'OpenAI',
          purpose: 'Ask-the-data agent',
          configured: Boolean(process.env.OPENAI_API_KEY),
          model: process.env.OPENAI_MODEL || 'gpt-5',
          unit: 'tokens',
          ...openai,
          balance: {
            available: false,
            reason:
              'OpenAI bills in arrears and publishes no balance endpoint on the API key. ' +
              'See platform.openai.com/usage for the account total.',
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
