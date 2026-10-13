# ELITE Spaces app (v1 prototype)

The ELITE Spaces app from `docs/PRD.md` (source: "ELITE Spaces App — PRD (v1)", Oct 6, 2026).
It checks homeschool students in and out of ELITE Spaces study centers, handles recurring
session enrollment with caps and waitlists, sends announcements and emergency alerts,
posts daily staff notes to parents, and exports attendance and hours.

Built with the gauntlet loop: builder versus a fresh critic, against a hard benchmark.

## Run it
```
npm install
npm run seed      # demo data; every password is demo1234
npm start         # http://localhost:3000 (PORT env to change); dev mode on by default
```
Dev mode adds a purple bar for setting the clock and running scheduled jobs, plus one-tap
demo sign-in on the sign-in screen.

## The benchmark (the gauntlet's pass condition)
```
npm run gate      # = npm test && npm run mutate && npm run coverage
```
Passing means all three of these:
1. `npm test` shows **FAIL 0**.
2. `npm run mutate` shows **MISSED 0, stale 0**. Every mutation deliberately breaks one behavior, and the tests must catch it.
3. `npm run coverage` shows **gaps 0**. Every `gate: "test"` requirement in `docs/requirements.json` has at least one test and at least one mutation in each module it lists.

You can scope any of them to a module: `node tests/run.js checkin`, `node tests/mutate.js checkin`,
`node tests/coverage.js checkin`.

## Layout and file ownership

| Path | Owner |
|---|---|
| `schema/000_core.sql`, `src/{app,auth,db,clock,time,notify,audit,errors}.js`, `src/modules/index.js`, `public/js/app.js`, `public/css/app.css`, `public/index.html`, `tests/{lib,run,mutate,coverage}.js`, `scripts/seed.js` | **foundation**: shared, change only when integrating |
| `src/modules/<m>/` (routes, services, jobs, optional `seed.js`) | module `<m>` |
| `schema/NNN_<m>.sql` (additive only: new tables, `ALTER TABLE ... ADD COLUMN`) | module `<m>` |
| `public/js/views/<m>.js` | module `<m>` |
| `tests/<m>.test.js`, `tests/mutations/<m>.js` | module `<m>` |

Modules: `accounts checkin sessions enrollment membership announcements notes attendance`.
Schema file numbers are `010_accounts 020_checkin 030_sessions 040_enrollment 050_membership 060_announcements 070_notes 080_attendance`.

Modules talk through the **core tables** (`schema/000_core.sql`), not by importing each other.
A module may `require('../<other>/...')` only for read-only helpers that the other module exports
on purpose. Notifications go through `src/notify.js`, staff edits through `src/audit.js`, and scope
checks through `src/auth.js`.

## Rules
- **Every behavior arrives with a test that fails when the behavior is reverted**, plus a mutation
  in `tests/mutations/<m>.js` that proves it. Changing a test instead of the code is a failed round.
- Tests reach the app only through `tests/lib.js` (`makeApp`, `load`). Never `require('../src/...')`.
- Tag every test with the requirement IDs it proves: `test(['CI-1','NF-4'], 'name', async () => {...})`.
- Every endpoint enforces scope (NF-1): families see only their own, staff only their location,
  and HQ everything. Each module tests that a family can't read another family's data and that staff can't reach
  another location's data.
- Times: UTC ms in the DB. Location-local dates and times come from `src/time.js` and the location's
  `timezone`, never the server's zone.
- Follow `docs/decisions.md`. A change that needs a different rule must ask first.
- No payment data. No real push, email or SMS: notifications go to the in-app inbox.
- English only (PRD non-goal). WCAG 2.1 AA: labeled controls, 44px targets, contrast tokens from
  `app.css`, visible focus.
- Never deploy, never push to a remote, and never touch real families' data.
