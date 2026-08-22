'use strict';

// Mock 'electron' the same way scripts/smoke-test.js does, purely so
// standardsService.js's transitive requires (evidenceService -> logger ->
// paths -> electron) can load in plain Node. Nothing in this script
// actually calls into Electron — computeIntegrityManifest() takes a plain
// directory path and walks it with fs directly.
const path = require('path');
const os = require('os');
const Module = require('module');

const fakeUserData = path.join(os.tmpdir(), 'standards-baseline-userdata-' + Date.now());
require('fs').mkdirSync(fakeUserData, { recursive: true });

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: () => fakeUserData,
    getVersion: () => '1.0.0-tool',
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-mock-virtual';
  return origResolve.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

const fs = require('fs');
const standardsService = require('../server/services/standardsService');

// --- CLI ---------------------------------------------------------------
// generate:  node scripts/generate-standards-baseline.js generate <rootDir> <outFile>
// verify:    node scripts/generate-standards-baseline.js verify   <rootDir> <baselineFile>

const [, , mode, rootDirArg, thirdArg] = process.argv;

if (!mode || !rootDirArg || !thirdArg) {
  console.error('Usage:');
  console.error('  node scripts/generate-standards-baseline.js generate <rootDir> <outFile>');
  console.error('  node scripts/generate-standards-baseline.js verify   <rootDir> <baselineFile>');
  process.exit(2);
}

const rootDir = path.resolve(rootDirArg);

if (mode === 'generate') {
  const manifest = standardsService.computeIntegrityManifest(rootDir);
  fs.writeFileSync(thirdArg, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote integrity baseline: ${thirdArg}`);
  console.log(`  folderName: ${manifest.folderName}`);
  console.log(`  dirCount:   ${manifest.dirCount}`);
  console.log(`  fileCount:  ${manifest.fileCount}`);
  process.exit(0);
} else if (mode === 'verify') {
  const baseline = JSON.parse(fs.readFileSync(thirdArg, 'utf8'));
  const current = standardsService.computeIntegrityManifest(rootDir);
  const diff = standardsService.compareIntegrityManifest(baseline, current);
  if (diff.identical) {
    console.log('✅ STRUCTURE IDENTICAL — no differences vs baseline');
    process.exit(0);
  } else {
    console.error('❌ DIFFERENCES FOUND vs baseline:');
    console.error(JSON.stringify(diff, null, 2));
    process.exit(1);
  }
} else {
  console.error(`Unknown mode "${mode}" — use "generate" or "verify"`);
  process.exit(2);
}
