const test = require('node:test');
const assert = require('node:assert/strict');

const { normaliseItem, normaliseItems } = require('../watiNormalise');
const { topicsOf, isGreeting } = require('../enquiryTopics');

const msg = (owner, operatorName, text, created = '2026-09-21T09:52:00Z') => ({
  eventType: 'message',
  type: 'text',
  owner,
  operatorName,
  text,
  created,
});

test('senders: lead, bot, automation, human', () => {
  assert.equal(normaliseItem(msg(false, null, 'Hi')).kind, 'lead');
  assert.equal(normaliseItem(msg(true, 'Bot ', 'Welcome')).kind, 'bot');
  assert.equal(normaliseItem(msg(true, 'API Token 1087297 ', 'Hey')).kind, 'auto');
  assert.equal(normaliseItem(msg(true, null, 'May i call now ?')).kind, 'rep');
});

test('bot flow events and chat-opened topic', () => {
  const started = normaliseItem({
    eventType: 'ticket',
    eventDescription: 'Started: Chatbot Contact Onboarding v3 by API ',
    created: '2026-09-21T09:52:00Z',
  });
  assert.deepEqual(
    { kind: started.kind, state: started.state, name: started.name },
    { kind: 'flow', state: 'started', name: 'Contact Onboarding v3' }
  );
  assert.equal(
    normaliseItem({ eventType: 'ticket', eventDescription: 'Expired: Chatbot Onb by API', created: '2026-09-21T10:00:00Z' }).state,
    'expired'
  );
  const opened = normaliseItem({
    eventType: 'ticket',
    eventDescription: 'The chat has been initialized by contact X',
    topicName: 'General Enquiry',
    created: '2026-09-21T09:52:00Z',
  });
  assert.equal(opened.kind, 'ticket');
  assert.equal(opened.topic, 'General Enquiry');
});

test('templates keep their name and text; items come out oldest first, deduped', () => {
  const items = normaliseItems([
    { id: 'b', eventType: 'broadcastMessage', finalText: 'Discover the kit', template: { elementName: 'kit_info' }, created: '2026-09-21T10:38:24Z' },
    { id: 'a', ...msg(false, null, 'Hi', '2026-09-21T09:52:00Z') },
    { id: 'a', ...msg(false, null, 'Hi', '2026-09-21T09:52:00Z') },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'lead');
  assert.equal(items[1].name, 'kit_info');
});

test('topics by keyword; greetings are not enquiries', () => {
  assert.deepEqual(topicsOf(['I need details about last attempt kit']).sort(), ['attempt', 'details', 'kit']);
  assert.deepEqual(topicsOf(['What is the fee for G2?']).sort(), ['attempt', 'fees']);
  assert.deepEqual(topicsOf(['can i get a sample']), ['demo']);
  assert.deepEqual(topicsOf(['Is it in Tamil?']), ['language']);
  assert.deepEqual(topicsOf(['where are you located']), []);
  assert.equal(isGreeting('Hi'), true);
  assert.equal(isGreeting('hiii'), true);
  assert.equal(isGreeting('Ok sir'), false);
});

test('ad pre-fill, video, confirm and level are recognised', () => {
  assert.deepEqual(topicsOf(['Hello! Can I get more info on this?']), ['adClick']);
  assert.deepEqual(topicsOf(['வணக்கம்! இது குறித்த மேலும் தகவல்கள் எனக்கு கிடைக்கும்?']), ['adClick']);
  assert.deepEqual(topicsOf(['Get video']), ['video']);
  assert.deepEqual(topicsOf(['Confirm']), ['confirm']);
  assert.deepEqual(topicsOf(['Are the classes live or recorded?']), ['classes']);
  assert.deepEqual(topicsOf(['foundation']), ['attempt']);
  assert.deepEqual(topicsOf(["didn't received any call yet"]), ['callMe']);
});
