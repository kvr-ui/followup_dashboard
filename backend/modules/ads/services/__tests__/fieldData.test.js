const test = require('node:test');
const assert = require('node:assert/strict');
const { entryName, entryValues } = require('../fieldData');

test('entryName reads name, then key, then field, normalised', () => {
  assert.equal(entryName({ name: 'Phone Number' }), 'phonenumber');
  assert.equal(entryName({ key: 'WhatsApp_No.' }), 'whatsappno');
  assert.equal(entryName({ field: 'City' }), 'city');
  assert.equal(entryName({ name: 'Email', key: 'ignored' }), 'email');
  assert.equal(entryName({}), '');
  assert.equal(entryName(null), '');
  assert.equal(entryName('phone'), '');
});

test('entryValues accepts every shape Meta and the migration produced', () => {
  assert.deepEqual(entryValues({ values: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(entryValues({ values: 'a' }), ['a']);
  assert.deepEqual(entryValues({ value: ['a'] }), ['a']);
  assert.deepEqual(entryValues({ value: 'a' }), ['a']);
  assert.deepEqual(entryValues({ value: 0 }), [0]);
  assert.deepEqual(entryValues({}), []);
  assert.deepEqual(entryValues(undefined), []);
});
