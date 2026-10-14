'use strict';
// Local server. `npm run seed` first to create demo data, then `npm start`.
const path = require('path');
const { createApp, runJobs } = require('./src/app');

const PORT = Number(process.env.PORT || 3000);
const DB = process.env.ELITE_DB || path.join(__dirname, 'data', 'elite-spaces.db');
const DEV = process.env.ELITE_DEV !== '0';

// The sign-in cookie is named per port: browsers share cookies across ports on
// one host, so two local servers would otherwise sign each other out.
const { app, ctx } = createApp({ dbFile: DB, dev: DEV, cookieName: 'sid_' + PORT });
setInterval(() => { try { runJobs(ctx); } catch (e) { console.error('jobs:', e); } }, 30000);
runJobs(ctx);
app.listen(PORT, () => console.log(`ELITE Spaces on http://localhost:${PORT}${DEV ? '  (dev mode)' : ''}`));
