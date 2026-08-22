'use strict';

/**
 * StandardsService — the single, explicitly-named place the application
 * goes to answer questions about the IMMUTABLE school standards structure
 * ("معايير التقويم والاعتماد المدرسي"): where it lives, what its hierarchy
 * looks like, whether it's intact, and whether it has changed since a
 * known-good point in time.
 *
 * This is deliberately a thin facade, not a second path-resolution
 * mechanism:
 *   - The actual root path is still resolved exactly one way, by
 *     electron/utils/paths.js (getDefaultEvidenceRoot / EVIDENCE_FOLDER_NAME)
 *     and server/app.js#resolveEvidenceRoot() (which layers the optional
 *     user-configured override on top). This module does not duplicate
 *     that logic — resolveRoot() below is an identity/documentation
 *     function, not a second resolver.
 *   - The folder hierarchy itself is still defined exactly one way, by
 *     server/data/evidence-manifest.json / evidence-tree.json, already
 *     loaded once by evidenceService.js. This module reads that same data
 *     (via evidenceService's exports) rather than loading it again.
 *
 * What this module adds that didn't exist before Phase 2:
 *   - computeIntegrityManifest() / compareIntegrityManifest(): a
 *     deterministic, SHA-256-based snapshot of the standards directory's
 *     actual on-disk contents, and a diff against a prior snapshot. This
 *     is what proves — not just asserts — that the immutable structure
 *     hasn't changed, both for this phase's own before/after verification
 *     and for any future regression check that wants the same guarantee.
 *   - getStructureSummary(): a read-only, renderer-safe description of
 *     the domain/standard/indicator hierarchy (names and codes only, no
 *     filesystem paths), for anything that wants to describe the
 *     structure without needing evidenceService's lower-level exports.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../../electron/utils/paths');
const evidenceService = require('./evidenceService');

/** The one, canonical name of the immutable standards folder. Never redefine this elsewhere. */
function getFolderName() {
  return paths.EVIDENCE_FOLDER_NAME;
}

/**
 * The standards root IS the evidence root — this app has always used one
 * directory for both concepts (the immutable folder hierarchy AND the
 * school-specific evidence files placed inside its leaf indicator
 * folders). This function does not compute anything; it exists so
 * call sites can ask "what's the standards root?" using standards-specific
 * language, instead of every caller needing to know that the answer is
 * "the same value as the evidence root." The actual value still comes
 * from exactly one place: server/app.js#resolveEvidenceRoot(), which the
 * caller already has as app.locals.evidenceRoot.
 */
function resolveRoot(evidenceRoot) {
  return evidenceRoot;
}

/** True if the standards root directory currently exists on disk. */
async function verifyRootExists(evidenceRoot) {
  return evidenceService.folderExists(evidenceRoot);
}

/**
 * Read-only description of the domain/standard/indicator hierarchy —
 * names and codes only, never filesystem paths. Safe to expose to the
 * renderer as-is (though nothing currently does; GET /api/structure
 * exposes indicatorMap + evidenceRoot for a different, already-existing
 * purpose — see PHASE_2_REPORT.md "Main/Preload/Renderer Integration").
 */
function getStructureSummary() {
  const domains = new Map();
  for (const code of evidenceService.CODES) {
    const entry = evidenceService.MANIFEST[code];
    if (!domains.has(entry.domainFolder)) domains.set(entry.domainFolder, new Map());
    const standards = domains.get(entry.domainFolder);
    if (!standards.has(entry.standardFolder)) standards.set(entry.standardFolder, []);
    standards.get(entry.standardFolder).push({ code, indicatorFolder: entry.indicatorFolder, priv: entry.priv });
  }
  return Array.from(domains.entries()).map(([domain, standards]) => ({
    domain,
    standards: Array.from(standards.entries()).map(([standard, indicators]) => ({ standard, indicators })),
  }));
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/**
 * Walks `rootDir` and returns a deterministic manifest of every directory
 * and file inside it: relative path (POSIX-style, so the manifest is
 * portable across OSes), type, size, and — for files — a SHA-256 hash.
 * Entries are sorted so two independently-generated manifests of
 * identical content always produce byte-identical JSON.
 *
 * Pure and side-effect-free: never writes, renames, or deletes anything.
 * This is the function PHASE_2_STANDARDS_INTEGRITY_BASELINE.json was
 * generated from, and the function any future regression check should
 * call again and diff against that baseline via compareIntegrityManifest().
 */
function computeIntegrityManifest(rootDir) {
  const entries = [];

  function walk(dir, relBase) {
    const names = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const abs = path.join(dir, name);
      const rel = relBase ? `${relBase}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) {
        entries.push({ relPath: rel, type: 'directory' });
        walk(abs, rel);
      } else if (st.isFile()) {
        entries.push({ relPath: rel, type: 'file', size: st.size, sha256: sha256File(abs) });
      }
      // Symlinks/other special files deliberately not followed or hashed —
      // none exist in the standards tree today; if one ever appears this
      // manifest will simply omit it rather than guessing at its content,
      // which will show up as a difference against any prior baseline.
    }
  }

  if (fs.existsSync(rootDir)) walk(rootDir, '');

  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const fileCount = entries.filter((e) => e.type === 'file').length;
  const dirCount = entries.filter((e) => e.type === 'directory').length;

  return {
    generatedAt: new Date().toISOString(),
    folderName: getFolderName(),
    fileCount,
    dirCount,
    entries,
  };
}

/**
 * Compares two manifests produced by computeIntegrityManifest() (or loaded
 * from a previously-saved baseline JSON file) and reports exactly what, if
 * anything, differs. Ignores `generatedAt` (a timestamp is expected to
 * differ every time; it is not part of the content being verified).
 */
function compareIntegrityManifest(baseline, current) {
  const byPath = (manifest) => {
    const map = new Map();
    for (const e of manifest.entries) map.set(e.relPath, e);
    return map;
  };
  const baseMap = byPath(baseline);
  const curMap = byPath(current);

  const added = [];
  const removed = [];
  const changed = [];

  for (const [relPath, entry] of curMap) {
    if (!baseMap.has(relPath)) added.push(relPath);
  }
  for (const [relPath, entry] of baseMap) {
    if (!curMap.has(relPath)) removed.push(relPath);
  }
  for (const [relPath, baseEntry] of baseMap) {
    const curEntry = curMap.get(relPath);
    if (!curEntry) continue;
    if (baseEntry.type !== curEntry.type) {
      changed.push({ relPath, reason: 'type', before: baseEntry.type, after: curEntry.type });
    } else if (baseEntry.type === 'file' && (baseEntry.sha256 !== curEntry.sha256 || baseEntry.size !== curEntry.size)) {
      changed.push({ relPath, reason: 'content', beforeHash: baseEntry.sha256, afterHash: curEntry.sha256, beforeSize: baseEntry.size, afterSize: curEntry.size });
    }
  }

  return {
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
    added,
    removed,
    changed,
  };
}

module.exports = {
  getFolderName,
  resolveRoot,
  verifyRootExists,
  getStructureSummary,
  computeIntegrityManifest,
  compareIntegrityManifest,
};
