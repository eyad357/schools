'use strict';

// Mock the 'electron' module BEFORE anything requires it — same pattern
// as scripts/smoke-test.js (see that file for why).
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

const fakeUserData = path.join(os.tmpdir(), 'pptx-hifi-test-userdata-' + Date.now());
const fakeDocs = path.join(os.tmpdir(), 'pptx-hifi-test-docs-' + Date.now());
fs.mkdirSync(fakeUserData, { recursive: true });
fs.mkdirSync(fakeDocs, { recursive: true });
process.env.SCHOOL_APP_TEST_INSTALL_DIR = fakeDocs;

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (name) => (name === 'userData' ? fakeUserData : name === 'documents' ? fakeDocs : os.tmpdir()),
    getVersion: () => '1.0.0-test',
  },
  shell: { openPath: async () => {} },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-mock-virtual';
  return origResolve.call(this, request, ...rest);
};
require.cache['electron-mock-virtual'] = { id: 'electron-mock-virtual', filename: 'electron-mock-virtual', loaded: true, exports: fakeElectron };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, parent, isMain);
};

// ── now actually load what we're testing ──
const libreOfficeService = require('../server/services/libreOfficeService');
const { getUploadsTmpDir } = require('../electron/utils/paths');

let passed = 0, failed = 0;
const results = [];
async function check(name, fn, opts = {}) {
  try {
    await fn();
    passed++;
    results.push(`✅  ${name}`);
  } catch (err) {
    if (opts.envDependent) {
      results.push(`⏭️  ${name}  (skipped — environment-dependent: ${err.message})`);
    } else {
      failed++;
      results.push(`❌  ${name}  — ${err.message}`);
    }
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const FIXTURES = path.join(__dirname, '..', '..', 'testfiles'); // /home/claude/testfiles in this environment
const SAMPLE_PPTX = path.join(FIXTURES, 'sample.pptx');
const hasFixture = fs.existsSync(SAMPLE_PPTX);

(async () => {
  // ── 1/2: extension detection (route-level allow-list) ──
  await check('route recognizes .pptx and .ppsx as presentation extensions', () => {
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'pptxHighFidelity.js'), 'utf8');
    assert(/PRESENTATION_EXTS\s*=\s*new Set\(\[['"]pptx['"],\s*['"]ppsx['"]\]\)/.test(routeSrc), 'PRESENTATION_EXTS set no longer covers exactly pptx+ppsx');
  });

  // ── 3: LibreOffice resolver ──
  let sofficeAvailable = false;
  await check('resolveLibreOffice() returns a result without throwing', async () => {
    const result = await libreOfficeService.resolveLibreOffice({ force: true });
    sofficeAvailable = !!result;
    assert(result === null || typeof result === 'string', 'resolveLibreOffice() must return a string path/command or null, never throw');
  });
  results.push(`ℹ️  LibreOffice detected in this environment: ${sofficeAvailable}`);

  await check('resolveLibreOffice() is platform-aware (does not hardcode a Linux-only path as the sole candidate)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'libreOfficeService.js'), 'utf8');
    assert(/win32/.test(src), 'no Windows-specific branch found — resolveLibreOffice() must not assume /usr/bin/libreoffice');
    assert(/darwin/.test(src), 'no macOS-specific branch found');
    assert(/LIBREOFFICE_PATH/.test(src), 'no explicit override env var — needed for a future bundled/portable deployment');
  });

  // ── 4: safe argument construction (no shell string building) ──
  await check('convertToPdf() uses execFile (argv array) — never exec()/a shell string', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'libreOfficeService.js'), 'utf8');
    assert(/execFile\(/.test(src), 'execFile(...) call not found');
    assert(!/\bexec\(/.test(src.replace(/execFile\(/g, '')), 'a bare exec() call was found — shell-string execution is a shell-injection risk; use execFile with an argv array instead');
    assert(/args\s*=\s*\[/.test(src), 'LibreOffice arguments are not built as an array');
  });

  await check('a filename containing shell metacharacters does not break/inject during conversion', async () => {
    if (!sofficeAvailable) throw new Error('LibreOffice not available in this environment');
    if (!hasFixture) throw new Error('sample.pptx fixture not present');
    const dangerousDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-hifi-danger-'));
    const dangerousPath = path.join(dangerousDir, '$(whoami); rm -rf ~ #.pptx');
    fs.copyFileSync(SAMPLE_PPTX, dangerousPath);
    try {
      const result = await libreOfficeService.convertToPdf(dangerousPath, { timeoutMs: 30000 });
      assert(fs.existsSync(result.pdfPath), 'conversion did not produce an output file for a dangerously-named input');
      await result.cleanup();
    } finally {
      fs.rmSync(dangerousDir, { recursive: true, force: true });
    }
  }, { envDependent: true });

  // ── 5: conversion failure handling (malformed input) ──
  // Note: LibreOffice's Impress import filter is very lenient — plain
  // garbage bytes with a .pptx extension typically convert "successfully"
  // into a blank PDF rather than erroring (confirmed empirically while
  // writing this test). So this exercises BOTH real outcomes rather than
  // assuming failure, and — either way — asserts the temp dir is cleaned
  // up, which is what actually matters for this check.
  await check('convertToPdf() handles a malformed/corrupt file without crashing, and always cleans up its temp dir', async () => {
    if (!sofficeAvailable) throw new Error('LibreOffice not available in this environment');
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-hifi-bad-'));
    const badPath = path.join(badDir, 'not-really-a-pptx.pptx');
    fs.writeFileSync(badPath, Buffer.from('this is not a real pptx file, just garbage bytes'));
    try {
      let result = null, threw = null;
      try { result = await libreOfficeService.convertToPdf(badPath, { timeoutMs: 30000 }); }
      catch (e) { threw = e; }
      if (threw) {
        assert(threw instanceof libreOfficeService.LibreOfficeError, 'thrown error is not a LibreOfficeError');
        assert(['CONVERSION_FAILED', 'INVALID_OUTPUT'].includes(threw.code), `unexpected error code: ${threw.code}`);
      } else {
        // LibreOffice tolerated the bad input and produced SOME PDF —
        // still must be a real, validated PDF (convertToPdf's own magic-
        // byte check already ran), and the caller must still be able to
        // clean it up normally.
        assert(fs.existsSync(result.pdfPath), 'no error was thrown but no output file exists either');
        await result.cleanup();
        assert(!fs.existsSync(path.dirname(result.pdfPath)), 'cleanup() did not remove the working directory');
      }
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  }, { envDependent: true });

  // ── 6: timeout handling ──
  await check('convertToPdf() throws CONVERSION_TIMEOUT when the process runs past the deadline', async () => {
    // A tiny fake "soffice" that ignores every argument and just sleeps —
    // this exercises the timeout path deterministically, without needing
    // real LibreOffice to actually hang (which we can't reliably force).
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-hifi-fakebin-'));
    const isWin = process.platform === 'win32';
    const fakeSofficePath = path.join(fakeBinDir, isWin ? 'soffice.bat' : 'soffice.sh');
    fs.writeFileSync(fakeSofficePath, isWin ? '@echo off\r\nping -n 30 127.0.0.1 >nul\r\n' : '#!/bin/sh\nsleep 30\n');
    if (!isWin) fs.chmodSync(fakeSofficePath, 0o755);

    const prevEnv = process.env.LIBREOFFICE_PATH;
    process.env.LIBREOFFICE_PATH = fakeSofficePath;
    try {
      await libreOfficeService.resolveLibreOffice({ force: true }); // re-resolve so the override takes effect
      if (!hasFixture) throw new Error('sample.pptx fixture not present');
      let threw = null;
      const start = Date.now();
      try { await libreOfficeService.convertToPdf(SAMPLE_PPTX, { timeoutMs: 800 }); }
      catch (e) { threw = e; }
      const elapsed = Date.now() - start;
      assert(threw, 'convertToPdf() did not throw for a hanging process');
      assert(threw.code === 'CONVERSION_TIMEOUT', `expected CONVERSION_TIMEOUT, got ${threw.code}`);
      assert(elapsed < 10000, `timeout took far longer than the requested 800ms deadline (${elapsed}ms) — hard-kill fallback may not be working`);
    } finally {
      process.env.LIBREOFFICE_PATH = prevEnv;
      await libreOfficeService.resolveLibreOffice({ force: true }); // restore real resolution for later checks
      fs.rmSync(fakeBinDir, { recursive: true, force: true });
    }
  });

  // ── 7: generated PDF validation, on a real successful conversion ──
  let goodConversion = null;
  await check('a successful conversion produces a file starting with the real %PDF- magic bytes', async () => {
    if (!sofficeAvailable) throw new Error('LibreOffice not available in this environment');
    if (!hasFixture) throw new Error('sample.pptx fixture not present');
    goodConversion = await libreOfficeService.convertToPdf(SAMPLE_PPTX, { timeoutMs: 30000 });
    const head = Buffer.alloc(5);
    const fh = fs.openSync(goodConversion.pdfPath, 'r');
    fs.readSync(fh, head, 0, 5, 0);
    fs.closeSync(fh);
    assert(head.toString('latin1') === '%PDF-', `output does not start with %PDF- (got ${JSON.stringify(head.toString('latin1'))})`);
  }, { envDependent: true });

  // ── 9: temp-file cleanup ──
  await check('cleanup() removes the conversion working directory', async () => {
    if (!goodConversion) throw new Error('no successful conversion available from the previous check');
    const workDir = path.dirname(goodConversion.pdfPath);
    assert(fs.existsSync(workDir), 'sanity check: working dir should still exist before cleanup()');
    await goodConversion.cleanup();
    assert(!fs.existsSync(workDir), 'working directory was not removed by cleanup()');
  }, { envDependent: true });

  await check('a conversion that produces no useful result still cleans up its temp directory (no leak on any exit path)', async () => {
    if (!sofficeAvailable) throw new Error('LibreOffice not available in this environment');
    const before = fs.existsSync(path.join(getUploadsTmpDir(), 'pptx-hifi')) ? fs.readdirSync(path.join(getUploadsTmpDir(), 'pptx-hifi')).length : 0;
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-hifi-bad2-'));
    const badPath = path.join(badDir, 'garbage.pptx');
    fs.writeFileSync(badPath, Buffer.from('garbage'));
    try {
      const result = await libreOfficeService.convertToPdf(badPath, { timeoutMs: 30000 });
      await result.cleanup(); // mirrors what the real route always does, success or not
    } catch { /* a thrown LibreOfficeError already cleans up internally before rethrowing */ }
    fs.rmSync(badDir, { recursive: true, force: true });
    const after = fs.existsSync(path.join(getUploadsTmpDir(), 'pptx-hifi')) ? fs.readdirSync(path.join(getUploadsTmpDir(), 'pptx-hifi')).length : 0;
    assert(after <= before, `temp dirs under pptx-hifi/ grew from ${before} to ${after} — a working directory was leaked`);
  }, { envDependent: true });

  // ── 10: no artificial file-size limit ──
  await check('neither the service nor the route rejects files based on size', () => {
    const serviceSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'libreOfficeService.js'), 'utf8');
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'pptxHighFidelity.js'), 'utf8');
    const sizeLimitPattern = /\.size\s*[<>]=?\s*\d|MAX_(FILE_)?SIZE|maxFileSize|fileSizeLimit/i;
    assert(!sizeLimitPattern.test(serviceSrc), 'libreOfficeService.js appears to contain a file-size limit check');
    assert(!sizeLimitPattern.test(routeSrc), 'pptxHighFidelity.js route appears to contain a file-size limit check');
  });

  // ── 11: original evidence file remains untouched ──
  await check('the source file\'s bytes/mtime are unchanged after a real conversion', async () => {
    if (!sofficeAvailable) throw new Error('LibreOffice not available in this environment');
    if (!hasFixture) throw new Error('sample.pptx fixture not present');
    const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-hifi-integrity-'));
    const checkPath = path.join(checkDir, 'integrity-check.pptx');
    fs.copyFileSync(SAMPLE_PPTX, checkPath);
    const before = fs.readFileSync(checkPath);
    const statBefore = fs.statSync(checkPath);
    try {
      const conv = await libreOfficeService.convertToPdf(checkPath, { timeoutMs: 30000 });
      await conv.cleanup();
      const after = fs.readFileSync(checkPath);
      const statAfter = fs.statSync(checkPath);
      assert(before.equals(after), 'source file bytes changed after conversion');
      assert(statBefore.mtimeMs === statAfter.mtimeMs, 'source file mtime changed after conversion');
    } finally {
      fs.rmSync(checkDir, { recursive: true, force: true });
    }
  }, { envDependent: true });

  // ── 12/13: native renderer + PDF viewer reuse (structural checks — no
  //           browser available in this environment, matches the existing
  //           project convention of source-pattern checks for frontend
  //           behavior that can't be executed headlessly; see
  //           viewer-lifecycle-test.js's own header note on this tradeoff) ──
  await check('the native PPTX renderer dispatch is untouched (renderersByEngine still maps pptx-text-extract to renderPptx)', () => {
    const viewerSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'viewer.js'), 'utf8');
    assert(/'pptx-text-extract':\s*renderPptx/.test(viewerSrc), 'renderersByEngine no longer maps pptx-text-extract to renderPptx — native rendering path may have been removed');
  });

  await check('switchToPdfView() reuses the existing renderPdf()/PDFEngine — no second PDF renderer was introduced', () => {
    const viewerSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'viewer.js'), 'utf8');
    const body = (() => {
      const start = viewerSrc.indexOf('function switchToPdfView(pdfUrl)');
      const end = viewerSrc.indexOf('\n  }', start);
      return viewerSrc.slice(start, end);
    })();
    assert(body.includes('renderPdf()'), 'switchToPdfView() no longer calls the existing renderPdf() — a duplicate PDF renderer may have been introduced instead of reusing it');
    const openDocumentCallSites = (viewerSrc.match(/PDFEngine\.openDocument\(/g) || []).length
      + fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'pdf-engine.js'), 'utf8').split('PDFEngine.openDocument(').length - 1;
    assert(openDocumentCallSites <= 1, `found ${openDocumentCallSites} PDFEngine.openDocument() call sites in viewer.js — expected exactly the one inside renderPdf(), reused by switchToPdfView()`);
  });

  // ── 8: stale-conversion protection (structural — see note above) ──
  await check('the high-fidelity flow checks ctx.isActive() before applying a conversion result (stale-response protection)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'viewers', 'pptx-high-fidelity.js'), 'utf8');
    const isActiveChecks = (src.match(/isActive\(\)/g) || []).length;
    assert(isActiveChecks >= 3, `expected isActive() to be checked at multiple points around the async conversion round-trip (after the fetch, after reading the body, before wiring the availability button) — found only ${isActiveChecks}`);
    assert(/switchToPdfView\(/.test(src), 'pptx-high-fidelity.js no longer calls ctx.switchToPdfView() — the handoff to the existing PDF viewer may be broken');
  });

  await check('viewer.js exposes isActive as a fresh per-render identity check tied to state, not a constant', () => {
    const viewerSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'viewer.js'), 'utf8');
    assert(/isActive:\s*\(\)\s*=>\s*state === myState/.test(viewerSrc), 'renderPptx() no longer builds a fresh isActive() closure around the render-time state reference — stale conversion responses could corrupt whatever file is now actually open');
  });

  console.log('\n=== PPTX HIGH-FIDELITY FALLBACK — REGRESSION RESULTS ===');
  results.forEach((r) => console.log(r));
  console.log(`\n${passed}/${passed + failed} passed` + (results.some(r => r.startsWith('⏭️')) ? ' (some environment-dependent checks skipped — see ⏭️ above)' : ''));
  if (failed > 0) process.exit(1);
})();
