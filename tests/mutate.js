'use strict';
// Mutation check: proves the tests are not vacuous.
//
// Each mutation deliberately breaks one behavior in a throwaway copy of the
// code (.mutants/<n>/) and re-runs the tests against it. Every mutation must
// make the tests FAIL. One that leaves them green means that behavior is not
// actually covered.
//
//   node tests/mutate.js             all of tests/mutations/*.js, full suite per mutant
//   node tests/mutate.js checkin     only mutations/checkin.js, run against checkin.test.js
//
// A mutation whose `find` text does not appear EXACTLY ONCE in its file is
// "stale" and counts as a failure: the code moved and the mutation no longer
// tests anything.
//
// Mutation shape: { name, covers: ['CI-1'], file: 'src/modules/checkin/index.js', find, repl }
// Nothing here writes to the real source tree.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MDIR = path.join(__dirname, 'mutations');
// Inside the project so node_modules resolves; one folder per run so parallel
// runs (several builders at once) never overwrite each other's mutants.
const WORK = path.join(ROOT, '.mutants', 'p' + process.pid);
const COPY = ['src', 'schema', 'public'];

const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const mutFiles = fs.readdirSync(MDIR).filter(f => f.endsWith('.js'))
  .filter(f => !only.length || only.includes(f.replace(/\.js$/, ''))).sort();

const MUTATIONS = [];
for (const f of mutFiles) {
  for (const m of require(path.join(MDIR, f))) MUTATIONS.push(Object.assign({ group: f.replace(/\.js$/, '') }, m));
}

const testArgs = only.length ? only : [];

// A suite that never started (Windows can fail a spawn with UNKNOWN/EAGAIN under
// load) is retried, and if it still won't start it is reported as an error: it
// must never crash the whole run, and never count as a caught mutation.
function runOnce(root) {
  return new Promise(resolve => {
    try {
      execFile(process.execPath, ['--no-warnings', path.join(__dirname, 'run.js'), ...testArgs], {
        env: Object.assign({}, process.env, { ELITE_ROOT: root, ELITE_QUIET: '1' }), timeout: 180000, maxBuffer: 16 << 20,
      }, (err, stdout) => {
        if (err && String(err.syscall || '').startsWith('spawn')) return resolve({ spawnError: err.code || err.message });
        resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || '') });
      });
    } catch (err) { resolve({ spawnError: err.code || err.message }); }
  });
}

async function runSuite(root) {
  let r;
  for (let attempt = 0; attempt < 5; attempt++) {
    r = await runOnce(root);
    if (!r.spawnError) return r;
    await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
  }
  return r;
}

function copyTree(dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  for (const d of COPY) if (fs.existsSync(path.join(ROOT, d))) fs.cpSync(path.join(ROOT, d), path.join(dst, d), { recursive: true });
}

(async () => {
  if (!MUTATIONS.length) { console.log('No mutations found' + (only.length ? ' for ' + only.join(', ') : '') + '.'); process.exit(1); }

  // Baseline: the unmutated code must pass, or every "caught" below is meaningless.
  const base = await runSuite(ROOT);
  if (base.code !== 0) {
    console.log('BASELINE FAILS - fix the tests before mutating.\n' + (base.spawnError ? 'could not start the suite: ' + base.spawnError : base.out.split('\n').slice(-3).join('\n')));
    process.exit(1);
  }

  fs.mkdirSync(WORK, { recursive: true });
  const results = new Array(MUTATIONS.length);
  let next = 0;
  const workers = Number(process.env.ELITE_MUTATE_WORKERS) || Math.max(1, Math.min(6, os.cpus().length - 1));

  async function worker(w) {
    while (next < MUTATIONS.length) {
      const i = next++;
      const m = MUTATIONS[i];
      const abs = path.join(ROOT, m.file || '');
      const src = m.file && fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') : null;
      const count = src == null || !m.find ? 0 : src.split(m.find).length - 1;
      if (count !== 1) { results[i] = { m, status: 'stale', why: src == null ? 'file not found' : `find text appears ${count} times` }; continue; }
      const dir = path.join(WORK, 'w' + w);
      copyTree(dir);
      fs.writeFileSync(path.join(dir, m.file), src.replace(m.find, () => m.repl));
      const r = await runSuite(dir);
      results[i] = r.spawnError ? { m, status: 'error', why: 'suite never started: ' + r.spawnError } : { m, status: r.code === 0 ? 'MISSED' : 'caught' };
    }
  }
  await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)));
  fs.rmSync(WORK, { recursive: true, force: true });

  let caught = 0, missed = 0, stale = 0, errors = 0;
  for (const r of results) {
    if (r.status === 'caught') caught++; else if (r.status === 'MISSED') missed++; else if (r.status === 'error') errors++; else stale++;
    const tag = r.status === 'caught' ? '  caught' : r.status === 'MISSED' ? '  MISSED' : r.status === 'error' ? '  ERROR ' : '  STALE ';
    console.log(`${tag}  [${r.m.group}] ${(r.m.covers || []).join(',')}  ${r.m.name}${r.why ? '  (' + r.why + ')' : ''}`);
  }
  console.log(`\nCAUGHT ${caught}  MISSED ${missed}  stale ${stale}  errors ${errors}  (${MUTATIONS.length} mutations)`);
  process.exit(missed || stale || errors ? 1 : 0);
})();
