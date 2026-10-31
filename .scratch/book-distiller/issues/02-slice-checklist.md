# 02: Slice the book into a checklist

**What to build:** After an accepted PDF, Start opens a local checklist. The reader sees one row per slice, with page ranges, front matter unchecked, and the cuts the slicer chose. They toggle rows. They choose an output folder. Confirm stays off when every row is unchecked. Confirm opens Study with the checked slices queued and does not call Cursor.

**Spec:** [docs/prd.md](../../../docs/prd.md)

**Blocked by:** 01: Accept or refuse a PDF

**Status:** resolved

- [x] Start opens the checklist locally, with no model call.
- [x] An outline heading of 6 pages or fewer is one slice. A longer heading splits on child entries, then into consecutive chunks of 6 pages with a shorter last chunk.
- [x] Pages in no outline entry appear as “Pages a–b”, at most 6 pages, starting unchecked.
- [x] A PDF with no outline becomes tiled 4-page windows, last window shorter, labeled as page windows. A window whose text begins with an English front-matter title starts unchecked. The other windows start checked.
- [x] Preface, foreword, acknowledgments, about the author, table of contents, bibliography, glossary, index, and appendix start unchecked. The reader can check them.
- [x] The reader can toggle slices. Page boundaries stay as the slicer set them.
- [x] Confirm stays off when every slice is unchecked.
- [x] The reader chooses a folder. A missing folder is created. A folder that is neither empty nor already this PDF’s book folder is refused with a short message.
- [x] Confirm opens Study with each checked slice queued, and the machine makes no network call.
- [x] Automated tests lock the booklet’s slices and the 6-page and no-outline cases through the checklist the reader would see.
