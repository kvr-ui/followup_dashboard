/**
 * Turn a campaign's variable bindings into the actual strings one contact will see.
 *
 * WATI wants `parameters: [{ name, value }]` matching the template's customParams.
 * A missing value is not harmless: WhatsApp renders the literal "{{1}}" to the
 * contact, or rejects the send outright. So every binding resolves to *something* —
 * the fallback, or the empty string — and we report which contacts fell back so the
 * admin can see the damage before sending to five thousand people.
 */

/** Read `name`, `email`, or any attributes.* path off a contact. */
function attributeOf(contact, path) {
  if (!path) return undefined;
  if (path === 'name') return contact.name;
  if (path === 'email') return contact.email;
  if (path === 'phone' || path === 'phoneKey') return contact.phoneKey;

  const key = path.startsWith('attributes.') ? path.slice('attributes.'.length) : path;
  const attrs = contact.attributes || {};
  return attrs[key];
}

/**
 * Render one contact's variables.
 * Returns { variables: {name: value}, missing: [names that fell back] }.
 */
function renderVariables(bindings, contact) {
  const variables = {};
  const missing = [];

  for (const b of bindings || []) {
    if (!b || !b.name) continue;

    let value;
    if (b.source === 'attribute') {
      value = attributeOf(contact, b.value);
      if (value === undefined || value === null || value === '') {
        missing.push(b.name);
        value = b.fallback || '';
      }
    } else {
      // 'static' and 'link' are both literal strings; a link is only different in
      // that links.trackUrls() will rewrite it afterwards.
      value = b.value ?? '';
    }

    variables[b.name] = String(value);
  }

  return { variables, missing };
}

/** WATI's wire format. */
function toWatiParameters(variables) {
  return Object.entries(variables).map(([name, value]) => ({ name, value: String(value ?? '') }));
}

/**
 * Dry-run the whole audience before a send: how many contacts are missing which
 * variable. This is the check that catches "half the list has no first name" while
 * it is still a warning, rather than after 2,000 people got "Hi ,".
 */
function auditVariables(bindings, contacts) {
  const counts = new Map();

  for (const contact of contacts) {
    const { missing } = renderVariables(bindings, contact);
    missing.forEach((name) => counts.set(name, (counts.get(name) || 0) + 1));
  }

  return [...counts.entries()]
    .map(([name, count]) => {
      const binding = (bindings || []).find((b) => b.name === name);
      return {
        name,
        missing: count,
        // A fallback makes it survivable. No fallback means those contacts get an
        // empty string in the middle of a sentence.
        hasFallback: Boolean(binding && binding.fallback),
      };
    })
    .sort((a, b) => b.missing - a.missing);
}

module.exports = { renderVariables, toWatiParameters, auditVariables, attributeOf };
