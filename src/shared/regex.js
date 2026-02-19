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
  // - ${...} token interpolation
  // - {S}/{S1}/... string shortcuts
  // - {N}/{N1}/{N<=300}/... numeric shortcuts
  // - {TS} timer-seconds shortcuts (hh:mm:ss or raw seconds)
  p = p.replace(/\$\{[^}]+\}/g, '.*?');
  let tsCaptureAdded = false;
  let sCaptureAdded = false;
  const tsPattern =
    '(?<ts>\\d{1,2}:\\d{2}(?::\\d{2})?|\\d+(?:\\.\\d+)?(?:\\s*(?:ms|msec|millisecond(?:s)?|s|sec|secs|second(?:s)?|m|min|mins|minute(?:s)?|h|hr|hrs|hour(?:s)?|d|day(?:s)?))?)';
  const tsPatternNoGroup =
    '(?:\\d{1,2}:\\d{2}(?::\\d{2})?|\\d+(?:\\.\\d+)?(?:\\s*(?:ms|msec|millisecond(?:s)?|s|sec|secs|second(?:s)?|m|min|mins|minute(?:s)?|h|hr|hrs|hour(?:s)?|d|day(?:s)?))?)';
  p = p.replace(/\{ts\}/gi, () => {
    if (!tsCaptureAdded) {
      tsCaptureAdded = true;
      return tsPattern;
    }
    return tsPatternNoGroup;
  });
  p = p.replace(/\{s(?:\d+)?\}/gi, () => {
    if (!sCaptureAdded) {
      sCaptureAdded = true;
      return '(?<s>.*?)';
    }
    return '.*?';
  });
  p = p.replace(/\{([sn])(?:\d+)?(?:(?:<=|>=|=|<|>)-?\d+)?\}/gi, (_match, kind) => {
    return kind.toLowerCase() === 'n' ? '(?:\\d+)' : '.*?';
  });

  // Possessive quantifiers (e.g., ++, *+, ?+) are unsupported in JS
  p = p.replace(/([+*?])\+/g, '$1');

  return p;
}

module.exports = {
  sanitizeRegexPattern,
};

