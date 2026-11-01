# PRD: Book Distiller

v1 is a Windows app for one person. It turns one technical PDF into section boards the reader can check against the original page. Someone else on Windows can run the same build later, on their machine, with their own Cursor key.

## Problem Statement

Programming books mix rules, code, and diagrams with stories and repeated intros. Reading four hundred pages to keep the engineering content wastes the part that teaches. Sending each chapter to a model as “summarize this” throws away numbers, listings, and warnings. Text extraction stays, and the slice’s own page images are sent as well so the model can see figures and layout.

The reader wants each small section as a board: every technical point still there, the book’s own example still there, the listing still there, and a page number that opens the original page.

## Solution

A local Electron app. The reader drops one PDF, chooses an output folder, saves a Cursor key, picks one model, and confirms which slices to run. The app slices the book locally, sends slices to up to six Cursor agents at once, one slice per agent at a time — that slice’s page images and its extracted text, not the whole PDF — and keeps a board file only when the JSON shape is valid and every cited page is inside the slice. The viewer shows the first accepted board while later slices run. Closing the app keeps every accepted board inside a folder named after the book. Opening that book folder again shows them and spends nothing until the reader presses Continue.

## Compose

Distill still adds nothing the source did not write. Compose, on the study screen, sends each finished technical board through a reviewer and writes `composed.pdf` in the book folder. The reviewer may add a labeled gap, a current technique, or an extra example, and it may leave an addition out. The sheet shows pages and the tokens of that run. Open PDF appears when the manifest field `composedPdf` is `composed.pdf` and that file is in the folder. Cancel keeps finished chapters and does not publish the PDF.

## Terms

- **Slice.** A heading-bounded run of pages, at most 6, or a 4-page window when the PDF has no outline. When the outline has a bookmark titled Chapter plus a number, the cuts follow that chapter’s own sections. One slice becomes one board.
- **Board.** The kept technical content of one slice: points, book examples, and the book’s code for that slice, each with a PDF page. That code is copied from the text when it matches the page, and from the image otherwise.
- **Must remember.** A load-bearing rule. Short.
- **Mechanics.** Every other technical point in the slice.
- **Useful later.** A niche case the reader does not need today.
- **Listing.** A run of lines the PDF draws in a monospace font. A one-line run that is only a URL, or only digits, is not a listing.
- **Book folder.** The folder named after one book, inside the output folder. It is the record. When the output folder is already that PDF’s book, the files stay in the output folder.
- **Manifest.** The index of that folder. A slice is done because its board file validates, and the app can rewrite the manifest from the board files and the PDF.
- **Note.** The markdown rendering of one board, written when that board is accepted.
- **Launchpad.** The screen before a run: a drop zone, Open book, and one Start button. The key, the model, and the output folder are inside a Settings popup.
- **Study.** The viewer region on the same window during and after a run: slice list, board, page drawer.

A **page** is the PDF page index. The printed folio in the corner is ignored. The number on a claim and the page the drawer opens are the same number.

## User Stories

1. As a reader, I want to drop or choose one PDF, so that I can distill a single book.
2. As a reader, I want a PDF with a real text layer to be accepted, so that I can see its title and page count before I spend anything.
3. As a reader, I want a scan, or a PDF whose text is only page numbers, to be refused with a short message, so that I do not pay for a book the app cannot read.
4. As a reader, I want the window title to be the PDF title, or the file name when the PDF has no title, so that I know which book is open.
5. As a reader, I want Start to open a checklist of slices before any model call, so that I can skip what I already know.
6. As a reader, I want preface, foreword, acknowledgments, about the author, table of contents, bibliography, glossary, index, and appendix to start unchecked, so that front matter is skipped unless I opt in.
7. As a reader, I want to toggle slices and leave the page boundaries as the slicer set them, so that I choose what to spend on and the app chooses the cuts.
8. As a reader, I want Confirm to stay off when every slice is unchecked, so that I cannot start an empty run.
9. As a reader, I want each outline heading of 6 pages or fewer to be one slice when the book has no Chapter-numbered bookmark, so that a model has room to keep every technical detail.
10. As a reader, I want a longer heading in a book with no Chapter-numbered bookmark to split on its child headings and then into chunks of 6 pages with a shorter last chunk, so that no board covers more than 6 pages.
11. As a reader, I want a book whose outline contains Chapter-numbered bookmarks to be cut on each chapter’s own sections, wherever those bookmarks sit, so that a part title or a grandchild heading does not become the slice. A section longer than 6 pages splits into 6-page chunks that keep that section’s title. Pages before the first section join that section. Cover, copyright, contents, contributors, a Packt page, introduction, about the author or reviewer, the index and its letter bookmarks, and the other front-matter titles start unchecked. Another heading outside a chapter starts checked.
12. As a reader, I want pages that sit in no outline entry to appear as “Pages a–b” slices that start unchecked, so that stray pages are visible and unspent.
13. As a reader, I want a PDF with no outline to become tiled 4-page windows, last window shorter, so that a book without bookmarks still slices.
14. As a reader, I want a window whose text begins with an English front-matter title to start unchecked, so that an outline-less preface is skipped the same way.
15. As a reader, I want to choose an output folder, and have a missing folder created, so that each book is saved in a folder named after the book.
16. As a reader, I want a folder that is already a book to open in the viewer, and any other folder to be the output folder, so that I can keep many books in one place. An unreadable book folder is refused.
17. As a reader, I want to paste a Cursor key and see the models that key can use, so that I pick the model for the run.
18. As a reader, I want a key stored only after Cursor returns that catalog, so that a bad key is never saved.
19. As a reader, I want the key in Windows Credential Manager, so that other Windows accounts on the PC cannot read it.
20. As a reader, I want Replace key and Forget key, so that I can change or remove the credential.
21. As a reader, I want the window to receive model names and boards, and never the key, so that the page cannot leak the credential.
22. As a reader, I want Start to stay off until the key is saved, a model is chosen, the PDF is accepted, and the folder is set, so that a run cannot start half-configured.
23. As a reader, I want one model for every slice in the run, so that the book is extracted with a single choice.
24. As a reader, I want up to six slices to be written at once, so that the book finishes sooner and I can read the first board while the others are written.
25. As a reader, I want the first accepted board to open immediately, so that I start studying without waiting for the rest of the book.
26. As a reader, I want each slice shown as queued, writing, done, or failed, so that I can see the run.
27. As a reader, I want a rejected board tried once more, then failed with a short reason, so that a bad reply does not loop.
28. As a reader, I want Cancel to stop the queue, so that I can halt a run.
29. As a reader, I want a slice with no accepted board to stay unfinished, so that closing the app or a failed call can be continued later.
30. As a reader, I want a done slice to open while another slice is writing, so that I can move around the finished part of the book.
31. As a reader, I want every technical rule, number, warning, and mechanism kept, and narrative fluff left out, so that the board is complete and readable.
32. As a reader, I want the book’s own example kept on the point it illustrates, with its page, so that I still have the concrete case.
33. As a reader, I want each point in exactly one kind — must remember, mechanics, or useful later — so that the load-bearing rules stay short and nothing technical is dropped to make them short.
34. As a reader, I want the book’s code when that code teaches, with its page, language, and a short note on why lines matter, so that I can study the book’s code.
35. As a reader, I want the viewer to show must remember, then mechanics, then useful later, then code, so that the board always has the same shape.
36. As a reader, I want a page citation to open that PDF page, fitted to width, with previous and next staying inside the slice, so that I can check a claim in one click.
37. As a reader, I want a slice with no technical content to become a valid empty board, so that the queue moves on and the viewer says those pages had no technical content.
38. As a reader, I want a board file and a note on disk as soon as the board is accepted, so that a crash keeps what I already paid for.
39. As a reader, I want an existing valid board skipped on the next run, so that I do not pay twice.
40. As a reader, I want to open a book folder from the launchpad and see the viewer without a model call, so that browsing past work is free.
41. As a reader, I want Continue, when the queue is idle, to run every checked slice that is missing or failed, so that I finish the book on purpose.
42. As a reader, I want checkboxes on slices that are not done, so that I can skip a remaining slice before Continue.
43. As a reader, I want Redo, when the queue is idle, to keep the current board up until the new one validates, so that a failed redo leaves the old board.
44. As a reader, I want the drawer to say the PDF is missing when the stored path is gone, so that the boards still open.
45. As a reader, I want the UI in English, on one dark appearance (near-black canvas, thin borders, short motion), so that the app stays a simple reading tool.
46. As a reader, I want to run the app from this repo on Windows, so that I can use it before any installer exists.

## Implementation Decisions

- The app is one Electron program, TypeScript. Electron’s main process reads the PDF, stores the key, and calls Cursor. The window is a React page with one stylesheet, English, on a solid near-black surface.
- v1 runs on Windows. It is started from this repo with Node. A packaged executable waits.
- The Cursor SDK is the model caller. Auth is a Cursor API key. Inference goes through Cursor’s hosted models. The model list is the catalog for that key. One model applies to the whole run. Each call is one model reply with no tools. It sends that slice only, at most 6 pages: rendered page images in order, one JPEG per PDF page, and the extracted text with `--- PAGE N ---` stamps. The image is the authority for what the page means (figures, columns, commands versus programs). The text layer is the authority for code spelling when it agrees with the image. The model is not left to OCR the program. The last model and the last output folder live in ordinary app settings.
- The key is stored in Windows Credential Manager, tied to the Windows login. Save asks Cursor for the catalog first. Failure stores nothing and shows the error. After a successful save the field is write-only. Any program running as the same Windows user can read that vault; that is how the desktop credential store works.
- The only network calls are Cursor calls: the catalog on save, and the agent during a run.
- A page counts as text when it has at least 40 letters. On drop, fewer than 80% of pages passing means the incompatible-file message and no checklist.
- Slice text is PDF.js text in engine order. Each page is stamped `--- PAGE N ---` using the PDF page index. v1 does no column reordering and no hyphen repair, because the page image carries layout.
- A listing is a run of lines whose PDF.js font-family hint is monospace. A one-line run that is only a URL, or only digits, is not a listing. The board includes the book’s code when that code teaches.
- Slicing uses the PDF outline when it exists. If any bookmark is titled Chapter plus a number, those bookmarks are the chapters, including when they sit under parts. A chapter is cut on its own sections, not on their children. A section longer than 6 pages becomes consecutive chunks of 6 pages, last chunk shorter, and the chunks keep that section’s title. Pages from the chapter start up to the first section join that first section, and the 6-page cap then splits from the front. Two section bookmarks on the same page keep the first. Pages outside every chapter start unchecked when the bookmark is cover, copyright, contents, contributors, a Packt page, introduction, about the author or reviewer, or one of the other front-matter titles. Another heading outside a chapter starts checked. A run of single-letter index bookmarks stays under the Index title, in chunks of at most 6 pages. When no bookmark is titled Chapter plus a number, a heading of 6 pages or fewer is one slice, and a longer heading splits on child outline entries, then into consecutive chunks of 6 pages, last chunk shorter. Pages in no outline entry become slices titled “Pages a–b”, at most 6 pages, starting unchecked. With no outline, slices are tiled 4-page windows labeled as page windows, last window shorter. A window starts unchecked when its text begins with one of the English front-matter titles listed in the user stories. Other windows start checked.
- The PDF is chosen by drop or by a file chooser. The output folder is chosen by a folder chooser. A missing folder is created. A folder that already holds a readable book manifest opens that book and does not replace the output folder. Any other folder is the output folder, even when it already holds files. An unreadable manifest is refused.
- Start opens the slice checklist as a sheet, and Confirm on that sheet starts the queue. The checklist itself is local. While the queue runs, the viewer stays on the same window.
- The app holds a warm pool of at most six local Cursor agents for the session. The width is six unless `BOOK_DISTILLER_AGENT_CONCURRENCY` sets another whole number from 1 to 6, and fewer slices that still need a model start fewer agents. An agent is created on the first real model call of its slot, and every later slice, Continue, and Redo that slot runs sends on that same agent with the model selected at that moment, so only each slot’s first slice pays startup. A slice that already has a valid board gets no agent. The agents have no tools and do not retry on their own. Each agent has its own stable workspace directory for its life, and no two agents share one; each slice overwrites the page images, slice text, and board instructions of the slice that agent ran before. Each slice prompt is self-contained and says that slice stands alone. The second attempt for a rejected board stays on the same agent, with the rejection in its prompt. Once a slice is settled, accepted or failed, the app summarizes that same agent’s conversation and waits for it. That is the clear between slices, so the next slice does not carry the previous page images. A failed summary does not fail the slice. If one agent’s send throws, only that agent is disposed and its worker creates a replacement for a later slice. Every agent is disposed when the key is forgotten or replaced and when the app quits; the temporary workspace root is deleted only after that, and a delete that fails leaves the directory in place without failing the queue. The app copies a board into the book folder only after validation. The key and the other boards stay outside that workspace.
- The top bar shows the session token total, just left of Settings, once a turn reports usage. It is the sum of each live agent’s latest cumulative total plus what agents already disposed had counted, updated after each send and each summary, and it stays up when the queue goes idle. There is no second counter. Forgetting or replacing the key resets it; quitting keeps it.
- Each worker takes the next checked slice that is not done, so no slice runs twice at once; failed slices are taken again, done ones are not. The status line names the slice when exactly one is writing and says how many (for example `Writing 4 slices`) when several are. Redo is one slice on one agent. A rejected board (bad shape or network) is tried once more. A second rejection marks the slice failed. The short reason is one of: shape, network, or cancelled. Cancel stops every worker from taking another slice and cancels every run that is live on any agent, whether that is a slice or a summary, without waiting for the model to finish; the button reads Cancelling until the queue settles, and the agents stay open for Continue. A network failure uses the same failed state.
- The agent’s job is complete technical extraction of that slice. It keeps every technical rule, number, threshold, mechanism, edge case, and warning. It keeps the book’s own example on the point it illustrates. It includes the book’s code when that code teaches, with its page, language, and short line notes. Those notes are the model’s words. It copies that code from the text layer when the text matches the page, and from the image otherwise. It leaves out conversational filler, anecdotes that teach no rule, historical trivia, and repeated intros. It cites the PDF page index from the stamps and the image order, never the printed folio in the corner. It adds no example the book did not write.
- A point has exactly one kind: `must-remember`, `mechanics`, or `useful-later`.
- Validation keeps a board when the JSON shape is valid and every cited page is inside the slice. An empty board is valid.
- Redo and Continue are available when the queue is idle. Redo uses the model selected now. The previous board stays in place until the replacement validates.
- On confirm, the app writes into a book folder inside the output folder. The book folder’s name is the PDF title, or the file name when the PDF has no title. Characters that Windows rejects in a folder name are replaced, and a blank name becomes Book. A child folder whose manifest points at this PDF is reused. If the name is taken by a different book or by unrelated files, the next free name is Title (2), Title (3), and so on. If the output folder itself is already this PDF’s book, the files stay there. The manifest is written when the run starts, before the first model call.
- Opening a book folder from the launchpad, or choosing one in Settings, shows the viewer and does not call the agent. Done slices are the ones whose board file exists and validates. Missing and failed slices that are still checked are what Continue runs. Unchecking a slice that has no board skips it. Unchecking a slice that already has a board leaves that board.
- The book folder looks like this:

```text
<book name>/book-manifest.json
<book name>/boards/<sectionId>.board.json
<book name>/notes/<sectionId>.md
```

- `sectionId` is a slug of the heading: lowercase, hyphen-separated. When two headings would share a slug, the start page is added. The manifest stores `schemaVersion`, the PDF path, the title, and each slice’s id, title, page range, checked state, status, model id when a board was accepted, and the failure reason when it failed. The app may rewrite the manifest from the board files and the PDF. The note is written only when a board is accepted, in viewer order, with page numbers, and it contains nothing the board does not contain. The PDF file is not copied. A missing PDF leaves the boards readable and the drawer says the PDF is missing.

Board shape:

```json
{
  "schemaVersion": 1,
  "sectionId": "write-ahead-log",
  "sectionTitle": "Write-ahead log",
  "pageStart": 4,
  "pageEnd": 6,
  "points": [
    {
      "kind": "must-remember",
      "title": "Flush the log before memory",
      "explanation": "A write is durable only after the log is on disk.",
      "page": 4,
      "example": { "text": "The book's own outage example.", "page": 5 }
    }
  ],
  "code": [
    {
      "title": "put",
      "language": "rust",
      "page": 6,
      "source": "wal.append(key, val)?;",
      "notes": [{ "lines": "1", "why": "Disk is forced before memory changes." }]
    }
  ]
}
```

`example` is present only when the book illustrates that point. `notes` may be empty. `kind` is `must-remember`, `mechanics`, or `useful-later`.

## Testing Decisions

A good test checks behavior the reader can observe: accept or refuse, the checklist, the files in the book folder, and what the viewer shows. Tests avoid private helpers.

The highest seam is the app’s operation on a PDF and a book folder. There is no prior test suite.

The committed fixture is a short single-column booklet with a text layer, an outline, a preface of fluff, a section with a numbered rule and a book example, a section with a monospace listing and a figure drawn on the page, and a trailing page outside the outline. Slicer tests against it are exact: pages, headings, and the listing text. A second fixture with too little text proves refusal. Further small generated PDFs prove the 6-page split and the no-outline windows.

Automated agent tests use a stand-in that returns board text. They accept a board when the shape validates and every page falls inside the slice. They do not require each listing after whitespace collapse. A slice run records one image per page, and the prompt names those PDF page numbers. The real Cursor call is gated by a person reading one board from the booklet against the booklet. Extraction is done only after that read.

## Out of Scope

OCR and image-only scans. macOS and Linux. An installer. Tauri. Theme switching and component kits. Animated diagrams and cropped figures. Generated exercises. A library of books. A price counter. The agent’s transcript. Column reordering and hyphen repair.

## Further Notes

The brainstorm that led here is `docs/brainstorming/AI Technical Book Reader.pdf`. This PRD replaces that thread. Tickets live under `.scratch/book-distiller/issues/`.
