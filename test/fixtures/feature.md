# Export selected notes

## Problem

People cannot share a small subset of their notes without exporting the entire notebook.

## Proposal

Add a selection-based Markdown export. The export stays local and creates a ZIP containing only selected notes and their referenced attachments.

## Rationale and stages

Selection keeps unrelated notes private. First implement a preview showing every included file, then create the archive in a temporary directory, validate its entries, and move it to the user-selected destination.

## Risks

Attachment links might escape the notebook directory. Reject paths outside that directory and symbolic links rather than following them. Never include credentials or internal application state.

## Uncertainty

Large attachment exports may require streaming; memory usage has not been measured.

## Open question

Should internal note links be rewritten when a linked note was not selected? Product review is needed before choosing a default.

## Next action

Prototype the preview using a notebook with missing attachments and cross-note links. Automatic cloud sharing is excluded.
