const test = require('node:test');
const assert = require('node:assert/strict');
const { key10, phoneKey, isRealPhoneKey, PLACEHOLDER_PHONES, OFFICE_DID } = require('../phone');

test('phoneKey is strict, key10 is lenient', () => {
  assert.equal(phoneKey('+91 98765 43210'), '9876543210');
  assert.equal(phoneKey('09876543210'), '9876543210');
  assert.equal(phoneKey('123456'), null);
  assert.equal(key10('123456'), '123456');
  assert.equal(key10(''), null);
});

test('isRealPhoneKey drops empties, test contacts and the office DID', () => {
  assert.equal(isRealPhoneKey('9123456789'), true);
  assert.equal(isRealPhoneKey(OFFICE_DID), false);
  for (const k of PLACEHOLDER_PHONES) assert.equal(isRealPhoneKey(k), false);
  assert.equal(isRealPhoneKey(null), false);
  assert.equal(isRealPhoneKey(undefined), false);
  assert.equal(isRealPhoneKey(''), false);
});
