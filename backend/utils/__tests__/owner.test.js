const test = require('node:test');
const assert = require('node:assert/strict');
const { isAdmin, ownerEmailOf, taskOwnerEmails } = require('../owner');

test('isAdmin: only an exact "admin" role counts', () => {
  assert.equal(isAdmin({ role: 'admin' }), true);
  assert.equal(isAdmin({ role: 'sales' }), false);
  assert.equal(isAdmin({ role: 'Admin' }), false);
  assert.equal(isAdmin({}), false);
  assert.equal(isAdmin(null), false);
  assert.equal(isAdmin(undefined), false);
});

test('taskOwnerEmails handles a single body and an array body', () => {
  assert.deepEqual(taskOwnerEmails({ body: { Owner: { email: 'A@x.com' } } }), ['a@x.com']);
  assert.deepEqual(
    taskOwnerEmails({ body: [{ Owner: { email: 'a@x.com' } }, { Owner: {} }, { Owner: { email: 'B@x.com' } }] }),
    ['a@x.com', 'b@x.com']
  );
  assert.deepEqual(taskOwnerEmails(null), []);
  assert.equal(ownerEmailOf(null), null);
});
