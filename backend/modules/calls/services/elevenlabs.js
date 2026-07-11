// ElevenLabs Speech-to-Text (Scribe).
//
// Calls are 8kHz mono telephone audio with mixed Tamil/English code-switching,
// so we let the model auto-detect the language and rely on diarization to tell
// the agent and the customer apart.

const API_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

const API_KEY = process.env.ELEVENLABS_API_KEY;
const MODEL = process.env.ELEVENLABS_MODEL || 'scribe_v2';
const FALLBACK_MODEL = 'scribe_v1';

function isConfigured() {
  return Boolean(API_KEY);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Group the flat word list into per-speaker segments (readable transcript). */
function buildSegments(words) {
  if (!Array.isArray(words) || !words.length) return null;

  const segments = [];
  let current = null;

  for (const w of words) {
    if (w.type && w.type !== 'word' && w.type !== 'spacing') continue;
    const speaker = w.speaker_id || 'speaker_0';

    if (!current || current.speaker !== speaker) {
      if (current) segments.push(current);
      current = { speaker, start: w.start, end: w.end, text: '' };
    }
    current.text += (w.type === 'spacing' ? ' ' : w.text || '');
    current.end = w.end ?? current.end;
  }
  if (current) segments.push(current);

  return segments
    .map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text);
}

/**
 * Transcribe an audio buffer.
 * @returns {{ok:boolean, text?:string, language?:string, segments?:Array, durationSec?:number, model?:string, error?:string}}
 */
async function transcribe(buffer, filename = 'call.mp3', attempt = 0, model = MODEL) {
  if (!isConfigured()) return { ok: false, skipped: true, error: 'ELEVENLABS_API_KEY not set' };

  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/mpeg' }), filename);
    form.append('model_id', model);
    form.append('diarize', 'true');       // separate agent vs customer
    form.append('num_speakers', '2');     // a sales call is two people
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'false');
    // language_code intentionally omitted -> auto-detect (Tamil/English mixing)

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'xi-api-key': API_KEY },
      body: form,
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      if (attempt < 2) {
        await sleep(2000 * (attempt + 1));
        return transcribe(buffer, filename, attempt + 1, model);
      }
      return { ok: false, error: `ElevenLabs non-JSON response (${res.status})` };
    }

    if (!res.ok) {
      const msg = json.detail?.message || json.detail || json.message || `HTTP ${res.status}`;

      // Unknown model -> retry once on the older Scribe model.
      if (res.status === 422 && model !== FALLBACK_MODEL) {
        return transcribe(buffer, filename, 0, FALLBACK_MODEL);
      }
      // Rate limited / transient -> back off and retry.
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(3000 * (attempt + 1));
        return transcribe(buffer, filename, attempt + 1, model);
      }
      return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
    }

    return {
      ok: true,
      model,
      text: json.text || '',
      language: json.language_code || null,
      languageConfidence: json.language_probability ?? null,
      segments: buildSegments(json.words),
      durationSec: json.audio_duration_secs ?? json.duration ?? null,
    };
  } catch (err) {
    if (attempt < 2) {
      await sleep(2000 * (attempt + 1));
      return transcribe(buffer, filename, attempt + 1, model);
    }
    return { ok: false, error: err.message };
  }
}

module.exports = { isConfigured, transcribe, MODEL };
