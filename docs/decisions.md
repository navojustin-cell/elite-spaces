# Build decisions (v1 prototype)

The PRD leaves these open or unspecified. Each is a default chosen so the build
can proceed; any of them can be overturned by ELITE. Builders must follow them;
critics judge against them.

## PRD open questions

| # | PRD open question | Default in this build |
|---|---|---|
| D-1 | Can a student enroll at more than one location? | **Home location only.** Enrollment, check-in and notes all use the student's `users.location_id`. |
| D-2 | Should students see their own daily notes? | **Parent-only**, as DN-5 says for v1. |
| D-3 | Does the weekly cap reset on a fixed day; how does a holiday count? | The cap limits **how many weekly slots a student holds**, not visits. A student with cap 3 may hold at most 3 active recurring slots. Holidays don't change it because nothing is "used up" per week. |
| D-4 | Can staff add capacity for a single day? | **Not in v1.** Directors can raise a session's capacity (SC-4), which applies to every week. |
| D-5 | Who sets QR rotation time and geofence radius? | **The director, for their own location** (HQ for any). Defaults: rotation 04:00 local, radius 150 m. |
| D-6 | Canadian locations? | Same rules in v1, English only. The Toronto demo location exists to prove per-location time zones. Quebec French is flagged for ELITE's legal review. |
| D-7 | Build approach | In-house prototype: Node + SQLite + a phone-installable web app. |
| D-8 | Note checklist and scale wording | The four PRD items. Scale: **1 = Needs work, 2 = Good, 3 = Great**. Ratings start blank (DN-4). HQ can rename, add, reorder or retire items. |
| D-9 | Pilot metric targets | PRD targets kept as written. |

## Rules the PRD implies but does not spell out

| # | Rule |
|---|---|
| D-10 | **A slot is (session, weekday).** "Mon/Wed/Fri 1–4pm" is one session with three weekly slots. Families enroll per slot, capacity is per slot, and the weekly cap counts slots. |
| D-11 | **Notifications.** Every notification goes into the in-app inbox (`notifications` table) and streams live to open apps. If the user has allowed browser notifications, they also get a system notification. Real Web Push (VAPID keys, HTTPS) is a deployment step and isn't in this prototype. |
| D-12 | **QR code.** The code value is an HMAC of the location's secret plus its current "QR day". The QR day changes at `qr_rotate_at` local time, so before 04:00 the previous day's code is still valid. The printed QR encodes a URL into the app (`/#/scan/<locationId>/<code>`), so a phone camera opens the app straight to the scan. |
| D-13 | **Check-in window.** A student can check in from 30 minutes before an enrolled slot's start until its end. A scan outside every enrolled window is refused with a clear message (CI-3), and staff can override (CI-7). |
| D-14 | **Auto-checkout** (CI-5). The checkout time is the earlier of the slot's end and the location's closing time. The visit is flagged "Did not scan out" for staff review, and parents get a notification labeled as an automatic checkout. |
| D-15 | **Absent** (EN-7). A past occurrence of an active enrollment counts as absent when it has no visit and its date isn't a closure or outside the term. It's computed, not stored, and carries no penalty. |
| D-16 | **Membership validity.** `expires_on` is the last valid day, inclusive. Once the location's local date passes it, or when staff set the membership inactive, the student's active enrollments become `paused` (MB-5). Renewing or reactivating restores them to `active` if the seat is still free; otherwise they go to the front of that slot's waitlist. Expiry reminders go out once each, at 14 and 3 days before. |
| D-17 | **Student requests** (EN-3) go to every active linked parent. The first parent to decide settles it. Approval then runs the same membership and capacity checks as a direct enrollment (see the flow diagram in the PRD). |
| D-18 | **Waitlist** (EN-5) is per slot, first come first served. When a seat opens, the earliest waiting student who still passes the membership and cap checks is enrolled. Anyone ahead who fails a check is skipped but keeps their place. Joining the waitlist runs the membership and cap checks too. |
| D-19 | **Closures** (SC-3) cancel that date's occurrences. Enrollments stay. Families enrolled in any affected slot are notified. |
| D-20 | **Accounts** (AC-1/3). A parent signs up from the sign-in screen and picks a home location. They invite a student by email or phone, which creates a pending student with a one-time invite code. The student opens the invite and sets a password, and the parent then approves the link. Only after that approval can the student sign in. A parent can also invite a second guardian. |
| D-21 | **Staff accounts** (AC-4). A director creates staff at their own location with a temporary password, which is shown once. A director can deactivate staff at their location. HQ creates locations and directors (AC-5). |
| D-22 | **No payment data anywhere** (MB-2). Memberships carry status, cap and dates only. |
| D-23 | **Location privacy** (NF-5). Scan coordinates are used for the radius check and then discarded. They're never written to the database or logs. |

## Rules recorded at integration

Builders settled these while building their modules. They are this build's
defaults, like the rest of this file, and ELITE can overturn any of them.

| # | Rule |
|---|---|
| D-10a | **Seats per slot** (SC-2). A session's capacity is a whole number from 1 to 1,000 seats per weekly slot. A director can't lower it below the students already enrolled on a day that stays. |
| D-15a | **A staff check-in with no session** (CI-7) counts toward any session it overlaps at that location on one of the session's days in its term, closures aside (EN-7, D-15). It clears that day's absence in the schedule and in attendance, and a report filtered to that session (AT-4) lists the visit and its hours. |
| D-16a | **Renewal and the weekly cap** (MB-5, EN-4). When a membership is renewed or reactivated, paused slots come back only up to the weekly cap, counted the way enrollment counts it: active enrollments in active sessions of the current and every upcoming term. A slot that would go over the cap stays paused and saved, and comes back if staff later raise the cap. A slot whose seat was taken goes to the front of that slot's waitlist. Slots from a term that has ended are left alone. |
| D-24 | **Co-guardians** (AC-2, D-20). Co-guardians are direct only: two parents are co-guardians when one accepted the other's guardian invite. They are never followed transitively, and sharing a student does not make two parents co-guardians. A guardian who joins a family is linked to the inviter's students; their own existing students are not shared with the inviter. A new student invite links the student to the inviter and the inviter's direct co-guardians, and approving the student activates all of that student's pending links. |
| D-25 | **Posting a daily note** (DN-2, DN-4, DN-5). Ratings start blank and a draft may keep blanks. Post is refused until every checklist item is rated, and the message names the items still missing, so a parent never sees a blank score. Editing a posted note updates it in place with an "Edited" marker and an audit row, and does not notify parents again. |
| D-26 | **Shared contracts between modules.** (1) A membership change is written to `audit_log` with `target_type = 'membership'`, `target_id = memberships.id`, and `detail = { student_id, before: {status, weekly_cap, start_date, expires_on} or null, after: {...} }`. Attendance rebuilds when a membership was valid from these rows. (2) Every change to an enrollment's status is stamped in `enrollment_status_log` by a database trigger on the app clock, whichever module makes it. The enrollment schedule and attendance both read it to tell a paused week from an absent one. (3) Check-in writes notifications with kind `checkin`, `checkout` or `checkout_auto` and `ref_type = 'visit'`. A visit needs review while `flagged = 1 AND reviewed_by IS NULL`. (4) Whatever ends an enrollment sets `status = 'dropped'` and `ended_at` (a parent's drop, a cancelled session or removed day, a renewal whose seat was taken); a pause never sets `ended_at`. |
