/*
  Cleans up src/shared/mobWindows.json by:
    - removing entries with HTML tags in names
    - removing entries with ids starting with 'span-dir-auto-'
    - removing entries whose id starts with 'the-' if the same id without 'the-' exists
    - sorting by name

  Usage:
    node scripts/cleanup-mob-windows.js
*/

const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, '..', 'src', 'shared', 'mobWindows.json');

function main() {
  const raw = fs.readFileSync(OUT_PATH, 'utf8');
  let list = JSON.parse(raw);
  // remove HTML-tagged names and span-dir-auto ids
  list = list.filter((e) => e && typeof e.name === 'string' && !/[<>]/.test(e.name) && !(String(e.id || '').startsWith('span-dir-auto-')));
  const byId = new Map(list.map((e) => [e.id, e]));
  // remove leading 'the-' duplicates
  for (const id of Array.from(byId.keys())) {
    if (id.startsWith('the-')) {
      const alt = id.replace(/^the-/, '');
      if (byId.has(alt)) byId.delete(id);
    }
  }
  const final = Array.from(byId.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  fs.writeFileSync(OUT_PATH, JSON.stringify(final, null, 2), 'utf8');
  console.log(`Cleaned and wrote ${final.length} entries to ${OUT_PATH}`);
}

main();

