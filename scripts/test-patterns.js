/*
  Simple harness to validate imported GINA/.NET regex patterns against sample log lines

  Usage:
    node scripts/test-patterns.js --triggers external/all-gina.triggers.json --lines test/log-lines-sample.txt
*/

const fs = require('fs');
const path = require('path');
const { sanitizeRegexPattern } = require('../src/shared/regex');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--triggers') args.triggers = argv[++i];
    else if (a === '--lines') args.lines = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--filter') args.filter = argv[++i];
  }
  return args;
}

function parseLineMessage(line) {
  const m = line.match(/^\[(.+?)\]\s*(.*)$/);
  return m ? m[2] : line;
}

function compileTrigger(t) {
  if (!t || !t.pattern) return { ...t, matcher: () => false, compiled: null, error: 'No pattern' };
  if (t.isRegex) {
    const sanitized = sanitizeRegexPattern(String(t.pattern));
    try {
      const reg = new RegExp(sanitized, t.flags || 'i');
      return { ...t, compiled: reg, matcher: (msg) => reg.test(msg) };
    } catch (err) {
      return { ...t, compiled: null, error: String(err), matcher: (msg) => msg.toLowerCase().includes(String(t.pattern).toLowerCase()) };
    }
  }
  const needle = String(t.pattern).toLowerCase();
  return { ...t, compiled: null, matcher: (msg) => msg.toLowerCase().includes(needle) };
}

async function main() {
  const args = parseArgs(process.argv);
  const triggersPath = args.triggers || path.join(process.cwd(), 'external', 'all-gina.triggers.json');
  const linesPath = args.lines || path.join(process.cwd(), 'test', 'log-lines-sample.txt');

  const rawTrig = await fs.promises.readFile(triggersPath, 'utf8');
  const triggers = JSON.parse(rawTrig.replace(/^\uFEFF/, ''));
  const linesRaw = await fs.promises.readFile(linesPath, 'utf8');
  const lines = linesRaw.split(/\r?\n/).filter(Boolean);

  const filtered = args.filter
    ? triggers.filter((t) => (t.label || '').toLowerCase().includes(args.filter.toLowerCase()))
    : triggers;
  const compiled = filtered.map(compileTrigger);

  const limit = Number.isFinite(args.limit) ? args.limit : compiled.length;
  const part = compiled.slice(0, limit);

  const compileFailures = part.filter((t) => t.error);
  if (compileFailures.length > 0) {
    console.log(`Compile failures: ${compileFailures.length} of ${part.length}`);
    for (const f of compileFailures.slice(0, 10)) {
      console.log(` - ${f.label || f.id}: ${f.error}`);
    }
  }

  let totalMatches = 0;
  const matchedByTrigger = new Map();
  for (const t of part) {
    let count = 0;
    for (const raw of lines) {
      const msg = parseLineMessage(raw);
      if (t.matcher(msg)) {
        count++;
        totalMatches++;
      }
    }
    if (count > 0) matchedByTrigger.set(t.label || t.id || t.pattern, count);
  }

  console.log(`Checked ${part.length} triggers against ${lines.length} lines.`);
  console.log(`Total matches: ${totalMatches}`);
  const top = Array.from(matchedByTrigger.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 12);
  if (top.length > 0) {
    console.log('Top matches:');
    for (const [label, count] of top) {
      console.log(` - ${label}: ${count}`);
    }
  } else {
    console.log('No matches found. Try adjusting --filter or sample lines.');
  }
}

main().catch((err) => {
  console.error('Pattern test failed:', err);
  process.exitCode = 1;
});

