# PHASE 6A — PPTX Professional Viewer — Change Manifest

## Files changed (this phase, scoped strictly to PPTX)

| File | Why |
|---|---|
| `app/js/viewers/pptx-viewer.js` | Rewritten: theme/layout/master background inheritance + scheme-color resolution, per-run font size/bold/italic/underline/color, shape fill/border, rotation, vertical anchor, presentation-specific zoom (own state, not the shell's), slide nav (prev/next/first/last/counter), presentation mode, keyboard navigation. |
| `app/js/viewer.js` | Only the generic shell hooks a specialized engine needs to implement keyboard nav + its own teardown (`setKeyHandler`, `onCleanup` — see Contract below) and the `renderPptx()` adapter passing them through. **No pptx-specific logic added to the shell.** |
| `app/js/file-support-policy.js` | `VIEWER_CAPABILITIES_BY_ENGINE['pptx-text-extract']` now declares `zoom: true, presentationMode: true` (previously false/absent) because pptx-viewer.js now actually implements them; `notes` text updated to describe the new fidelity level accurately. |
| `app/css/viewer.css` | New rules for the slide counter, presentation-mode layout (hide rail, full-width canvas), and active-toolbar-button state. No existing selectors changed. |
| `scripts/viewer-lifecycle-test.js` | Split the old combined excel+pptx "capability tables do NOT falsely claim zoom" check into two: excel's stays a not-claimed guard; pptx's is now a **claim-is-real** guard (asserts `addZoomControls` is actually called in pptx-viewer.js AND the capability table says `zoom:true`) — so a future regression in either direction (removing zoom without updating the capability table, or vice versa) still fails the build. |

No other files were touched. `server/`, `electron/`, `scripts/` (other than the one test file above), and the immutable standards/evidence folder were not modified — verified via `git status` before packaging.

## Public/internal interface changes

### New shell hooks (generic, not PPTX-specific — any future engine can use them)
```js
ctx.setKeyHandler(fn)   // fn(KeyboardEvent) => boolean; shell calls it before its own
                        // key handling; return true to mark the event as handled.
                        // Auto-cleared on the shell's next open()/close().
ctx.onCleanup(fn)       // fn() => void; shell calls it once in cleanupPrevious(),
                        // before the next file opens or the viewer closes.
```
These live in `viewer.js` module state (`extraKeyHandler`, `extraCleanup`) and are wired into the existing `onKeydown()`/`cleanupPrevious()` — no new listeners were added to the shell itself; it just now has two optional extension points.

### PPTX engine contract (`app/js/viewers/pptx-viewer.js`)
`ctx` grew from `{fetchBytes, showLoading, showError, setInfoExtra, addSearchToggle, esc, dom, state}` to additionally include:
```
addToolBtn, addSep, addZoomControls, toggleFullscreen, setKeyHandler, onCleanup
```
All are existing shell primitives (already used by the PDF/image/word renderers) — nothing new was invented for PPTX specifically. `renderPptx()` in `viewer.js` remains a one-line-body adapter that just builds this object and calls `PptxViewer.render(ctx)`.

## Dependencies added/removed
None. Still JSZip + native `DOMParser`, already loaded by `app/index.html`.

## Tests added/modified
- `scripts/viewer-lifecycle-test.js`: one check split into two (see table above); both still exercised by `npm run verify:viewer-lifecycle`.
- No new test files added this phase (Phase 7.5's `evidence-intake-test.js`/`viewer-lifecycle-test.js` recovery was a prior phase).
- Fidelity logic (theme/master/background resolution, font-size/color extraction) was validated against the real committed `.ppsx` evidence file via a throwaway Node harness (JSZip + `@xmldom/xmldom`, not committed to the repo) — see Verification in the final report for the numbers. This is spot-check tooling, not a maintained test; a real headless-DOM regression test for this would need a browser test runner, which this project deliberately doesn't have (see `viewer-lifecycle-test.js`'s own header comment on that tradeoff).

## Known limitations
See the final report's "Known Limitations" section — summarized: real PowerPoint fonts, gradient/picture backgrounds beyond a flat-color approximation, shadows/3D/animations/transitions/charts/SmartArt graphics, custom `clrMapOvr` remaps, and exact nested-group transforms are not attempted (documented in `pptx-viewer.js`'s own header comment, not hidden).

## Integration notes for future phases
- **Don't put format-specific logic in `viewer.js`.** The two new hooks (`setKeyHandler`, `onCleanup`) are intentionally generic — a future PDF/Word/Excel/media engine extraction can reuse them exactly as PPTX does, with zero shell changes.
- **The `renderersByEngine` table in `viewer.js` is still the single resolver** (`Evidence → FileSupportPolicy → category/engine → renderersByEngine → specialized render function`). Adding a new engine means adding one entry there plus a capability entry in `file-support-policy.js` — nothing else in the shell needs to change.
- **A specialized engine that registers `setKeyHandler` should return `false` for any key it doesn't specifically own**, so the shell's own Escape/close, `F`-fullscreen, and Ctrl/Cmd+F-search keep working unmodified — this is how pptx-viewer.js coexists with the shell's existing keyboard behavior without either side needing to know about the other's key bindings.
- **A specialized engine that adds any listener/observer of its own (ResizeObserver, `window`-level listeners, timers, etc.) must register `ctx.onCleanup(...)` to dispose it.** This is exactly the class of bug the Phase 7.5 root-cause investigation found and fixed for the PDF viewer's old observers — the hook exists specifically so it doesn't happen again for new engines.
- The PPTX engine's zoom is **local to that engine** (its own `zoomLevel` variable + a CSS `transform: scale()` on its own canvas element) — it does not touch `state.zoom`/`applyContentZoom()`, which remain scoped to image/word/text as before. A future engine wanting its own zoom should follow the same pattern (own state + `ctx.addZoomControls`) rather than extending the shell's `applyContentZoom()` branch list.
