## Summary

```text
Launchpad
  save Cursor key
    list models
  choose model and book folder
  Start
Checklist
  confirm checked slices
Study
  distillQueue (serial)
    write board and note
    one retry
    cancel drops an in-hand reply
  Continue / Redo
```

```text
src/main/
├── cursorKey.ts    # key, catalog, remembered model and folder
├── slicePdf.ts     # cuts the PDF into slices
├── bookFolder.ts   # empty folder or this book's folder
└── distill.ts      # queue, boards, notes, resume
src/renderer/
├── App.tsx         # launchpad, checklist, Study
└── app.css         # viking-night palette
```

## Evidence

- **Before:** the launchpad accepted a text PDF and stopped there.
  **After:** `npm test` — 53 passed (1.5m), covering the key, the checklist, one board, the queue, resume, and the viking-night theme.

## Merge Danger

**Door:** two-way

A revert of this commit returns the app to the launchpad. Tests keep the key in memory. A person saving a key on this login is the only path that writes Windows Credential Manager.

**Blast Radius:** app

Study, the book folder, and the Cursor key are new. The launchpad uses the viking-night palette.
