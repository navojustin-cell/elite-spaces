'use strict';
// Test runner.
//   node tests/run.js              every tests/*.test.js
//   node tests/run.js checkin core only those files
//   node tests/run.js --list       print { file, ids, name } for every test as JSON (used by coverage.js)
// Exits 1 if any test fails.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const args = process.argv.slice(2);
const list = args.includes('--list');
const only = args.filter(a => !a.startsWith('--'));

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js'))
  .filter(f => !only.length || only.includes(f.replace(/\.test\.js$/, ''))).sort();

for (const f of files) { lib.setFile(f); require(path.join(__dirname, f)); }

if (list) {
  process.stdout.write(JSON.stringify(lib.TESTS.map(t => ({ file: t.file, ids: t.ids, name: t.name }))) + '\n');
  process.exit(0);
}

const TIMEOUT = 15000;
(async () => {
  let pass = 0, fail = 0;
  const quiet = !!process.env.ELITE_QUIET;
  for (const t of lib.TESTS) {
    const label = `[${t.file.replace('.test.js', '')}] ${t.ids.join(',')} ${t.name}`;
    try {
      await Promise.race([
        Promise.resolve().then(() => t.fn()),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after ' + TIMEOUT + 'ms')), TIMEOUT).unref()),
      ]);
      pass++;
      if (!quiet) console.log('  ok   ' + label);
    } catch (e) {
      fail++;
      if (!quiet) console.log('  FAIL ' + label + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n       '));
    } finally {
      await lib.closeAll();
    }
  }
  console.log(`\nPASS ${pass}  FAIL ${fail}  (${lib.TESTS.length} tests, ${files.length} files)`);
  process.exit(fail || !lib.TESTS.length ? 1 : 0);
})();
