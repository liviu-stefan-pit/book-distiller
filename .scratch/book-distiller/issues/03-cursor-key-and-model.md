# 03: Save a Cursor key and pick a model

**What to build:** On the launchpad the reader pastes a Cursor key. The app stores it only after Cursor returns the model catalog, then the dropdown lists those models. A bad key is not stored and the error shows. The key lives in Windows Credential Manager. The window never receives it. Replace key and Forget key work. Start stays off until the key is saved, a model is chosen, the PDF is accepted, and the folder is set.

**Spec:** [docs/prd.md](../../../docs/prd.md)

**Blocked by:** 01: Accept or refuse a PDF

**Status:** resolved

- [x] Save asks Cursor for the model catalog. Success stores the key and fills the dropdown. Failure stores nothing and shows the error.
- [x] The key is in Windows Credential Manager. After save the field is write-only, with Replace key and Forget key.
- [x] The window receives model names only. The key stays in the main process.
- [x] The reader picks one model. That choice is what the run will use.
- [x] Start stays off until the key is saved, a model is chosen, the PDF is accepted, and the output folder is set.
- [x] The last model and the last output folder are remembered in ordinary app settings.
- [x] An automated test uses a stand-in catalog: a successful save fills the dropdown, a failed save leaves nothing stored.
