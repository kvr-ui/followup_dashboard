// A very small markdown renderer for the assistant's answers.
//
// WHY NOT A LIBRARY
// This frontend has exactly two dependencies (react, react-dom) and no build-time
// anything else. Pulling in a markdown parser and a sanitiser to render bold text
// and the occasional table is a poor trade; the subset below is what the agent is
// actually told to produce — short paragraphs, bullet lists, tables, bold, inline
// code — and nothing else needs to work.
//
// WHY IT RETURNS REACT NODES
// It never builds an HTML string, so there is no `dangerouslySetInnerHTML` and
// nothing to sanitise. That matters here specifically: an answer is stitched
// together from CRM data — contact names, deal names, loss reasons typed by a rep
// — and any of those could contain angle brackets. As React children they are
// text, always, and the worst a hostile string can do is look odd.

import React from 'react';

/** Inline: `code`, **bold**, *italic*. Anything else is literal text. */
function inline(text, keyPrefix) {
  const parts = [];
  // One pass, one regex: whichever marker comes first wins, so `**a**` inside
  // backticks stays literal.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/g;
  let last = 0;
  let match;
  let i = 0;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${i}`;
    if (token.startsWith('``') || token.startsWith('`')) {
      parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      parts.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
    i += 1;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

/** A markdown table: header row, a |---|---| separator, then body rows. */
function table(lines, key) {
  const header = splitRow(lines[0]);
  const body = lines.slice(2).map(splitRow);
  return (
    <div className="agent-table-wrap" key={key}>
      <table className="agent-table">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th key={i}>{inline(cell, `${key}-h${i}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c}>{inline(cell, `${key}-r${r}c${c}`)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const BULLET = /^\s*[-*]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const isTableRow = (line) => line.trim().startsWith('|');

/**
 * Render an answer. Blocks are separated by blank lines, except that a run of
 * list or table lines ends its block on the first line that isn't one.
 */
export function renderMarkdown(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Table — needs the separator row underneath to be a table and not a
    // sentence that happens to start with a pipe.
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(lines[i]);
        i += 1;
      }
      if (rows.length >= 2) {
        blocks.push(table(rows, `t${blocks.length}`));
        continue;
      }
    }

    // List
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const items = [];
      while (i < lines.length && (BULLET.test(lines[i]) || NUMBERED.test(lines[i]))) {
        items.push(lines[i].replace(BULLET, '').replace(NUMBERED, ''));
        i += 1;
      }
      const key = `l${blocks.length}`;
      const children = items.map((item, n) => <li key={n}>{inline(item, `${key}-${n}`)}</li>);
      blocks.push(
        ordered ? (
          <ol key={key}>{children}</ol>
        ) : (
          <ul key={key}>{children}</ul>
        )
      );
      continue;
    }

    // Heading — the agent is told not to use them, but a stray one should read
    // as a heading rather than as literal hashes.
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const key = `h${blocks.length}`;
      blocks.push(
        <h4 className="agent-heading" key={key}>
          {inline(heading[2], key)}
        </h4>
      );
      i += 1;
      continue;
    }

    // Paragraph: consecutive non-blank lines that start nothing else.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !BULLET.test(lines[i]) &&
      !NUMBERED.test(lines[i]) &&
      !isTableRow(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    const key = `p${blocks.length}`;
    blocks.push(<p key={key}>{inline(para.join(' '), key)}</p>);
  }

  return blocks;
}
