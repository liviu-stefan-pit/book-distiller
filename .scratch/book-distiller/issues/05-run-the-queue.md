# 05: Run the rest of the queue

**What to build:** Confirm runs every checked slice, one at a time. The first accepted board opens while later slices write. The reader can open a done slice during the run. A slice that already has a valid board is skipped. Cancel stops the queue. Failures show a short reason and leave finished boards untouched. When the queue is idle, the reader can return to the launchpad.

**Spec:** [docs/prd.md](../../../docs/prd.md)

**Blocked by:** 04: One slice becomes a board

**Status:** resolved

- [x] Checked slices run serially. Status is queued, writing, done, or failed.
- [x] The first accepted board opens on its own. Done slices can be opened while another slice is writing.
- [x] A second rejection marks the slice failed with a short reason: shape, missing listing, network, or cancelled. Finished boards stay.
- [x] Cancel stops the queue. A slice with no accepted board stays unfinished.
- [x] A slice whose board file already validates is loaded and skipped, with no agent call.
- [x] While the queue is running, Study stays up. The launchpad is available once the queue is idle.
- [x] The manifest records each slice’s status and, for an accepted board, the model id used.
- [x] An automated test runs three slices through a stand-in: one accepted, one failing twice, one skipped because its board is already valid, and Cancel leaving the in-flight slice unfinished.
