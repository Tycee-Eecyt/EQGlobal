function sanitizeRegexPattern(pattern) {
  let p = String(pattern || '');
  // Normalize common escaped single quotes from JSON encodings
  p = p.replace(/\u0027/g, "'");

  // .NET atomic groups (?>...) -> non-capturing groups (?:...)
  p = p.replace(/\(\?>/g, '(?:');

  // Inline option groups (?imnsx) and scoped forms (?imnsx:...) are unsupported in JS
  p = p.replace(/\(\?[imnsx-]+\)/g, '');
  p = p.replace(/\(\?[imnsx-]+:/g, '(');

  // Inline comments (?# ... ) -> remove
  p = p.replace(/\(\?#.*?\)/g, '');

  // Anchors: \A (start of string), \Z (end of string) -> ^ and $
  p = p.replace(/\\A/g, '^').replace(/\\Z/g, '$');

  // Placeholders frequently used by GINA
  p = p.replace(/\$\{[^}]+\}/g, '.*?');
  p = p.replace(/\{s\}/gi, '.*?');

  // Possessive quantifiers (e.g., ++, *+, ?+) are unsupported in JS
  p = p.replace(/([+*?])\+/g, '$1');

  return p;
}

module.exports = {
  sanitizeRegexPattern,
};

