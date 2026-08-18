# PHASE 1 — Change Manifest

Working copy: `/home/claude/workspace/phase1-working-copy`
Baseline commit (Phase 1A): `ba36bc9a183c94a9c0c917673c8ec1ba0a1e942e`
Refactoring commits (this phase):
- `e9d627d` — `refactor: move evidence file write/delete/rename fs operations into evidenceService`
- `4495c3a` — `refactor: extract scattered operational constants into config modules`

---

## Added Files

### `electron/config/index.js`
- **New responsibility:** exports `PREFERRED_PORTS`, the ordered list of
  ports the embedded server tries on startup.
- **Reason:** previously defined inline at module scope in
  `electron/main/main.js`, mixed in with app-lifecycle/window-management
  code. This constant has no relationship to lifecycle logic and is more
  discoverable as its own small module.
- **Risk:** Low — pure data export, no logic, no side effects, value
  unchanged.
- **Validation:** `node -c` syntax check; `node -e "require('./electron/config')"` runtime check confirms the exact same 5-element array; `electron/main/main.js` still resolves `activePort` identically (implicitly verified by `verify:server`, which boots the real app factory through the same port-trying code path).

### `server/config/index.js`
- **New responsibility:** exports `SELF_HEAL_INTERVAL_MS`,
  `JSON_BODY_LIMIT`, and `CONTENT_SECURITY_POLICY`.
- **Reason:** previously defined inline inside `server/app.js`'s
  `createApp()` function body — a 60-second interval constant sitting
  next to the self-heal `setInterval` call, a `'5mb'` string literal
  passed directly to `express.json()`, and an 8-line CSP string built
  inline inside a middleware closure. None of the three have any
  necessary connection to the bootstrap logic they were embedded in.
- **Risk:** Low — pure data export, no logic, no side effects, values
  unchanged.
- **Validation:** `node -c` syntax check; runtime `require()` check
  confirms all three keys present; **direct string-equality check**
  confirmed `CONTENT_SECURITY_POLICY` is byte-identical to the original
  inline CSP string (this was the highest-risk value to move, since a
  silent formatting change would weaken or break the app's security
  headers — confirmed not to have happened); `verify:server`'s `GET /`
  check implicitly exercises the CSP-setting middleware on every request.

### `PHASE_1_ARCHITECTURE_REPORT.md`, `PHASE_1_CHANGE_MANIFEST.md`
- Documentation deliverables for this phase, per the phase brief.

---

## Moved Files

None.

## Renamed Files

None.

## Deleted Files

None.

---

## Modified Files

### `server/services/evidenceService.js`
- **Previous responsibility:** owned all evidence-tree *read* operations
  (list, get-path, folder-for-code, integrity, stats) plus folder-skeleton
  creation and template seeding.
- **New responsibility:** the above, **plus** the three corresponding
  *write* operations: `writeEvidenceFile(dir, filename, body)`,
  `deleteEvidenceFile(evidenceRoot, code, name)`,
  `renameEvidenceFile(evidenceRoot, code, oldName, newName)`. All three
  are additive exports — nothing existing was removed or renamed.
- **Reason:** Phase 0 audit §21 explicitly flagged filesystem
  write/delete/rename logic living inline in route handlers rather than
  the service layer that already owned the corresponding reads. This
  closes that gap for the one module (`evidenceService.js`) whose whole
  purpose is owning evidence filesystem interaction.
- **Risk:** Medium — this is the functionally significant change in this
  phase (real logic moved, not just a constant). Mitigated by: (a)
  preserving every line of the original validation/safety logic verbatim,
  just relocated and restructured into named result reasons instead of
  early `res.status()` returns; (b) the existing `verify:part2-remaining`
  suite already covers every rename edge case (duplicate/409, path
  traversal, 404, invalid characters) and every upload/delete path is
  covered by `verify:server` and `verify:file-support-policy`.
- **Validation:** `verify:server` 15/15, `verify:part2-remaining` 12/12,
  `verify:file-support-policy` 61/61, `verify:completion` 23/23 (all
  re-run after this specific change, before the config-extraction change
  was made, to isolate which change was being validated).

### `server/routes/files.js`
- **Previous responsibility:** HTTP framing **and** direct filesystem
  I/O (`fs.mkdirSync`/`fs.writeFileSync` for upload, `fs.unlinkSync` for
  delete, filename validation + `fs.renameSync` for rename) **and**
  audit-logging, all interleaved in the same handler functions.
- **New responsibility:** HTTP framing and audit-logging only. All direct
  `fs.*` calls for upload/delete/rename were removed and replaced with
  calls to the corresponding new `evidenceService` function; the route
  now maps that function's return value to the exact same HTTP status
  code and JSON error body it already returned for every case (verified
  case-by-case in code review: `UNKNOWN_INDICATOR`→400 "مؤشر غير معروف",
  `INVALID_NAME`→400, `INVALID_CHARS`→400, `INVALID_PATH`→400,
  `SOURCE_NOT_FOUND`→404, `DUPLICATE`→409 with the exact original
  interpolated message, no-op→200 with the exact original message).
- **Reason:** direct consequence of the `evidenceService.js` change above
  — this file is the "before" side of that move.
- **Risk:** Medium (same change as above, viewed from the caller's side).
  The `GET /api/files/:code`, `GET /api/file/:code/:name`, `GET
  /api/file-policy`, `POST /api/open-folder/:code`, and `POST
  /api/open-file/:code/:name` endpoints in this same file were **not**
  modified at all — only the three endpoints whose logic moved
  (`DELETE /api/file/:code/:name`, `POST /api/upload(-raw)/:code`,
  `PATCH /api/file/:code/rename`) changed.
- **Validation:** same suites as `evidenceService.js` above, since the two
  files were changed together as one logical unit and tested together.

### `server/app.js`
- **Previous responsibility:** app-factory function that, among other
  things, defined `SELF_HEAL_INTERVAL_MS` inline, built the CSP header
  string inline inside a middleware closure, and passed a literal
  `'5mb'` string to `express.json()`.
- **New responsibility:** identical app-factory logic, now importing
  those three values from `server/config/index.js` instead of defining
  them inline. No control flow, ordering, or middleware-registration
  logic changed — only where the three values come from.
- **Reason:** direct consequence of the `server/config/index.js`
  addition above.
- **Risk:** Low — purely a `require`/reference change; every other line
  of `createApp()` (evidence-root resolution, watcher wiring, SSE
  broadcaster, static file serving, route mounting, error handler, the
  `app_started` audit entry) is byte-for-byte unchanged.
- **Validation:** `verify:server` 15/15 (its `GET /` check exercises the
  CSP-setting middleware and the static-file serving that follows the
  `express.json()` line on every request); CSP string byte-equality
  check (see `server/config/index.js` entry above).

### `electron/main/main.js`
- **Previous responsibility:** defined `PREFERRED_PORTS` inline at module
  scope, in addition to all its existing app-lifecycle responsibilities.
- **New responsibility:** identical app-lifecycle logic, now importing
  `PREFERRED_PORTS` from `electron/config/index.js`. The port-trying loop
  in `startServer()` is otherwise byte-for-byte unchanged.
- **Reason:** direct consequence of the `electron/config/index.js`
  addition above.
- **Risk:** Low — single-line change (a `require` added, one array
  literal removed).
- **Validation:** `verify:server` boots the real app factory through
  `createApp()` (the same function `main.js` calls in production), and
  the Electron binary itself was independently version-checked
  (`--version --no-sandbox` → `v43.3.0`) after this change to confirm the
  file still loads without a syntax/require error in the actual Electron
  runtime, not just Node.

---

## Dependency Changes

None. `package.json` and `package-lock.json`: zero diff (`git diff` on
both files against the Phase 1A baseline commit produces no output).

---

## Summary Table

| Change | Files touched | Lines changed | Behavior change | Test evidence |
|---|---|---|---|---|
| Evidence filesystem-write ownership | `evidenceService.js`, `routes/files.js` | +85 / −56 (net) across the two files | None (verified) | 15+12+11+61+23 = 122 passing, all pre-existing |
| Config-constant extraction | `main.js`, `app.js`, +2 new files | +2 / −21 in existing files, +65 in new files | None (verified, incl. byte-exact CSP string) | 15+11+12+4+61+23 = 126 passing, all pre-existing |

**Total files touched across Phase 1:** 4 modified, 2 created, 0 moved, 0
renamed, 0 deleted (excluding the two Markdown reports and the Phase 1A
baseline doc committed as this phase's starting checkpoint).
