# Diagnose duplicate notifications

## Problem

Some users report receiving the same reminder twice after waking a laptop. The cause is unknown.

## Proposal and rationale

Instrument the local scheduling path with anonymous event IDs and compare scheduled reminders before and after sleep. Investigate before changing retry behavior so that a speculative fix does not silently drop reminders.

## Stages

Add a reproducible sleep and wake test. Trace scheduling and cancellation. If duplicate scheduling is confirmed, deduplicate by reminder ID. Test the fix against time-zone changes and clock adjustments.

## Risks

Aggressive deduplication could suppress a legitimate repeated reminder. Debug logs must omit reminder text and account identifiers.

## Uncertainty and open questions

There is no evidence yet that server retries cause this issue. It is unclear whether the issue affects Intel Macs as well as Apple silicon.

## Next action

Reproduce the issue on an affected machine before deciding on a fix. Do not disable reminders globally.
