# Three-participant quick test mode

## Enable

Deploy the updated bundle through the Azure image/revision pipeline. Log in to the existing Empirica admin interface and create a batch containing **only `test` treatment**. The treatment still requires three participants and retains all normal timers and AI timing. Each assigned participant sees a collapsible **测试模式** panel at bottom right.

Only open test batches during team testing. Close test batches before opening `main` for recruitment. This version does not route test IDs separately while formal batches are open. Test IDs and `?test=1` do not authorize controls.

Select **Researcher test shared 24h** for tests. Use a lobby duration of at least 30 minutes; use 24 hours (`86400000000000` ns) for rehearsal. Ensure `experimentOpen=true` on Global and `initialized=true` on the batch, with a running, non-ended batch. An existing ended batch cannot be reopened solely by toggling experimentOpen. Verify real subscription liveness before live use.

## Controls

- **上一页（自己）**: return within the current personal flow, including practice preparation. Saved answers remain; completion markers are cleared and the page timer starts again. Cannot return across an ended stage.
- **跳过本页（自己）**: bypass validation without generating answers. Completing the personal flow waits for the other two participants.
- **全组下一阶段**: after confirmation, end the current stage for all three. Can skip reading, discussion, decision or follow-up without waiting. A skipped unconfirmed group decision records `test_skipped`, no official answer, and no natural timeout.
- **跳过休息（全组）**: available after all three participants arrive and the shared break starts. Completes the break immediately.

The panel shows current round, stage, personal page and server acknowledgements. Refresh preserves server state. Shared requests are serialized by stage version; a stale request is rejected and may be retried as a new operation. Repeated delivery of the same request does not execute twice. There is no pause control or cross-round jump in this version.

## Research data

Test sequence assignments use `testSequenceAllocationLedgerV1`, separate from formal assignments. Test games and operations remain in Tajriba for diagnosis; skipped forms remain missing, not fabricated. Normal export lists exclude test games. Select **Include test data** (API: `includeTest=true`) to list them. Direct game downloads remain available and are labelled: JSON `game.testMode`, questionnaire CSV `test_mode`, HTML and Markdown TEST SESSION notices. Bundles include the bounded test operation log.

Complete Tajriba backups and native Empirica exports still contain test data; filter it before formal analysis. The custom research-export filter does not delete data.

## Verification and release

Run scoped offline source tests and both production builds. Three-browser live acceptance should cover independent page controls, all-group progression, break skip, reconnects and AI results returning after a stage was skipped. Do not consider an offline pass proof of live Tajriba behavior. Deploy an immutable Azure image/revision; no hot edits. This implementation does not deploy or start a pilot automatically.
