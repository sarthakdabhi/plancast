# SQLite search migration

## Problem

Search currently scans every note in memory, making large notebooks slow.

## Proposal and rationale

Move note search to SQLite FTS5 while retaining Markdown files as the source of truth. An index can speed up queries without changing the portable storage format.

## Stages

1. Add an index builder that reads Markdown files and records their relative paths.
2. Run the old scanner and new index side by side on a test notebook.
3. Enable indexed search only after result parity is confirmed.

## Risks

An interrupted index update could produce stale results. Keep the old scanner available as a fallback and rebuild the index when corruption is detected.

## Uncertainty

A performance gain is expected but has not been measured. The acceptance target is search under 100 milliseconds for 10,000 notes; this is a target, not an observed result.

## Open questions

Should encrypted notebooks be indexed at all? This decision is unresolved. Do not enable indexing for encrypted notebooks before it is decided.

## Exclusions

This work does not change sync, cloud storage, or note formats. Note contents stay local.

## Next action

Create a representative 10,000-note fixture and benchmark the current scanner before implementing the index.
