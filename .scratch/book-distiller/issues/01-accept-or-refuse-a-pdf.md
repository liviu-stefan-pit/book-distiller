# 01: Accept or refuse a PDF

**What to build:** The reader starts the app from the repo and gets one dark English window. They drop a PDF or choose one. A book with a real text layer shows its title and page count. A scan, or a file whose pages are mostly too thin to select, shows a short incompatible-file message and nothing further.

**Spec:** [docs/prd.md](../../../docs/prd.md)

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] Starting the app opens the launchpad: one dark English window.
- [x] The reader can drop one PDF or choose it with a file chooser.
- [x] The committed booklet is single-column and selectable, with an outline, a fluff preface, a numbered rule, a book example, one monospace listing, a figure drawn on a page, and a trailing page outside the outline.
- [x] Dropping the booklet accepts it and shows the PDF title, or the file name when the title metadata is empty, plus the page count.
- [x] A page counts as text at 40 letters. A fixture where fewer than 80% of pages pass shows the incompatible-file message and does not continue.
- [x] An automated test covers accept and refuse through that observable result.
