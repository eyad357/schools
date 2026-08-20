'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const log = require('../../electron/utils/logger');

const MANIFEST = require('../data/evidence-manifest.json'); // code -> { relPath, domainId, standardId, priv, text }
const TREE = require('../data/evidence-tree.json');

const CODES = Object.keys(MANIFEST);
const CODE_IN_FOLDER_NAME = /\((\d+-\d+-\d+-\d+)\)/; // e.g. "مؤشر (1-2-1-1) تعزز المدرسة ..."

// Single source of truth for "what kind of file is this" — see
// FILE-SUPPORT-ARCHITECTURE-REPORT.md. This used to be a locally
// hand-maintained CATEGORY_BY_EXT map that had drifted out of sync with
// the frontend's own copy; both now read the same table.
const FileSupportPolicy = require('../../app/js/file-support-policy.js');

function categoryForExt(ext) {
  return FileSupportPolicy.getCategory(ext);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(val >= 10 ? 0 : 1)} ${units[i]}`;
}

/** All 52 indicator codes, or only the 49 non-private ones for government schools. */
function applicableCodes(schoolType) {
  if (schoolType === 'gov') return CODES.filter((c) => !MANIFEST[c].priv);
  return CODES.slice();
}

function folderForCode(evidenceRoot, code) {
  const entry = MANIFEST[code];
  if (!entry) return null;
  return path.join(evidenceRoot, ...entry.relPath.split('/'));
}

/**
 * Given an absolute file path somewhere under the evidence root, walk up
 * the directory chain until a segment's folder name contains a known
 * indicator code in parentheses, e.g. "مؤشر (1-2-1-1) تعزز المدرسة ...".
 * This keeps file detection working even if a user creates subfolders
 * inside an indicator folder, or the watcher fires on a nested path.
 */
function codeFromPath(evidenceRoot, filePath) {
  let dir = path.dirname(path.resolve(filePath));
  const root = path.resolve(evidenceRoot);
  let guard = 0;
  while (dir.startsWith(root) && dir !== path.dirname(root) && guard < 20) {
    const base = path.basename(dir);
    const match = base.match(CODE_IN_FOLDER_NAME);
    if (match && MANIFEST[match[1]]) return match[1];
    if (dir === root) break;
    dir = path.dirname(dir);
    guard++;
  }
  return null;
}

/** Create every indicator folder that doesn't already exist. Never deletes or touches existing content. */
async function ensureAllFolders(evidenceRoot) {
  await fsp.mkdir(evidenceRoot, { recursive: true });
  for (const code of CODES) {
    const dir = folderForCode(evidenceRoot, code);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (err) {
      log.warn(`Could not create indicator folder for ${code}:`, err.message);
    }
  }
}

/** Copy the bundled template (if any files ship with the installer) without overwriting existing files. */
async function seedFromTemplate(templateRoot, evidenceRoot) {
  if (!fs.existsSync(templateRoot)) return;
  await copyMerge(templateRoot, evidenceRoot);
}

async function copyMerge(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyMerge(s, d);
    } else if (!fs.existsSync(d)) {
      await fsp.copyFile(s, d);
    }
  }
}

async function folderExists(dir) {
  try {
    const st = await fsp.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function listFiles(evidenceRoot, code) {
  const dir = folderForCode(evidenceRoot, code);
  if (!dir) return { folderExists: false, files: [] };
  const exists = await folderExists(dir);
  if (!exists) return { folderExists: false, files: [] };

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue; // ignore stray subfolders at this level
    const full = path.join(dir, entry.name);
    try {
      const st = await fsp.stat(full);
      const ext = path.extname(entry.name);
      files.push({
        name: entry.name,
        ext,
        category: categoryForExt(ext),
        size: formatSize(st.size),
        bytes: st.size,
        modified: st.mtime.toISOString(),
        created: st.birthtime.toISOString(),
        path: full,
      });
    } catch (err) {
      log.warn(`Skipping unreadable file ${full}:`, err.message);
    }
  }
  files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  return { folderExists: true, files };
}

async function getFilePath(evidenceRoot, code, name) {
  const dir = folderForCode(evidenceRoot, code);
  if (!dir) return null;
  const safeName = path.basename(name); // prevent path traversal
  const full = path.join(dir, safeName);
  if (!full.startsWith(path.resolve(dir))) return null;
  return full;
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Given a desired filename inside `dir`, returns a filename guaranteed not
 * to already exist in that directory — the original name if it's free,
 * otherwise "name (1).ext", "name (2).ext", etc. (the same disambiguation
 * pattern Windows Explorer itself uses for copy conflicts, so the result
 * looks familiar rather than invented). Never overwrites; see Phase 3's
 * "Duplicate Handling" — silently overwriting an existing evidence file
 * on re-upload was a real, undocumented gap this replaces.
 */
function generateNonConflictingName(dir, filename) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const extPart = dot > 0 ? filename.slice(dot) : '';
  let candidate = filename;
  let n = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${n})${extPart}`;
    n++;
  }
  return candidate;
}

/**
 * Writes an uploaded file's bytes into an indicator's folder, creating the
 * folder if it doesn't exist yet. `dir` must already be a resolved,
 * trusted indicator folder path (callers resolve it via folderForCode()
 * first, since an unknown indicator is a distinct 400-vs-500 case the
 * caller needs to handle before ever reaching this function). `filename`
 * must already be sanitized (path.basename()'d and FileSupportPolicy-
 * validated) by the caller — this function does not re-validate filename
 * safety, but it does own three things the caller does not:
 *
 *   1. Duplicate-safe naming — never silently overwrites an existing file
 *      with the same name (see generateNonConflictingName above).
 *   2. Atomic storage — writes to a hidden temp file in the SAME
 *      directory (so the final rename is same-filesystem and therefore
 *      atomic on both POSIX and Windows), then renames it into place.
 *      Any failure during the write leaves no partially-written file
 *      under a real evidence filename — either the temp file is cleaned
 *      up, or (if even that fails) it's left with its own hidden
 *      ".uploading-*" name, never the name real evidence would use, so it
 *      can never be mistaken for a successfully-stored file.
 *   3. Checksum — returns the SHA-256 of the bytes actually written, ideal
 *      for later corruption/duplicate-content detection (Phase 3
 *      "Checksum / Integrity"), computed from the same in-memory buffer
 *      that gets written, not re-read from disk afterward.
 *
 * Throws on any filesystem failure; callers are expected to catch and
 * translate that into their own error response, exactly as before this
 * function existed.
 */
function writeEvidenceFile(dir, filename, body) {
  fs.mkdirSync(dir, { recursive: true });
  const finalName = generateNonConflictingName(dir, filename);
  const destPath = path.join(dir, finalName);
  const tempPath = path.join(dir, `.${finalName}.uploading-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const sha256 = sha256Buffer(body);
  try {
    fs.writeFileSync(tempPath, body);
    const written = fs.statSync(tempPath);
    if (written.size !== body.length) {
      throw new Error(`incomplete write: expected ${body.length} bytes, wrote ${written.size}`);
    }
    fs.renameSync(tempPath, destPath); // atomic on the same filesystem (POSIX rename(2) / Windows MoveFileEx)
  } catch (err) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) { /* best-effort cleanup only */ }
    throw err;
  }

  return { destPath, filename: finalName, size: body.length, sha256 };
}

/**
 * Deletes a named file from an indicator's folder. Returns a small result
 * object rather than throwing/booleaning, so callers (HTTP routes, or any
 * future non-HTTP caller) can map the outcome to their own response shape
 * without duplicating the existence check evidenceService already owns.
 *
 * Explicitly refuses to target anything that isn't a regular file (see
 * PHASE_2_REPORT.md "Read-Only Contract"): a crafted name of "." resolves
 * to the indicator folder itself, which — without this check — would
 * reach fs.unlinkSync() and throw an uncaught EISDIR instead of being
 * rejected as a normal, handled "not found"-shaped error. This function
 * never mutates a directory, structural or otherwise.
 */
async function deleteEvidenceFile(evidenceRoot, code, name) {
  const filePath = await getFilePath(evidenceRoot, code, name);
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: 'NOT_FOUND' };
  if (!fs.lstatSync(filePath).isFile()) return { ok: false, reason: 'NOT_A_FILE' };
  fs.unlinkSync(filePath);
  return { ok: true };
}

/**
 * Renames a file within an indicator's folder. Owns the full safety
 * contract that previously lived inline in the route handler: filename
 * sanitization (path.basename), a reserved/invalid-name check, a
 * disallowed-character check, path-containment validation (defense in
 * depth against path traversal even though basename() already prevents
 * it), a same-name/case-only no-op short-circuit, and a duplicate-target
 * check — all as distinct, named result reasons so the HTTP layer can
 * keep mapping each one to the exact status code/message it already used.
 *
 * Explicitly refuses to target anything that isn't a regular file (see
 * PHASE_2_REPORT.md "Read-Only Contract"): a crafted oldName of "."
 * resolves to the indicator folder itself, which — without this check —
 * could reach fs.renameSync() with the indicator's own directory as the
 * source. On this codebase's directory layout that specific attempt
 * always fails at the OS level too (the destination is necessarily
 * nested inside the source, which every OS rejects), but this function
 * rejects it explicitly and up front rather than relying on that as an
 * accidental side effect of the folder layout. This function never
 * mutates a directory, structural or otherwise.
 *
 * This function performs the actual fs.renameSync itself, so a caller
 * never needs to touch `fs` directly to rename evidence. It does not log
 * or persist anything — audit-trail logging is an application/HTTP-layer
 * concern (it depends on `store`, which evidenceService intentionally has
 * no dependency on) and stays the caller's responsibility, same as it
 * already was for uploads and deletes.
 */
function renameEvidenceFile(evidenceRoot, code, oldName, newName) {
  const dir = folderForCode(evidenceRoot, code);
  if (!dir) return { ok: false, reason: 'UNKNOWN_INDICATOR' };

  const safeOld = path.basename(oldName);
  const safeNew = path.basename(newName).trim();
  const nameCheck = FileSupportPolicy.validateFilename(safeNew);
  if (!nameCheck.ok) {
    return { ok: false, reason: nameCheck.reason };
  }

  const oldPath = path.join(dir, safeOld);
  const newPath = path.join(dir, safeNew);
  if (!oldPath.startsWith(path.resolve(dir)) || !newPath.startsWith(path.resolve(dir))) {
    return { ok: false, reason: 'INVALID_PATH' };
  }
  if (!fs.existsSync(oldPath)) return { ok: false, reason: 'SOURCE_NOT_FOUND' };
  if (!fs.lstatSync(oldPath).isFile()) return { ok: false, reason: 'NOT_A_FILE' };
  if (safeOld.toLowerCase() === safeNew.toLowerCase()) {
    return { ok: true, noop: true, filename: safeNew }; // e.g. case-only rename on a case-insensitive FS
  }
  if (fs.existsSync(newPath)) {
    return { ok: false, reason: 'DUPLICATE', filename: safeNew };
  }

  fs.renameSync(oldPath, newPath);
  return { ok: true, filename: safeNew, oldName: safeOld };
}

async function integrityCheck(evidenceRoot, schoolType) {
  const issues = [];
  const missingFolders = [];

  const rootOk = await folderExists(evidenceRoot);
  if (!rootOk) {
    issues.push({ message: 'مجلد الشواهد الرئيسي غير موجود، سيتم إنشاؤه تلقائيًا.' });
    return { issues, missingFolders };
  }

  for (const code of applicableCodes(schoolType)) {
    const dir = folderForCode(evidenceRoot, code);
    if (!(await folderExists(dir))) missingFolders.push(code);
  }
  return { issues, missingFolders };
}

async function stats(evidenceRoot, schoolType) {
  const codes = applicableCodes(schoolType);
  let indicatorsWithFiles = 0;
  let totalFiles = 0;
  const recent = [];

  for (const code of codes) {
    const { files } = await listFiles(evidenceRoot, code);
    if (files.length > 0) indicatorsWithFiles++;
    totalFiles += files.length;
    for (const f of files) recent.push({ code, name: f.name, modified: f.modified });
  }

  recent.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  const completionPct = codes.length ? Math.round((indicatorsWithFiles / codes.length) * 100) : 0;

  return {
    indicatorsWithFiles,
    totalFiles,
    completionPct,
    recentFiles: recent.slice(0, 10),
  };
}

function indicatorMap(evidenceRoot) {
  // { code: true } for every indicator whose folder currently exists — mirrors what
  // the frontend expects from GET /api/structure (indicatorMap / total).
  const map = {};
  let total = 0;
  for (const code of CODES) {
    const dir = folderForCode(evidenceRoot, code);
    if (fs.existsSync(dir)) {
      map[code] = true;
      total++;
    }
  }
  return { map, total };
}

module.exports = {
  MANIFEST,
  TREE,
  CODES,
  applicableCodes,
  folderForCode,
  codeFromPath,
  ensureAllFolders,
  seedFromTemplate,
  folderExists,
  listFiles,
  getFilePath,
  writeEvidenceFile,
  deleteEvidenceFile,
  renameEvidenceFile,
  generateNonConflictingName,
  integrityCheck,
  stats,
  indicatorMap,
  formatSize,
  categoryForExt,
};
