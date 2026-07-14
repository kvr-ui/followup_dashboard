/**
 * The WATI calls the campaigns module needs on top of services/wati.js.
 *
 * Kept separate rather than bolted onto the shared service, because the task-level
 * `sendTemplate` there has one job (fire and forget, log the result on the Task) and
 * a campaign needs something different: the provider's MESSAGE ID. Without it, an
 * inbound `read` webhook cannot be joined back to the message that earned it, and
 * the entire funnel collapses into a send count.
 */

const { isConfigured, normalizeNumber } = require('../../../services/wati');

const WATI_API_URL = (process.env.WATI_API_URL || '').replace(/\/$/, '');
const WATI_TOKEN = process.env.WATI_TOKEN;

async function watiFetch(path, options = {}) {
  const res = await fetch(WATI_API_URL + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + WATI_TOKEN,
      ...(options.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.message || json.info || `WATI error ${res.status}`);
  }
  return json;
}

/**
 * Dig the message id out of a send response.
 *
 * WATI has shipped at least four shapes for this over the years, and their docs
 * describe none of them reliably. Rather than pick one and break on the day they
 * change it, look everywhere it has ever been. When it genuinely isn't there, return
 * null — the webhook handler has a phone-number fallback for exactly this case, and
 * a wrong id would be worse than no id (it would attach a stranger's read receipt to
 * this message).
 */
function extractMessageId(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const candidates = [
    raw.id,
    raw.messageId,
    raw.whatsappMessageId,
    raw.message && raw.message.id,
    raw.message && raw.message.whatsappMessageId,
    raw.data && raw.data.id,
    raw.data && raw.data.messageId,
    Array.isArray(raw.messages) && raw.messages[0] && raw.messages[0].id,
  ];
  const hit = candidates.find((c) => typeof c === 'string' && c.length > 3);
  return hit || null;
}

function extractTicketId(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return raw.ticketId || (raw.message && raw.message.ticketId) || raw.conversationId || null;
}

/**
 * Send one approved template. Returns { ok, messageId, error, raw }.
 *
 * Note the failure mode this guards against: WATI answers HTTP 200 with
 * `result: false` when it rejects a message. A naive `res.ok` check would record
 * every rejected send as a success, and the campaign would report 100% sent while
 * nobody received anything.
 */
async function sendTemplate(number, templateName, parameters = [], broadcastName) {
  if (!isConfigured()) return { ok: false, error: 'WATI is not configured', skipped: true };

  const num = normalizeNumber(number);
  if (!num) return { ok: false, error: 'No valid phone number' };

  const body = {
    template_name: templateName,
    broadcast_name: broadcastName || templateName,
    parameters: (parameters || []).filter((p) => p && p.name),
  };

  try {
    const raw = await watiFetch(`/api/v1/sendTemplateMessage?whatsappNumber=${num}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (raw.result === false || raw.result === 'false') {
      return { ok: false, error: raw.info || 'WATI rejected the message', raw };
    }

    return {
      ok: true,
      number: num,
      messageId: extractMessageId(raw),
      ticketId: extractTicketId(raw),
      raw,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Every template WATI knows about, INCLUDING the rejected and pending ones.
 *
 * services/wati.js deliberately filters to APPROVED (a picker should only offer what
 * can actually be sent). The health monitor needs the opposite: a template that flips
 * to REJECTED overnight is precisely the thing that silently kills a scheduled
 * campaign, and you only find out if something is watching for it.
 */
async function listTemplates() {
  if (!isConfigured()) return { ok: false, skipped: true, templates: [] };

  try {
    const json = await watiFetch('/api/v1/getMessageTemplates', { method: 'GET' });
    const arr = json.messageTemplates || json.data || (Array.isArray(json) ? json : []);

    const templates = (Array.isArray(arr) ? arr : [])
      .map((t) => ({
        name: t.elementName || t.name,
        status: t.status || 'UNKNOWN',
        category: (t.category || 'MARKETING').toUpperCase(),
        language: (t.language && t.language.text) || t.languageCode || '',
        params: (t.customParams || []).map((p) => p.paramName),
        body: t.body || (t.customParams ? null : t.bodyOriginal) || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { ok: true, templates };
  } catch (err) {
    return { ok: false, error: err.message, templates: [] };
  }
}

/** Push a contact into WATI's own address book so replies show a name, not a number. */
async function upsertContact(number, name, customParams = []) {
  if (!isConfigured()) return { ok: false, skipped: true };
  const num = normalizeNumber(number);
  if (!num) return { ok: false, error: 'No valid phone number' };

  try {
    const raw = await watiFetch(`/api/v1/addContact/${num}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || num, customParams }),
    });
    return { ok: raw.result !== false, raw };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  isConfigured,
  normalizeNumber,
  sendTemplate,
  listTemplates,
  upsertContact,
  extractMessageId,
};
