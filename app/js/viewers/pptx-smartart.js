/* ════════════════════════════════════════════════════════════
   PPTX SMARTART — app/js/viewers/pptx-smartart.js
   ────────────────────────────────────────────────────────────
   Renders an embedded SmartArt diagram (<p:graphicFrame> whose
   <a:graphicData uri> ends in "/diagram"). Depends on PptxCommon.

   Contract: PptxSmartArt.renderDiagramFrame(graphicFrameNode, opts)
   where opts = { zip, slidePath, clrScheme, txStyles, pos, esc,
   defaultSizePt } -> { kind:'smartart', pos, html } or null.

   STRATEGY (this is the key insight, not a hack): PowerPoint does NOT
   expect every consumer to run its own SmartArt layout algorithm
   (hierarchy/layout/positioning is genuinely complex — that's the
   actual OOXML "diagram layout definition" spec). Instead, every
   SmartArt PowerPoint itself saves ALSO includes a pre-rendered cache
   of the exact shapes it drew — ppt/diagrams/drawing1.xml — generated
   specifically so older/non-PowerPoint consumers can display something
   correct without re-running the layout engine. This file reuses THAT
   cache (real shapes: position, size, fill, border, geometry preset,
   text) rather than attempting the layout algorithm itself, which is
   both far more accurate and far more practical.

   Only if that cache is genuinely missing (rare — hand-crafted or very
   old files) does this fall back to a structured list of the
   diagram's actual node text pulled from its semantic data model
   (ppt/diagrams/data1.xml) — not exact layout, but real content,
   clearly presented, never silently dropped.
   ════════════════════════════════════════════════════════════ */
const PptxSmartArt = (function () {
  'use strict';
  const C = PptxCommon;

  // Extracts a compact, presentation-consistent text block from a
  // <dsp:txBody> (SmartArt's own txBody wrapper — same inner DrawingML
  // <a:p>/<a:r>/<a:rPr> as any <p:txBody>, so PptxCommon's paragraph/run
  // helpers apply unchanged).
  function extractDspText(txBody, esc, defaultSizePt) {
    const paras = Array.from(txBody.getElementsByTagName('a:p'));
    const lines = [];
    for (const p of paras) {
      const runs = Array.from(p.getElementsByTagName('a:r'));
      const spans = [];
      let lineText = '';
      for (const r of runs) {
        const t = r.getElementsByTagName('a:t')[0];
        const text = t ? t.textContent : '';
        if (!text) continue;
        const rPr = r.getElementsByTagName('a:rPr')[0];
        const props = C.getRunProps(rPr, C.DEFAULT_SCHEME);
        spans.push({ text, props });
        lineText += text;
      }
      if (!lineText.trim()) continue;
      const sizedSpan = spans.find(s => s.props.sizePt);
      lines.push({
        spans,
        sizePt: sizedSpan ? sizedSpan.props.sizePt : defaultSizePt.body,
        rtl: C.paragraphIsRtl(p, lineText),
        align: C.paragraphAlign(p) || 'center',
      });
    }
    if (!lines.length) return '';
    return lines.map(l => {
      const spansHtml = l.spans.map(s => {
        let style = '';
        if (s.props.bold) style += 'font-weight:700;';
        if (s.props.color) style += `color:${s.props.color};`;
        return style ? `<span style="${style}">${esc(s.text)}</span>` : esc(s.text);
      }).join('');
      return `<div class="dv-slide-line" data-pt="${l.sizePt}"${l.rtl ? ' dir="rtl"' : ''} style="text-align:${l.align};line-height:1.25;">${spansHtml}</div>`;
    }).join('');
  }

  // Reads every <dsp:sp>'s raw box + fill/border/geometry/text, then
  // normalizes all of them into FRACTIONS of their own shared bounding
  // box (0..1) — this is what lets them be repositioned onto the
  // graphicFrame's actual on-slide box below, without needing the
  // diagram's own absolute coordinate space to mean anything in
  // particular (PowerPoint's cached drawing uses whatever virtual
  // canvas size was in effect when it was generated, not necessarily
  // matching the graphicFrame's current on-slide size 1:1).
  function extractDrawingShapes(drawingXdoc, clrScheme, esc, defaultSizePt) {
    const spNodes = Array.from(drawingXdoc.getElementsByTagName('dsp:sp'));
    const raw = spNodes.map(sp => {
      const spPr = sp.getElementsByTagName('dsp:spPr')[0];
      const xfrm = spPr && spPr.getElementsByTagName('a:xfrm')[0];
      if (!xfrm) return null;
      const off = xfrm.getElementsByTagName('a:off')[0];
      const ext = xfrm.getElementsByTagName('a:ext')[0];
      if (!off || !ext) return null;
      const x = parseInt(off.getAttribute('x'), 10), y = parseInt(off.getAttribute('y'), 10);
      const cx = parseInt(ext.getAttribute('cx'), 10), cy = parseInt(ext.getAttribute('cy'), 10);
      if (![x, y, cx, cy].every(Number.isFinite)) return null;
      const txBody = sp.getElementsByTagName('dsp:txBody')[0];
      return {
        x, y, cx, cy,
        fill: C.extractShapeFill(spPr, clrScheme),
        border: C.extractShapeBorder(spPr, clrScheme),
        geomCss: C.extractGeometryCss(spPr),
        html: txBody ? extractDspText(txBody, esc, defaultSizePt) : '',
      };
    }).filter(Boolean);
    if (!raw.length) return [];
    const minX = Math.min(...raw.map(s => s.x)), minY = Math.min(...raw.map(s => s.y));
    const maxX = Math.max(...raw.map(s => s.x + s.cx)), maxY = Math.max(...raw.map(s => s.y + s.cy));
    const bboxW = Math.max(1, maxX - minX), bboxH = Math.max(1, maxY - minY);
    return raw.map(s => ({
      fracLeft: (s.x - minX) / bboxW, fracTop: (s.y - minY) / bboxH,
      fracWidth: s.cx / bboxW, fracHeight: s.cy / bboxH,
      fill: s.fill, border: s.border, geomCss: s.geomCss, html: s.html,
    }));
  }
  function wrapShapesAsBox(shapes) {
    const inner = shapes.map(s => {
      let style = `position:absolute;left:${(s.fracLeft * 100).toFixed(2)}%;top:${(s.fracTop * 100).toFixed(2)}%;width:${(s.fracWidth * 100).toFixed(2)}%;height:${(s.fracHeight * 100).toFixed(2)}%;overflow:hidden;box-sizing:border-box;padding:2%;display:flex;align-items:center;justify-content:center;`;
      if (s.fill) style += `background:${s.fill};`;
      if (s.border) style += `border:${s.border.widthPx}px solid ${s.border.color};`;
      if (s.geomCss && s.geomCss.borderRadius) style += `border-radius:${s.geomCss.borderRadius};`;
      return `<div style="${style}">${s.html}</div>`;
    }).join('');
    return `<div style="position:relative;width:100%;height:100%;">${inner}</div>`;
  }

  // Fallback when no cached drawing exists at all: the diagram's own
  // semantic data model (ppt/diagrams/dataN.xml) lists every node's text
  // in <dgm:pt type="node"><dgm:t>...<a:t>. Not exact SmartArt layout,
  // but real content, clearly presented — never silently dropped.
  function renderDataModelFallback(dataXdoc, esc) {
    const pts = Array.from(dataXdoc.getElementsByTagName('dgm:pt')).filter(pt => {
      const type = pt.getAttribute('type');
      return !type || type === 'node'; // skip 'doc' (root container), 'asst'/'parTrans'/'sibTrans' (structural, no user text)
    });
    const items = pts.map(pt => {
      const tEl = pt.getElementsByTagName('dgm:t')[0];
      if (!tEl) return null;
      const text = Array.from(tEl.getElementsByTagName('a:t')).map(r => r.textContent).join('').trim();
      return text || null;
    }).filter(Boolean);
    if (!items.length) return null;
    return `<div class="dv-smartart-fallback">${items.map(t => `<div class="dv-smartart-fallback-item">${esc(t)}</div>`).join('')}</div>`;
  }

  async function renderDiagramFrame(graphicFrameNode, opts) {
    const { zip, slidePath, clrScheme, pos, esc, defaultSizePt } = opts;
    try {
      const graphicData = graphicFrameNode.getElementsByTagName('a:graphicData')[0];
      const relIds = graphicData.getElementsByTagName('dgm:relIds')[0];
      const dmRid = relIds && relIds.getAttribute('r:dm');
      if (!dmRid) return null;
      const slideRelMap = await C.getRelsMap(zip, slidePath);
      const dataTarget = slideRelMap[dmRid] && slideRelMap[dmRid].target;
      if (!dataTarget) return null;
      const dataPath = C.resolveOoxmlPath(C.dirOf(slidePath), dataTarget);

      // Primary path: PowerPoint's own cached rendered shapes.
      const dataRelMap = await C.getRelsMap(zip, dataPath);
      const drawingRel = C.findRelByTypeSuffix(dataRelMap, '/diagramDrawing');
      if (drawingRel) {
        const drawingPath = C.resolveOoxmlPath(C.dirOf(dataPath), drawingRel.target);
        const drawingXdoc = await C.loadXml(zip, drawingPath);
        if (drawingXdoc) {
          const shapes = extractDrawingShapes(drawingXdoc, clrScheme, esc, defaultSizePt);
          if (shapes.length) return { kind: 'smartart', pos, html: wrapShapesAsBox(shapes) };
        }
      }
      // Fallback: structured text from the semantic data model.
      const dataXdoc = await C.loadXml(zip, dataPath);
      if (dataXdoc) {
        const html = renderDataModelFallback(dataXdoc, esc);
        if (html) return { kind: 'smartart', pos, html };
      }
      return null;
    } catch (err) {
      console.warn('[pptx-smartart] failed to render SmartArt, skipping it', err);
      return null;
    }
  }

  return { renderDiagramFrame };
})();
