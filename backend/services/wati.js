// WATI (WhatsApp) client. Sends approved template messages to leads.
// Requires WATI_API_URL and WATI_TOKEN in the environment.

const WATI_API_URL = (process.env.WATI_API_URL || '').replace(/\/$/, '');
const WATI_TOKEN = process.env.WATI_TOKEN;

function isConfigured() {
  return Boolean(WATI_API_URL && WATI_TOKEN);
}

// Normalise a stored phone to WATI format: digits only, with country code.
function normalizeNumber(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) d = '91' + d; // bare 10-digit -> assume India
  return d;
}

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

// Approved templates with their parameter names, for the dashboard picker.
async function getTemplates() {
  if (!isConfigured()) return { ok: false, skipped: true, templates: [] };
  try {
    const json = await watiFetch('/api/v1/getMessageTemplates', { method: 'GET' });
    const arr = json.messageTemplates || json.data || (Array.isArray(json) ? json : []);
    const templates = (Array.isArray(arr) ? arr : [])
      .filter((t) => t.status === 'APPROVED')
      .map((t) => ({
        name: t.elementName || t.name,
        category: t.category || '',
        language: (t.language && t.language.text) || t.languageCode || '',
        params: (t.customParams || []).map((p) => p.paramName),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, templates };
  } catch (err) {
    return { ok: false, error: err.message, templates: [] };
  }
}

// Send a template message. parameters = [{ name, value }].
async function sendTemplate(number, templateName, parameters = []) {
  if (!isConfigured()) return { ok: false, skipped: true };
  const num = normalizeNumber(number);
  if (!num) return { ok: false, error: 'No valid phone number' };

  try {
    const body = {
      template_name: templateName,
      broadcast_name: `${templateName}_followup`,
      parameters: parameters.filter((p) => p && p.name),
    };
    const json = await watiFetch(
      `/api/v1/sendTemplateMessage?whatsappNumber=${num}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (json.result === false || json.result === 'false') {
      return { ok: false, error: json.info || 'WATI rejected the message', raw: json };
    }
    return { ok: true, number: num, raw: json };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { isConfigured, getTemplates, sendTemplate, normalizeNumber };
