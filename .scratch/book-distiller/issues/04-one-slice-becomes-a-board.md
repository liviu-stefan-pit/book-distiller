# 04: One slice becomes a board

**What to build:** The reader confirms a checklist with one slice checked. That slice’s text, page-stamped, goes to a Cursor agent in its own workspace. When the reply matches the board shape, the app writes the board file and the note, and Study shows must-remember, mechanics, useful later, and code. Clicking a page opens that PDF page. An empty technical slice still finishes, with the viewer saying those pages had no technical content.

**Spec:** [docs/prd.md](../../../docs/prd.md)

**Blocked by:** 02: Slice the book into a checklist, 03: Save a Cursor key and pick a model

**Status:** resolved

- [x] Confirm sends the first checked slice only. Other checked slices stay queued. The agent workspace holds that slice’s text and the extraction instructions from the PRD.
- [x] Slice text is PDF.js order, stamped `--- PAGE N ---` with the PDF page index.
- [x] A board is copied into the book folder only after it validates: schema version 1, every page inside the slice, every monospace listing present after whitespace is collapsed.
- [x] A shape failure or a missing listing is tried once more, then the slice fails with that short reason.
- [x] The board and the note use the folder layout and the board shape in the PRD. The note matches the board in reading order.
- [x] Study shows must remember, then mechanics, then useful later, then code. A book example hangs off its point with its page.
- [x] A page citation opens that page, fitted to width. Previous and next stay inside the slice.
- [x] A slice whose slicer found no listings can finish as an empty board, and the viewer says those pages had no technical content.
- [x] Automated tests drive this with a stand-in agent and the booklet’s known listing and page range.
- [ ] A person has read one real board generated from the booklet, and the technical points match the pages.
