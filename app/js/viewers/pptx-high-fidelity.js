/* ════════════════════════════════════════════════════════════
   PPTX HIGH-FIDELITY FALLBACK — app/js/viewers/pptx-high-fidelity.js
   ────────────────────────────────────────────────────────────
   Phase 6C. Isolated, PPTX-specific module — nothing here leaks into
   viewer.js beyond the two small generic hooks it already exposes
   (ctx.isActive, ctx.switchToPdfView — see viewer.js's renderPptx()).

   Responsibilities:
     1. getPresentationRenderStrategy(nativeCapabilities) — pure decision
        function: should this file's toolbar suggest/offer the
        high-fidelity path, and why.
     2. checkAvailability() — asks the server whether LibreOffice is
        resolvable at all (cached — see note below).
     3. attachButton(ctx, {code, filename, nativeCapabilities}) — adds the
        toolbar button, owns its loading/error/disabled state, and on
        success calls ctx.switchToPdfView() (after re-checking
        ctx.isActive() — the conversion is a multi-second server round
        trip; the user may have opened a different file by the time it
        resolves, and that response must be discarded, not applied).

   Server contract (server/routes/pptxHighFidelity.js):
     GET  /api/pptx-high-fidelity/available
          -> { available: boolean }
     POST /api/pptx-high-fidelity/:code/:name
          -> streams back "Content-Type: application/pdf" on success,
             or a JSON { error, message } with a 4xx/5xx status on
             failure (LibreOffice missing / conversion timeout /
             conversion failed / invalid output).
   ════════════════════════════════════════════════════════════ */
const PptxHighFidelity = (function () {
  'use strict';

  // getPresentationRenderStrategy — pure, no I/O. `nativeCapabilities`
  // matches the shape pptx-viewer.js computes during its own parse pass
  // (see render()'s nativeCapabilities accumulator).
  function getPresentationRenderStrategy(nativeCapabilities) {
    const reasons = [];
    const c = nativeCapabilities || {};
    if (c.hasSmartArt) reasons.push('يحتوي هذا العرض على SmartArt (رسم تخطيطي ذكي)');
    if (c.degradedChartCount > 0) reasons.push(`يحتوي هذا العرض على ${c.degradedChartCount} رسم بياني من نوع غير مدعوم مباشرة (يُعرض كجدول بيانات)`);
    if (c.hasUnsupportedObjects) reasons.push('يحتوي هذا العرض على كائنات غير مدعومة (مثل ملفات مضمّنة)');
    if (c.hasEffects) reasons.push('يحتوي هذا العرض على تأثيرات بصرية متقدمة (ظلال/توهج/تأثيرات ثلاثية الأبعاد) لا تُعرض محليًا');
    if (c.hasAnimations) reasons.push('يحتوي هذا العرض على حركات/انتقالات — تُعرض الشريحة في حالتها الثابتة فقط');
    return { mode: reasons.length ? 'native-with-fallback' : 'native', reasons };
  }

  // Cached for the lifetime of the page — LibreOffice availability
  // cannot meaningfully change between two files opened moments apart
  // in the same session, so there's no reason to ask the server again
  // for every single PPTX the user opens.
  let availabilityCache = null;
  async function checkAvailability() {
    if (availabilityCache !== null) return availabilityCache;
    try {
      const res = await fetch(`${window.API || ''}/api/pptx-high-fidelity/available`);
      const data = await res.json();
      availabilityCache = !!data.available;
    } catch {
      availabilityCache = false;
    }
    return availabilityCache;
  }

  function attachButton(ctx, opts) {
    const { code, filename, strategy } = opts;
    const { addToolBtn, addSep, isActive, switchToPdfView } = ctx;
    // Availability check happens async, after the toolbar/slides have
    // already rendered — the native view is never blocked or delayed
    // waiting on it (matches "if native rendering is already visually
    // sufficient, do not force conversion").
    checkAvailability().then((available) => {
      if (!available) return;
      if (!isActive()) return; // user already moved on before this resolved
      addSep();
      const label = strategy.mode === 'native-with-fallback' ? '⚠ عرض بجودة عالية' : '🖹 عرض بجودة عالية';
      const title = strategy.reasons.length
        ? 'هذا العرض يحتوي على عناصر قد لا تظهر بدقة كاملة في العرض المباشر:\n' + strategy.reasons.join('\n') + '\n\nانقر لعرضه بجودة عالية عبر LibreOffice (قد يستغرق بضع ثوانٍ).'
        : 'عرض هذا الملف بجودة عالية عبر LibreOffice (قد يستغرق بضع ثوانٍ) — مفيد عند الحاجة لأعلى دقة ممكنة، مثل العرض أمام الزوار.';
      const btn = addToolBtn(label, title, () => convertAndShow());
      let converting = false;

      async function convertAndShow() {
        if (converting) return;
        converting = true;
        const originalLabel = btn.textContent;
        btn.textContent = '⏳ جارٍ التحويل…';
        btn.disabled = true;
        try {
          const res = await fetch(`${window.API || ''}/api/pptx-high-fidelity/${encodeURIComponent(code)}/${encodeURIComponent(filename)}`, { method: 'POST' });
          if (!isActive()) return; // the user opened a different file while this was in flight — discard
          if (!res.ok) {
            let message = 'تعذّر إنشاء عرض بجودة عالية لهذا الملف.';
            try { const errBody = await res.json(); if (errBody && errBody.message) message = errBody.message; } catch {}
            showFidelityError(ctx, message);
            return;
          }
          const blob = await res.blob();
          if (!isActive()) return; // re-check after the (potentially large) body finished downloading too
          const objectUrl = URL.createObjectURL(blob);
          // state.objectUrls is the shell's own revoke-on-cleanup list —
          // switchToPdfView() calls cleanupPrevious() internally, which
          // already revokes everything in it, so this blob URL is
          // guaranteed disposed whenever the user navigates away.
          if (ctx.state && ctx.state.objectUrls) ctx.state.objectUrls.push(objectUrl);
          await switchToPdfView(objectUrl);
          // switchToPdfView() rebuilds the toolbar for the PDF viewer
          // (generic, knows nothing about PPTX) — the one PPTX-specific
          // addition, a way back to the native render, is appended here
          // instead, right after it, rather than teaching the generic
          // PDF path about PPTX.
          if (isActive()) ctx.addToolBtn('⤺ العرض الأصلي', 'العودة إلى العرض المباشر داخل التطبيق', () => ctx.reopenNative());
        } catch (err) {
          if (isActive()) showFidelityError(ctx, 'تعذّر الاتصال بخدمة العرض بجودة عالية.');
        } finally {
          converting = false;
          if (document.body.contains(btn)) { btn.textContent = originalLabel; btn.disabled = false; }
        }
      }
    });
  }

  function showFidelityError(ctx, message) {
    const { esc, dom } = ctx;
    const toast = document.createElement('div');
    toast.className = 'dv-hifi-toast';
    toast.textContent = message;
    (dom.content.parentElement || dom.content).appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  return { getPresentationRenderStrategy, checkAvailability, attachButton };
})();
