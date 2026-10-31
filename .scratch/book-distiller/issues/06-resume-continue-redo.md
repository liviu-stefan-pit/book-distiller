# 06: Resume, continue, and redo

**What to build:** The reader closes the app in the middle of a book and later chooses the same folder. Study shows the boards already paid for, and nothing calls Cursor until they press Continue. Continue runs the checked slices that are missing or failed. Redo, when the queue is idle, replaces one board only after the new one validates. If the PDF path is dead, the boards still open and the drawer says the PDF is missing.

**Spec:** [docs/prd.md](../../../docs/prd.md)

**Blocked by:** 05: Run the rest of the queue

**Status:** resolved

- [x] Choosing a folder that already holds this PDF’s manifest opens Study and does not call the agent.
- [x] Closing the app mid-slice leaves that slice unfinished. Continue, when the queue is idle, runs every checked slice that is missing or failed.
- [x] Slices that are not done keep a checkbox. Unchecking one with no board skips it. Unchecking one that already has a board leaves that board.
- [x] Redo is available when the queue is idle. The current board stays visible until the new board validates. A failed redo leaves the old board and its note.
- [x] A slice counts as done only when its board file exists and validates. The app can rewrite the manifest from the board files and the PDF.
- [x] A board or manifest whose schema version is missing or not 1 fails validation.
- [x] When the stored PDF path is missing, boards still open and the drawer says the PDF is missing.
- [x] An automated test covers reopen-without-a-call, Continue picking up a failed slice, a failed redo keeping the old board, a bad schema version, and a missing PDF.
