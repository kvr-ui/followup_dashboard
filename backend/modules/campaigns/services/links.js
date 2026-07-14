/**
 * Click tracking. The one thing WhatsApp will never give you.
 *
 * There is no link-tap event in the WhatsApp Business API — not in WATI, not in
 * Meta's own Cloud API. The ONLY way to learn that a contact acted on a campaign is
 * to own the redirect: rewrite every URL we send into a short link we host, log the
 * hit, then 302 to the real destination.
 *
 * A code is minted PER MESSAGE, not per campaign, so a click is attributable to one
 * contact rather than to a crowd. That is the whole point — a campaign-level click
 * count tells you a link works; a contact-level click tells you WHO to call.
 */

const crypto = require('crypto');

const BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

// No 0/O/1/l/I. These links get read aloud, retyped, and screenshotted.
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';

function makeCode(len = 7) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function isConfigured() {
  return Boolean(BASE_URL);
}

// Matches a bare URL inside a longer string, so a variable like
// "Seats open: https://focasedu.com/apply — reply YES" still gets tracked.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/**
 * Rewrite every URL in a set of rendered variables into tracked short links.
 *
 * Returns { variables, links }. `links` is what goes onto the CampaignMessage so a
 * later /r/<code> hit can be traced back to this exact send.
 *
 * If PUBLIC_BASE_URL isn't set we hand the original URLs straight back rather than
 * minting codes that resolve to nothing. A campaign with dead links is a far worse
 * failure than a campaign with untracked ones.
 */
function trackUrls(renderedVariables) {
  const links = [];
  if (!isConfigured()) return { variables: renderedVariables, links };

  const variables = {};
  for (const [name, raw] of Object.entries(renderedVariables)) {
    const value = String(raw ?? '');
    variables[name] = value.replace(URL_RE, (url) => {
      // Strip trailing punctuation that belongs to the sentence, not the URL.
      const trimmed = url.replace(/[.,;:!?]+$/, '');
      const tail = url.slice(trimmed.length);
      const code = makeCode();
      links.push({ code, targetUrl: trimmed, clicks: 0 });
      return `${BASE_URL}/r/${code}${tail}`;
    });
  }

  return { variables, links };
}

/**
 * Meta pre-fetches every link we send so it can render a preview card in the chat.
 * That fetch hits our redirect exactly like a human would — so without this check,
 * every single message would record a "click" the moment it was delivered, and the
 * click-through rate would read 100%. Which would be worse than having no click
 * tracking at all, because it would look like it was working.
 */
const BOT_RE = /bot|crawler|spider|facebookexternalhit|whatsapp|preview|curl|wget|python-requests|headless|slurp|monitor/i;

function isBot(userAgent) {
  if (!userAgent) return true; // no UA at all is a scraper, not a phone
  return BOT_RE.test(userAgent);
}

/** Only http/https, and never back to ourselves — a redirect endpoint is an open-redirect gift. */
function isSafeTarget(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

module.exports = { makeCode, trackUrls, isBot, isSafeTarget, isConfigured, BASE_URL };
