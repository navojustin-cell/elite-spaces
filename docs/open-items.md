# Open items after the gauntlet (Oct 14, 2026)

The full gate is green (see the latest commit). These came out of the real browser walkthroughs
and the last fix-and-verify pass. None of them blocks the gate.

## Needs Justin / ELITE to decide (beyond the PRD, so not built)
- A combined activity feed on parent Home (check-ins, check-outs, notes, news), filterable by child.
- A way for a director to end an emergency alert early. Today an alert stays "Active now" for 24 hours, even after an "all clear".
- Telling parents when a scheduled session is missed entirely. Today a missed session only shows as Absent.
- A call button or phone number on announcements. v1 has no reply channel.
- An "include audit log of staff edits" option on attendance exports.
- Notification settings beyond muting announcements.

- **Daily check-in goals (Justin, Oct 21, 2026; to design later).** After scanning in, a student picks the
  subject they're working on (Math, English, ...). The app offers example goals for that subject, and the student
  writes a sentence or two about what they're doing (studying, a project). Up to 3 goals, optional, not required
  daily. Mentors and staff can see it and comment, so they can check in on anyone who needs help. Over time it
  tracks what each student works on (study content stays in their own third-party curriculum).

## Known small issues (bugs or polish, in scope, not yet fixed)
- **Focus:** after some re-rendering actions (Refresh numbers), focus falls back to the top of the page.

## Environment notes
- The Claude browser pane blocks service workers, the camera and `window.confirm`. Scans in that pane use the dev "Simulate scan" button. On a real phone the camera scan needs the app served over HTTPS (localhost is fine on the same machine).
