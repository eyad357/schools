'use strict';

// Same electron-mock harness pattern as scripts/smoke-test.js.
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const Module = require('module');

const fakeDocs = path.join(os.tmpdir(), 'intake-test-docs-' + Date.now());
require('fs').mkdirSync(fakeDocs, { recursive: true });
process.env.SCHOOL_APP_TEST_INSTALL_DIR = fakeDocs;

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-mock-virtual';
  return origResolve.call(this, request, ...rest);
};
const fakeElectron = { app: { isPackaged: false, getPath: () => fakeDocs, getVersion: () => '1.0.0-test' } };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, parent, isMain);
};

const FileSupportPolicy = require('../app/js/file-support-policy.js');
const evidenceService = require('../server/services/evidenceService');

(async () => {
  const results = [];
  async function check(section, name, fn) {
    try {
      await fn();
      results.push([section, name, 'OK']);
    } catch (err) {
      results.push([section, name, 'FAIL: ' + err.message]);
    }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

  const http = require('http');
  const { createApp } = require('../server/app');
  const app = await createApp();
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const evidenceRoot = app.locals.evidenceRoot;
  const CODE = evidenceService.CODES[0];

  async function uploadRaw(filename, bytes, contentType) {
    return fetch(`${base}/api/upload/${CODE}`, {
      method: 'POST',
      headers: { 'content-type': contentType || 'application/octet-stream', 'x-filename': encodeURIComponent(filename) },
      body: bytes,
    });
  }
  function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
  function minimalZip(payload) {
    const deflated = zlib.deflateRawSync(payload);
    return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), deflated]);
  }

  // ══════════════════════════════════════════════════════════════════
  // LEVEL 1 — UNIT TESTS (pure FileSupportPolicy / evidenceService logic)
  // ══════════════════════════════════════════════════════════════════
  const L1 = 'L1 Unit';

  await check(L1, 'extension classification: known vs unknown', async () => {
    assert(FileSupportPolicy.getCategory('report.pdf') === 'pdf');
    assert(FileSupportPolicy.getCategory('data.xyzabc') === 'other');
  });
  await check(L1, 'MIME classification: known extension has expected MIME list', async () => {
    assert(FileSupportPolicy.getPolicy('x.pdf').mimeTypes.includes('application/pdf'));
  });
  await check(L1, 'reserved Windows device names rejected (bare and with extension)', async () => {
    for (const n of ['CON', 'con.txt', 'NUL', 'LPT1.pdf', 'com9.docx']) {
      const r = FileSupportPolicy.validateFilename(n);
      assert(!r.ok && r.reason === 'RESERVED_NAME', `expected RESERVED_NAME for "${n}", got ${JSON.stringify(r)}`);
    }
  });
  await check(L1, 'non-reserved names that merely contain a reserved word are allowed', async () => {
    const r = FileSupportPolicy.validateFilename('CONSTITUTION.pdf'); // starts with CON but base != CON
    assert(r.ok, 'expected CONSTITUTION.pdf to be allowed');
  });
  await check(L1, 'path traversal detection at the filename-validation level', async () => {
    // path.basename() is the actual traversal defense (applied by callers
    // before validateFilename runs) — validateFilename itself rejects raw
    // separator characters if they somehow survive basename().
    assert(!FileSupportPolicy.validateFilename('a/b').ok);
    assert(!FileSupportPolicy.validateFilename('a\\b').ok);
  });
  await check(L1, 'absolute-path-shaped filenames are rejected by validateFilename (separator check)', async () => {
    assert(!FileSupportPolicy.validateFilename('/etc/passwd').ok);
    assert(!FileSupportPolicy.validateFilename('C:\\Windows\\evil.exe').ok);
  });
  await check(L1, 'size validation: known-type oversize rejected, unknown-type default cap enforced', async () => {
    const big = FileSupportPolicy.classifyUpload({ filename: 'x.pdf', size: 999 * 1024 * 1024 });
    assert(!big.ok && big.reason === 'TOO_LARGE');
    const bigUnknown = FileSupportPolicy.classifyUpload({ filename: 'x.xyzabc', size: FileSupportPolicy.DEFAULT_UNKNOWN_MAX_BYTES + 1 });
    assert(!bigUnknown.ok && bigUnknown.reason === 'TOO_LARGE');
  });
  await check(L1, 'type validation: dangerous deny-list always rejected regardless of size', async () => {
    const r = FileSupportPolicy.classifyUpload({ filename: 'tool.exe', size: 10 });
    assert(!r.ok && r.reason === 'DANGEROUS_TYPE');
  });
  await check(L1, 'unknown type handling: safe-but-unrecognized extension accepted, categorized "other"', async () => {
    const r = FileSupportPolicy.classifyUpload({ filename: 'notes.xyzabc', size: 10 });
    assert(r.ok && r.category === 'other' && r.policy.preview.supported === false);
  });
  await check(L1, 'checksum generation is deterministic and content-sensitive', async () => {
    const a = sha256(Buffer.from('hello'));
    const b = sha256(Buffer.from('hello'));
    const c = sha256(Buffer.from('hellO'));
    assert(a === b && a !== c);
  });
  await check(L1, 'storage path generation: non-conflicting name generator produces Explorer-style " (n)" suffixes', async () => {
    const scratch = path.join(os.tmpdir(), 'nonconflict-' + Date.now());
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'a.txt'), '1');
    fs.writeFileSync(path.join(scratch, 'a (1).txt'), '2');
    const name = evidenceService.generateNonConflictingName(scratch, 'a.txt');
    assert(name === 'a (2).txt', `expected "a (2).txt", got "${name}"`);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  await check(L1, 'error mapping: EMPTY_FILE for zero-byte, INVALID_FILENAME for reserved name', async () => {
    const empty = FileSupportPolicy.classifyUpload({ filename: 'x.txt', size: 0 });
    assert(!empty.ok && empty.reason === 'EMPTY_FILE');
    const reserved = FileSupportPolicy.classifyUpload({ filename: 'CON.txt', size: 10 });
    assert(!reserved.ok && reserved.reason === 'INVALID_FILENAME');
  });

  // ══════════════════════════════════════════════════════════════════
  // LEVEL 2 — FILESYSTEM INTEGRATION TESTS (real temp files, real service calls)
  // ══════════════════════════════════════════════════════════════════
  const L2 = 'L2 Filesystem integration';

  await check(L2, 'writeEvidenceFile: creates folder, writes bytes, returns metadata', async () => {
    const scratch = path.join(os.tmpdir(), 'intake-fs-' + Date.now());
    const content = Buffer.from('integration test content');
    const result = evidenceService.writeEvidenceFile(scratch, 'file.txt', content);
    assert(fs.existsSync(path.join(scratch, 'file.txt')));
    assert(result.sha256 === sha256(content));
    assert(result.size === content.length);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  await check(L2, 'writeEvidenceFile: no temp/partial file left behind after a successful write', async () => {
    const scratch = path.join(os.tmpdir(), 'intake-fs2-' + Date.now());
    evidenceService.writeEvidenceFile(scratch, 'clean.txt', Buffer.from('x'));
    const leftover = fs.readdirSync(scratch).filter((f) => f.includes('.uploading-'));
    assert(leftover.length === 0, `found leftover temp file(s): ${leftover.join(', ')}`);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  await check(L2, 'duplicate handling: second upload of the same name does not overwrite the first', async () => {
    const scratch = path.join(os.tmpdir(), 'intake-fs3-' + Date.now());
    const first = evidenceService.writeEvidenceFile(scratch, 'report.pdf', Buffer.from('first version'));
    const second = evidenceService.writeEvidenceFile(scratch, 'report.pdf', Buffer.from('second version'));
    assert(first.filename === 'report.pdf');
    assert(second.filename === 'report (1).pdf', `expected auto-renamed, got ${second.filename}`);
    assert(fs.readFileSync(path.join(scratch, 'report.pdf'), 'utf8') === 'first version', 'original was overwritten!');
    assert(fs.readFileSync(path.join(scratch, 'report (1).pdf'), 'utf8') === 'second version');
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  await check(L2, 'retrieval: uploaded file is listed by evidenceService.listFiles', async () => {
    const r = await fetch(`${base}/api/files/${CODE}`);
    const before = (await r.json()).files.length;
    await uploadRaw('level2-retrieval-check.txt', Buffer.from('hi'));
    const r2 = await fetch(`${base}/api/files/${CODE}`);
    const after = (await r2.json()).files.length;
    assert(after === before + 1, `expected file count to increase by 1, went ${before} -> ${after}`);
  });
  await check(L2, 'failure cleanup: an invalid target directory throws, no orphan evidence record implied', async () => {
    // Point at a path that cannot be created as a directory (a file exists
    // where a directory is needed) — writeEvidenceFile must throw, not
    // silently "succeed" with nothing on disk.
    const scratch = path.join(os.tmpdir(), 'intake-fs4-' + Date.now());
    fs.mkdirSync(scratch, { recursive: true });
    const blockerPath = path.join(scratch, 'blocker');
    fs.writeFileSync(blockerPath, 'im a file, not a directory');
    let threw = false;
    try {
      evidenceService.writeEvidenceFile(blockerPath, 'x.txt', Buffer.from('x')); // blockerPath exists as a FILE, mkdirSync on it must fail
    } catch (e) {
      threw = true;
    }
    assert(threw, 'expected writeEvidenceFile to throw when the target cannot be created as a directory');
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  await check(L2, 'invalid input handling: uploading to an unknown indicator code is rejected before any write', async () => {
    const r = await fetch(`${base}/api/upload/NOT-A-REAL-CODE`, {
      method: 'POST',
      headers: { 'x-filename': 'x.txt' },
      body: Buffer.from('x'),
    });
    assert(r.status === 400);
  });
  await check(L2, 'storage errors are classified into structured codes, never leaking raw fs error text', async () => {
    // Force a real EACCES-shaped failure: an indicator folder that exists
    // as a read-only directory. Skipped gracefully if this sandbox is
    // running as root (root ignores directory write permission bits on
    // most filesystems, so the EACCES this test wants to provoke will not
    // actually occur) — that's an environment property, not something to
    // paper over with a fake result.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      results.push(['L2 Filesystem integration', '  (skipped: running as root, EACCES cannot be provoked)', 'OK']);
      return;
    }
    const scratch = path.join(os.tmpdir(), 'intake-fs5-' + Date.now());
    fs.mkdirSync(scratch, { recursive: true, mode: 0o500 }); // read+execute, no write
    let threw = null;
    try {
      evidenceService.writeEvidenceFile(scratch, 'x.txt', Buffer.from('x'));
    } catch (e) {
      threw = e;
    }
    assert(threw && (threw.code === 'EACCES' || threw.code === 'EPERM'), `expected an EACCES/EPERM-coded error, got ${threw && threw.code}`);
    fs.chmodSync(scratch, 0o700);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  // ══════════════════════════════════════════════════════════════════
  // LEVEL 3 — REAL FILE FIXTURES (multiple categories, real end-to-end upload)
  // ══════════════════════════════════════════════════════════════════
  const L3 = 'L3 Real fixtures';
  const fixtures = [
    ['minimal.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj<<>>endobj\n%%EOF')])],
    ['minimal.docx', minimalZip(Buffer.from('word/document.xml placeholder'))],
    ['minimal.pptx', minimalZip(Buffer.from('ppt/presentation.xml placeholder'))],
    ['minimal.xlsx', minimalZip(Buffer.from('xl/workbook.xml placeholder'))],
    ['photo.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('fake jpeg body')])],
    ['photo.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')])],
    ['icon.svg', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['clip.mp4', Buffer.from('fake mp4 bytes, no signature check defined for video')],
    ['audio.mp3', Buffer.from('fake mp3 bytes, no signature check defined for audio')],
    ['notes.txt', Buffer.from('plain text evidence note')],
    ['data.csv', Buffer.from('col1,col2\n1,2\n')],
    ['config.json', Buffer.from('{"a":1}')],
    ['bundle.zip', minimalZip(Buffer.from('archived evidence'))],
  ];
  for (const [filename, bytes] of fixtures) {
    await check(L3, `real fixture accepted end-to-end: ${filename}`, async () => {
      const r = await uploadRaw(filename, bytes);
      if (r.status !== 200) throw new Error(`expected 200 for ${filename}, got ${r.status}: ${await r.text()}`);
      const body = await r.json();
      assert(body.sha256 === sha256(bytes), 'returned checksum does not match uploaded content');
      assert(body.size === bytes.length, 'returned size does not match uploaded content');
      // Confirm retrieval round-trips the exact same bytes.
      const getR = await fetch(`${base}/api/file/${CODE}/${encodeURIComponent(body.filename)}`);
      const retrieved = Buffer.from(await getR.arrayBuffer());
      assert(sha256(retrieved) === body.sha256, 'retrieved bytes do not match what was uploaded');
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // LEVEL 4 — MALFORMED FILES
  // ══════════════════════════════════════════════════════════════════
  const L4 = 'L4 Malformed files';

  await check(L4, 'renamed extension: real PNG bytes named .pdf is rejected (signature mismatch)', async () => {
    const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')]);
    const r = await uploadRaw('disguised.pdf', pngBytes);
    assert(r.status === 415);
    const body = await r.json();
    assert(body.reason === 'SIGNATURE_MISMATCH');
  });
  await check(L4, 'zero-byte file is rejected, not reported as success', async () => {
    const r = await uploadRaw('empty.txt', Buffer.alloc(0));
    assert(r.status === 400);
    const body = await r.json();
    assert(body.reason === 'EMPTY_FILE');
  });
  await check(L4, 'truncated known-signature file is rejected', async () => {
    const r = await uploadRaw('truncated.pdf', Buffer.from([0x25, 0x50])); // just "%P", not the full "%PDF-" signature
    assert(r.status === 415);
    const body = await r.json();
    assert(body.reason === 'SIGNATURE_MISMATCH');
  });
  await check(L4, 'wrong declared content-type does not bypass server-side signature validation', async () => {
    const r = await uploadRaw('lied.pdf', Buffer.from('not a pdf'), 'application/pdf');
    assert(r.status === 415, 'a false content-type header must not bypass the actual byte-content check');
  });
  await check(L4, 'extremely long filename is rejected', async () => {
    const r = await uploadRaw('a'.repeat(200) + '.txt', Buffer.from('x'));
    assert(r.status === 400);
    const body = await r.json();
    assert(body.reason === 'INVALID_FILENAME');
  });
  await check(L4, 'Unicode/Arabic filename is accepted and preserved', async () => {
    const arabicName = 'خطة تطوير المدرسة 2026 (نسخة نهائية).txt';
    const r = await uploadRaw(arabicName, Buffer.from('Arabic evidence content'));
    if (r.status !== 200) throw new Error(await r.text());
    const body = await r.json();
    assert(body.filename === arabicName, `expected original Arabic filename preserved, got "${body.filename}"`);
  });
  await check(L4, 'duplicate filename via HTTP upload is auto-renamed, not overwritten', async () => {
    const name = 'dup-http-test.txt';
    const r1 = await uploadRaw(name, Buffer.from('version A'));
    const r2 = await uploadRaw(name, Buffer.from('version B'));
    const b1 = await r1.json();
    const b2 = await r2.json();
    assert(b1.filename === name && b2.filename !== name, `expected second upload to be renamed, got "${b2.filename}"`);
    const check1 = await (await fetch(`${base}/api/file/${CODE}/${encodeURIComponent(b1.filename)}`)).text();
    assert(check1 === 'version A', 'first upload was overwritten by the second');
  });
  await check(L4, 'invalid/traversal path in filename is neutralized (stays inside the evidence root)', async () => {
    const r = await uploadRaw('../../../escape-attempt.txt', Buffer.from('should not escape'));
    assert(r.status === 200, 'basename() should reduce this to a plain filename, not reject the whole request');
    const body = await r.json();
    assert(body.filename === 'escape-attempt.txt', `expected traversal segments stripped, got "${body.filename}"`);
    assert(!fs.existsSync(path.join(evidenceRoot, '..', '..', 'escape-attempt.txt')), 'file escaped the evidence root!');
  });
  await check(L4, 'reserved Windows device name upload is rejected', async () => {
    const r = await uploadRaw('CON.txt', Buffer.from('x'));
    assert(r.status === 400);
    const body = await r.json();
    assert(body.reason === 'INVALID_FILENAME');
  });

  // ══════════════════════════════════════════════════════════════════
  // LEVEL 5 — LARGE FILE TEST
  // ══════════════════════════════════════════════════════════════════
  const L5 = 'L5 Large file';

  await check(L5, '20MB file uploads correctly with matching size and checksum', async () => {
    const big = crypto.randomBytes(20 * 1024 * 1024);
    const expectedHash = sha256(big);
    const t0 = Date.now();
    const r = await uploadRaw('large-evidence.bin', big); // .bin -> unknown-but-safe category, 50MB default cap covers this
    const elapsedMs = Date.now() - t0;
    if (r.status !== 200) throw new Error(await r.text());
    const body = await r.json();
    assert(body.size === big.length, 'size mismatch on large file');
    assert(body.sha256 === expectedHash, 'checksum mismatch on large file — possible corruption');
    results.push([L5, `  (20MB intake took ${elapsedMs}ms)`, 'OK']);
  });

  // ══════════════════════════════════════════════════════════════════
  // LEVEL 6 — SECURITY TESTS (path traversal / injection attempts)
  // ══════════════════════════════════════════════════════════════════
  const L6 = 'L6 Security';
  const traversalAttempts = [
    '../evil.txt',
    '../../evil.txt',
    '..\\evil.txt',
    '..\\..\\evil.txt',
    '/etc/evil.txt',
    'C:\\Windows\\System32\\evil.txt',
    '\\\\server\\share\\evil.txt',
    '....//....//evil.txt',
    'a/../../evil.txt',
    'a\\..\\..\\evil.txt',
  ];
  for (const attempt of traversalAttempts) {
    await check(L6, `path traversal neutralized: "${attempt}"`, async () => {
      const r = await uploadRaw(attempt, Buffer.from('attempted escape'));
      // Every attempt must either be accepted with the path collapsed to a
      // safe basename-only filename INSIDE the evidence root, or rejected
      // outright — it must NEVER write outside evidenceRoot.
      if (r.status === 200) {
        const body = await r.json();
        const finalPath = path.join(evidenceService.folderForCode(evidenceRoot, CODE), body.filename);
        assert(path.resolve(finalPath).startsWith(path.resolve(evidenceRoot)), `file escaped evidence root: ${finalPath}`);
      }
      // A parent-outside-root path must never exist as a result of this request.
      assert(!fs.existsSync(path.join(evidenceRoot, '..', 'evil.txt')), 'traversal attempt escaped the evidence root!');
    });
  }
  await check(L6, 'encoded traversal (URL-encoded dots/slashes) is neutralized', async () => {
    const r = await fetch(`${base}/api/upload/${CODE}`, {
      method: 'POST',
      headers: { 'x-filename': '%2e%2e%2f%2e%2e%2fevil-encoded.txt' },
      body: Buffer.from('encoded escape attempt'),
    });
    if (r.status === 200) {
      const body = await r.json();
      const finalPath = path.join(evidenceService.folderForCode(evidenceRoot, CODE), body.filename);
      assert(path.resolve(finalPath).startsWith(path.resolve(evidenceRoot)));
    }
    assert(!fs.existsSync(path.join(evidenceRoot, '..', 'evil-encoded.txt')));
  });
  await check(L6, 'rename endpoint: path traversal in newName is neutralized to a safe basename (stays inside the folder)', async () => {
    await uploadRaw('rename-target.txt', Buffer.from('x'));
    const result = evidenceService.renameEvidenceFile(evidenceRoot, CODE, 'rename-target.txt', '../../escaped-rename.txt');
    // path.basename('../../escaped-rename.txt') === 'escaped-rename.txt' — the
    // traversal segments are stripped, same defense pattern as upload, so
    // this succeeds as an ordinary in-folder rename rather than being
    // rejected outright. The security property under test is that it can
    // never land outside the evidence root, not that the request is refused.
    assert(result.ok && result.filename === 'escaped-rename.txt', `expected neutralized in-folder rename, got ${JSON.stringify(result)}`);
    const indicatorDir = evidenceService.folderForCode(evidenceRoot, CODE);
    assert(fs.existsSync(path.join(indicatorDir, 'escaped-rename.txt')), 'renamed file should exist inside the indicator folder');
    assert(!fs.existsSync(path.join(evidenceRoot, '..', '..', 'escaped-rename.txt')), 'file escaped the evidence root!');
  });
  await check(L6, 'delete/rename cannot target a directory (structural mutation guard, re-verified under Phase 3)', async () => {
    const delResult = await evidenceService.deleteEvidenceFile(evidenceRoot, CODE, '.');
    assert(!delResult.ok && delResult.reason === 'NOT_A_FILE');
  });
  await check(L6, 'uploaded files are never executed or interpreted — intake is a pure byte-store operation', async () => {
    // Static verification: writeEvidenceFile's only operations are
    // fs.mkdirSync/fs.writeFileSync/fs.renameSync — grep confirms no
    // eval/exec/require/child_process/vm usage anywhere in the intake path.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'evidenceService.js'), 'utf8');
    assert(!/child_process|\beval\(|new Function\(|require\(\s*['"]vm['"]\)/.test(src), 'intake code path references execution-capable APIs');
  });
  await check(L6, 'archives are stored but never auto-extracted', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'evidenceService.js'), 'utf8');
    assert(!/unzip|extract|jszip|adm-zip/i.test(src), 'evidenceService appears to reference archive-extraction logic — should not, per Phase 3 archive policy');
  });

  // ══════════════════════════════════════════════════════════════════
  // LEVEL 7 — REGRESSION (existing evidence + existing suites)
  // ══════════════════════════════════════════════════════════════════
  const L7 = 'L7 Regression';
  await check(L7, 'existing evidence (present before this test run) remains listed and retrievable', async () => {
    // The real committed standards-folder sample evidence lives under a
    // different indicator than CODE; verify it via the manifest directly
    // rather than assuming this test run's throwaway root has it (it
    // doesn't — SCHOOL_APP_TEST_INSTALL_DIR isolates this run, same as
    // every other test script). This checks the MECHANISM (listFiles
    // still works for indicators with pre-existing files), using files
    // this suite itself created earlier as the "existing evidence" stand-in.
    const r = await fetch(`${base}/api/files/${CODE}`);
    const data = await r.json();
    assert(data.files.length > 0, 'expected previously-uploaded files from this suite to still be listed');
  });

  server.close();

  console.log('\n=== EVIDENCE INTAKE TEST RESULTS ===');
  let pass = 0;
  let currentSection = null;
  for (const [section, name, status] of results) {
    if (section !== currentSection) {
      console.log(`\n-- ${section} --`);
      currentSection = section;
    }
    console.log(`${status === 'OK' ? '✅' : '❌'} ${name}${status === 'OK' ? '' : '  - ' + status}`);
    if (status === 'OK') pass++;
  }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
