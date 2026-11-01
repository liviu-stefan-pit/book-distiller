# Book Distiller

A Windows app that turns one technical PDF into section boards you can check against the original page, then composes those boards into a PDF you can open from the study screen. The product notes are in [`docs/prd.md`](docs/prd.md).

## What you can do

**Open a book.** Drop a PDF or choose one. A file with a real text layer is accepted and shows its title and page count. A scan, or a PDF whose text is mostly too thin to read, is refused. The window title is the PDF title, or the file name when the PDF has none.

**Set up once.** In Settings, paste a Cursor key. The key is saved only after Cursor returns the model catalog, and it is stored in Windows Credential Manager. Replace key and Forget key change or remove it. Pick one model for the whole run. The last model, including its effort and fast setting, and the last output folder are remembered. Choose an output folder; a missing folder is created. Opening a folder that is already a book shows that book and does not spend a model call. Start stays off until the key is saved, a model is chosen, the PDF is accepted, and the folder is set.

**Choose the slices.** Start opens a checklist before any model call. Each slice is at most six pages. A book with Chapter-numbered bookmarks is cut on each chapter's own sections. A longer section splits into six-page chunks that keep that section's title. Without those bookmarks, a short heading is one slice and a longer one splits on its children, then into six-page chunks. A PDF with no outline becomes four-page windows. Cover, copyright, contents, preface, and the other front matter start unchecked. Pages outside the outline show up as "Pages a–b" and start unchecked. You can toggle slices. Confirm stays off when every slice is unchecked. The app sets the page boundaries.

**Distill.** Confirm writes up to six slices at once. Each slice sends that slice's page images and its extracted text, not the whole PDF. A board keeps every technical rule, number, warning, and mechanism, the book's own example, and the book's code when that code teaches. Points are must-remember, mechanics, or useful later. A slice with nothing technical becomes an empty board. A rejected reply is tried once more, then the slice fails with a short reason. Cancel stops the queue. The first accepted board opens while the rest are still writing, and a done slice stays readable. The top bar shows the tokens for the session. Each accepted board is saved immediately, with a markdown note, in a folder named after the book. Opening that folder later shows the boards and spends nothing until you press Continue. Continue runs the checked slices that are still missing or failed. Redo rewrites the open slice and keeps the current board until the new one validates. A page citation opens that PDF page. If the PDF file is gone, the boards still open and the drawer says the PDF is missing.

**Compose.** On the study screen, Compose sends each finished technical board through a reviewer and writes `composed.pdf` in the book folder. Distill still adds nothing the source did not write. The reviewer may add a labeled gap, a current technique, or an extra example, and it may leave an addition out. The sheet shows the pages, the sections, and the tokens of that run. Each section is Waiting, Reviewing, Done, or Failed on its own, even when two chunks share a title. Cancel keeps the chapters already written and does not publish the PDF. Open PDF appears when the book has been published. A later Compose skips a section whose board has not changed.

The book folder looks like this:

```text
<book name>/book-manifest.json
<book name>/source.pdf
<book name>/boards/<section id>.board.json
<book name>/notes/<section id>.md
<book name>/figures/<section id>-<n>.jpg
<book name>/composed/<section id>.chapter.json
<book name>/composed.pdf
```

A board may include a cropped figure with its caption and page.

## Run

On Windows, from this repo: `npm install`, then `npm start`. `npm test` rebuilds the app and runs the checks.

## Pack

`npm run pack` writes a portable exe under `release/` named like `Book Distiller` plus the version (the file to send). Recipients need 64-bit Windows, internet, and their own Cursor key. They do not need Node. The exe is unsigned, so Windows SmartScreen may say it protected the PC; More info then Run anyway is how to open it. No installer. Pushing a vX.Y.Z tag publishes that portable exe on the repo's Releases page.

## License

MIT. Anyone can use, change, and share this. It is provided as-is, with no warranty, and the author is not liable for what anyone does with it. See [`LICENSE`](LICENSE).
