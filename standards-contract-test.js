'use strict';

// Mock 'electron' the same way scripts/smoke-test.js does, so this can run
// as a plain Node script with no display and no real Electron runtime.
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

const fakeUserData = path.join(os.tmpdir(), 'standards-test-userdata-' + Date.now());
const fakeDocs = path.join(os.tmpdir(), 'standards-test-docs-' + Date.now());
fs.mkdirSync(fakeUserData, { recursive: true });
fs.mkdirSync(fakeDocs, { recursive: true });
process.env.SCHOOL_APP_TEST_INSTALL_DIR = fakeDocs;

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (name) => (name === 'userData' ? fakeUserData : name === 'documents' ? fakeDocs : os.tmpdir()),
    getVersion: () => '1.0.0-test',
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
  },
  shell: { openPath: async () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox: () => {} },
  BrowserWindow: class { constructor() {} loadURL() {} loadFile() {} once() {} on() {} show() {} focus() {} },
  ipcMain: { handle: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} },
  screen: {},
};
require.cache['electron-mock-virtual'] = { id: 'electron-mock-virtual', filename: 'electron-mock-virtual', loaded: true, exports: fakeElectron };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-mock-virtual';
  return origResolve.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, parent, isMain);
};

const paths = require('../electron/utils/paths');
const evidenceService = require('../server/services/evidenceService');
const standardsService = require('../server/services/standardsService');

(async () => {
  const results = [];
  async function check(name, fn) {
    try {
      await fn();
      results.push([name, 'OK']);
    } catch (err) {
      results.push([name, 'FAIL: ' + err.message]);
    }
  }
  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }

  const http = require('http');
  const { createApp } = require('../server/app');
  const app = await createApp();
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const evidenceRoot = app.locals.evidenceRoot;

  // 1. Standards root can be resolved.
  await check('1. standards root resolves to a non-empty absolute path', async () => {
    assert(typeof evidenceRoot === 'string' && evidenceRoot.length > 0, 'evidenceRoot is empty');
    assert(path.isAbsolute(evidenceRoot), 'evidenceRoot is not absolute');
    assert(standardsService.resolveRoot(evidenceRoot) === evidenceRoot, 'resolveRoot() did not return the same root');
  });

  // 2. Root exists.
  await check('2. resolved root exists on disk after app bootstrap', async () => {
    const exists = await standardsService.verifyRootExists(evidenceRoot);
    assert(exists === true, 'standards root does not exist after createApp() bootstrap');
  });

  // 3. Expected hierarchy exists.
  await check('3. expected domain/standard/indicator hierarchy exists under the root', async () => {
    const summary = standardsService.getStructureSummary();
    assert(summary.length === 4, `expected 4 domains, got ${summary.length}`);
    const totalIndicators = summary.reduce((n, d) => n + d.standards.reduce((m, s) => m + s.indicators.length, 0), 0);
    assert(totalIndicators === 52, `expected 52 indicators total, got ${totalIndicators}`);
  });

  // 4. Important expected folders exist.
  await check('4. every manifest indicator folder exists on disk (post-bootstrap)', async () => {
    const { missingFolders } = await evidenceService.integrityCheck(evidenceRoot, 'private');
    assert(missingFolders.length === 0, `missing folders: ${missingFolders.join(', ')}`);
  });

  // 5. Application can read the standards structure.
  await check('5. GET /api/structure returns the full indicator map via the HTTP boundary', async () => {
    const r = await fetch(`${base}/api/structure`);
    const d = await r.json();
    assert(d.total === 52, `expected total=52, got ${d.total}`);
    assert(Object.keys(d.indicatorMap).length === 52, 'indicatorMap does not have 52 entries');
  });

  // 6. Renderer does not independently discover the standards filesystem path.
  await check('6. renderer source contains no direct filesystem access', async () => {
    const rendererFiles = [
      path.join(__dirname, '..', 'app', 'index.html'),
      ...fs.readdirSync(path.join(__dirname, '..', 'app', 'js')).filter((f) => f.endsWith('.js')).map((f) => path.join(__dirname, '..', 'app', 'js', f)),
    ];
    for (const file of rendererFiles) {
      const src = fs.readFileSync(file, 'utf8');
      // require('fs') / require("fs") / window.electronAPI reaching into fs would be the red flag;
      // the renderer is expected to only ever use fetch()/EventSource against the HTTP API.
      assert(!/require\(\s*['"]fs['"]\s*\)/.test(src), `${path.basename(file)} contains a direct require('fs')`);
    }
    // The only filesystem-adjacent capability exposed to the renderer at all is the
    // native folder *picker* dialog (electron/preload/preload.js) — it returns a path
    // the user selected via the OS UI, it cannot read/write anything itself.
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload', 'preload.js'), 'utf8');
    assert(!/require\(\s*['"]fs['"]\s*\)/.test(preloadSrc), 'preload.js contains a direct require(\'fs\')');
  });

  // 7. Path resolution works from the expected runtime context.
  await check('7. EVIDENCE_FOLDER_NAME is the sole folder-name source, and evidenceRoot ends with it', async () => {
    assert(evidenceRoot.endsWith(paths.EVIDENCE_FOLDER_NAME), 'evidenceRoot does not end with EVIDENCE_FOLDER_NAME');
    assert(standardsService.getFolderName() === paths.EVIDENCE_FOLDER_NAME, 'standardsService.getFolderName() diverged from paths.js');
  });

  // 8. Missing/invalid root is handled safely.
  await check('8. a missing root is reported, not thrown, and self-heals', async () => {
    // Don't touch the real evidenceRoot — verify the *mechanism* using a
    // throwaway directory that mirrors the same shape.
    const scratchRoot = path.join(os.tmpdir(), 'standards-test-scratch-' + Date.now());
    const existsBefore = await standardsService.verifyRootExists(scratchRoot);
    assert(existsBefore === false, 'scratch root should not exist yet');
    const { issues } = await evidenceService.integrityCheck(scratchRoot, 'private');
    assert(issues.length === 1, 'integrityCheck() did not report the missing-root issue safely');
    await evidenceService.ensureAllFolders(scratchRoot);
    const existsAfter = await standardsService.verifyRootExists(scratchRoot);
    assert(existsAfter === true, 'ensureAllFolders() did not create the missing root');
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  // 9. No unexpected mutation occurs — the NOT_A_FILE guard added in Phase 2.
  await check('9. delete/rename refuse to target a directory (structural-mutation guard)', async () => {
    const scratchRoot = path.join(os.tmpdir(), 'standards-test-mutation-' + Date.now());
    await evidenceService.ensureAllFolders(scratchRoot);
    const code = evidenceService.CODES[0];
    const indicatorDir = evidenceService.folderForCode(scratchRoot, code);
    assert(fs.existsSync(indicatorDir), 'scratch indicator folder was not created');

    const delResult = await evidenceService.deleteEvidenceFile(scratchRoot, code, '.');
    assert(delResult.ok === false && delResult.reason === 'NOT_A_FILE', `expected NOT_A_FILE, got ${JSON.stringify(delResult)}`);
    assert(fs.existsSync(indicatorDir), 'indicator folder was deleted — structural mutation occurred!');

    const renResult = evidenceService.renameEvidenceFile(scratchRoot, code, '.', 'renamed-folder');
    assert(renResult.ok === false && renResult.reason === 'NOT_A_FILE', `expected NOT_A_FILE, got ${JSON.stringify(renResult)}`);
    assert(fs.existsSync(indicatorDir), 'indicator folder was renamed — structural mutation occurred!');

    // A real file inside the same folder must still be deletable/renameable —
    // this guard must not have broken the legitimate evidence-file case.
    fs.writeFileSync(path.join(indicatorDir, 'real-file.txt'), 'hello');
    const okDel = await evidenceService.deleteEvidenceFile(scratchRoot, code, 'real-file.txt');
    assert(okDel.ok === true, 'legitimate file delete was unexpectedly blocked');

    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  // 10. Integrity verification can detect a changed file.
  await check('10. computeIntegrityManifest + compareIntegrityManifest detect content drift', async () => {
    const scratchRoot = path.join(os.tmpdir(), 'standards-test-integrity-' + Date.now());
    fs.mkdirSync(path.join(scratchRoot, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(scratchRoot, 'sub', 'a.txt'), 'original content');

    const baseline = standardsService.computeIntegrityManifest(scratchRoot);
    const sameAgain = standardsService.computeIntegrityManifest(scratchRoot);
    const identicalDiff = standardsService.compareIntegrityManifest(baseline, sameAgain);
    assert(identicalDiff.identical === true, 'two manifests of unchanged content were reported as different');

    // Mutate content — this must be detected.
    fs.writeFileSync(path.join(scratchRoot, 'sub', 'a.txt'), 'TAMPERED content');
    const afterChange = standardsService.computeIntegrityManifest(scratchRoot);
    const changedDiff = standardsService.compareIntegrityManifest(baseline, afterChange);
    assert(changedDiff.identical === false, 'content tampering was not detected');
    assert(changedDiff.changed.length === 1, `expected exactly 1 changed entry, got ${changedDiff.changed.length}`);

    // Add + remove — both must be detected too.
    fs.writeFileSync(path.join(scratchRoot, 'sub', 'new.txt'), 'new');
    fs.rmSync(path.join(scratchRoot, 'sub', 'a.txt'));
    const afterAddRemove = standardsService.computeIntegrityManifest(scratchRoot);
    const addRemoveDiff = standardsService.compareIntegrityManifest(baseline, afterAddRemove);
    assert(addRemoveDiff.added.includes('sub/new.txt'), 'added file was not detected');
    assert(addRemoveDiff.removed.includes('sub/a.txt'), 'removed file was not detected');

    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  server.close();

  console.log('\n=== STANDARDS CONTRACT TEST RESULTS ===');
  let pass = 0;
  for (const [name, status] of results) {
    console.log(`${status === 'OK' ? '✅' : '❌'} ${name}${status === 'OK' ? '' : '  - ' + status}`);
    if (status === 'OK') pass++;
  }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
