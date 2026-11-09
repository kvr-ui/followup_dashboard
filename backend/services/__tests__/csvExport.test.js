const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { watiPhone, watiRows, watiCsv, fullCsv, chunk, zipStore, WATI_HEADER } = require('../csvExport');

test('watiPhone normalises Indian numbers and rejects junk', () => {
  assert.equal(watiPhone('9876501234'), '919876501234');
  assert.equal(watiPhone('+91 98765 01234'), '919876501234');
  assert.equal(watiPhone('09876501234'), '919876501234');
  assert.equal(watiPhone('12345'), null);
  assert.equal(watiPhone(null), null);
});

test('watiRows dedupes, drops unusable numbers and strips commas from names', () => {
  const rows = watiRows([
    { name: 'Asha, P', phone: '9876501234' },
    { name: 'Dup', phone: '+919876501234' },
    { name: 'Bad', phone: '123' },
    { name: 'Ravi', phone: '9000000001' },
  ]);
  assert.deepEqual(rows, ['Asha  P,91,9876501234,True,True', 'Ravi,91,9000000001,True,True']);
});

test('watiCsv is CRLF with no BOM; fullCsv quotes and has a BOM', () => {
  const w = watiCsv(['a,91,1,True,True']);
  assert.equal(w, `${WATI_HEADER}\r\na,91,1,True,True\r\n`);
  const f = fullCsv(['Name'], [['say "hi"\nthere']]);
  assert.equal(f, '\uFEFF"Name"\n"say ""hi"" there"\n');
});

test('chunking 1001 rows at 500 gives 500/500/1', () => {
  const parts = chunk(Array.from({ length: 1001 }, (_, i) => i), 500);
  assert.deepEqual(parts.map((p) => p.length), [500, 500, 1]);
});

test('zipStore output unzips to the same files', (t) => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    t.skip('unzip not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipstore-'));
  const zip = path.join(dir, 'out.zip');
  fs.writeFileSync(zip, zipStore([
    { name: 'part-1.csv', data: 'a\r\nb\r\n' },
    { name: 'part-2.csv', data: 'தமிழ்\r\n' },
  ]));
  execFileSync('unzip', ['-q', '-t', zip]);
  execFileSync('unzip', ['-q', zip, '-d', dir]);
  assert.equal(fs.readFileSync(path.join(dir, 'part-1.csv'), 'utf8'), 'a\r\nb\r\n');
  assert.equal(fs.readFileSync(path.join(dir, 'part-2.csv'), 'utf8'), 'தமிழ்\r\n');
  fs.rmSync(dir, { recursive: true, force: true });
});
