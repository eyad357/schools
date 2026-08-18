# PHASE 1A — Safe Working Copy & Refactoring Baseline

Status: **SAFE WORKING COPY READY**

This document records the exact state the working copy was created from, what
was and wasn't copied, dependency-reproduction results, and baseline
verification results. No architectural refactoring, bug fixes, or redesign
were performed in this phase.

---

## 1. Original Git Commit

- **Repository:** `https://github.com/eyad357/-.git`
- **Branch:** `main`
- **Commit:** `ba36bc9a183c94a9c0c917673c8ec1ba0a1e942e`
- **Commit summary:** "Merge pull request #5 from eyad357/file-support-policy-v1" (2026-08-12 13:07:37 +0300)
- Confirmed identical to `origin/main` (`git status`: "up to date with 'origin/main'").

## 2. Original Branch

`main` — no other local or remote branches exist in the clone.

## 3. Original Working-Tree Status

Clean. `git status --short` produced no output — no uncommitted, staged, or
untracked changes existed in the original baseline clone before this phase
began. There were no user changes to document or preserve, per §1 of the
Phase 1A brief.

## 4. Working-Copy Location

```
/home/claude/workspace/phase1-working-copy
```

Created via `cp -a` (archive copy, preserves permissions/timestamps and the
full `.git` directory) from the original clone at `/home/claude/repo`, which
remains untouched and independently recoverable at the same commit hash
(re-verified after all steps below — see §13).

The working copy was verified byte-identical to the original immediately
after creation via `diff -rq` (no differences reported) and a `sha256sum`
comparison of every file inside the standards folder specifically (§10).

## 5. Package Manager

**npm**, version 10.9.7 (host), Node.js v22.22.2 (host) — satisfies the
project's declared `"engines": { "node": ">=22.13.0" }` constraint.

Determined from: `package-lock.json` present at the repo root; no
`yarn.lock` or `pnpm-lock.yaml` present. `npm ci` was used specifically
because it installs exactly what the lockfile specifies without touching
`package.json`/`package-lock.json` — appropriate for a reproducibility
baseline where no dependency versions may change.

## 6. Dependency Installation Result

**Success.** `npm ci` in the working copy:

- Installed 442 packages, audited 443, **0 vulnerabilities found**.
- Ran the project's own `postinstall` (`electron-builder install-app-deps`),
  which completed successfully (`@electron/rebuild` against Electron
  43.3.0/x64 — no native modules required rebuilding, consistent with the
  Phase 0 finding that this project has zero native/compiled dependencies).
- `package.json` and `package-lock.json` are **byte-identical** to the
  original after install (`git status --short` in the working copy shows no
  diff on either file — only the gitignored `node_modules/` directory
  appeared, which is expected and excluded from the repo by `.gitignore`).
- No dependency version was changed, upgraded, or downgraded at any point.

One environment-specific step required manual intervention and is recorded
here for transparency: the `electron` npm package's own binary-download step
(`node_modules/electron/install.js`, which fetches the actual Electron
runtime from GitHub release assets) did not run automatically as part of
`npm ci` in this sandbox. Running it explicitly (`node
node_modules/electron/install.js`) completed successfully and produced a
working `node_modules/electron/dist/electron` binary — this is standard,
official Electron-package behavior, not a modification of any project file,
and required no version change or workaround.

## 7. Build/Run Result

**Electron binary:** confirmed working — `electron --version --no-sandbox`
reports `v43.3.0`, exactly matching the pinned `devDependencies.electron`
version in `package.json`. (`--no-sandbox` was required only because this
container runs as root, which Chromium's sandbox refuses by design
regardless of project configuration — not a project bug. A real desktop
install, running as a normal user, does not hit this. The project's own
`electron/security/security.js` sandbox settings were not altered or
bypassed by this flag; it only affects how the *host* Electron process
itself launches in this root container.)

**Full GUI launch (`npm run dev` / `npm start`):** not attempted — this
sandbox has no display server, matching the same constraint the project's
own prior-pass reports (§ PDF-RENDER-CORRUPTION-FIX-REPORT.md) already
documented ("This sandbox has no display... Windows/macOS packaged builds
were not produced or tested here"). A real interactive launch requires a
Windows/macOS/Linux machine with a display, or Xvfb + CDP as those prior
passes used.

**Embedded server layer (the part that *can* be verified headlessly, per
the project's own documented approach in `README.md` §"Verifying the server
logic without a display"):** run via `npm run verify:server`, which mocks
the `electron` module and drives the real Express app with real HTTP
requests, including a live filesystem-watcher check.

```
=== SMOKE TEST RESULTS ===
✅ GET /api/school — OK
✅ POST /api/school (setup) — OK
✅ GET /api/structure — OK
✅ GET /api/integrity (should be clean after bootstrap) — OK
✅ GET /api/stats (empty) — OK
✅ POST /api/upload/:code + GET /api/files/:code — OK
✅ GET /api/stats (after upload, should be 1 file) — OK
✅ DELETE /api/file/:code/:name — OK
✅ GET /api/license/status (not activated) — OK
✅ POST /api/license/activate (valid key roundtrip) — OK
✅ POST /api/settings + GET /api/settings — OK
✅ GET /api/audit (has entries) — OK
✅ POST /api/backup + GET /api/backups — OK
✅ GET / serves the SPA — OK
✅ Real-time watcher: manually dropped file is detected without any upload API call — OK

15/15 passed
```

This test runs against a throwaway `SCHOOL_APP_TEST_INSTALL_DIR` (a temp
folder), the escape hatch documented in `electron/utils/paths.js` —
confirmed it never touches the real evidence folder at the repo root (§10).

All other project-provided verification scripts were also run for a full
baseline picture:

| Script | Result | Notes |
|---|---|---|
| `verify:server` | **15/15 passed** | See above |
| `verify:viewer` | **10/19 passed** — 9 failures | **Environment fixture gap, not a code bug** — see §11 |
| `verify:part2` | **11/11 passed** | |
| `verify:pdf-render-order` | **4/4 passed** | Confirms the render-order regression guard from the prior PDF pass is intact |
| `verify:file-support-policy` | **61/61 passed** | |
| `verify:part2-remaining` (rename/open-file) | **12/12 passed** | |
| `verify:completion` (progress/completion engine) | **23/23 passed** | |

**Totals: 136/145 passing** across the automated suites in this
environment; the 9 non-passing cases are a documented, non-code fixture
issue (§11), not a functional regression.

## 8. Important Project Directories

(Restated from the Phase 0 inventory, confirmed unchanged in the working copy.)

```
electron/     — Electron main process, preload, IPC, security, path/logging/backup utils
server/       — embedded Express backend (routes, services, store, generated evidence-manifest/tree data)
app/          — renderer (index.html + css/js, including vendor libs and the FileSupportPolicy/PDFEngine modules)
splash/       — splash screen shown while the embedded server boots
build/        — installer icons + build/installer.nsh (custom NSIS step)
scripts/      — hand-rolled verification scripts + generate-license.js vendor CLI
معايير التقويم والاعتماد المدرسي/  — the (partial, dev-only) real evidence tree at repo root — immutable, see §10
```

## 9. Generated Directories Excluded From the Working Copy

None were present to exclude at copy time — the original repository
contained **no** `node_modules/`, `dist/`, `release/`, build output, caches,
logs, OS metadata, editor metadata, coverage output, or other generated
content (confirmed: `.gitignore` only lists `node_modules/` and `release/`,
and neither existed in the source clone). The working copy was created as a
full, unmodified `cp -a` of the entire original clone (including `.git`)
for maximum recoverability, and `node_modules/` was subsequently generated
*inside the working copy only*, via `npm ci` (§6) — never copied from
anywhere, and never present in the original clone at `/home/claude/repo`,
which remains exactly as it was.

## 10. School Standards Folder Verification

**Folder:** `معايير التقويم والاعتماد المدرسي` (immutable, per Phase 0 §5 and
this phase's brief).

- **File listing:** identical between original and working copy (`diff` of
  sorted `find` output — no differences).
- **Content integrity:** identical between original and working copy,
  verified via `sha256sum` of every file in the tree, before *and* after
  running `npm ci` and all seven verification scripts — no difference at
  either checkpoint.
- **Structure/hierarchy/naming:** untouched — same single-domain, single-
  indicator partial tree documented in the Phase 0 audit (Domain 1 →
  "معيار التخطيط" → "مؤشر (1-1-1-1) ..." → 7 real sample files: 4 PDF, 1
  DOCX, 1 CSV, 1 PPSX).
- **Relationship with the application:** unchanged — still resolved
  exclusively through `electron/utils/paths.js#EVIDENCE_FOLDER_NAME` /
  `getDefaultEvidenceRoot()`, which was not modified.
- The known **packaging gap** already documented in the Phase 0 report
  (`resources/evidence-template/` does not exist anywhere in the
  repository) is confirmed still present, unchanged, in the working copy —
  this phase did not attempt to create, populate, or otherwise touch that
  path, per the "do not modify school standards structure" instruction.

**Verdict: the school standards folder is confirmed unchanged.**

## 11. Known Bugs (discovered or re-confirmed during this phase's verification — none fixed)

- **`scripts/viewer-integration-test.js` hardcodes an absolute host path,
  `/home/claude/testfiles/`, as the source of its sample PDF/DOCX/XLSX/CSV/
  PPTX/TXT/JPG fixture files** (line 100: `path.join('/home/claude/testfiles',
  name)`). That directory does not exist in this sandbox, so the 9
  "round-trip" sub-tests that copy a sample file in and verify it round-
  trips through the API all fail with `ENOENT`, and the one "GET
  /api/files/:code lists new files" assertion that depends on those copies
  having succeeded fails as a consequence. This is a **portability defect in
  the test script itself** (a machine-specific absolute path baked into a
  script that's meant to be runnable in any environment, including CI) —
  it is not evidence of any problem in `viewer.js`, the API routes, or the
  file-support policy, all of which are independently exercised and passing
  in the other six suites (including `verify:file-support-policy`'s 61
  tests, which cover magic-byte validation, upload rejection, and category
  classification using files generated in-memory rather than copied from a
  fixed path). **Not fixed in this phase**, per the "do not fix bugs
  discovered during verification" instruction — flagged here as a known
  baseline issue for whichever future phase touches the test tooling.
- All PDF-rendering, PowerPoint-rendering, licensing, and backup-restore
  baseline issues already documented in the Phase 0 report (see that
  report's §11, §12, §17, §18, §21, §25) remain exactly as documented —
  nothing new was discovered in those areas during this phase, and nothing
  was touched.

## 12. Known Limitations

- This sandbox has no display server — full interactive Electron GUI launch
  (`npm run dev`) could not be attempted or verified here, only (a) the
  Electron binary's own `--version` check, and (b) the embedded server
  layer via the project's own headless test harness. This mirrors the exact
  limitation already disclosed in the project's own prior-pass reports.
- The `electron` npm package's binary-download step required one manual,
  standard invocation (§6) rather than completing automatically inside
  `npm ci` in this particular sandboxed network environment — worth
  knowing if a future clean-machine build ever behaves the same way,
  though this is an environment quirk, not a project configuration defect
  (the correct, official Electron binary for the exact pinned version
  downloaded and ran correctly once invoked).
- `npm run build` / `npm run pack` (the actual Windows-installer packaging
  step) were **not** attempted in this phase — Phase 0 already identified
  the `resources/evidence-template/` packaging gap that would make a real
  `npm run build` fail before producing an installer (see Phase 0 §5/§19);
  re-confirming that failure mode was out of scope for this
  dependency/baseline-verification phase and is deferred to whichever
  phase addresses that gap.

## 13. Baseline Verification Results

| Check | Result |
|---|---|
| Original repo (`/home/claude/repo`) commit hash unchanged after this phase | ✅ `ba36bc9a183c94a9c0c917673c8ec1ba0a1e942e` |
| Original repo working-tree status after this phase | ✅ clean (`git status --short` empty) |
| Working copy created, byte-identical to original at copy time | ✅ (`diff -rq`, no output) |
| Dependencies installed via `npm ci` (no manifest/lockfile drift) | ✅ 442 packages, 0 vulnerabilities |
| Electron binary matches pinned version | ✅ `v43.3.0` |
| Embedded server boots and serves the full real API surface headlessly | ✅ 15/15 (`verify:server`) |
| Real-time file watcher (Explorer-drop detection) functions in the working copy | ✅ (covered by `verify:server`'s watcher check) |
| Existing navigation / evidence structure reachable via the API | ✅ (`GET /api/structure`, `GET /api/school`, `GET /api/integrity` all pass) |
| Existing evidence accessible | ✅ (upload/list/delete round-trip passes in `verify:server`; full round-trip coverage for other formats blocked only by the missing `/home/claude/testfiles/` fixtures, §11) |
| School standards folder unchanged (listing + content hash) | ✅ identical before and after all installs/tests |
| Working copy's own git status after all steps | ✅ clean except the (gitignored, expected) `node_modules/` |
| No dependency version changed | ✅ confirmed via unchanged `package.json`/`package-lock.json` |
| No bug fixed during this phase | ✅ the one bug found (§11) was documented, not touched |

---

## Working-Copy Size Summary

| Path | Size |
|---|---|
| `/home/claude/repo` (original, untouched) | 35 MB |
| `/home/claude/workspace/phase1-working-copy` (working copy, incl. `.git` + `node_modules`) | 468 MB |
| — of which `node_modules/` | ~121 MB |
| — of which the Electron runtime binary itself | ~271 MB (`node_modules/electron/dist/`) |

---

## SAFE WORKING COPY READY

- **Baseline commit:** `ba36bc9a183c94a9c0c917673c8ec1ba0a1e942e` on `main`, clean working tree.
- **Working-copy status:** `/home/claude/workspace/phase1-working-copy` — clean git status, dependencies installed via `npm ci` with zero manifest drift, Electron 43.3.0 binary present and version-verified.
- **Verification results:** embedded server layer 15/15; five other automated suites fully passing (11/11, 4/4, 61/61, 12/12, 23/23); one suite (viewer round-trip) partially blocked by a pre-existing, now-documented, unfixed test-script portability bug (missing external fixture directory), not a functional regression.
- **Excluded generated directories:** none existed to exclude at copy time; `node_modules/` was generated fresh inside the working copy only, per the project's own `.gitignore`.
- **School standards structure:** confirmed byte-for-byte unchanged (file listing + SHA-256 content hashes identical before and after all install/verification steps).

Awaiting explicit approval to begin **PHASE 1 — ARCHITECTURE REFACTORING**.
