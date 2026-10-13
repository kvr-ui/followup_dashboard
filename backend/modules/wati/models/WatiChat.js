const mongoose = require('mongoose');

// One lead's WATI chat history, normalised — one document per phone key.
//
// Written only by services/watiSync (the scheduler and the backfill script).
// Read by the Rep Lifecycle tab to see what a lead did on WhatsApp before the
// first call: what the bot asked, what the lead enquired about, and whether the
// rep chatted before dialling. WATI's raw payload is not kept — just the
// fields in services/watiNormalise.
const itemSchema = new mongoose.Schema(
  {
    at: Date,
    // lead      a message from the lead
    // bot       the onboarding chatbot (WATI operatorName "Bot")
    // auto      our API automation (operatorName "API Token …")
    // rep       a human in the WATI inbox
    // template  a broadcast / template send
    // flow      a chatbot flow started / ended / expired
    // ticket    any other chat event (opened, closed, expired, assigned)
    kind: String,
    text: String,
    name: String, // template or flow name
    state: String, // flow: started | ended | expired
    topic: String, // WATI topic on a chat-opened event, e.g. "General Enquiry"
  },
  { _id: false }
);

const watiChatSchema = new mongoose.Schema(
  {
    phoneKey: { type: String, required: true, unique: true, index: true },
    items: { type: [itemSchema], default: [] }, // oldest first
    lastMessageAt: { type: Date, default: null },
    fetchedAt: { type: Date, default: null, index: true },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WatiChat', watiChatSchema, 'wati_chats');
