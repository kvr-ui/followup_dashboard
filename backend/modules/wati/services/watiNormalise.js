// WATI getMessages items -> the WatiChat item shape. No I/O.
//
// What WATI gives us (checked against live chats, Oct 2026):
//   message           owner:false = the lead; owner:true = our side, where
//                     operatorName says who: "Bot" (the onboarding chatbot),
//                     "API Token …" (our automation), null or a name (a human
//                     in the inbox). It carries a trailing space, so trim.
//   broadcastMessage  a template send; the text is in finalText.
//   ticket            chat events. Bot flows read "Started: Chatbot <flow> by
//                     API", "Ended: …", "Expired: …"; the chat-opened event
//                     carries topicName ("General Enquiry").

const TEXT_MAX = 500;

const clip = (s) => (s ? String(s).slice(0, TEXT_MAX) : null);

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function senderOf(m) {
  if (!m.owner) return 'lead';
  const op = String(m.operatorName || '').trim();
  if (op === 'Bot') return 'bot';
  if (/^API Token/i.test(op)) return 'auto';
  return 'rep';
}

const FLOW_RE = /^(Started|Ended|Expired):\s*Chatbot\s+(.+?)\s+by\b/i;

/** One WATI item -> a WatiChat item, or null for something we don't keep. */
function normaliseItem(m) {
  const at = toDate(m.created) || (m.timestamp ? new Date(Number(m.timestamp) * 1000) : null);
  if (!at) return null;

  if (m.eventType === 'message') {
    const text = m.type === 'text' ? m.text : `[${m.type || 'media'}]${m.text ? ` ${m.text}` : ''}`;
    return { at, kind: senderOf(m), text: clip(text) };
  }
  if (m.eventType === 'broadcastMessage') {
    const t = m.template || {};
    return { at, kind: 'template', text: clip(m.finalText), name: t.elementName || t.name || null };
  }
  if (m.eventType === 'ticket') {
    const desc = m.eventDescription || '';
    const flow = FLOW_RE.exec(desc);
    if (flow) return { at, kind: 'flow', state: flow[1].toLowerCase(), name: flow[2], text: clip(desc) };
    return { at, kind: 'ticket', text: clip(desc), topic: m.topicName || null };
  }
  return null;
}

/** A page set (newest first, possibly overlapping) -> items oldest first. */
function normaliseItems(raw) {
  const out = [];
  const seen = new Set();
  for (const m of raw) {
    const key = m.id || m.whatsappMessageId || `${m.created}|${m.eventType}|${m.text || m.eventDescription || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = normaliseItem(m);
    if (item) out.push(item);
  }
  return out.sort((a, b) => a.at - b.at);
}

module.exports = { normaliseItem, normaliseItems, senderOf };
