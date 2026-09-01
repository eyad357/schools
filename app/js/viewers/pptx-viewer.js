/* ════════════════════════════════════════════════════════════
   PRESENTATION (.pptx) VIEWER ENGINE — Phase 7.5
   ────────────────────────────────────────────────────────────
   Specialized viewer engine, split out of the viewer.js monolith so
   the shell (viewer.js) doesn't need to know anything about OOXML
   slide structure, and this file doesn't need to know anything about
   the shell's toolbar/state/DOM plumbing beyond the small `ctx`
   contract below.

   Contract: window.PptxViewer.render(ctx) where ctx provides:
     ctx.fetchBytes()        -> Promise<ArrayBuffer>  current file's bytes
     ctx.showLoading(msg)    -> shows the shell's loading state
     ctx.showError(title, body) -> shows the shell's error state
     ctx.setInfoExtra(html)  -> populates the shell's info panel
     ctx.addSearchToggle()   -> wires the shell's in-viewer search button
     ctx.esc(str)            -> shared HTML-escaping helper
     ctx.dom.content         -> the shell's content container element
     ctx.dom.statusLeft      -> the shell's status-bar left-side element
     ctx.state               -> the shell's current-file state object
                                 (only `state.searchTarget` is written here)

   Depends on the globally-loaded JSZip vendor bundle and the browser's
   native DOMParser — both already loaded before this script by
   app/index.html, same as every other viewer engine.

   This approximates real slide layout rather than just dumping text:
   every shape's on-slide position/size (<a:xfrm>) is preserved as a
   percentage of the real slide dimensions (read from
   ppt/presentation.xml's <p:sldSz>), so text boxes, titles, and images
   land in roughly the right place relative to each other instead of
   being flattened into one title+bullet-list column. Solid slide
   background fills, per-paragraph RTL/alignment, and simple tables are
   also read directly from the OOXML.

   Still NOT a real PowerPoint rendering engine — no actual PowerPoint
   fonts (the browser substitutes its own), no gradients/shadows/theme
   colors, no animations or transitions, no charts/SmartArt (their text
   runs, where present in the XML, are extracted; the graphic itself is
   not). That is a genuine, disclosed limitation (see fidelity:'partial'
   in file-support-policy.js), not a bug — building a full OOXML
   rendering engine client-side is out of scope for a document evidence
   viewer; see FILE-SUPPORT-ARCHITECTURE-REPORT.md for the recommended
   (separately-scoped) server-side-conversion alternative.
   ════════════════════════════════════════════════════════════ */
const PptxViewer = (function () {
  'use strict';

  // Resolves an OOXML relationship Target (e.g. "../media/image1.png") against
  // the directory of the file that referenced it (e.g. "ppt/slides"), the way
  // a real zip/relative-path resolver would — simple string concatenation
  // breaks on the leading "../" that PowerPoint always uses for media refs.
  function resolveOoxmlPath(baseDir, target) {
    const baseParts = baseDir.split('/').filter(Boolean);
    const targetParts = target.split('/').filter(Boolean);
    for (const part of targetParts) {
      if (part === '..') baseParts.pop();
      else if (part === '.') continue;
      else baseParts.push(part);
    }
    return baseParts.join('/');
  }

  // Converts a shape's <a:xfrm><a:off/><a:ext/></a:xfrm> (EMU units, the
  // OOXML measurement unit — 914400 per inch) into a position expressed as
  // a PERCENTAGE of the slide's real dimensions. Percentages (not px) are
  // what let the same shape land in the same relative spot on the slide
  // canvas regardless of how large that canvas is actually rendered.
  function getXfrmPercent(shapeNode, slideCxEmu, slideCyEmu) {
    if (!shapeNode) return null;
    const xfrm = shapeNode.getElementsByTagName('a:xfrm')[0];
    if (!xfrm) return null;
    const off = xfrm.getElementsByTagName('a:off')[0];
    const ext = xfrm.getElementsByTagName('a:ext')[0];
    if (!off || !ext) return null;
    const x = parseInt(off.getAttribute('x'), 10);
    const y = parseInt(off.getAttribute('y'), 10);
    const cx = parseInt(ext.getAttribute('cx'), 10);
    const cy = parseInt(ext.getAttribute('cy'), 10);
    if (![x, y, cx, cy].every(Number.isFinite)) return null;
    return {
      left: (x / slideCxEmu) * 100,
      top: (y / slideCyEmu) * 100,
      width: (cx / slideCxEmu) * 100,
      height: (cy / slideCyEmu) * 100,
    };
  }
  // A paragraph is RTL if pPr explicitly says so, OR — since PowerPoint
  // exports from Arabic-locale authors don't always set rtl="1" on every
  // paragraph — if the extracted text itself is predominantly Arabic
  // script. Explicit markup wins; script sniffing is only a fallback.
  function paragraphIsRtl(pNode, text) {
    const pPr = pNode.getElementsByTagName('a:pPr')[0];
    if (pPr && pPr.getAttribute('rtl') === '1') return true;
    if (pPr && pPr.getAttribute('rtl') === '0') return false;
    return /[\u0600-\u06FF\u0750-\u077F]/.test(text);
  }
  // Only prefixes a bullet glyph when the paragraph's own properties
  // actually define one (a:buChar/a:buAutoNum) — a paragraph with
  // <a:buNone/> or no bullet element at all is plain body/title text, and
  // guessing wrong in either direction looks worse than leaving it be.
  function paragraphBulletPrefix(pNode) {
    const pPr = pNode.getElementsByTagName('a:pPr')[0];
    if (!pPr) return '';
    if (pPr.getElementsByTagName('a:buNone').length) return '';
    const buChar = pPr.getElementsByTagName('a:buChar')[0];
    if (buChar && buChar.getAttribute('char')) return buChar.getAttribute('char') + ' ';
    if (pPr.getElementsByTagName('a:buAutoNum').length) return '• ';
    return '';
  }
  function looksArabicLine(text) {
    return /[\u0600-\u06FF\u0750-\u077F]/.test(text);
  }
  const ALGN_TO_CSS = { l: 'left', ctr: 'center', r: 'right', just: 'justify' };
  function paragraphAlign(pNode) {
    const pPr = pNode.getElementsByTagName('a:pPr')[0];
    const algn = pPr && pPr.getAttribute('algn');
    return ALGN_TO_CSS[algn] || '';
  }
  // Slide background: only the common, unambiguous case (a flat solid
  // RGB fill declared directly on the slide) is resolved. Theme-color
  // references, gradients, and picture fills would need full theme/master
  // resolution to render correctly — attempting a wrong guess (e.g. a
  // hardcoded gray for every schemeClr) would misrepresent the actual
  // design more than just leaving the default white background, so those
  // cases are deliberately left unresolved rather than approximated.
  function getSlideBackgroundColor(slideXdoc) {
    const bg = slideXdoc.getElementsByTagName('p:bg')[0];
    if (!bg) return null;
    const srgb = bg.getElementsByTagName('a:srgbClr')[0];
    return srgb ? '#' + srgb.getAttribute('val') : null;
  }

  async function render(ctx) {
    const { fetchBytes, showLoading, showError, setInfoExtra, addSearchToggle, esc, dom, state } = ctx;
    showLoading('جارٍ تحليل عرض PowerPoint…');
    if (typeof JSZip === 'undefined') { showError('تعذّر تحميل عارض العروض', 'مكوّن العرض غير متاح.'); return; }
    try {
      const buf = await fetchBytes();
      const zip = await JSZip.loadAsync(buf);
      const slideFiles = Object.keys(zip.files)
        .filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
        .sort((a, b) => {
          const na = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
          const nb = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
          return na - nb;
        });
      if (!slideFiles.length) throw new Error('no slides found');

      const parser = new DOMParser();

      // Real slide canvas size in EMU — everything is positioned as a
      // percentage of this, so the aspect ratio (16:9, 4:3, or custom)
      // matches the source file instead of being hardcoded.
      let slideCx = 12192000, slideCy = 6858000; // PowerPoint's modern 16:9 default, used only if presentation.xml is missing/unreadable
      const presFile = zip.file('ppt/presentation.xml');
      if (presFile) {
        const presXdoc = parser.parseFromString(await presFile.async('text'), 'application/xml');
        const sz = presXdoc.getElementsByTagName('p:sldSz')[0];
        const cx = sz && parseInt(sz.getAttribute('cx'), 10);
        const cy = sz && parseInt(sz.getAttribute('cy'), 10);
        if (Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0) { slideCx = cx; slideCy = cy; }
      }

      // Extracts one shape (text box/title/body placeholder) into a
      // positioned block. Returns null for shapes with no visible content
      // (empty text boxes, purely decorative shapes) so they don't render
      // as blank overlapping rectangles.
      function extractTextShape(sp) {
        const paras = Array.from(sp.getElementsByTagName('a:p'));
        const lines = [];
        for (const p of paras) {
          const runs = Array.from(p.getElementsByTagName('a:t')).map(t => t.textContent).join('');
          if (!runs.trim()) continue;
          lines.push({
            text: runs,
            rtl: paragraphIsRtl(p, runs),
            align: paragraphAlign(p),
            bullet: paragraphBulletPrefix(p),
          });
        }
        if (!lines.length) return null;
        const ph = sp.getElementsByTagName('p:ph')[0];
        const isTitle = !!(ph && /title|ctrTitle/i.test(ph.getAttribute('type') || ''));
        const pos = getXfrmPercent(sp.getElementsByTagName('p:spPr')[0], slideCx, slideCy);
        const html = lines.map(l =>
          `<div class="dv-slide-line"${l.rtl ? ' dir="rtl"' : ''}${l.align ? ` style="text-align:${l.align}"` : ''}>${esc(l.bullet + l.text)}</div>`
        ).join('');
        return { kind: isTitle ? 'title' : 'text', pos, html, isTitle };
      }

      async function extractImageShape(pic, relMap) {
        const pos = getXfrmPercent(pic.getElementsByTagName('p:spPr')[0], slideCx, slideCy);
        const blip = pic.getElementsByTagName('a:blip')[0];
        const rId = blip && blip.getAttribute('r:embed');
        const target = rId && relMap[rId];
        if (!target) return null;
        const mediaPath = resolveOoxmlPath('ppt/slides', target);
        const mf = zip.file(mediaPath);
        if (!mf) return null;
        const base64 = await mf.async('base64');
        const ext = mediaPath.split('.').pop().toLowerCase();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' }[ext] || 'image/png';
        return { kind: 'image', pos, html: `<img src="data:${mime};base64,${base64}" alt="">` };
      }

      function extractTable(graphicFrame) {
        const tbl = graphicFrame.getElementsByTagName('a:tbl')[0];
        if (!tbl) return null;
        const rows = Array.from(tbl.getElementsByTagName('a:tr'));
        if (!rows.length) return null;
        const rowsHtml = rows.map(tr => {
          const cells = Array.from(tr.getElementsByTagName('a:tc'));
          const cellsHtml = cells.map(tc => {
            const text = Array.from(tc.getElementsByTagName('a:t')).map(t => t.textContent).join(' ');
            return `<td>${esc(text)}</td>`;
          }).join('');
          return `<tr>${cellsHtml}</tr>`;
        }).join('');
        // <p:graphicFrame>'s own xfrm is a direct child, not under p:spPr
        // (unlike <p:sp>/<p:pic>) — OOXML puts it directly under
        // <p:xfrm> at the graphicFrame level.
        const pos = getXfrmPercent(graphicFrame, slideCx, slideCy);
        return { kind: 'table', pos, html: `<table class="dv-slide-table">${rowsHtml}</table>` };
      }

      const slides = [];
      for (const slidePath of slideFiles) {
        const xmlText = await zip.file(slidePath).async('text');
        const xdoc = parser.parseFromString(xmlText, 'application/xml');

        const relsPath = slidePath.replace('slides/slide', 'slides/_rels/slide') + '.rels';
        const relsFile = zip.file(relsPath);
        let relMap = {};
        if (relsFile) {
          const relsXml = parser.parseFromString(await relsFile.async('text'), 'application/xml');
          Array.from(relsXml.getElementsByTagName('Relationship')).forEach(r => {
            relMap[r.getAttribute('Id')] = r.getAttribute('Target');
          });
        }

        const spTree = xdoc.getElementsByTagName('p:spTree')[0];
        const topLevelShapes = spTree ? Array.from(spTree.children) : [];
        const shapes = [];
        let title = '';
        for (const node of topLevelShapes) {
          const tag = node.tagName;
          if (tag === 'p:sp') {
            const shape = extractTextShape(node);
            if (shape) {
              if (shape.isTitle && !title) title = shape.html.replace(/<[^>]+>/g, '');
              shapes.push(shape);
            }
          } else if (tag === 'p:pic') {
            const img = await extractImageShape(node, relMap);
            if (img) shapes.push(img);
          } else if (tag === 'p:graphicFrame') {
            const table = extractTable(node);
            if (table) shapes.push(table);
          } else if (tag === 'p:grpSp') {
            // Grouped shapes: nested transforms would need full group
            // coordinate-space math to position exactly, which isn't
            // worth the complexity for a preview — instead, resolve the
            // group's own bounding box (its <p:grpSpPr><a:xfrm>) and stack
            // its children's text inside it. Approximate, but every
            // group's text still appears roughly where the group itself
            // sits on the slide, rather than being silently dropped.
            const groupPos = getXfrmPercent(node.getElementsByTagName('p:grpSpPr')[0], slideCx, slideCy);
            const innerParas = Array.from(node.getElementsByTagName('a:p'));
            const innerLines = innerParas
              .map(p => Array.from(p.getElementsByTagName('a:t')).map(t => t.textContent).join(''))
              .filter(t => t.trim());
            if (innerLines.length) {
              const html = innerLines.map(t => `<div class="dv-slide-line"${looksArabicLine(t) ? ' dir="rtl"' : ''}>${esc(t)}</div>`).join('');
              shapes.push({ kind: 'text', pos: groupPos, html });
            }
          }
        }

        const bg = getSlideBackgroundColor(xdoc);
        slides.push({ title, shapes, bg });
      }

      dom.content.className = 'dv-content dv-content-flush';
      dom.content.innerHTML = `<div class="dv-slides-wrap">
        <div class="dv-slides-rail" id="dv-slides-rail"></div>
        <div class="dv-slide-stage" id="dv-slide-stage"></div>
      </div>`;
      const rail = dom.content.querySelector('#dv-slides-rail');
      const stage = dom.content.querySelector('#dv-slide-stage');
      setInfoExtra(`<div class="dv-info-row"><span class="k">عدد الشرائح</span><span class="v">${slides.length}</span></div>
        <div class="dv-info-row"><span class="k">ملاحظة</span><span class="v" style="font-size:.68rem;font-weight:500">معاينة تقريبية للمحتوى والتخطيط — وليست عرضًا مطابقًا تمامًا للتصميم الأصلي (الخطوط والتأثيرات والحركات غير مدعومة)</span></div>`);
      dom.statusLeft.textContent = `${slides.length} شريحة`;

      function draw(i) {
        rail.querySelectorAll('.dv-slide-thumb').forEach((t, ti) => t.classList.toggle('active', ti === i));
        const s = slides[i];
        const canvasStyle = `aspect-ratio:${slideCx}/${slideCy};${s.bg ? `background:${s.bg};` : ''}`;
        let flowTop = 4; // percent; running offset for shapes with no explicit position (e.g. some placeholder text)
        const shapeHtml = s.shapes.map(shape => {
          const pos = shape.pos;
          let style;
          if (pos) {
            style = `left:${pos.left}%;top:${pos.top}%;width:${pos.width}%;height:${pos.height}%;`;
          } else {
            style = `left:4%;top:${flowTop}%;width:92%;`;
            flowTop += shape.kind === 'title' ? 14 : 10;
          }
          const kindClass = shape.kind === 'title' ? ' dv-slide-shape-title' : shape.kind === 'image' ? ' dv-slide-shape-image' : '';
          return `<div class="dv-slide-shape${kindClass}" style="${style}">${shape.html}</div>`;
        }).join('');
        stage.innerHTML = `<div class="dv-slide-canvas" style="${canvasStyle}">${
          shapeHtml || '<div class="dv-slide-empty-text">لا يوجد محتوى قابل للاستخراج في هذه الشريحة</div>'
        }</div>`;
        state.searchTarget = stage;
      }
      slides.forEach((s, i) => {
        const t = document.createElement('div');
        t.className = 'dv-slide-thumb';
        t.innerHTML = `<span class="dv-slide-thumb-num">${i + 1}</span>${esc(s.title || '(بدون عنوان)')}`;
        t.addEventListener('click', () => draw(i));
        rail.appendChild(t);
      });
      draw(0);
      addSearchToggle();
    } catch (err) {
      console.error(err);
      showError('تعذّر عرض الشرائح داخل التطبيق', 'يمكن تحميل الملف وفتحه في برنامج العروض التقديمية.');
    }
  }

  return { render };
})();
