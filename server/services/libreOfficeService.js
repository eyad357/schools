'use strict';

/**
 * Phase 6C — high-fidelity PPTX/PPSX fallback: LibreOffice resolution +
 * conversion. Isolated service, mirrors the existing evidenceService.js/
 * backupService.js pattern (plain functions, no class, explicit deps).
 *
 * SECURITY: every LibreOffice invocation goes through execFile() with an
 * argv array — never a shell string — so a malicious filename cannot
 * inject shell syntax. See convertToPdf() below.
 *
 * WINDOWS: resolveLibreOffice() is platform-aware and never assumes a
 * Linux path. Priority order: an explicit LIBREOFFICE_PATH override, a
 * future bundled/portable copy under the app's resources dir, common
 * per-OS install locations, then a bare PATH lookup. Nothing here
 * hardcodes /usr/bin — see resolveLibreOffice().
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const log = require('../../electron/utils/logger');
const { getUploadsTmpDir, getResourcesPath } = require('../../electron/utils/paths');

class LibreOfficeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LibreOfficeError';
    this.code = code; // 'LIBREOFFICE_NOT_FOUND' | 'CONVERSION_TIMEOUT' | 'CONVERSION_FAILED' | 'INVALID_OUTPUT'
  }
}

// ── resolution ────────────────────────────────────────────────────

function candidatePaths() {
  const candidates = [];
  if (process.env.LIBREOFFICE_PATH) candidates.push(process.env.LIBREOFFICE_PATH);

  // Future bundled/portable deployment (see Phase 6B recommendation) —
  // checked first among the non-override candidates so dropping a
  // portable copy under resources/libreoffice/ "just works" with zero
  // code changes later. Doesn't exist yet; existsSync below just skips it.
  const bundledName = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
  candidates.push(path.join(getResourcesPath(), 'libreoffice', 'program', bundledName));

  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  } else {
    candidates.push('/usr/bin/soffice', '/usr/bin/libreoffice', '/opt/libreoffice/program/soffice');
  }
  return candidates;
}

let cachedResolution; // undefined = not yet checked; null = checked, not found; string = resolved path/command
/**
 * Finds a usable LibreOffice executable, or returns null. Cached for the
 * process lifetime (matches checkAvailability()'s own caching on the
 * frontend) — re-probing the filesystem/PATH on every single conversion
 * request would be wasted work for something that cannot change during
 * a running session.
 */
async function resolveLibreOffice({ force } = {}) {
  if (!force && cachedResolution !== undefined) return cachedResolution;

  for (const candidate of candidatePaths()) {
    try {
      if (fs.existsSync(candidate)) { cachedResolution = candidate; return cachedResolution; }
    } catch { /* ignore and keep trying */ }
  }
  // Bare PATH lookup as the last resort — works cross-platform because
  // execFile resolves an unqualified command through the OS's own PATH
  // search (PATHEXT on Windows already includes .exe), so this single
  // check covers "soffice" being registered under any install location
  // we didn't already guess above.
  const pathCommand = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
  const found = await new Promise((resolve) => {
    execFile(pathCommand, ['--version'], { timeout: 5000 }, (err) => resolve(!err));
  });
  cachedResolution = found ? pathCommand : null;
  return cachedResolution;
}

// ── conversion ────────────────────────────────────────────────────

const PDF_MAGIC = Buffer.from('%PDF-');

/**
 * Converts one PPTX/PPSX file to PDF via LibreOffice headless.
 *
 * - Uses execFile() (argv array, no shell) — safe against any filename.
 * - Runs with an isolated `-env:UserInstallation` profile per call, in
 *   its own temp dir, so concurrent conversions never contend for (or
 *   corrupt) a shared LibreOffice profile lock.
 * - Never touches `sourcePath` except to read it — LibreOffice's own
 *   --convert-to only ever writes into --outdir, and this additionally
 *   verifies the source's mtime/size are unchanged afterward as a
 *   belt-and-suspenders integrity check (the caller — the route — also
 *   re-checks this before trusting the result; see server/routes/
 *   pptxHighFidelity.js).
 * - No size limit is imposed here; a large file simply takes longer,
 *   bounded only by `timeoutMs`.
 *
 * Returns { pdfPath, cleanup } — the caller MUST call cleanup() once
 * done with pdfPath (streaming it out, etc.), success or failure.
 */
async function convertToPdf(sourcePath, { timeoutMs = 60000 } = {}) {
  const soffice = await resolveLibreOffice();
  if (!soffice) throw new LibreOfficeError('LIBREOFFICE_NOT_FOUND', 'LibreOffice غير مثبَّت أو لم يتم العثور عليه على هذا الجهاز.');

  const workDir = path.join(getUploadsTmpDir(), 'pptx-hifi', crypto.randomBytes(8).toString('hex'));
  await fsp.mkdir(workDir, { recursive: true });
  const profileDir = path.join(workDir, 'loprofile');
  const cleanup = async () => { try { await fsp.rm(workDir, { recursive: true, force: true }); } catch (e) { log.warn(`[libreOfficeService] temp cleanup failed for ${workDir}: ${e.message}`); } };

  const statBefore = await fsp.stat(sourcePath);

  try {
    const args = [
      '--headless', '--norestore', '--invisible',
      `-env:UserInstallation=file://${profileDir.split(path.sep).join('/')}`,
      '--convert-to', 'pdf',
      '--outdir', workDir,
      sourcePath,
    ];
    await new Promise((resolve, reject) => {
      const child = execFile(soffice, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
        if (err) {
          if (err.killed || err.signal === 'SIGKILL' || err.code === null) {
            reject(new LibreOfficeError('CONVERSION_TIMEOUT', `انتهت مهلة تحويل الملف بعد ${Math.round(timeoutMs / 1000)} ثانية.`));
          } else {
            reject(new LibreOfficeError('CONVERSION_FAILED', 'فشل تحويل الملف عبر LibreOffice.'));
          }
          return;
        }
        resolve();
      });
      // Belt-and-suspenders against a hang execFile's own `timeout` option
      // doesn't catch (observed occasionally with soffice's own child
      // processes on some platforms) — force-kill after a small grace
      // period past the requested timeout.
      const hardKill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs + 5000);
      child.on('exit', () => clearTimeout(hardKill));
    });

    // LibreOffice derives the output filename from the input's own
    // basename (extension replaced with .pdf), regardless of the
    // original extension — so "خطة.ppsx" becomes "خطة.pdf", not named
    // after anything we chose.
    const expectedName = path.basename(sourcePath, path.extname(sourcePath)) + '.pdf';
    const outputPath = path.join(workDir, expectedName);

    if (!fs.existsSync(outputPath)) throw new LibreOfficeError('INVALID_OUTPUT', 'لم ينتج عن التحويل ملف PDF.');
    const outStat = await fsp.stat(outputPath);
    if (outStat.size === 0) throw new LibreOfficeError('INVALID_OUTPUT', 'ملف PDF الناتج فارغ.');
    const head = Buffer.alloc(PDF_MAGIC.length);
    const fh = await fsp.open(outputPath, 'r');
    try { await fh.read(head, 0, PDF_MAGIC.length, 0); } finally { await fh.close(); }
    if (!head.equals(PDF_MAGIC)) throw new LibreOfficeError('INVALID_OUTPUT', 'الملف الناتج ليس PDF صالحًا.');

    const statAfter = await fsp.stat(sourcePath);
    if (statAfter.mtimeMs !== statBefore.mtimeMs || statAfter.size !== statBefore.size) {
      // Should be structurally impossible (LibreOffice --convert-to never
      // writes back to the input), but the evidence file's integrity is
      // exactly the thing this whole feature must never risk — treat any
      // discrepancy as a hard failure rather than silently proceeding.
      throw new LibreOfficeError('CONVERSION_FAILED', 'تم اكتشاف تغيّر في الملف الأصلي أثناء التحويل — تم إيقاف العملية للحماية.');
    }

    return { pdfPath: outputPath, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

module.exports = { resolveLibreOffice, convertToPdf, LibreOfficeError };
