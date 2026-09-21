# Signed desktop release

## Problem

Manual release steps have caused mismatched versions between the app and its update feed.

## Proposal

Build a signed release from a clean checkout, notarize it, and publish the installer before changing the update feed. Keep the current feed intact until the uploaded installer is verified.

## Rationale

Users should receive an update only when the referenced artifact is available and passes integrity checks.

## Stages

First run unit tests and build with an explicit version and build number. Then sign and notarize the app, create the installer, upload it, and verify the public bytes. Finally update the feed and verify its version, length, and signature against the uploaded file.

## Risks and uncertainty

A CDN may briefly serve an old feed or installer. Do not announce the release until public hashes match. Notarization latency is unpredictable; the release time is not promised.

## Open question

The release owner still needs to choose whether to publish this Friday or wait until Monday.

## Next action

Confirm the version and release owner, then run the existing checks on a clean checkout. Do not modify customer license data as part of this release.
