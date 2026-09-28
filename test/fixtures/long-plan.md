# Local notebook search migration

This is a synthetic evaluation fixture. All product constraints and acceptance targets below describe a proposed project, not measured customer results.

## Problem

The notebook application currently reads every Markdown note for each search. The scan runs on a background queue, but large notebooks still wait for file reads and parsing before useful results appear. A new query cancels the previous scan, so users who type quickly can repeatedly discard work. There is no persistent search index today.

The proposed project serves people who keep a large local collection and frequently search exact phrases or combinations of words. It does not aim to improve handwriting recognition, image search, or audio transcription. Existing note files must remain readable with ordinary editors. The team wants faster repeated searches without making a database the only copy of a note.

## Proposal

Add a local SQLite FTS5 index derived from the Markdown files. Store relative paths, note titles, extracted plain text, and source modification metadata in the index. Keep the Markdown directory as the authoritative store. The database is disposable: deleting it should trigger a rebuild rather than lose note content. Search results resolve back to files, and editing continues through the existing note editor.

A single worker owns index writes and processes file changes in batches. A completed batch commits in one transaction. Search queries read the most recent committed state, so they never depend on partially indexed files. The file watcher queues updates and deletions, while a reconciliation pass discovers changes missed while the application was closed. The proposal does not claim that filesystem notifications are perfectly reliable.

## Rationale and alternatives

An index avoids rereading every file on each query and allows phrase matching through a maintained search structure. SQLite is already suitable for a single local database and supports transactional updates. The project must still benchmark the actual workload; choosing an index is a design hypothesis, not proof of a particular speedup. No performance result has been collected for this implementation.

Keeping the existing scanner is an explicit fallback and an evaluation reference. Moving all notes into a database was considered but rejected for this project because it would change the portable storage model. A hosted search service is also excluded: this project must not upload note text, filenames, or queries. The team is not proposing semantic embeddings or a remote vector database.

## Implementation sequence

First, create a deterministic fixture containing ten thousand synthetic notes with known phrase matches, renamed files, deleted notes, and non-ASCII titles. Record scanner results and timing before implementing indexed search. Save the expected result sets so later comparisons test correctness as well as latency. Synthetic notes must contain no real user data.

Next, build the disposable database in a temporary location. Record a schema version and complete the initial indexing transaction before making the database available to search. Run both the scanner and index on the same queries. Compare the actual note identities returned, including empty queries and phrases with punctuation. Investigate mismatches before enabling the index by default.

Then add incremental updates, deletion handling, reconciliation, and cancellation. Enable indexed search only after result parity is established on the fixture. Roll out behind a local feature flag so testers can return to the scanner. The final stage documents recovery, measures rebuild cost, and checks that disabling the feature preserves existing note files and search behavior.

## Risks and mitigations

A missed file event can leave stale search results. Reconcile at startup and offer an explicit rebuild action. A corrupted or incompatible index must not block access to notes; fall back to the scanner and rebuild the disposable database. Rebuilding should never rewrite the Markdown sources.

Large initial imports can consume CPU, disk space, and battery. Batch work and support cancellation, then measure behavior on a smaller laptop as well as the development machine. A cancelled rebuild should leave the previous valid database in service. Do not silently replace it with a half-populated index.

Relative paths can change when users reorganize folders. Treat rename events carefully and confirm that results open the intended file. Validate paths before resolving them beneath the selected notebook root. A result from an old database must not cause the application to open an unrelated path outside that root.

## Uncertainty and open questions

The acceptance target is search below one hundred milliseconds on the ten-thousand-note fixture; it is a target, not an observed measurement. The team has not yet measured cold-start search, total database size, peak memory during rebuilds, or sustained indexing on battery power. Record these separately because a fast warm query does not establish a fast initial experience.

The treatment of encrypted notebooks is unresolved. Do not index encrypted notebook contents until the storage and unlock behavior have been reviewed explicitly. The default handling of hidden folders and symbolic links also needs a decision. These choices affect what enters the index and must be documented before expanding the rollout.

Ranking changes are not part of the first release. Preserve the existing result ordering where possible, and report any unavoidable difference during parity review. A separate decision is needed before introducing relevance ranking, stemming changes, or language-specific tokenization. The initial evaluation is English only and does not establish multilingual correctness.

## Exclusions and next action

This work does not change sync, cloud storage, note formats, licensing, or the application interface beyond a rebuild action and a local feature flag. Note content and search queries stay on the Mac. There is no telemetry upload in this project. The database may contain derived note text and must be treated as sensitive local data.

The immediate next action is to build the synthetic fixture and benchmark the current scanner. Record expected matches, timing methodology, and the machine used. Review those baseline results before implementing the index. The go/no-go decision for default enablement comes later, after parity checks and recovery tests pass; approval of this proposal does not imply that the performance target has already been met.
