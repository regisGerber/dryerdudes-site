# Agentic operations update — September 2, 2026

Branch: `feature/ops-portal-improvements-2026-09-02`

This file records the files changed for each requested action so an individual feature can be reviewed or reverted without guessing.

## Files changed by requested action

| Requested action | Files changed | What changed |
|---|---|---|
| Multiple parts on one tech bill | `tech.html`, `tech-multi-parts.js`, `api/tech-submit-billing-multi.js` | Adds repeatable part-description, quantity, and unit-cost rows. The existing parts total is calculated automatically and the itemized list is saved in the customer/PM billing summary. No database migration is required. |
| Automatic reply to incoming text questions | `api/incoming-sms.js` | Adds a Twilio-compatible incoming-message webhook that directs new customers to the website and existing customers to Appointment Help with their job reference. |
| Morning-of Full Service wording | `api/send-reminders.js` | Makes clear that the Full Service reminder only applies if the customer has not already selected it. |
| Warranty remedy at Dryer Dudes’ discretion | `index.html`, `faq.html`, `job-help.html`, `api/tech-complete-booking.js` | States that Dryer Dudes may choose to redo the covered repair, replace a covered part, or refund the amount paid for the original covered repair. A refund resolves that warranty claim. |
| Automatic phone formatting | `phone-format.js`, `index.html`, `pm.html` | Formats the regular booking and PM tenant phone fields as `(xxx)-xxx-xxxx` while the user types. |
| State that home vent cleaning is not offered | `index.html`, `faq.html` | Adds the limitation to the main service-scope card and FAQ, including FAQ structured data. |
| Allow an admin to delete a job | `admin.html`, `admin-delete-job.js`, `api/admin-delete-job.js` | Adds an admin-only permanent-delete tool by exact job reference. It deletes an unpaid booking and related operational records and reopens the schedule slot. Paid/collected jobs are blocked so payment records are not silently destroyed. |

## One required Twilio setting after deployment

The new incoming-text response will not activate until the Twilio phone number’s **A message comes in** webhook is set to:

`https://www.dryerdudes.com/api/incoming-sms`

Use HTTP `POST`. The endpoint returns TwiML, so Twilio sends the reply without another outbound API call.

## Multiple-parts compatibility note

The current database has one aggregate `parts_cost_cents` field. This update keeps that field as the total for compatibility and adds the itemized part list to the billing/customer summary. Existing PM approval, saved-card, payment-link, parts-on-order, and return-visit logic still use the correct summed total.

## Admin deletion safeguards

- Requires an authenticated `admin` profile.
- Requires the exact `DD-######` job reference twice.
- Refuses to delete a job with money collected or `payment_status = paid`.
- Reopens the linked schedule slot.
- Deletes related billing, event, part, and help records where present.
- Attempts to delete the linked booking request; if another database relationship prevents that, the request is retained as canceled.

## Suggested post-deploy checks

1. Add two parts in the tech billing form and confirm the total and customer/PM summary show both items.
2. Run the morning reminder endpoint in dry-run mode and review the revised Full Service sentence.
3. Type ten digits in the public and PM phone fields and confirm `(xxx)-xxx-xxxx` formatting.
4. Open the FAQ and confirm the no-vent-cleaning scope and revised warranty language.
5. Delete an unpaid test job from the admin portal and confirm its schedule slot becomes open.
6. After configuring Twilio, text the Dryer Dudes number from a non-opted-out phone and confirm the website/job-reference reply.

## Reverting

The easiest complete rollback is to revert the pull-request commit. For a partial rollback, use the table above to identify the files tied to that feature. New standalone files can be removed after their corresponding script reference is removed from the HTML page.
