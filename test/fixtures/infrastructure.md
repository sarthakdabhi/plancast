# Queue background thumbnail work

## Problem

Thumbnail generation blocks image uploads and increases response latency.

## Proposal and rationale

Move thumbnail generation to a background queue so an upload can return once the original file is safely stored. A placeholder will be shown while a thumbnail is pending.

## Stages

Define an idempotent job keyed by file ID and requested size. Add a worker, retry transient failures twice, and record a terminal failure after the third attempt. Release to a small cohort and compare latency and failure rates before wider rollout.

## Risks

A queue outage could delay thumbnails, and duplicate jobs could waste CPU. Keep originals available, expose pending status, and deduplicate completed work. Do not delete originals after thumbnail failure.

## Uncertainty

The expected latency improvement is a hypothesis, not a measured result. Worker concurrency must be established by load testing.

## Open question

The retention period for failed job metadata is unresolved. No new queue vendor has been chosen.

## Next action

Measure current upload latency and prototype one idempotent worker against a local queue. Video processing is outside this change.
