// CSV and ZIP building shared by every export endpoint.
//
// Two CSV dialects:
//   full  quoted cells, LF, UTF-8 BOM so Excel reads Tamil names correctly
//   wati  WATI's contact-import template: Name,CountryCode,Phone,AllowCampaign,
//         AllowSMS — unquoted, CRLF, no BOM (the importer reads a BOM into the
//         first header name)
//
// zipStore() packs several files into one .zip without compression. CSVs of a
// few thousand rows are tiny, and a store-only zip needs no dependency.

// CRC-32 (IEEE), table-driven. zlib.crc32 only exists from Node 22.2.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// One CSV cell: quoted, inner quotes doubled, newlines flattened so a note typed
// into Bigin can't split a row.
function csvCell(v) {
  if (v === null || v === undefined) return '""';
  return `"${String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

/** Header + rows -> a BOM-prefixed CSV string Excel opens as UTF-8. */
function fullCsv(header, rows) {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
  return `﻿${lines.join('\n')}\n`;
}

// Indian numbers arrive as "98xxxxxxxx", "+91 98…", "098…". WATI wants country
// code + number, digits only.
function watiPhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.length === 10) p = `91${p}`;
  else if (p.length === 11 && p[0] === '0') p = `91${p.slice(1)}`;
  return /^\d{11,15}$/.test(p) ? p : null;
}

const WATI_HEADER = 'Name,CountryCode,Phone,AllowCampaign,AllowSMS';

/**
 * [{ name, phone }] -> WATI data lines (no header). Unusable and duplicate
 * numbers are dropped; the first occurrence wins.
 */
function watiRows(contacts) {
  const seen = new Set();
  const out = [];
  for (const c of contacts) {
    const phone = watiPhone(c.phone);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    // No commas or quotes in a name, so the row never needs quoting.
    const name = String(c.name || '').replace(/[",\r\n]+/g, ' ').trim();
    out.push([name, phone.slice(0, -10), phone.slice(-10), 'True', 'True'].join(','));
  }
  return out;
}

/** WATI lines -> one importable file body. */
function watiCsv(rows) {
  return `${[WATI_HEADER, ...rows].join('\r\n')}\r\n`;
}

/** Split an array into consecutive chunks of `size`. */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// --- store-only ZIP ---------------------------------------------------------

/**
 * [{ name, data: string|Buffer }] -> a .zip Buffer (method 0, no compression).
 * Names are written as UTF-8 (general-purpose flag bit 11).
 */
function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // DOS date/time of "now" — every file gets the same stamp.
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra len, comment len, disk no, internal attrs, external attrs = 0
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...centrals, end]);
}

module.exports = {
  csvCell,
  fullCsv,
  watiPhone,
  watiRows,
  watiCsv,
  WATI_HEADER,
  chunk,
  zipStore,
  crc32,
};
