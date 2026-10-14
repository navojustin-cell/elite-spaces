# Brightwheel as the UX reference for ELITE Spaces

Researched Oct 13, 2026 from public sources only: brightwheel's help center (help.mybrightwheel.com), mybrightwheel.com product pages, the App Store listing, and public review summaries (Capterra, GetApp, Software Advice). No account was signed into and no forms were submitted. Everything below is paraphrased; button and setting names are quoted only where the exact label matters.

**How to read this.** Each flow has four parts: how Brightwheel does it, what makes it good, the bar it sets for ELITE Spaces, and where our PRD deliberately differs. "The bar" items are what a critic should check our screens against. Where Brightwheel's public docs are silent (they often skip exact screen layouts and notification wording), this file says so instead of guessing. Those gaps are marked **Not documented**.

**Why Brightwheel.** It's the most-used parent/staff app in US childcare, rated about 4.9 from roughly 152K App Store ratings. It solves the same core loop we do: a person arrives, scans or taps, staff see who's here, parents get told, staff write a short daily update, and admins export attendance. Its audience differs from ours (adults dropping off young children, versus teens checking themselves in), so several of its mechanics don't transfer. The *quality bar* does.

---

## At a glance: Brightwheel vs ELITE Spaces

| Concern | Brightwheel | ELITE Spaces v1 (PRD + decisions.md) |
|---|---|---|
| Who checks in | An adult contact (parent, family, approved pickup) checks the child in | The student checks themselves in on their own phone |
| Proof the person is legit | A personal 4-digit check-in code, plus optional signature and health screen | The signed-in student account plus a location radius check (CI-2) |
| QR code | One per program. Static by default, with an optional refresh every 3 hours. Shown on a kiosk, a browser screen or a printed poster | One per location. Rotates daily at 04:00 local (CI-1, D-5, D-12). No kiosk (non-goal) |
| Location check | **None documented** for families or staff | Required at the moment of scan, and never stored (CI-2, D-23) |
| Forgotten check-out | Flagged in the admin Check-in Report and fixed by hand. No auto-checkout | Auto-checkout at session end or closing time, flagged "Did not scan out", and the parent is told (CI-5, D-14) |
| Parent told of arrival | Push notification and feed entry. Staff-app check-ins are **off by default** ("Share with Parents") | A push for every check-in and check-out, including auto and staff-entered ones (CI-6) |
| Daily update | Activity feed (photos, meals, naps, notes) plus an opt-in email digest at checkout | One structured note per attended day: 4 ratings, a 3-point scale and an optional comment (DN-1 to DN-5) |
| Messaging | Two-way threads, plus Reminder, Alert (with SMS) and Announcement types | One-way announcements and emergency alerts only. No chat in v1 |
| Attendance export | Admin-side reports (CSV, print, email). **No documented parent self-export** | Parents export PDF or CSV for any range (AT-3). Directors and HQ export by location, session and range (AT-4) |
| Family linking | Provider adds contacts. Parents can add contacts if allowed. 4 contact types | Parent creates the family, invites the student and approves the link. Can invite a second guardian (D-20) |
| Billing | Core product | Non-goal |
| Platform | Native iOS and Android apps plus web | Mobile-first installable web app (PWA). iOS push needs Add to Home Screen |

---

## 1. QR / self check-in and check-out (including location checks)

### How Brightwheel does it

**Setup (admin).** An admin turns on "Quick Scan" in the school's check-in settings (web: My School > Settings > School Info). The system makes one QR code per program. A second toggle, "Quick Scan Refresh", regenerates the code every 3 hours. The help text tells admins to leave it off if they plan to print the code, because a printed code would go stale. The code can be shown three ways: a full-screen "Quick Scan Mode" in a browser, a locked kiosk device (which also shows a 4-digit keypad), or a printed poster. There is no documented manual "regenerate now" button.

**The family's flow (app).**
1. The parent taps the **Check-in/out** button on the app's Home screen, or scans the poster with the phone's own camera app. Both open the in-app scanner.
2. They center the code. If nothing happens, they can tap the code on screen. The child's profile appears. A family with several children sees all of them and can check them in together with one scan.
3. Optionally, they tap a pencil icon to add a note for staff (a drop-off form covering wake time, last meal and similar) and pick the room.
4. They answer the health screen and sign, if the program requires either.
5. They tap **Check-in/out**. The same button covers both directions, and the system knows which state the child is in.
6. They enter their personal 4-digit code. Some states treat this code as the legal equivalent of a signature.
7. A green **Success** confirmation appears. The event also lands in the child's Feed, which can be filtered to "Check Ins & Outs".

**Errors and edge cases, as documented:**
- **No camera permission.** The app explains the problem and gives the exact OS path to fix it, with separate iPhone and Android instructions.
- **Program hasn't enabled QR.** A message says Quick Scan isn't supported at this school and to ask the program for another method.
- **Code from the wrong program.** A message says no students were found at this school.
- **Forgotten 4-digit code.** The code shows as a banner on the Home screen by default. If the parent dismissed the banner, a "Show check-in code" toggle in Edit Profile brings it back.
- **Duplicate 4-digit code.** If two users share a code, the app asks for the last 4 digits of the phone number to tell them apart, and recommends changing the code.
- **Child not visible.** The contact isn't linked yet, or the email or phone doesn't match. Troubleshooting says to log out and back in after the provider fixes the link.
- **No smartphone.** Staff check the child in, or the parent uses the kiosk keypad.
- **Forgot to check out.** Nothing automatic happens. The admin Check-in Report shows a red banner listing check-ins with no check-out (plus other anomalies), and an admin fixes them by hand.
- **Location check.** **None documented** for families. For staff, the only control is a "Staff Check-in From Any Device" toggle. When it's off, staff can't self-check-in remotely and must use the kiosk or QR. There is no geofence.

### What makes it good
- **One button for both directions.** Parents don't have to choose between "in" and "out". The system knows the current state.
- **The scan works from the native camera too.** The poster deep-links into the app, so a parent who opens the camera instead of the app still lands in the right place.
- **A family is one action.** Siblings are checked in together, not one at a time.
- **The errors name the cause and the fix.** The camera-permission error gives the actual settings path for each OS instead of "something went wrong".
- **The help center is honest about tradeoffs.** It says outright that rotating codes and printed posters don't mix.
- **The confirmation is unmistakable:** a large green success state.

### The bar for ELITE Spaces
- **Two taps or fewer from opening the camera to the confirmation**, and under 2 seconds on a normal connection (PRD NFR). Because the student is already signed in on their own phone, there is no PIN step at all. Don't add one.
- **The app decides in or out from the student's state.** The confirmation says which one happened in large type, with the time, the session and the end time. Example: "Checked in · 1:02 PM · Mon/Wed/Fri Study Block · ends 4:00 PM". Check-out says the total time.
- **Opening the code from the phone's own camera must work** (D-12 already encodes a URL into the app). If the student isn't signed in, the app signs them in and then finishes the scan without asking them to scan again.
- **Every refusal names the cause and the next step**, in one sentence each:
  - Yesterday's code: "This code has expired. Scan today's code at the entrance."
  - Wrong location: "This code is for [Location]. You're a member at [Home location]."
  - Not enrolled now (CI-3, D-13): "You don't have a session right now. Your next one is Wed 1:00 PM. Staff can check you in if needed."
  - Outside the radius: "You need to be inside [Location] to check in." Plus a fallback: "Ask staff to check you in."
  - Membership inactive: "Your membership isn't active. Ask a parent or the front desk."
- **Location permission is requested at the first scan, not at sign-up**, with one line on why ("We check you're in the building. Your location isn't saved."). If it's denied, show OS-specific steps to turn it back on, the same pattern Brightwheel uses for camera permission. If the GPS fix is poor, say so and offer a retry before refusing.
- **Camera permission denied** gets the same OS-specific recovery steps.
- **Guard against accidental double scans.** A second scan within a few minutes of checking in should ask "Check out now?" rather than silently checking the student out. This is our addition. Brightwheel doesn't document it.
- **The rotating code needs a way to be displayed.** Brightwheel warns that rotating codes and printed posters conflict, and our code rotates daily (CI-1) with no kiosk allowed. The staff app therefore needs a full-screen "Today's code" view for a staff-owned screen, plus a print option that shows the date the printout is valid for. This is an open design question. Raise it rather than leave it implicit.

### Where ELITE deliberately differs
- **No 4-digit code, signature, health screen or drop-off form.** The student's own signed-in phone is the identity, and pickup verification is a non-goal.
- **No kiosk.** Students only scan with their own phone.
- **We add a location radius check**, which Brightwheel doesn't have. The scan coordinates are thrown away after the check (D-23).
- **We auto-checkout** (CI-5). Brightwheel leaves missing check-outs for an admin to find.
- **Check-in is tied to an enrolled session window** (CI-3, D-13). Brightwheel accepts a check-in at any time.

---

## 2. Parent arrival/departure notifications and the parent home feed

### How Brightwheel does it
- **Push is on by default** for parent and family contacts, covering check-ins, messages and alerts, photos and videos, notes, incidents, meals, naps and more. Each category can be switched off under the hamburger menu: Edit Profile > Settings > Notifications. Unread messages also show as a badge on the app icon. An SMS channel exists ("All messages" toggle) and is likely on for anyone who signed up with a phone number.
- **The help center troubleshoots delivery at the OS level.** It tells Android users to turn off the battery setting that pauses unused apps, because that setting silently blocks notifications.
- **The feed is per child.** On the home screen the parent taps a child's name to open that child's feed, newest first. Cards include check-ins and check-outs, photos and video, meals, naps, notes and milestones. The web version filters by date and activity type, and the app filters for check-ins. Parents can heart photos and videos, but not check-ins, incidents, health checks or absences. Hearts don't trigger notifications.
- **There's a daily digest by email.** It's off until the parent opts in, per child. It's emailed when the child is checked out, summarizes that day's parent-visible activities, and isn't sent if there's no checkout or no activity.
- **Staff check-ins may not reach parents.** When staff check a child in through the staff app's Attendance Mode, parents are **not** notified unless "Share with Parents" is on. That setting is per device and per staff account, and off by default. Check-ins logged on the web always notify. The help center has a troubleshooting article for parents who can't see attendance, which shows this trips people up.

**From public reviews:**
- A parent noticed that a staff message triggers a push, but a co-parent's reply in the same thread doesn't.
- A parent of several children disliked opening each child's page to read the same message.
- Staff complain about noisy notifications for parent messages meant for other teachers.

### What makes it good
- **Arrival is the moment parents care about most**, and it reaches them in real time by default with no setup.
- **Every check-in and check-out becomes a permanent feed entry**, so a notification the parent missed isn't lost.
- **Per-category toggles** let a parent turn off low-value updates while keeping attendance updates.
- **The digest is tied to departure**, the natural end of the day.

### The bar for ELITE Spaces
- **Every check-in and check-out notifies every linked parent.** That includes scan, staff-entered and auto-checkout, with no hidden per-device switch. This is the opposite of Brightwheel's "Share with Parents" default, and it's what CI-6 requires.
- **The notification reads as one complete sentence that works on a lock screen:** who, what, where and when. For example, "Maya checked in at Irvine · 1:02 PM" or "Maya was checked out automatically at 4:00 PM (didn't scan out)". Staff-entered events say so: "checked in by staff".
- **The parent home is family-level, not per child.** It shows a status card for each student ("At Irvine since 1:02 PM" or "Not checked in · next session Wed 1:00 PM"), with a combined feed below that can be filtered by child. This fixes the Brightwheel complaint about opening each child separately.
- **The feed shows check-ins, check-outs (with total time), notes, announcements and alerts in one newest-first list.** Every notification has a matching feed item, so the inbox is never the only record.
- **Install and permissions onboarding is part of the flow, not a help article.** iOS needs the app added to the Home Screen before web push works (PRD Platform), so first run must walk the parent through it and confirm that a test notification arrived.
- **Notification settings are reachable in one tap from the profile**, not buried under "Edit Profile". Arrival/departure and note notifications can be turned off. Emergency alerts can't (AN-5), and the toggle says so instead of disappearing.

### Where ELITE deliberately differs
- **No photos, videos, meals, naps or likes.** The v1 feed holds attendance, notes and announcements only.
- **No SMS or email.** The prototype delivers to the in-app inbox plus browser notifications (D-11).
- **Students have their own app view** (schedule, check-in, announcements), but they don't see notes (DN-5, D-2).

---

## 3. Staff "who is here" roster and manual check-in/out

### How Brightwheel does it
- **The roster lives per room.** In the staff app, a teacher opens a room and taps **Attendance**. Each student's photo bubble shows a teal "Checked-in" label when present. The teacher selects one student, several, or uses **Select All**, then picks an action from the bottom bar: **Check In/Out** (toggles), **Absent** (with an optional reason and note, and future dates allowed), or **Move Room**. **Close** exits. A public county staff guide warns staff not to use Select All for check-in, so they don't mark absent children present.
- **On the web**, staff filter students by name, room or status and click **Check in/out** or **Mark absent** per row. Bulk actions aren't available there.
- **Rules:** staff can't record a check-in for a future time, but they can log a future absence. A future absence shows as absent on the day without staff action.
- **Headcounts.** Admins get a Room Check view (students, staff and ratio per room, in real time) and a push notification when a room goes out of ratio. Tapping it opens that room's attendance screen so they can fix it.
- **Corrections.** Admins fix past records from the Check-in Report. A red banner lists anomalies:
  - a check-in with no check-out
  - a check-out with no check-in
  - absent and checked in on the same day
  - a record over 24 hours
  - overlapping records

  **Review** opens them for editing, and admins can duplicate a record for a repeat schedule. An export can include an audit log showing who changed what and when.

### What makes it good
- **The roster is the hub.** Attendance, absence and moves all start from one list with multi-select.
- **Status is shown with a text label ("Checked-in"), not color alone.**
- **Problems come to the admin:** an out-of-ratio push opens straight to the screen where it can be fixed.
- **The audit trail exists and can be exported.**

### The bar for ELITE Spaces
- **The staff landing screen is the live "In the building" list**, defaulting to today and the current session. It shows a count up top ("18 in the building · 24 expected"), then three groups: **Here**, **Expected, not here yet**, and **Left**. Each row shows the student's name, the session, the time in, and how they checked in (scan or staff).
- **The list updates live** without a manual refresh. Brightwheel's web Room Check needs a Refresh click, and that's not good enough.
- **Manual check-in or check-out is two taps from the row:** the row action, then a confirm sheet that names the student and the action. The confirm sheet takes an optional reason (dead phone, forgot phone, location failed) and logs the staff member's name (CI-7). There is no bulk check-in. Brightwheel's own customers warn against Select All for check-in.
- **Overrides are explicit.** When staff check in a student who has no session now (CI-3 override), the sheet says so ("Not enrolled in this session · check in anyway?").
- **Visits that need review are shown first.** Auto-checkouts flagged "Did not scan out" appear in a "Needs review" banner at the top of the roster with a count, styled like Brightwheel's red anomaly banner. Each item can be fixed in place: set the real out time, or confirm the automatic one.
- **Every staff edit is logged** with who, what, before, after and when (src/audit.js), and that log can be exported.
- **No status relies on color alone.** Every state carries a text label.

### Where ELITE deliberately differs
- **No rooms, ratios or Move Room.** Students choose their own spot (SC-2), so the roster is per location and session.
- **No future absences or absence reasons.** Absence is computed, not entered (EN-7, D-15).
- **Manual entry is the exception.** The pilot target is 90%+ of visits by QR, so the roster shouldn't nudge staff into doing check-ins by hand.

---

## 4. Daily reports / notes by staff

### How Brightwheel does it
- **Logging is fast for groups.** From a room, staff tap **Add Activity**, pick a type, choose students (or Select All), tap **Next**, optionally add a note or photo, optionally turn on **Staff Only**, then tap **Add Activity** again to post. Staff can also start from one student's feed. A program-wide setting can make every activity Staff Only by default, for programs that review before sharing. Staff Only posts can later be approved for families.
- **Staff get reminders to log.** A teacher sets one-time or recurring reminders per student (food, nap, and so on) that repeat until checkout. They show minutes until due, turn red with minutes overdue, push when due, and clear when the activity is logged.
- **Posts can be edited and deleted.** Staff can change the time, the note or Staff Only after posting. Deleting removes the post for everyone. **Not documented:** whether parents are told about edits.
- **What parents get:**
  - each activity in the feed (photos, notes and incidents notify by push)
  - optionally, a per-child daily email at checkout listing the day's parent-visible activities (Staff Only items left out, nothing sent if nothing was logged)
  - staff can also print or email a daily report by hand
- **What reviewers say.** A 2025 App Store review from a teacher says posting is too many steps, posts can't be edited (from that teacher's view), there's a 10-photo cap, and the feed is hard to follow.

### What makes it good
- **Notes start from the list staff already have open** (the room), and one action can cover many students.
- **Reminders with visible overdue state** keep logging from slipping to the end of the day.
- **Staff Only plus approval** gives programs a review step without a separate tool.
- **The summary arrives at the natural end of the day** (checkout), and nothing is sent when there's nothing to say.

### The bar for ELITE Spaces
- **Notes start from today's attendance list** (DN-4). A **Notes** view shows every student who attended today, with a status per row (Not started / Done), a progress count ("12 of 18 notes done"), and the remaining ones first.
- **A full note takes no more than about 6 taps when there's no comment:** open the student, tap one of 3 options on each of the 4 items, then Post. The 3-point options are large labelled buttons (Needs work / Good / Great, D-8), not a dropdown or a slider. After posting, the view moves to the next student without a trip back to the list.
- **Ratings start blank** (DN-4, D-8). A blank must never reach a parent as a score: either Post stays disabled and names what's missing ("Rate Focused to post"), or the parent view shows "Not rated". Pick one and write it into decisions.md.
- **The comment is optional and clearly marked so**, with room for at least a few sentences. A draft survives leaving the screen.
- **Staff get a nudge before the day ends.** Notes not yet posted show on the staff home as a count, with a reminder near closing time. This supports the 90% same-day target.
- **Posting notifies every linked parent** (DN-5). The parent's note view shows the date, the session, the times in and out, the four items in words, the comment and the staff member's name, and it's browsable by date.
- **Edits after posting are allowed and visible.** The parent view shows "Edited" with the time, and the audit log records the change. Brightwheel is silent on this. We shouldn't be.
- **Apply-to-selected is a tradeoff to decide, not a default.** Brightwheel's multi-select model doesn't fit per-student feedback well, because group ratings encourage rubber-stamping. If we offer it, it pre-fills the ratings and each note is still reviewed and posted individually.

### Where ELITE deliberately differs
- **Our note is a fixed, structured checklist** (4 items × 3 points, the same everywhere, edited only by HQ) plus one comment. Brightwheel offers free-form activity types, photos and video.
- **There's exactly one note per student per attended day**, not a stream of activities.
- **Notes go only to parents.** Students don't see them in v1.
- **No Staff Only or approval step.** Posting means the note is published to parents.

---

## 5. Announcements / messaging and emergency or urgent alerts

### How Brightwheel does it
- **Message types:**
  - **General:** chat-style messages
  - **Reminder:** a bolded date and time with a bell icon, sent immediately and never scheduled
  - **Alert:** an urgent in-app message with a megaphone icon, plus an SMS to parents with a verified US or Canadian mobile number, capped at 300 characters
  - **Announcement:** any of the types above sent to whole rooms or the whole program, by admins and managers only
  - **Newsletter:** long-form text and images, written on the web
- **Emergency guidance** (help-center best practices):
  - Use the Alert type with the text option, so families know to open the app.
  - Use Select All to reach every room.
  - Keep it within 300 characters.
  - Watch replies, which come back into each classroom's message threads.
  - Parents who haven't activated their account still get the text.
  - Print the student emergency information report ahead of time.
- **Two-way messaging is structured.** Each child has an admin-only thread and a teacher-and-admin thread. Parents messaging the room pick a category (General, Late drop off, Late pick up, Early pick up, Absent), and every category except General shows in bold. Family-type contacts can send messages but can't read them. Parents can't message each other.
- **Read state is limited.** Staff can sort by unread and mark threads read or unread. **Not documented:** read receipts or delivery counts for announcements and alerts. Review sites and buyer guides list "can I see who read the alert?" as a question to ask vendors.
- **A customer story** credits the Alert and SMS combination with getting about 200 children picked up within 30 minutes during the 2021 Texas storms.

### What makes it good
- **Urgency is a type of message, not a style.** Alerts have their own icon and channel.
- **The 300-character limit enforces short, actionable emergency text.**
- **Mass sending is limited to admins and managers.**
- **Reply categories turn common parent messages into structured, scannable events.**

### The bar for ELITE Spaces
- **Composing an announcement takes four steps:**
  1. Audience (all families, parents only, students only, or one session, per AN-4, and for HQ, which locations per AN-2)
  2. Title and body
  3. Send now or schedule (AN-3)
  4. A review screen that says exactly who will receive it ("Parents of 46 students at Irvine")
- **Emergency alerts are a separate entry point**, not a checkbox on an announcement:
  - The button is distinct, red with an icon, and sits on the director and HQ home.
  - Scheduling isn't offered.
  - The body is capped at a short limit (about 300 characters, Brightwheel's tested number).
  - A confirm step names the locations and the recipient count, and states that the alert can't be muted.
  - Only directors (for their own location) and HQ (any location) see it (AN-5).
- **On arrival, an emergency alert looks unmistakable:**
  - a full-width banner pinned to the top of every role's home until dismissed or expired
  - a different color and icon, plus a text label ("Emergency"), so color isn't the only signal
  - a notification that ignores the user's mute settings
- **Senders see delivery and read counts per announcement and alert** (AN-6), refreshed live after an emergency. This goes beyond Brightwheel, which has no documented read tracking.
- **Every announcement and alert shows the location's phone number** (or a "Call [Location]" action), because v1 has no reply thread. Families must never hit a dead end with an urgent question.
- **The feed keeps every announcement and alert**, with sender, location and time. Scheduled posts show a "Scheduled for…" state to the sender until they go out.

### Where ELITE deliberately differs
- **No two-way messaging, no SMS, no newsletters in v1.** Announcements are one-way. The bar above compensates with a visible contact route.
- **Emergency alerts reach everyone at the location** (parents, students and staff) and can't be muted (AN-5). Brightwheel's Alert goes to parents of the selected rooms, and the parent's own notification settings still apply.
- **Targeting by enrolled session** (AN-4) replaces targeting by room.

---

## 6. Attendance reports and exports (parents and admins)

### How Brightwheel does it
- **The admin Check-in Report** (web, Reporting > Reports):
  - filters: date range (up to 6 months per run), room, student, student status and subsidy status
  - toggles to show absences and signatures
  - shows in and out times, signatures and total hours per record, plus the count present
  - a red banner lists anomalies (no check-out, overlaps, over 24 hours, and so on), with **Review** to fix them
  - export by download or email, choosing which detail columns to include. Print is available. The audit log can be attached as a second spreadsheet
- **Other attendance reports:**
  - an hours-and-days-present summary, grouped by day, week or month
  - a weekly first-in/last-out report, scheduled vs actual
  - absences, full-time equivalent (FTE), ratios, and blank sign-in sheets for paper backup
  - most reports export as CSV, and an "Other" section emails bulk CSV downloads
  - multi-site organizations get an Organization dashboard with cross-location reports
- **Data lag.** Attendance from the last 60 days refreshes every 2 hours, and older data overnight, so recent fixes may not show yet. A known pitfall: days with a check-in but no check-out show as present with zero hours until corrected.
- **What families see.** Check-ins and check-outs show in the child's feed when they're shared. Some subsidy programs ask the guardian to approve and sign the week's attendance in the app (a notification titled roughly "Signatures required for week of [date]", then review, then **Sign and approve**). **Not documented:** any way for families to export their own attendance or hours.

### What makes it good
- **Anomalies come to the report reader.** A banner says what's wrong before anyone trusts the totals.
- **Corrections happen inside the report**, and the audit log travels with the export, which matters for licensing.
- **The same data can be cut many ways** (per record, hours summary, weekly grid) with consistent filters.

### The bar for ELITE Spaces
- **Parents can export on their own** (AT-3). This is our biggest step beyond Brightwheel. From Attendance:
  - Presets (This month, Last month, This term) plus a custom range, then PDF or CSV, in two taps after choosing the range.
  - The PDF header: student name, location, date range, generated date and totals (visits, total hours). One row per visit: date, session, time in, time out, total, and check-out method (scan / auto / staff, per AT-1).
  - It's suitable to hand to a homeschool evaluator without editing.
  - The CSV has stable column names and ISO dates, with times in the location's local time.
- **The parent's on-screen history** (AT-2) shows week, month and term with a total at the top. Auto-checkout visits carry a visible label, so a parent can see why a visit ended at exactly 4:00 PM.
- **The admin report** (AT-4) filters by location (HQ), session and date range:
  - totals at the top
  - a "Needs review" count for visits flagged "Did not scan out"
  - the same columns as the parent export plus who edited
  - export to CSV and PDF, with the audit log as an option
- **Numbers are live.** Our data is small enough to read directly, so a fix staff just made appears in the next export. No Brightwheel-style refresh lag.
- **An empty range says so** ("No visits between Sep 1 and Sep 30") instead of producing a blank file.

### Where ELITE deliberately differs
- **No billing, subsidy, FTE, ratio or meal reports.**
- **No guardian signature on attendance.**
- **Parents get full self-serve export.** Brightwheel keeps exports with the provider.

---

## 7. Family accounts: inviting a second guardian, linking children

### How Brightwheel does it
- **The provider starts it.** The program adds a parent's email or phone to the child's profile, and the parent gets an invite by email (subject begins "[Action Required]") or text. Opening it asks only for a password, then **Create account**. The parent must sign up with the exact email or phone on file, or the account won't link.
- **A fallback code.** A parent can sign up on their own and enter a child's 10-digit code (My Children > **Add a Child**). Only the program can provide the code.
- **Parents can add other contacts.** A parent with edit permission opens the child's profile, goes to Contacts and taps **+ Add a Contact**, then picks a type. If the person already has an account, entering their email or phone fills in the rest. The types:
  - **Parent:** full access, messages, and billing
  - **Family:** sees the feed and can send messages, but can't read them
  - **Approved Pickup:** check-in and pickup only, no child information
  - **Emergency Contact:** listed only, no app access
- **Documented errors:**
  - an existing account blocks signup
  - an email and phone that belong to different accounts
  - duplicate accounts (one by email, one by phone) that can't be merged, so support has to deactivate one
  - an email already used by a staff account
  - a contact already listed
  - changing a contact's type means removing and re-adding them
  - a parent restricted by the provider sees a "view only" banner on the profile
- **The provider isn't alerted** when a parent adds a contact, so the help center advises telling the program.

### What makes it good
- **Invites are low-friction:** one link and one password.
- **Matching by email or phone** means an existing user is linked, not duplicated.
- **Each contact type's permissions are explained in plain language** where the type is chosen.
- **Every documented error has a named cause and a concrete fix.**

### The bar for ELITE Spaces
- **Inviting a student or second guardian takes one short form:** name, email or phone, and a role picked from a short list. One line under each role says what that person can see and do.
- **The family screen shows each person's state**, with **Resend** and **Cancel** actions on pending invites:
  - Invited (sent [date])
  - Accepted, waiting for your approval (for students, D-20)
  - Active
- **Approving a student link is one tap** from a notification. The parent sees the student's name and contact before approving.
- **Accepting an invite asks only what's missing:** a password, plus the name if not given. The invitee then lands on a home screen that already shows the linked student. They never see an empty "add a child" state.
- **Mismatches are explained without leaking data.** "This invite was sent to j•••@gmail.com. Sign in with that address, or ask [Parent] to resend." It never confirms whether an unrelated account exists.
- **Both guardians see the same records and get the same notifications.** The family screen states this, and either guardian can export.
- **Removing a guardian or unlinking a student takes a confirm step** that says what access ends, and the change is logged.

### Where ELITE deliberately differs
- **The parent creates the family, not the provider.** The PRD has parents self-serve, and staff never type in family accounts.
- **No Approved Pickup, Family-limited or Emergency Contact types.** Pickup verification is a non-goal, and v1 has guardians (equal access) and students.
- **Students are users with their own accounts** (13+), approved by a parent before they can sign in. Brightwheel's children never log in.
- **No billing role.**

---

## 8. Overall mobile UX patterns

### How Brightwheel does it
- **Navigation.**
  - **Parent app:** a Home screen listing children, with a check-in code banner and a **Check-in/out** button. Tapping a child opens that child's feed. A hamburger menu at the top left holds Edit Profile, where settings, notifications and the check-in code live. Messages is its own area.
  - **Staff app:** organized by Rooms. Inside a room: Attendance, Add Activity and Messages.
  - **Admin home:** adds Ratios and Kiosk entry points.
  - **Not documented:** exact tab names.
- **States and feedback:**
  - a green "Success" after check-in
  - a teal "Checked-in" label on roster bubbles
  - red overdue reminders and red anomaly banners
  - a bell icon for reminders and a megaphone icon for alerts
- **Empty states.** Mostly silent in public docs. The daily digest simply isn't sent when nothing was logged, which leaves parents to guess why.
- **Tone of voice.** Plain, warm and short. Task-named help articles ("Check in your child"). Second person. Fixes framed as next steps. Marketing promises speed ("set up in under 5 minutes").
- **Help as UX.** Nearly every error has a matching help article giving its cause and fix, including OS-level permission and battery settings.
- **Accessibility.** No public accessibility statement or VPAT turned up in this research. App Store release notes mention fixes to the check-in signature interaction and the attendance flow, but nothing about accessibility. (Unverified, so don't cite Brightwheel as an accessibility model.)
- **Pain points in public reviews:**
  - settings buried under Edit Profile
  - per-device settings that change behavior silently (Share with Parents)
  - a per-child feed that repeats the same message
  - message threads hard to follow
  - posting takes several steps
  - occasional glitches or slowness (Capterra cons)
  - unclear who a new message goes to

### What makes it good
- **Three or four primary destinations at most, with the main action on Home.** A parent at the door never digs through menus.
- **Status is always paired with a word.** Confirmations are loud and unambiguous.
- **Every role's home is built around that role's main job:** parents see their children, staff see rooms, admins see ratios.

### The bar for ELITE Spaces
- **Each role's home leads with its main job:**
  - **Student:** a big **Scan** button plus current status and the next session.
  - **Parent:** a status card per student plus the latest note.
  - **Staff:** the live in-the-building count plus notes outstanding.
  - **Director/HQ:** the same, plus Announce and Emergency alert.
- **Four or fewer bottom-navigation tabs per role** on phones (for example, Student: Home, Schedule, Updates, Me). Settings and notifications are one tap from Me, not nested.
- **Every list has a written empty state** that says why it's empty and what happens next:
  - "No note yet. Notes usually post by the end of the day."
  - "No sessions yet. Browse sessions to enroll."
  - "Nobody's checked in yet today."
- **The voice is plain, short, second person and verb-first.** Buttons name the action (**Check in**, **Post note**, **Send alert**), never "Submit" or "OK". Errors state the cause and the next step and never blame the user. No jargon ("slot", "occurrence" and "visit record" are internal words).
- **Accessibility is WCAG 2.1 AA (PRD)**, specifically:
  - text contrast of at least 4.5:1, using app.css tokens
  - targets of at least 44×44 px
  - every icon button has an accessible name
  - status is never conveyed by color alone
  - focus is visible
  - the scanner screen has a text alternative (a "Having trouble? Ask staff to check you in" link)
  - layouts survive 200% text zoom
  - confirmations are announced to screen readers (an aria-live region)
- **Destructive or broadcast actions confirm and name what will happen**: drop an enrollment, remove a guardian, send an alert. Routine actions don't ask for confirmation.
- **Fast and forgiving.** The scan-to-confirmation time stays under 2 s. A drafted note or announcement survives navigating away. Offline or slow-network states say so instead of spinning forever.
- **Onboarding covers PWA install** (iOS Add to Home Screen) and the camera, location and notification permissions, each asked at the moment it's needed and explained in one sentence.

### Where ELITE deliberately differs
- **We ship a mobile-first web app, not native apps.** Install and permission onboarding is ours to get right. Brightwheel inherits it from the app stores.
- **English only** in v1 (Brightwheel offers English and Spanish).
- **No hidden per-device settings.** Behavior is the same on every device, by rule.

---

## Critic checklist

Use these as pass/fail checks against a screen or flow. Each one traces to a section above.

1. From the moment the student opens the scanner to a visible confirmation takes 2 taps or fewer and under 2 seconds, with no PIN or code entry.
2. One scan action handles both directions. The confirmation states in large text whether it was a check-in or check-out, with the time, the session name and either the session end time (in) or the total time (out).
3. Scanning the entrance QR with the phone's own camera opens the app and completes the same check-in. If the student was signed out, they finish the scan after signing in without scanning again.
4. Each refusal (expired code, wrong location, no session now, outside radius, inactive membership, camera or location permission denied) shows its own one-sentence cause plus a concrete next step, including "Ask staff to check you in" where relevant.
5. Location permission is requested at the first scan, not at sign-up, with a one-line reason that says location isn't saved. Nothing from the scan's coordinates is stored or logged.
6. A second scan shortly after check-in asks for confirmation before checking out.
7. Every check-in and check-out (scan, staff and auto) creates a notification to every linked parent, plus a matching feed item, with no setting that silently suppresses it.
8. Parent notifications are complete lock-screen sentences naming the student, the action, the location and the time. Auto and staff-entered events are labelled as such.
9. The parent home shows one status card per linked student (where they are now, or their next session), followed by a single combined feed that can be filtered by student.
10. The staff home opens on a live "In the building" view with a count and Here / Expected / Left groups. It updates without a manual refresh, and each row shows how the student checked in.
11. A manual check-in or check-out takes at most 2 taps from the roster row. It confirms the student's name and the action, accepts an optional reason, warns when it overrides a missing enrollment, and records the staff member's name in the audit log. No bulk "select all" check-in exists.
12. Visits flagged "Did not scan out" appear in a counted "Needs review" banner on the staff home and the admin report, and each can be fixed in place.
13. A Notes view lists every student who attended today with Not started / Done status and an "N of M done" count. Posting one note goes straight to the next student.
14. Each note rating is a set of three large labelled buttons (Needs work / Good / Great). A blank rating can never reach a parent as a score: either Post is blocked with the missing item named, or the parent sees "Not rated".
15. A posted note notifies every linked parent and shows date, session, times in and out, the four items in words, the comment, the staff name and an "Edited" marker if it changed after posting.
16. Emergency alerts have their own entry point (not a checkbox), offer no scheduling, cap the body at about 300 characters, and confirm the locations, the recipient count and "cannot be muted" before sending.
17. A received emergency alert is pinned at the top of every role's home with a distinct color and icon plus the word "Emergency", and its notification can't be switched off in settings.
18. Every announcement and alert shows the sender, the location and a way to contact the location (a phone number or call action). The sender sees live delivery and read counts.
19. The announcement composer shows the exact audience and recipient count on a review step before Send, and supports scheduling for non-emergency posts.
20. A parent can export attendance for a preset or custom range as PDF or CSV without staff help. The PDF header carries student, location, range, generated date and total hours. Each row has date, session, in, out, total and check-out method.
21. Admin and HQ attendance reports filter by location, session and date range, show totals and a needs-review count, and export with an optional audit log of staff edits. Recent corrections appear right away.
22. Inviting a student or second guardian is one short form with a role explanation. Pending invites show their state with Resend and Cancel. Mismatch errors mask the address and never reveal whether another account exists.
23. Every list and feed has a written empty state that explains why it's empty and what happens next. No screen is ever just blank.
24. Buttons are verb-first and name the action (no "Submit" or "OK"). Interactive targets are at least 44×44 px, status never relies on color alone, focus is visible, and confirmations are announced to screen readers.
25. Destructive or broadcast actions (drop enrollment, remove guardian, send alert) confirm and name the consequence. Routine actions don't ask for confirmation.

---

## Sources (accessed Oct 13, 2026)

Brightwheel help center (help.mybrightwheel.com/en/articles/…):
- Everything you need to know about student check-in: 942374-everything-you-need-to-know-about-student-check-in
- Check in your child: 8640348-check-in-your-child
- Set up QR code scanning for check-in (Quick Scan): 8713191-set-up-qr-code-scanning-for-check-in-quick-scan
- Customize your check-in experience in settings: 1551710-customize-your-check-in-experience-in-settings
- My families can't check in or out: 12503309-my-families-can-t-check-in-or-out
- Where did my check-in code go?: 13134294-where-did-my-check-in-code-go
- Set up a Check-in Kiosk: 1329844-set-up-a-check-in-kiosk
- Understanding staff check-in: 8780981-understanding-staff-check-in
- Log student attendance as staff: 1031829-log-student-attendance-as-staff
- Mark students as absent: 11421200-mark-students-as-absent
- Correct attendance records: 942375-correct-attendance-records
- Choose if families can see attendance records: 5599812-choose-if-families-can-see-attendance-records
- Room Check Report: 942342-room-check-report
- Log activities: 1332274-log-activities
- Edit & delete activities: 12385410-edit-delete-activities
- Set reminders for staff to log activities: 2924024-set-reminders-for-staff-to-log-activities
- Send a log of student daily activities to families: 1380998-send-a-log-of-student-daily-activities-to-families
- Subscribe for daily updates on your child's activities: 5243986-subscribe-for-daily-updates-on-your-child-s-activities
- View your child's activity feed: 942392-view-your-child-s-activity-feed
- Log student incidents: 9264943-log-student-incidents
- Manage notifications as a student contact: 942383-manage-notifications-as-a-student-contact
- Turn on SMS notifications: 14745989-turn-on-sms-notifications
- Types of messages to send: 3370287-types-of-messages-to-send
- Start messaging in brightwheel: 2098452-start-messaging-in-brightwheel
- Send messages to families: 942329-send-messages-to-families
- Mark messages as read & unread: 9904214-mark-messages-as-read-unread
- Best practices for communicating with families in emergency situations: 2923901-best-practices-for-communicating-with-families-in-emergency-situations
- Overview of reports & data available in brightwheel: 942384-overview-of-reports-data-available-in-brightwheel
- Check-in Report: 2652805-check-in-report
- Report total hours & days a student was present: 9541549-report-total-hours-days-a-student-was-present
- Report on student attendance by week: 9591866-report-on-student-attendance-by-week
- Submit your signature to approve weekly attendance: 9854450-submit-your-signature-to-approve-weekly-attendance-at-provider-request
- Manage all locations from a single dashboard (multi-sites): 12143422-manage-all-locations-from-a-single-dashboard-for-multi-sites
- Sign up for brightwheel as a student contact: 4742905-sign-up-for-brightwheel-as-a-student-contact
- Get connected to my child's profile: 11817047-get-connected-to-my-child-s-profile
- Manage your child's contacts and approved pickup list: 1161627-manage-your-child-s-contacts-and-approved-pickup-list
- Overview of how to use brightwheel as a Parent, Family, or Approved Pickup: 2165917-overview-of-how-to-use-brightwheel-as-a-parent-family-or-approved-pickup
- Why can't I see all my children in brightwheel?: 11844354-why-can-t-i-see-all-my-children-in-brightwheel

Product pages and listings:
- https://mybrightwheel.com/child-care-attendance-tracking/
- https://mybrightwheel.com/in-home-child-care/communication
- https://apps.apple.com/us/app/brightwheel-child-care-app/id902823296 (ratings, release notes, visible reviews)

Public reviews and third-party guides (used for themes only):
- Capterra, GetApp and Software Advice brightwheel review summaries
- Loudoun County Parks staff brightwheel guide (public.powerdms.com/LoudounCountyParks/documents/2904550), seen only as search-result excerpts because the PDF text couldn't be extracted
