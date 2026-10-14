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

## Known small issues (bugs or polish, in scope, not yet fixed)
- **Accounts:** a student accepting a phone-only invite can claim an email that another family's open invite was sent to.
- **Accounts:** a guardian invite can be sent to someone who is already a co-guardian, which creates an unusable card.
- **Emergency alert "I have read this":** it finds the alert by title instead of by notification id, and the bell count doesn't refresh until the next reload.
- **Check-in "Fix time out":** saving the prefilled time unchanged relabels an automatic check-out as a staff correction. Use "Time is right" instead.
- **Focus:** after some re-rendering actions (Mark all read, I have read this, Refresh numbers, Decline/Cancel invite, Deactivate), focus falls back to the top of the page.
- **Accounts screen:** the Decline and Cancel invite buttons don't name the person.
- **Phones at 320px:** the bottom tab bar is slightly too wide (it fits at 375px), and the notes edit hint wraps to a third line.
- **HQ all-locations report:** the PDF Absences table has no Location column. With one session chosen, the report heading doesn't name its location. The review notice links to the first location, not the one with the flagged visits.
- **Parent notifications:** the check-out notification doesn't name the session (the check-in one does).
- **Home "Latest news":** it doesn't refresh live when a normal announcement arrives (emergency alerts do).
- **Tab titles:** the create-account and invite-code screens keep "Sign in" as the tab title.

## Environment notes
- The Claude browser pane blocks service workers, the camera and `window.confirm`. Scans in that pane use the dev "Simulate scan" button. On a real phone the camera scan needs the app served over HTTPS (localhost is fine on the same machine).
