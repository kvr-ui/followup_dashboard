// Zoho PhoneBridge recording download.
//
// Outbound calls are placed from Bigin through TeleCMI's PhoneBridge integration. Their
// audio is served by Zoho (phonebridge.zoho.in/...), NOT by TeleCMI's /v2/play — TeleCMI's
// REST API never returns those calls at all. So this is the only way to reach the audio
// for every outbound call, which is the bulk of a rep's day.
//
// Auth is the ordinary Zoho OAuth token, but the app must have been authorised with a
// PhoneBridge scope on top of the Bigin ones. Without it Zoho answers 200 with
// OAUTH_SCOPE_MISMATCH in the body (not a 4xx), so we detect it explicitly and report a
// fixable message instead of letting a JSON error blob get stored as "audio".

const { getAccessToken } = require('../../../services/zoho');

/** A scope failure is fixed once, centrally — it is never the individual call's fault. */
class ScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScopeError';
    this.isScopeError = true;
  }
}

/**
 * Download a PhoneBridge recording as a Buffer.
 * Throws ScopeError when the token lacks the PhoneBridge scope.
 */
async function downloadRecording(url) {
  if (!url) throw new Error('No recording URL');

  const token = await getAccessToken();
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });

  const type = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());

  // Zoho returns JSON (200 or 4xx) for auth/scope problems rather than audio. Storing
  // that blob as a recording would produce a "file is corrupted" transcription failure
  // three times over and permanently fail the call — catch it here instead.
  if (/json/i.test(type) || (buf.length < 4096 && /^\s*[{[]/.test(buf.toString('utf8', 0, 32)))) {
    let detail = buf.toString('utf8').slice(0, 200);
    try {
      const j = JSON.parse(buf.toString('utf8'));
      detail = j.message || j.code || detail;
      if (/OAUTH_SCOPE|scope/i.test(`${j.code} ${j.message}`)) {
        throw new ScopeError(
          'Zoho token lacks the PhoneBridge scope — re-authorise the Zoho app with the ' +
            'PhoneBridge call scope and update ZOHO_REFRESH_TOKEN. No call is at fault.'
        );
      }
    } catch (err) {
      if (err.isScopeError) throw err;
    }
    throw new Error(`PhoneBridge returned ${res.status}: ${detail}`);
  }

  if (!res.ok) throw new Error(`Recording download failed (${res.status})`);
  if (!buf.length) throw new Error('Recording download returned an empty body');

  return { buffer: buf, contentType: type || 'audio/mpeg' };
}

module.exports = { downloadRecording, ScopeError };
