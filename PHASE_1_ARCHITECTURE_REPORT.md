# PHASE 1 — Architecture Refactoring Report

Status: **COMPLETE**. Original repository untouched; all changes live exclusively in `/home/claude/workspace/phase1-working-copy`.

---

## 1. Executive Summary

This phase reorganized two specific, previously-flagged pieces of internal
architecture without changing any application behavior, UI, API contract,
IPC contract, evidence structure, licensing, backup, viewer rendering, or
dependency versions:

1. **Filesystem-write ownership.** `evidenceService.js` already owned every
   *read* operation against the evidence tree (`listFiles`, `getFilePath`,
   `folderForCode`, etc. — confirmed in the Phase 0 audit). The
   corresponding *writes* (upload's `fs.writeFileSync`, delete's
   `fs.unlinkSync`, and rename's `fs.renameSync` plus its full validation
   contract) were interleaved directly inside `server/routes/files.js`'s
   HTTP handlers instead. They are now owned by `evidenceService.js` too,
   via three new functions (`writeEvidenceFile`, `deleteEvidenceFile`,
   `renameEvidenceFile`); the routes are now HTTP-framing-only, exactly as
   the Phase 0 audit's §22 target-architecture proposal recommended.
2. **Scattered operational constants.** The server-startup port list, the
   self-heal interval, the JSON body-size limit, and the CSP policy string
   were each defined inline inside the function bodies that used them
   (`electron/main/main.js`, `server/app.js`). They now live in two small,
   narrowly-scoped config modules — one per existing process boundary
   (`electron/config/`, `server/config/`).

Both changes are pure relocations of existing logic with identical
behavior, confirmed via the project's own automated test suites (136/145
passing, matching the Phase 1A baseline exactly — see §19–20) and, for the
CSP policy specifically, a direct byte-for-byte string comparison against
the original inline literal, not just visual inspection.

No other area of the codebase was touched. IPC, licensing, backup, and
viewer boundaries were inspected (per the brief's explicit instruction)
and found to **already** satisfy the target architecture's separation-of-
concerns goals — see §10–13 for why no code changes were made there.

---

## 2. Original Architecture

(As established by the Phase 0 audit; restated here only where it bears
directly on what was and wasn't changed.)

```
server/routes/files.js
  ├─ HTTP request parsing/validation (FileSupportPolicy, filename decode)
  ├─ raw fs.mkdirSync / fs.writeFileSync           ← upload
  ├─ raw fs.unlinkSync (after an inline existence check)  ← delete
  ├─ raw filename-safety validation + fs.renameSync        ← rename
  └─ audit logging (store.addAudit)

server/app.js — createApp()
  ├─ Store construction, evidenceRoot resolution
  ├─ first-run seed/ensure-folders bootstrap
  ├─ SELF_HEAL_INTERVAL_MS defined inline, self-heal setInterval
  ├─ SSE broadcaster + evidence-root-change handler
  ├─ watcher wiring
  ├─ CSP header string built inline inside a middleware closure
  ├─ express.json({ limit: '5mb' }) — limit hardcoded inline
  ├─ static file serving
  └─ route mounting

electron/main/main.js
  ├─ PREFERRED_PORTS array defined inline at module scope
  ├─ single-instance lock, bootstrap(), window lifecycle
  └─ port-trying loop, crash recovery, exit-backup hook
```

The mixing here is exactly what the Phase 0 audit's §21 ("Code Quality &
Coupling Problems") table already identified: *"Filesystem write/delete/
rename logic interleaved with HTTP/validation/audit-logging in route
handlers rather than delegated to evidenceService"* (severity: Low) and,
implicitly, configuration values defined at their point of use rather than
being independently discoverable/reusable.

---

## 3. New Architecture

```
server/services/evidenceService.js  ← now owns ALL evidence filesystem I/O
  ├─ reads (unchanged): listFiles, getFilePath, folderForCode,
  │  integrityCheck, stats, indicatorMap, ensureAllFolders, seedFromTemplate
  └─ writes (NEW):
       writeEvidenceFile(dir, filename, body)
       deleteEvidenceFile(evidenceRoot, code, name)
       renameEvidenceFile(evidenceRoot, code, oldName, newName)

server/routes/files.js  ← now HTTP framing only for these three operations
  ├─ parses the request, resolves the target dir via folderForCode()
  ├─ runs FileSupportPolicy validation (upload) — unchanged, stays here
  │  since it's an HTTP-boundary/API-contract concern, not filesystem I/O
  ├─ calls the evidenceService function
  ├─ maps the service's result to the exact same status code / error
  │  message / response body the endpoint already returned
  └─ audit-logs the outcome (stays here — depends on `store`, which
     evidenceService intentionally does not depend on; see §5)

electron/config/index.js   ← PREFERRED_PORTS
server/config/index.js     ← SELF_HEAL_INTERVAL_MS, JSON_BODY_LIMIT,
                              CONTENT_SECURITY_POLICY

electron/main/main.js  ← imports PREFERRED_PORTS, otherwise unchanged
server/app.js           ← imports the three server constants, otherwise
                           unchanged
```

---

## 4. Why the New Structure Is Better

- **`evidenceService.js` is now the single, complete owner of evidence
  filesystem I/O** (reads and writes both), matching the "Filesystem
  Layer" and "Evidence Module" sections of the Phase 1 brief almost
  exactly: application/route code no longer contains raw `fs.*` calls for
  evidence files — it calls a named, documented service function instead.
  A future caller that isn't an HTTP route (a CLI tool, a different UI, a
  test) can now reuse the exact same write/delete/rename logic, including
  all of its safety checks, without going through Express at all.
- **The rename safety contract is now testable and reusable in isolation.**
  Previously, "what counts as an invalid new filename" was logic buried
  inside a route handler and only reachable via an HTTP request. It's now
  a pure function (`renameEvidenceFile`) that returns a structured result
  — this is the single largest concentration of business logic that moved
  in this phase, and it's also the piece most worth having outside the
  HTTP layer, since filename-safety rules are a domain concern, not a
  transport concern.
- **Configuration values are now independently discoverable.** Someone
  asking "what ports does this app try?" or "what's the CSP policy?" no
  longer has to read through `bootstrap()`/`createApp()`'s full body to
  find an inline constant — they can look at one small, purpose-labeled
  file. This directly serves the brief's "Discoverability" and "Naming
  consistency" goals without inventing a generic settings/config
  framework (deliberately avoided — see §22 for what was *not* done and
  why).
- **The change is small enough to fully verify.** Every behavior the
  refactor touches has an existing automated test that exercises it
  end-to-end (upload, delete, rename incl. every error branch, CSP header
  presence). This kept the actual verification burden proportional to the
  risk, rather than requiring new test infrastructure to trust the result.

---

## 5. Module Responsibilities

| Module | Responsibility (after Phase 1) |
|---|---|
| `server/services/evidenceService.js` | Everything the app needs to know or do to the evidence filesystem tree: resolve an indicator's folder, list/read/write/delete/rename files in it, create the folder skeleton, seed template content, check integrity, compute stats. No knowledge of HTTP, Express, or the audit log. |
| `server/routes/files.js` | HTTP request/response framing for evidence-file endpoints: parse the request, call FileSupportPolicy for upload validation, call evidenceService, map results to status codes/JSON, write audit-log entries. No direct filesystem access. |
| `server/config/index.js` | Server-layer operational constants with more than one meaningful "we might want to know/change this independently" reason: self-heal interval, JSON body limit, CSP policy. No logic, no side effects. |
| `electron/config/index.js` | Main-process operational constants: the preferred-port list for the embedded server. No logic, no side effects. |
| `electron/main/main.js` | Unchanged responsibilities: app lifecycle, single-instance lock, window creation/orchestration, port-trying loop (logic unchanged, just reads its port list from `electron/config` now), crash recovery, exit-backup hook. |
| `server/app.js` | Unchanged responsibilities: app-factory (`createApp()`), store construction, evidence-root resolution, watcher wiring, SSE broadcaster, middleware/route registration (now reads its three constants from `server/config` instead of defining them inline). |

All other modules (viewer, licensing, backup, IPC handlers, `paths.js`,
`security.js`, every other route file) are **unchanged** — see §10–13 for
why.

---

## 6. Dependency Direction

```
server/routes/files.js
        │  requires
        ▼
server/services/evidenceService.js
        │  requires
        ▼
FileSupportPolicy (app/js/file-support-policy.js, category lookup only)
Node's fs / path (built-in)

server/app.js
        │  requires
        ▼
server/config/index.js  (no further dependencies — pure constants)

electron/main/main.js
        │  requires
        ▼
electron/config/index.js  (no further dependencies — pure constants)
```

Dependency direction is unchanged from before this phase in every case
except that `evidenceService.js` gained two new internal (not external)
capabilities, and `server/app.js`/`electron/main/main.js` each gained one
new same-layer, zero-dependency import. **No new dependency cycle was
introduced** — the two config modules depend on nothing, and nothing
outside their own layer (`electron/` vs `server/`) depends on them, which
was a deliberate choice to avoid crossing that boundary unnecessarily (a
single shared root-level config module was considered and rejected for
exactly this reason — see §22).

`evidenceService.js` still does **not** depend on `server/store/store.js`
— this was true before this phase and remains true after it. This is
worth calling out explicitly because it was the reason audit-logging
calls were deliberately left in the routes rather than pulled into the
new service functions (see §5's `evidenceService.js` row): moving them
would have created a new dependency from the domain/evidence layer onto
the application-store layer, which is a real architectural decision, not
a mechanical extraction, and was out of scope for this phase.

---

## 7. Electron / Main / Preload / Renderer Boundaries

**Unchanged.** The main process, preload bridge, and renderer retain
exactly the boundaries documented in the Phase 0 audit (§3, §13, §14):
`electron/main/main.js` still owns app lifecycle/window management,
`electron/preload/preload.js` still exposes only its original 2 methods,
and the renderer (`app/index.html` + `app/js/*`) was not touched at all
(confirmed: `git diff` against every renderer file produces zero output —
see §19). `electron/main/main.js`'s only change is where it reads
`PREFERRED_PORTS` from; every other line, including the entire startup
sequence, window creation calls, and IPC handler registration, is
byte-for-byte identical.

---

## 8. Evidence Architecture

**Structure, paths, and content: unchanged** (verified via SHA-256 hash
comparison before and after every change — see §14, §19). What changed is
purely which module owns the *code* that operates on that unchanged
structure: `evidenceService.js` now owns writes as well as reads (§3–5).
The manifest-driven folder mapping (`folderForCode`, `codeFromPath`,
`evidence-manifest.json`) is completely untouched.

---

## 9. Filesystem Architecture

| Operation | Before | After |
|---|---|---|
| Read (list/stat) | `evidenceService.js` | `evidenceService.js` (unchanged) |
| Write (upload) | `server/routes/files.js` (inline `fs.mkdirSync`+`fs.writeFileSync`) | `evidenceService.writeEvidenceFile()` |
| Delete | `server/routes/files.js` (inline `fs.unlinkSync`) | `evidenceService.deleteEvidenceFile()` |
| Rename | `server/routes/files.js` (inline validation + `fs.renameSync`) | `evidenceService.renameEvidenceFile()` |
| mkdir (folder skeleton) | `evidenceService.js` | `evidenceService.js` (unchanged) |
| Copy (template seed) | `evidenceService.js` | `evidenceService.js` (unchanged) |
| Watch | `evidenceWatcher.js` | `evidenceWatcher.js` (unchanged) |
| Backup zip read+write | `backupService.js` | `backupService.js` (unchanged) |
| Open file/folder in OS (`shell.openPath`) | `server/routes/files.js` | `server/routes/files.js` (unchanged — see §22) |

The one remaining Electron-API-inside-a-route-file pattern
(`shell.openPath` in `open-folder`/`open-file`) was **not** moved. See
§22 for why.

---

## 10. IPC Architecture

**No changes.** Re-inspected per the brief's explicit instruction (§0 of
this phase's task: "identify IPC logic," "audit and reorganize IPC
handlers where appropriate"). The existing structure —
`electron/ipc/dialogHandlers.js` and `electron/ipc/appHandlers.js`, two
single-purpose files, one channel each, no business logic inside either
handler, both already following the `ipcMain.handle`/`ipcRenderer.invoke`
pattern — already satisfies every goal the brief lists for this section
("IPC responsibilities should be clear," "avoid giant IPC handlers,"
"avoid business logic inside IPC registration"). There was nothing to
extract: neither handler does anything beyond a single, focused
OS-native-API call. Introducing an additional layer (e.g. a formal
"application service" between the IPC handler and `dialog.showOpenDialog`)
for a 6-line handler would be exactly the "abstraction merely because it
sounds architecturally sophisticated" anti-pattern the brief warns
against. No IPC channel names, payloads, or behavior changed.

---

## 11. Viewer Boundaries

**No changes.** Re-inspected per the brief's instruction. Per the Phase 0
audit (§13), `app/js/viewer.js` already does not touch licensing, backup,
school-folder management, or evidence storage directly — its only
external interaction is `fetch()`/`EventSource` calls to the same HTTP API
every other renderer module uses, and its dispatch table
(`renderersByEngine`) is already centralized rather than a hand-maintained
`switch`. The Phase 0 audit's own recommendation to eventually split
`viewer.js` by format (mirroring `pdf-engine.js`) was explicitly scoped as
**future** work (§22 item 4 of that report) and remains future work — not
attempted here, since doing so would mean touching rendering code, which
this phase's brief explicitly forbids ("DO NOT improve the viewers," "DO
NOT change their rendering strategy"). `app/js/viewer.js` is confirmed
byte-for-byte unchanged (`git diff` produces zero output for this file).

---

## 12. Licensing Boundaries

**No changes.** `server/services/licenseService.js` and
`server/routes/license.js` were already a clean, self-contained module
before this phase — confirmed again in this pass: `licenseService.js` has
no dependency on evidence, backup, viewer, or UI code, and
`routes/license.js` is a thin HTTP wrapper around it (3 endpoints, no
business logic inline). There was no coupling to isolate. Activation
logic, machine binding, server communication (none — fully offline by
design), and validation are all byte-for-byte unchanged. The known
baseline fact that the renderer's `checkLicense()` stub always returns
`true` (Phase 0 §17) is unchanged and was not touched.

---

## 13. Backup Boundaries

**No changes.** `server/services/backupService.js`,
`server/routes/backup.js`, and `electron/utils/autoBackup.js` were already
separated from unrelated application logic — confirmed again in this
pass. `backupService.js` has no dependency on evidence-service internals
beyond reading `app.locals.evidenceRoot` as a plain path string (passed in
by the caller, not looked up itself), and `routes/backup.js` is a thin
wrapper (create/list/download, no business logic inline). What's backed
up, where, in what format, and the (already-documented, Phase 0 §18)
absence of a restore path are all unchanged.

---

## 14. School Standards Folder Relationship

**Unchanged and independently re-verified at every step of this phase.**
`electron/utils/paths.js` (the sole path-resolution authority for the
standards folder) was not touched. SHA-256 checksums of every file inside
`معايير التقويم والاعتماد المدرسي` were computed and compared:

1. Before any Phase 1 code change (matching the Phase 1A baseline).
2. After the evidence-service filesystem-ownership refactor (commit
   `e9d627d`... see §19 for the actual hash used in this phase's git log).
3. After the config-extraction refactor (final state).

All three checks produced **zero differences**. The folder's file
listing, hierarchy, names, and byte content are identical to the Phase 0
audit's original findings throughout this entire phase.

---

## 15. Files Moved

None. No file was relocated to a different path in this phase — this
phase added logic to an existing file (`evidenceService.js`) and created
two new, small files (`electron/config/index.js`, `server/config/index.js`)
rather than moving existing files around.

## 16. Files Created

| File | Purpose |
|---|---|
| `electron/config/index.js` | `PREFERRED_PORTS` constant, moved out of `electron/main/main.js` |
| `server/config/index.js` | `SELF_HEAL_INTERVAL_MS`, `JSON_BODY_LIMIT`, `CONTENT_SECURITY_POLICY` constants, moved out of `server/app.js` |
| `PHASE_1_ARCHITECTURE_REPORT.md` | This report |
| `PHASE_1_CHANGE_MANIFEST.md` | Structured change list (see separate file) |

`PHASE_1_BASELINE.md` was created in Phase 1A, not this phase, and is
listed here only for completeness of what exists in the working copy.

## 17. Files Deleted

None. Per the brief's explicit "before deleting anything, PROVE that it is
unnecessary… if uncertain, KEEP IT" instruction, and because this phase's
scope (two narrow extractions) never required removing any file — every
line moved out of `server/routes/files.js` and `server/app.js`/
`electron/main/main.js` was moved *into* another file, not deleted.

## 18. Dependency Changes

None. `package.json` and `package-lock.json` are byte-for-byte unchanged
(confirmed via `git diff` — zero output for both files). No package was
added, removed, upgraded, or downgraded. The two new config files use
only `module.exports`/plain object literals — no new runtime dependency
was introduced by their creation.

---

## 19. Tests Executed

Run after **each** logical change (not just once at the end), per the
brief's "run relevant checks… confirm behavior… continue" instruction:

| Suite | After evidenceService extraction (commit `e9d627d`) | After config extraction (final) |
|---|---|---|
| `verify:server` | 15/15 | 15/15 |
| `verify:part2-remaining` (rename/open-file — most relevant to the biggest change) | 12/12 | 12/12 |
| `verify:part2` | 11/11 | 11/11 |
| `verify:file-support-policy` | 61/61 | 61/61 |
| `verify:completion` | 23/23 | 23/23 |
| `verify:pdf-render-order` | 4/4 | 4/4 |
| `verify:viewer` | 10/19 (unchanged failure mode) | 10/19 (unchanged failure mode) |
| **Total** | **136/145** | **136/145** |

Additionally: `node -c` syntax-checked every new/modified file; a direct
runtime `require()` check confirmed both new config modules export exactly
the expected keys/values; a direct string-equality check confirmed the new
`CONTENT_SECURITY_POLICY` constant is byte-identical to the original
inline CSP string (not just visually similar).

Full interactive Electron GUI launch was not re-attempted in this phase
for the same reason it wasn't in Phase 1A (§12 of that report — no display
server in this sandbox); nothing in this phase's changes touches anything
the headless server test suite doesn't already exercise (routing,
filesystem I/O, middleware registration order, CSP header value).

## 20. Regression Results

**Zero regressions.** Test pass counts are identical before and after
this phase's changes, matching the Phase 1A baseline exactly (136/145,
with the same 9 pre-existing, documented, out-of-scope failures in
`verify:viewer` — see §21). No test that passed before this phase now
fails, and no test that failed before now passes (the fixture-path bug
was not touched, per the "do not fix bugs discovered during refactoring"
rule).

## 21. Known Bugs Intentionally Not Fixed

Restated from Phase 0/1A, confirmed still present and untouched:

- `resources/evidence-template/` still does not exist in the repository
  (Phase 0 §5/§19 — build-breaking packaging gap).
- License gate still hard-stubbed to `true` in the renderer (Phase 0
  §17).
- No backup-restore endpoint exists (Phase 0 §18).
- `auto_backup_interval` setting change still requires an app restart to
  take effect (Phase 0 §21).
- `scripts/viewer-integration-test.js` still hardcodes the absolute path
  `/home/claude/testfiles/` (Phase 1A §11) — this is why `verify:viewer`
  still shows 10/19 rather than 19/19 in this sandbox; not a code defect
  in the application itself.
- PDF Arabic-glyph edge cases for untested real-world generators remain
  open pending real repro files (Phase 0 §11).
- PowerPoint preview remains intentionally partial-fidelity for `.pptx`
  and entirely absent for `.ppt`/`.odp` (Phase 0 §12 — documented scope
  boundary, not a bug).

None of the above were touched, fixed, or worked around in this phase.

## 22. Remaining Architectural Problems

Carried forward from Phase 0's §21/§22, with a note on what this phase did
and did not address:

- **`shell.openPath` calls living inside `server/routes/files.js`**
  (`open-folder`/`open-file` endpoints) still directly `require('electron')`
  from what is otherwise a plain Express route file. This phase considered
  extracting this into `evidenceService.js` alongside the other filesystem
  operations, but did **not**, for a concrete reason: `shell.openPath` is
  not a filesystem operation on the evidence tree, it's an OS-integration
  call (asking the OS to launch a file/folder in its default handler) —
  moving it into `evidenceService.js` would give the "evidence storage"
  module a dependency on `electron`, which it currently does not have and
  which would make it harder to exercise in the headless test harness
  (`scripts/smoke-test.js` mocks `electron` precisely so the server logic
  can run without it). This is exactly the kind of "unrelated
  Electron-API-inside-a-route" pattern Phase 0 flagged as worth revisiting
  — but the right destination for it is a small, dedicated "OS shell
  integration" module, not `evidenceService.js`, and choosing/building
  that destination is a large enough decision that it belongs in its own
  explicitly-scoped future phase rather than being folded into this one.
- **`app/js/viewer.js` (1,141 lines) and `app/index.html` (1,878 lines)
  remain large, mixed-concern files.** Confirmed unchanged in this phase,
  per §11 and the brief's explicit prohibition on touching viewer/UI code.
  Splitting `viewer.js` by format (mirroring `pdf-engine.js`'s pattern) is
  still the right future direction, per Phase 0 §22 item 4 — still not
  attempted here.
- **DOC/PPT/RTF/ODT/ODS/ODP have no in-app preview.** Unchanged, entirely
  out of scope for an architecture-only phase (Phase 0 §22 item 3 already
  scopes this as a future "Universal Evidence/File Intake" phase — which
  is explicitly the *next* phase this brief names).
- **No backup-restore path.** Unchanged, out of scope for this phase
  (Phase 0 §18/§22 item 6).

---

## 23. Recommendations for Phase 2

Per this phase's own final-stop-condition instruction, Phase 2 is named
**"UNIVERSAL EVIDENCE / FILE INTAKE ARCHITECTURE."** Based on what this
phase found and did not touch:

1. The `evidenceService.js` write functions added in this phase
   (`writeEvidenceFile`, `deleteEvidenceFile`, `renameEvidenceFile`) give
   Phase 2 a stable, already-tested seam to build new intake behavior on
   top of (e.g. a future server-side conversion step for unsupported
   formats can call `writeEvidenceFile` for its converted output exactly
   the way the upload route already does).
2. Phase 2 will likely need to touch `app/js/file-support-policy.js` and
   `app/js/viewer.js` directly (adding new preview engines) — both were
   deliberately left untouched in this phase specifically so Phase 2
   starts from the exact, fully-verified baseline this report describes.
3. The `shell.openPath`-in-routes pattern noted in §22 is worth resolving
   *before or alongside* Phase 2, since any new "convert then preview"
   flow will likely want its own OS-integration touchpoints and would
   benefit from a clean, already-decided-upon home for that kind of call
   rather than inheriting an ambiguous one.

Nothing else identified in this phase changes the phase plan the Phase 0
audit already laid out (§23 of that report).

---

## Final Success Criteria Checklist

- [x] Original repository (`/home/claude/repo`) remains untouched — commit `ba36bc9a183c94a9c0c917673c8ec1ba0a1e942e`, clean working tree, reconfirmed after every step
- [x] Working copy contains the refactored project
- [x] Architecture is materially cleaner in the two scoped areas (evidence filesystem ownership, configuration constants)
- [x] Responsibilities are clearly separated (routes vs. service; constants vs. usage sites)
- [x] Dependencies are clearer (no new cycles; config modules depend on nothing)
- [x] Filesystem responsibilities are isolated (evidenceService now owns all evidence I/O, not just reads)
- [x] Evidence responsibilities are isolated (unchanged — was already correct, reconfirmed)
- [x] Viewer responsibilities are isolated (unchanged — was already correct, reconfirmed, not touched)
- [x] IPC responsibilities are clearer (unchanged — was already correct, reconfirmed, not touched)
- [x] Licensing is isolated (unchanged — was already correct, reconfirmed, not touched)
- [x] Backup is isolated (unchanged — was already correct, reconfirmed, not touched)
- [x] UI remains behaviorally equivalent (zero renderer files touched)
- [x] Existing features remain available (all 136 previously-passing tests still pass)
- [x] Evidence structure remains unchanged (SHA-256 verified at every step)
- [x] School standards structure remains unchanged (SHA-256 verified at every step)
- [x] Known bugs remain documented and unfixed (§21)
- [x] No unnecessary dependency changes occurred (package.json/package-lock.json byte-identical)
- [x] Tests pass or baseline failures are documented (136/145, 9 documented pre-existing failures)
- [x] Build/run verification succeeds (see §19; full GUI launch not re-attempted, same documented sandbox limitation as Phase 1A)
- [x] Clean ZIP is created — see `PHASE_1_CHANGE_MANIFEST.md` and the final report-out message for the verified path
- [x] ZIP excludes unnecessary generated content
- [x] ZIP contains all required source/project files
- [x] ZIP contains no secrets
- [x] ZIP extraction test succeeds
- [x] `PHASE_1_ARCHITECTURE_REPORT.md` exists (this file)
- [x] `PHASE_1_CHANGE_MANIFEST.md` exists (companion file)
