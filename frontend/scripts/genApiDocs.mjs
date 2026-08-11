// Generates docs/API.md from the SAME table the API Docs tab renders
// (frontend/src/apiDocs.js), so the page and the file cannot drift apart.
//
//   node frontend/scripts/genApiDocs.mjs
//
// Editing docs/API.md by hand is therefore pointless — the next run overwrites
// it. Change apiDocs.js and re-run.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { GROUPS, BASE_HINT, authLabel, curlFor, fetchFor } = await import(
  resolve(here, '../src/apiDocs.js')
);

const out = [];
const w = (s = '') => out.push(s);

const anchor = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/\s+/g, '-');

w('# Followup Dashboard — API reference');
w();
w('<!-- GENERATED FILE. Edit frontend/src/apiDocs.js and run:');
w('     node frontend/scripts/genApiDocs.mjs -->');
w();
w(BASE_HINT);
w();
w('The same reference is available inside the dashboard under the **API Docs** tab, where every');
w('GET endpoint has a **Run** button that fires the real request with your session token.');
w();

// ---- Auth preamble ---------------------------------------------------------
w('## Authenticating');
w();
w('Everything except the webhooks and the public lead ingest needs a JWT.');
w();
w('```bash');
w("TOKEN=$(curl -s http://localhost:3000/api/auth/login \\");
w("  -H 'Content-Type: application/json' \\");
w(`  -d '{"username":"kavya","password":"…"}' | jq -r .token)`);
w();
w("curl http://localhost:3000/api/tasks -H \"Authorization: Bearer $TOKEN\"");
w('```');
w();
w('Tokens last 30 days. A `401` means expired or invalid — log in again.');
w();
w('Three access levels appear below, copied from the router that enforces each one:');
w();
w('| Level | Meaning |');
w('| --- | --- |');
w('| **No auth** | Callable without a token: inbound webhooks and the landing-page lead ingest. |');
w('| **Any logged-in user** | Any valid token. The controller scopes a sales rep to their OWN rows — server-side, not hidden in the UI. |');
w('| **Admin only** | `authenticate` + `requireAdmin` at the router. A rep gets `403`. |');
w();

// ---- Index ----------------------------------------------------------------
w('## Endpoints');
w();
for (const g of GROUPS) {
  w(`- [${g.title}](#${anchor(g.title)})`);
  for (const e of g.endpoints) {
    w(`  - \`${e.method} ${e.path}\` — ${e.summary}`);
  }
}
w();

// ---- Detail ---------------------------------------------------------------
// A description like "today | yesterday | 7d" would otherwise split into extra
// columns and shred the table.
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');

const argTable = (title, rows, noType) => {
  w(`**${title}**`);
  w();
  w(noType ? '| Name | Description |' : '| Name | Type | Description |');
  w(noType ? '| --- | --- |' : '| --- | --- | --- |');
  for (const [name, type, desc] of rows) {
    w(
      noType
        ? `| \`${cell(name)}\` | ${cell(type)} |`
        : `| \`${cell(name)}\` | ${cell(type)} | ${cell(desc)} |`
    );
  }
  w();
};

for (const g of GROUPS) {
  w('---');
  w();
  w(`## ${g.title}`);
  w();
  w(g.blurb);
  w();

  for (const ep of g.endpoints) {
    const badge = authLabel(ep.auth);
    w(`### \`${ep.method} ${ep.path}\``);
    w();
    w(`**${badge.text}.** ${ep.summary}`);
    w();
    if (ep.note) {
      w(`> ${ep.note.replace(/\n/g, ' ')}`);
      w();
    }
    if (ep.params) argTable('Path parameters', ep.params);
    if (ep.query) argTable('Query parameters', ep.query);
    if (ep.headers) argTable('Headers', ep.headers, true);
    if (ep.body) argTable('Request body (JSON)', ep.body);

    w('**Request**');
    w();
    w('```bash');
    w(curlFor(ep, 'http://localhost:3000', null));
    w('```');
    w();
    w('```js');
    w(fetchFor(ep).raw);
    w('```');
    w();
    w(ep.rawResponse ? '**Response**' : '**Response** `200`');
    w();
    w(ep.rawResponse ? '```http' : '```json');
    w(ep.rawResponse || JSON.stringify(ep.response, null, 2));
    w('```');
    w();
    if (ep.errors) {
      w('**Errors**');
      w();
      w('| Status | Message |');
      w('| --- | --- |');
      for (const [code, msg] of ep.errors) w(`| \`${code}\` | ${cell(msg)} |`);
      w();
    }
    if (ep.source) {
      w(`Served by \`${ep.source}\`.`);
      w();
    }
  }
}

const target = resolve(here, '../../docs/API.md');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${out.join('\n')}\n`);
console.log(`Wrote ${target} (${out.length} lines)`);
