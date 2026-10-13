'use strict';
// Requirement coverage gate.
// For every requirement with gate 'test' in docs/requirements.json, and for
// EACH module it lists, there must be:
//   - at least one test tagged with the ID in tests/<module>.test.js
//   - at least one mutation covering the ID in tests/mutations/<module>.js
// It also refuses test files that reach into ../src directly (they would keep
// testing the real code while the mutation runner breaks a copy).
//
//   node tests/coverage.js            all modules
//   node tests/coverage.js checkin    only requirements owned by checkin

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const REQ = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'requirements.json'), 'utf8')).requirements;

const listed = JSON.parse(execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, 'run.js'), '--list'], { encoding: 'utf8' }));
const testsFor = (mod, id) => listed.filter(t => t.file === mod + '.test.js' && t.ids.includes(id));

const mutsFor = (mod, id) => {
  const f = path.join(__dirname, 'mutations', mod + '.js');
  if (!fs.existsSync(f)) return [];
  return require(f).filter(m => (m.covers || []).includes(id));
};

const problems = [];
for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js'))) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  if (/require\(\s*['"`]\.\.\/(src|schema)/.test(src)) problems.push(`${f}: requires ../src directly - use load() from tests/lib.js`);
}

let ok = 0, total = 0;
for (const r of REQ.filter(r => r.gate === 'test')) {
  for (const mod of r.modules) {
    if (only.length && !only.includes(mod)) continue;
    total++;
    const t = testsFor(mod, r.id).length, m = mutsFor(mod, r.id).length;
    if (t && m) { ok++; continue; }
    problems.push(`${r.id} [${mod}]: ${t ? '' : 'no test'}${!t && !m ? ', ' : ''}${m ? '' : 'no mutation'}`);
  }
}

for (const p of problems) console.log('  GAP  ' + p);
console.log(`\nCOVERED ${ok}/${total}  gaps ${problems.length}`);
process.exit(problems.length ? 1 : 0);
