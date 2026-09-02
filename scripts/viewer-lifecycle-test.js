'use strict';
/*
 * Phase 4 viewer regression guards.
 *
 * Same convention as scripts/pdf-render-order-test.js: this project does
 * not use a real browser/DOM engine (no Puppeteer/Playwright/jsdom
 * dependency anywhere in the codebase — confirmed by grep before writing
 * this file), so viewer.js's actual DOM/rendering behavior cannot be
 * executed or visually verified in this headless environment. What CAN
 * be verified without a browser, and what this file verifies, is that
 * the specific structural invariants Phase 4's audit found and fixed
 * remain present in source — so a future edit that silently reintroduces
 * one of these gaps fails immediately instead of shipping a
 * hard-to-notice memory leak or a broken toolbar control.
 *
 * This is a regression guard, not a rendering test. It does not and
 * cannot substitute for opening real files in a real Electron window —
 * see PHASE_4_VIEWER_AUDIT.md and PHASE_4_REPORT.md for the explicit,
 * honest accounting of what this environment could and could not verify.
 */
const fs = require('fs');
const path = require('path');

const results = [];
function check(name, fn) {
  try { fn(); results.push([name, 'OK']); }
  catch (err) { results.push([name, 'FAIL: ' + err.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const viewerSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'viewer.js'), 'utf8');
const policySrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'file-support-policy.js'), 'utf8');
const FileSupportPolicy = require('../app/js/file-support-policy.js');

function extractFunctionBody(src, fnSignaturePattern) {
  const m = src.match(fnSignaturePattern);
  assert(m, `could not locate function matching ${fnSignaturePattern}`);
  const start = m.index + m[0].length - 1; // position of the opening '{'
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces while extracting function body');
}

// ══════════════════════════════════════════════════════════════════
// Lifecycle cleanup — the two leaks found and fixed in Phase 4
// ══════════════════════════════════════════════════════════════════

check('cleanupPrevious() disconnects both PDF IntersectionObservers', () => {
  const body = extractFunctionBody(viewerSrc, /function cleanupPrevious\(\)\s*\{/);
  assert(/pdfObserver\.disconnect\(\)/.test(body), 'pdfObserver.disconnect() missing from cleanupPrevious()');
  assert(/pdfPageTracker\.disconnect\(\)/.test(body), 'pdfPageTracker.disconnect() missing from cleanupPrevious()');
});

check('cleanupPrevious() removes the image-pan window listeners', () => {
  const body = extractFunctionBody(viewerSrc, /function cleanupPrevious\(\)\s*\{/);
  assert(/window\.removeEventListener\(\s*'mousemove'\s*,\s*imgPanMove\s*\)/.test(body), 'mousemove listener removal missing from cleanupPrevious()');
  assert(/window\.removeEventListener\(\s*'mouseup'\s*,\s*imgPanEnd\s*\)/.test(body), 'mouseup listener removal missing from cleanupPrevious()');
});

check('cleanupPrevious() still destroys the PDF document and revokes object URLs (pre-existing, re-verified)', () => {
  const body = extractFunctionBody(viewerSrc, /function cleanupPrevious\(\)\s*\{/);
  assert(/PDFEngine\.destroyDocument\(state\.pdfDoc\)/.test(body), 'PDFEngine.destroyDocument call missing');
  assert(/URL\.revokeObjectURL/.test(body), 'object URL revocation missing');
});

check('open() calls cleanupPrevious() before establishing new state (pre-existing, re-verified)', () => {
  const body = extractFunctionBody(viewerSrc, /function open\(code, file\)\s*\{/);
  const cleanupIdx = body.indexOf('cleanupPrevious()');
  const freshStateIdx = body.indexOf('freshState()');
  assert(cleanupIdx !== -1 && freshStateIdx !== -1 && cleanupIdx < freshStateIdx, 'cleanupPrevious() must run before freshState() in open()');
});

// ══════════════════════════════════════════════════════════════════
// Zoom dispatch — the word/text zoom no-op found and fixed in Phase 4
// ══════════════════════════════════════════════════════════════════

check('zoomBy() dispatches through applyContentZoom() rather than only touching the image element', () => {
  const body = extractFunctionBody(viewerSrc, /function zoomBy\(delta\)\s*\{/);
  assert(/applyContentZoom\(\)/.test(body), 'zoomBy() no longer calls applyContentZoom()');
  assert(!/applyImageTransform\(\)/.test(body), 'zoomBy() should not call applyImageTransform() directly (that bypasses word/text zoom)');
});

check('applyContentZoom() actually branches on category for image/word/text', () => {
  const body = extractFunctionBody(viewerSrc, /function applyContentZoom\(\)\s*\{/);
  assert(/state\.category === 'image'/.test(body), 'missing image branch');
  assert(/state\.category === 'word'/.test(body), 'missing word branch');
  assert(/dv-text-pre/.test(body), 'missing text branch');
});

// ══════════════════════════════════════════════════════════════════
// Capability model (Phase 4 addition) stays in sync with the actual
// dispatch table — the exact class of drift Phase 0 already fixed once
// for the old per-format extension tables; this guard exists so the
// new capability table can't quietly suffer the same fate.
// ══════════════════════════════════════════════════════════════════

check('every engine key in viewer.js\'s renderersByEngine table has a capability entry in FileSupportPolicy', () => {
  const m = viewerSrc.match(/const renderersByEngine = (\{[\s\S]*?\});/);
  assert(m, 'could not locate renderersByEngine table in viewer.js');
  const engineKeys = [...m[1].matchAll(/'([a-z0-9-]+)':\s*render\w+/g)].map((mm) => mm[1]);
  assert(engineKeys.length >= 8, `expected at least 8 engine keys, found ${engineKeys.length}: ${engineKeys.join(', ')}`);
  for (const key of engineKeys) {
    assert(
      Object.prototype.hasOwnProperty.call(FileSupportPolicy.VIEWER_CAPABILITIES_BY_ENGINE, key),
      `engine "${key}" is dispatched to a render function in viewer.js but has no entry in VIEWER_CAPABILITIES_BY_ENGINE`
    );
  }
});

check('no capability table entry references an engine viewer.js does not actually dispatch', () => {
  const m = viewerSrc.match(/const renderersByEngine = (\{[\s\S]*?\});/);
  assert(m, 'could not locate renderersByEngine table in viewer.js');
  const engineKeys = new Set([...m[1].matchAll(/'([a-z0-9-]+)':\s*render\w+/g)].map((mm) => mm[1]));
  for (const key of Object.keys(FileSupportPolicy.VIEWER_CAPABILITIES_BY_ENGINE)) {
    assert(engineKeys.has(key), `VIEWER_CAPABILITIES_BY_ENGINE has an entry "${key}" that viewer.js's renderersByEngine table does not dispatch to`);
  }
});

check('capabilities claimed for the PDF engine match toolbar controls actually built in renderPdf()', () => {
  const body = extractFunctionBody(viewerSrc, /async function renderPdf\(\)\s*\{/);
  const caps = FileSupportPolicy.getViewerCapabilities('x.pdf');
  if (caps.zoom) assert(/addZoomControls\(zoomPdf/.test(body), 'claims zoom capability but renderPdf() does not call addZoomControls');
  if (caps.search) assert(/addSearchToggle\(\)/.test(body), 'claims search capability but renderPdf() does not call addSearchToggle');
  if (caps.print) assert(/printPdf/.test(body), 'claims print capability but renderPdf() has no print control');
  if (caps.rotate) assert(/rotatePdf/.test(body), 'claims rotate capability but renderPdf() has no rotate control');
  if (caps.thumbnails) assert(/buildPdfThumbnails/.test(body), 'claims thumbnails capability but renderPdf() never builds them');
});

check('capabilities claimed for word (mammoth) match toolbar controls actually built in renderWordDocx()', () => {
  const body = extractFunctionBody(viewerSrc, /async function renderWordDocx\(\)\s*\{/);
  const caps = FileSupportPolicy.getViewerCapabilities('x.docx');
  if (caps.zoom) assert(/addZoomControls\(zoomBy/.test(body), 'claims zoom capability but renderWordDocx() does not call addZoomControls');
  if (caps.search) assert(/addSearchToggle\(\)/.test(body), 'claims search capability but renderWordDocx() does not call addSearchToggle');
});

check('capabilities claimed for image match toolbar controls actually built in renderImage()', () => {
  const body = extractFunctionBody(viewerSrc, /function renderImage\(\)\s*\{/);
  const caps = FileSupportPolicy.getViewerCapabilities('x.png');
  if (caps.zoom) assert(/addZoomControls\(zoomBy/.test(body), 'claims zoom capability but renderImage() does not call addZoomControls');
  if (caps.rotate) assert(/تدوير/.test(body), 'claims rotate capability but renderImage() has no rotate control');
  if (caps.gallery) assert(/galleryFiles/.test(body), 'claims gallery capability but renderImage() has no gallery logic');
});

check('excel capability table does NOT falsely claim zoom (renderExcel() does not wire it up today)', () => {
  const xlsxBody = extractFunctionBody(viewerSrc, /async function renderExcel\(\)\s*\{/);
  assert(!/addZoomControls/.test(xlsxBody), 'renderExcel() unexpectedly has zoom now — update VIEWER_CAPABILITIES_BY_ENGINE.sheetjs to add zoom:true');
  const xlsxCaps = FileSupportPolicy.getViewerCapabilities('x.xlsx');
  assert(!xlsxCaps.zoom, 'VIEWER_CAPABILITIES_BY_ENGINE.sheetjs falsely claims zoom:true');
});

check('pptx capability table\'s zoom:true claim is real (Phase 6A: pptx-viewer.js actually wires up addZoomControls)', () => {
  // PPTX's real rendering logic lives in its own specialized engine file
  // (app/js/viewers/pptx-viewer.js) — this checks THAT file, not viewer.js's
  // thin adapter, since that's where the real implementation is.
  const pptxEngineSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'viewers', 'pptx-viewer.js'), 'utf8');
  assert(/addZoomControls/.test(pptxEngineSrc), 'pptx-viewer.js no longer wires up zoom — either restore it or set VIEWER_CAPABILITIES_BY_ENGINE[\'pptx-text-extract\'].zoom back to false/absent');
  const pptxCaps = FileSupportPolicy.getViewerCapabilities('x.pptx');
  assert(pptxCaps.zoom, 'VIEWER_CAPABILITIES_BY_ENGINE[\'pptx-text-extract\'] should claim zoom:true now that pptx-viewer.js actually implements it');
});

// ══════════════════════════════════════════════════════════════════
// Security — re-verify Phase 3's "never execute uploaded content"
// guarantee still holds for the viewer layer specifically (viewer.js
// parses untrusted OOXML/legacy-binary content client-side; confirm it
// never does so via eval/Function/innerHTML-of-raw-script).
// ══════════════════════════════════════════════════════════════════

check('viewer.js never uses eval/Function/document.write on file content', () => {
  assert(!/\beval\(/.test(viewerSrc), 'eval( found in viewer.js');
  assert(!/new Function\(/.test(viewerSrc), 'new Function( found in viewer.js');
  assert(!/document\.write\(/.test(viewerSrc), 'document.write( found in viewer.js');
});

check('mammoth-rendered HTML is inserted via a scoped container, not executed as a script context', () => {
  const body = extractFunctionBody(viewerSrc, /async function renderWordDocx\(\)\s*\{/);
  assert(/dv-office-doc/.test(body), 'expected mammoth output to land inside the dv-office-doc container');
  assert(!/insertAdjacentHTML.*script/i.test(body));
});

// ══════════════════════════════════════════════════════════════════
// Real-file-driven finding — .ppsx (PowerPoint Show), a real file
// already present in this repo's committed sample evidence, was
// classified as unrecognized/no-preview before Phase 4. Guard against
// it silently regressing back to that state.
// ══════════════════════════════════════════════════════════════════

check('.ppsx (PowerPoint Show) is recognized as powerpoint category with preview support', () => {
  const caps = FileSupportPolicy.getViewerCapabilities('x.ppsx');
  const policy = FileSupportPolicy.getPolicy('x.ppsx');
  assert(policy && policy.category === 'powerpoint', 'x.ppsx should classify as category "powerpoint"');
  assert(policy.preview.supported && policy.preview.engine === 'pptx-text-extract', 'x.ppsx should use the pptx-text-extract preview engine');
  assert(caps.slideNavigation, 'x.ppsx should have slideNavigation capability');
});

check('the real committed sample .ppsx evidence file is now classified correctly (regression check against actual repo content)', () => {
  const dir = path.join(__dirname, '..', 'معايير التقويم والاعتماد المدرسي', 'مجال الإدارة المدرسية', 'معيار التخطيط', 'مؤشر (1-1-1-1) تضع المدرسة خطة تشغيلية شاملة');
  const files = fs.readdirSync(dir);
  const ppsx = files.find((f) => f.endsWith('.ppsx'));
  assert(ppsx, 'expected the known real .ppsx sample file to still be present (read-only check, never modifies it)');
  const policy = FileSupportPolicy.getPolicy(ppsx);
  assert(policy && policy.preview.supported, `real sample file "${ppsx}" should now have preview support`);
});

// ══════════════════════════════════════════════════════════════════
// Phase 7.5 — Viewer Shell / specialized-engine split.
// Guards against the refactor silently regressing: the adapter left in
// viewer.js must actually delegate rather than re-duplicating the OOXML
// parsing logic, the engine file must exist and export the expected
// contract, and index.html must load it before viewer.js can call it.
// ══════════════════════════════════════════════════════════════════

check('renderPptx() in viewer.js is a thin adapter that delegates to PptxViewer.render(), not a reimplementation', () => {
  const body = extractFunctionBody(viewerSrc, /function renderPptx\(\)\s*\{/);
  assert(/PptxViewer\.render\(/.test(body), 'renderPptx() no longer delegates to PptxViewer.render()');
  assert(!/getElementsByTagName\('a:xfrm'\)/.test(body), 'renderPptx() appears to have OOXML parsing logic duplicated back into viewer.js — it should live only in app/js/viewers/pptx-viewer.js');
});

check('app/js/viewers/pptx-viewer.js exists and exposes the PptxViewer.render(ctx) contract', () => {
  const enginePath = path.join(__dirname, '..', 'app', 'js', 'viewers', 'pptx-viewer.js');
  assert(fs.existsSync(enginePath), 'app/js/viewers/pptx-viewer.js is missing');
  const src = fs.readFileSync(enginePath, 'utf8');
  assert(/const PptxViewer = \(function/.test(src), 'pptx-viewer.js should expose a PptxViewer module, matching the pattern used by pdf-engine.js/file-support-policy.js');
  assert(/return \{ render \}/.test(src), 'pptx-viewer.js should expose a render(ctx) function');
});

check('index.html loads js/viewers/pptx-viewer.js before js/viewer.js', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const engineIdx = indexHtml.indexOf('js/viewers/pptx-viewer.js');
  const shellIdx = indexHtml.indexOf('js/viewer.js');
  assert(engineIdx !== -1, 'app/index.html does not load js/viewers/pptx-viewer.js');
  assert(engineIdx < shellIdx, 'js/viewers/pptx-viewer.js must be loaded before js/viewer.js');
});

// ══════════════════════════════════════════════════════════════════
// Regression guards for the "Cannot read properties of undefined
// (reading 'sizePt')" crash found in real-world manual testing (a real
// PPTX where no run/paragraph anywhere specified an explicit font size —
// extremely common, since PowerPoint usually resolves size from the
// slide master's <p:txStyles> instead). Root cause was TWO things: (1)
// `array.find(...) || {}` followed immediately by a second `.prop` read
// — a bare `{}` fallback has no such property, so that pattern throws
// instead of falling through; (2) the renderer never consulted
// txStyles at all, so "no explicit size anywhere" was a common real
// case, not a rare edge case.
// ══════════════════════════════════════════════════════════════════

check('pptx-viewer.js has no `.find(...) || {})` followed by a chained property read (the exact pattern that crashed as "Cannot read properties of undefined (reading \'sizePt\')")', () => {
  const pptxEngineSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'viewers', 'pptx-viewer.js'), 'utf8');
  assert(
    !/\.find\([^)]*\)\s*\|\|\s*\{\}\)\s*\.[A-Za-z_$][\w$]*\s*\.[A-Za-z_$]/.test(pptxEngineSrc),
    'found `.find(...) || {})` followed by a two-level property access — a bare {} fallback has no nested property; use an explicit ternary or optional chaining that handles the no-match case instead'
  );
});

check('pptx-viewer.js resolves font size through real master <p:txStyles> inheritance, not just a flat guess (root-cause fix, not a defensive patch)', () => {
  const pptxEngineSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'viewers', 'pptx-viewer.js'), 'utf8');
  assert(/function parseTxStyles/.test(pptxEngineSrc), 'parseTxStyles() is missing — master-level <p:txStyles> font-size inheritance was removed');
  assert(/function txStyleDefaultsFor/.test(pptxEngineSrc), 'txStyleDefaultsFor() is missing');
  assert(/extractTextShape\(node, clrScheme, txStyles\)/.test(pptxEngineSrc), 'extractTextShape() is no longer called with txStyles — master-level font-size inheritance is disconnected from the render path');
});

check('pptx-viewer.js isolates a single bad slide or shape instead of letting it crash the whole presentation', () => {
  const pptxEngineSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'viewers', 'pptx-viewer.js'), 'utf8');
  assert(/catch \(shapeErr\)/.test(pptxEngineSrc), 'per-shape try/catch (catch (shapeErr)) is missing — one malformed shape could crash the whole slide again');
  assert(/catch \(slideErr\)/.test(pptxEngineSrc), 'per-slide try/catch (catch (slideErr)) is missing — one malformed slide could crash the whole presentation again');
});

// ══════════════════════════════════════════════════════════════════
// Two shell-level regressions found via manual testing of a real PPTX
// (not PPTX-specific bugs, but the file info header/toolbar they show
// up in are exercised by every viewer including PPTX's):
//   1. "NaN KB" file size — evidenceService.listFiles() returns BOTH a
//      pre-formatted `size` string ("12.4 KB") and a raw `bytes` number;
//      viewer.js's `file.size ?? file.bytes` always picked the string
//      (never null) and ran byte-math on it. Fixed by preferring
//      `bytes` first and making fmtBytes() defensive either way.
//   2. Slide counter showing "58 / 2" instead of "2 / 58" — plain text
//      "2 / 58" inside an RTL-context element let the browser's bidi
//      algorithm reorder the two numeral groups around the "/". Fixed
//      with an explicit direction:ltr/unicode-bidi:isolate rule.
// ══════════════════════════════════════════════════════════════════

check('viewer.js prefers the raw `bytes` field over the pre-formatted `size` string when displaying file size (the "NaN KB" bug)', () => {
  assert(/fmtBytes\(file\.bytes \?\? file\.size\)/.test(viewerSrc), 'the subtitle file-size display no longer prefers file.bytes over file.size — this is what produced "NaN KB", since evidenceService returns size as an already-formatted string like "12.4 KB"');
  assert(/fmtBytes\(f\.bytes \?\? f\.size\)/.test(viewerSrc), 'the info-panel file-size display no longer prefers f.bytes over f.size');
});

check('fmtBytes() is defensive against being handed an already-formatted size string (defense in depth for the "NaN KB" bug)', () => {
  const body = extractFunctionBody(viewerSrc, /function fmtBytes\(n\)\s*\{/);
  assert(/typeof n === 'string'/.test(body), 'fmtBytes() no longer detects a pre-formatted string input — a future caller passing `file.size` directly (e.g. a new call site) would silently produce "NaN" again instead of degrading gracefully');
});

check('the slide counter forces LTR direction so RTL page context cannot reorder the "current / total" numerals ("58 / 2" bug)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'css', 'viewer.css'), 'utf8');
  const rule = css.match(/\.dv-slide-counter\s*\{[^}]*\}/);
  assert(rule, '.dv-slide-counter rule is missing from viewer.css');
  assert(/direction\s*:\s*ltr/.test(rule[0]), '.dv-slide-counter no longer forces direction:ltr — the "current / total" numerals can be visually reordered by the surrounding RTL context again');
});

console.log('\n=== VIEWER LIFECYCLE / CAPABILITY REGRESSION RESULTS ===');
let pass = 0;
for (const [name, status] of results) {
  console.log(`${status === 'OK' ? '✅' : '❌'} ${name}${status === 'OK' ? '' : '  - ' + status}`);
  if (status === 'OK') pass++;
}
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
