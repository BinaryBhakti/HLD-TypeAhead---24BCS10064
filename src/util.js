'use strict';

// One place to decide what "the same query" means. Trim, collapse internal
// whitespace, lowercase. Used by both the read and write paths so a search for
// "  iPhone  15 " updates the same row that "iphone 15" suggestions come from.
function normalize(q) {
  if (q == null) return '';
  return String(q).trim().replace(/\s+/g, ' ').toLowerCase();
}

module.exports = { normalize };
