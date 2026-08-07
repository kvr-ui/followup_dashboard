// The one shape-insensitive comparison the attribution code uses for campaign
// names and UTM strings.
//
// It lived inside campaignResolver until the alias table needed it too. Both the
// resolver's third tier and the alias table's KEY are this function, and they
// have to be the same function: an alias stored under a key computed one way and
// looked up under a key computed another way is an alias that silently never
// matches. It is a separate module rather than an import from the resolver only
// because the resolver imports the alias store — one direction, no cycle.

/**
 * Lowercase, then drop everything that is not a letter or a digit.
 * "CA Foundation | Jun'25" and "ca_foundation_jun25" both collapse to
 * "cafoundationjun25".
 *
 * @param {*} value
 * @returns {string} possibly empty — a value of only punctuation normalizes away
 *   entirely, and callers must treat an empty key as "no key", never as a match.
 */
function normalizeName(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

module.exports = { normalizeName };
