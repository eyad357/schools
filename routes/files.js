'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const evidenceService = require('../services/evidenceService');
const FileSupportPolicy = require('../../app/js/file-support-policy.js');

const rawBody = express.raw({ type: '*/*', limit: '200mb' });

function decodeFilename(headerVal, fallback) {
  if (!headerVal) return fallback;
  try { return decodeURIComponent(headerVal); } catch { return fallback; }
}

// GET /api/files/:code
router.get('/files/:code', async (req, res) => {
  const { evidenceRoot } = req.app.locals;
  const data = await evidenceService.listFiles(evidenceRoot, req.params.code);
  res.json(data);
});

// GET /api/file/:code/:name  — view/download a single file
router.get('/file/:code/:name', async (req, res) => {
  const { evidenceRoot } = req.app.locals;
  const filePath = await evidenceService.getFilePath(evidenceRoot, req.params.code, req.params.name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'الملف غير موجود' });
  res.sendFile(filePath);
});

// DELETE /api/file/:code/:name
router.delete('/file/:code/:name', async (req, res) => {
  const { evidenceRoot, store } = req.app.locals;
  const result = await evidenceService.deleteEvidenceFile(evidenceRoot, req.params.code, req.params.name);
  if (!result.ok) {
    // NOT_A_FILE: the resolved target is a directory (structural, part of
    // the immutable standards hierarchy), not evidence — see Phase 2's
    // "Read-Only Contract". Reported as 404 too, same as NOT_FOUND: from
    // the API consumer's point of view both mean "no such evidence file",
    // and the app's UI never lists directories as deletable files in the
    // first place, so this branch is only reachable via a crafted request.
    return res.status(404).json({ error: 'الملف غير موجود' });
  }
  store.addAudit({ action: 'file_deleted', target: req.params.name, indicator: req.params.code, details: 'حُذف من داخل التطبيق' });
  res.json({ success: true });
});

// POST /api/upload/:code and /api/upload-raw/:code — both behave the same:
// raw request body = file bytes, x-filename header = original name.
//
// Validation is authoritative here (never trust the client) and goes
// through FileSupportPolicy — the single source of truth for which
// extensions are allowed, their size limits, and (where practical) their
// expected magic bytes. See FILE-SUPPORT-ARCHITECTURE-REPORT.md.
async function handleUpload(req, res) {
  const { evidenceRoot, store } = req.app.locals;
  const code = req.params.code;
  const dir = evidenceService.folderForCode(evidenceRoot, code);
  if (!dir) return res.status(400).json({ error: 'مؤشر غير معروف' });

  const filename = path.basename(decodeFilename(req.headers['x-filename'], `file-${Date.now()}`));
  const body = req.body || Buffer.alloc(0);

  const verdict = FileSupportPolicy.classifyUpload({
    filename,
    size: body.length,
    headerBytes: body.length ? body.subarray(0, 16) : null,
  });
  if (!verdict.ok) {
    store.addAudit({
      action: 'file_upload_rejected', target: filename, indicator: code,
      details: `${verdict.reason}: ${verdict.friendlyDetail}`,
    });
    return res.status(415).json({
      error: verdict.friendlyTitle,
      detail: verdict.friendlyDetail,
      reason: verdict.reason,
      extension: verdict.ext,
      allowedExtensions: FileSupportPolicy.allowedExtensionsList(),
    });
  }

  try {
    evidenceService.writeEvidenceFile(dir, filename, body);
    store.addAudit({ action: 'file_uploaded', target: filename, indicator: code });
    res.json({ success: true, filename });
  } catch (err) {
    res.status(500).json({ error: 'فشل حفظ الملف: ' + err.message });
  }
}

router.post('/upload/:code', rawBody, handleUpload);
router.post('/upload-raw/:code', rawBody, handleUpload);

// GET /api/file-policy — the same FileSupportPolicy table the server
// validates against, exposed so the frontend never has to hardcode its
// own copy of what's allowed (used for client-side pre-upload checks and
// the "supported formats" messaging shown to the user).
router.get('/file-policy', (req, res) => {
  res.json({
    extensions: FileSupportPolicy.EXTENSIONS,
    categories: FileSupportPolicy.CATEGORIES,
    allowedExtensions: FileSupportPolicy.allowedExtensionsList(),
  });
});

// POST /api/open-folder/:code — reveals the indicator folder in the OS file explorer
router.post('/open-folder/:code', async (req, res) => {
  const { evidenceRoot } = req.app.locals;
  const dir = evidenceService.folderForCode(evidenceRoot, req.params.code);
  if (!dir) return res.status(400).json({ error: 'مؤشر غير معروف' });
  fs.mkdirSync(dir, { recursive: true });
  try {
    const { shell } = require('electron');
    await shell.openPath(dir);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/file/:code/rename — { oldName, newName } in the JSON body.
// Renames the physical file on disk. The existing folder-watcher picks up
// the resulting unlink+add pair automatically, so the SSE refresh and the
// audit log's "file_detected"/"file_deleted" entries keep working exactly
// as they already do for any other filesystem change — no watcher changes
// needed. We additionally log a clearer "file_renamed" entry here so the
// audit trail reads naturally instead of just delete+add.
router.patch('/file/:code/rename', async (req, res) => {
  const { evidenceRoot, store } = req.app.locals;
  const { oldName, newName } = req.body || {};
  if (!oldName || !newName) return res.status(400).json({ error: 'اسم الملف الحالي والاسم الجديد مطلوبان' });

  let result;
  try {
    result = evidenceService.renameEvidenceFile(evidenceRoot, req.params.code, oldName, newName);
  } catch (err) {
    return res.status(500).json({ error: 'فشلت إعادة التسمية: ' + err.message });
  }

  if (!result.ok) {
    switch (result.reason) {
      case 'UNKNOWN_INDICATOR': return res.status(400).json({ error: 'مؤشر غير معروف' });
      case 'INVALID_NAME': return res.status(400).json({ error: 'اسم الملف الجديد غير صالح' });
      case 'INVALID_CHARS': return res.status(400).json({ error: 'اسم الملف يحتوي على رموز غير مسموح بها' });
      case 'INVALID_PATH': return res.status(400).json({ error: 'مسار غير صالح' });
      case 'SOURCE_NOT_FOUND': return res.status(404).json({ error: 'الملف الأصلي غير موجود' });
      // NOT_A_FILE: the resolved source is a directory (structural, part
      // of the immutable standards hierarchy), not evidence — see Phase
      // 2's "Read-Only Contract". Reported as 404 too, same as
      // SOURCE_NOT_FOUND: the app's UI never lists directories as
      // renameable files, so this branch is only reachable via a crafted
      // request, same reasoning as the DELETE endpoint above.
      case 'NOT_A_FILE': return res.status(404).json({ error: 'الملف الأصلي غير موجود' });
      case 'DUPLICATE': return res.status(409).json({ error: `يوجد ملف آخر بهذا الاسم بالفعل: ${result.filename}` });
      /* istanbul ignore next — no known code path returns an unlisted reason */
      default: return res.status(500).json({ error: 'فشلت إعادة التسمية' });
    }
  }

  if (result.noop) {
    return res.json({ success: true, filename: result.filename }); // no-op rename (e.g. case-only on case-insensitive FS)
  }

  store.addAudit({ action: 'file_renamed', target: `${result.oldName} ← ${result.filename}`, indicator: req.params.code, details: 'أُعيدت تسميته من داخل التطبيق' });
  res.json({ success: true, filename: result.filename });
});

// POST /api/open-file/:code/:name — opens the file with the OS default
// application (mirrors /api/open-folder/:code but targets the file itself).
router.post('/open-file/:code/:name', async (req, res) => {
  const { evidenceRoot } = req.app.locals;
  const filePath = await evidenceService.getFilePath(evidenceRoot, req.params.code, req.params.name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'الملف غير موجود' });
  try {
    const { shell } = require('electron');
    const errMsg = await shell.openPath(filePath);
    if (errMsg) return res.status(500).json({ error: errMsg });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
