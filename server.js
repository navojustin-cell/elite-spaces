'use strict';
// The server. Locally: `npm run seed` for demo data, then `npm start`.
// Hosted (render.yaml): ELITE_DB points at the persistent disk; a new database
// gets the schema only, unless ELITE_SEED_DEMO=1 asks for demo data (docs/deploy.md).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createApp, runJobs, devFromEnv, needsDemoSeed } = require('./src/app');

const PORT = Number(process.env.PORT || 3000);
const DB = process.env.ELITE_DB || path.join(__dirname, 'data', 'elite-spaces.db');
const DEV = devFromEnv(process.env); // off unless ELITE_DEV=1

fs.mkdirSync(path.dirname(DB), { recursive: true });
if (needsDemoSeed(DB, process.env)) {
  execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, 'scripts', 'seed.js')],
    { env: Object.assign({}, process.env, { ELITE_DB: DB }), stdio: 'inherit' });
}

// The sign-in cookie is named per port: browsers share cookies across ports on
// one host, so two local servers would otherwise sign each other out.
const { app, ctx } = createApp({ dbFile: DB, dev: DEV, cookieName: 'sid_' + PORT });
setInterval(() => { try { runJobs(ctx); } catch (e) { console.error('jobs:', e); } }, 30000);
runJobs(ctx);
app.listen(PORT, () => console.log(`ELITE Spaces on http://localhost:${PORT}${DEV ? '  (dev mode)' : ''}`));
