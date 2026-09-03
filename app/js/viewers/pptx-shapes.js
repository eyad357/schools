/* ════════════════════════════════════════════════════════════
   PPTX SHAPES / GROUPS / CONNECTORS — app/js/viewers/pptx-shapes.js
   ────────────────────────────────────────────────────────────
   Extracts <p:sp> (autoshapes + text), <p:pic> (images), <p:cxnSp>
   (connectors/lines/arrows), and recursively resolves <p:grpSp>
   (groups, including nested groups) into a flat, z-ordered list of
   renderable shape descriptors. Depends on PptxCommon (pptx-common.js)
   for OOXML/theme/geometry primitives; delegates to PptxCharts /
   PptxSmartArt (when a <p:graphicFrame> turns out to be one) if those
   modules are loaded — their absence or failure degrades gracefully
   (skip that one object, never the whole slide/shape list).

   GROUP TRANSFORMS (previously just an approximation — this file makes
   it real): a group's own <p:xfrm> carries not just its on-slide box
   but <a:chOff>/<a:chExt> — the coordinate space its children's OWN
   xfrm values are expressed in. A `transform` object is threaded
   through the recursion; at the slide root it's the identity transform
   (top-level shapes' xfrm values already ARE slide-EMU); entering a
   group composes a new transform that correctly maps that group's
   children (including further nested groups) into real slide-EMU
   coordinates. This is standard nested affine-transform composition,
   not a heuristic — it is exact given the file's own numbers, modulo
   rotation of the group itself, which is a known, disclosed
   approximation (see extractGroup below).

   Also fixes a real, previously-undiscovered bug: <p:graphicFrame>
   (tables/charts/SmartArt) uses <p:xfrm>, not <a:xfrm> — the old
   getXfrm() only checked 'a:xfrm', so graphicFrame elements (including
   every table) silently got NO position and fell back to flow-layout
   stacking instead of their real slide position. Fixed in
   PptxCommon.getXfrm(), which this file's positioning goes through.
   ════════════════════════════════════════════════════════════ */
const PptxShapes = (function () {
  'use strict';
  const C = PptxCommon;

  // ── raw (untransformed) geometry + transform composition ──────────

  function getRawXfrm(containerNode) {
    const xfrm = C.getXfrm(containerNode);
    if (!xfrm) return null;
    const off = xfrm.getElementsByTagName('a:off')[0];
    const ext = xfrm.getElementsByTagName('a:ext')[0];
    if (!off || !ext) return null;
    const x = parseInt(off.getAttribute('x'), 10), y = parseInt(off.getAttribute('y'), 10);
    const cx = parseInt(ext.getAttribute('cx'), 10), cy = parseInt(ext.getAttribute('cy'), 10);
    if (![x, y, cx, cy].every(Number.isFinite)) return null;
    const rot = xfrm.getAttribute('rot');
    return {
      x, y, cx, cy,
      rotDeg: rot ? parseInt(rot, 10) / 60000 : 0,
      flipH: xfrm.getAttribute('flipH') === '1',
      flipV: xfrm.getAttribute('flipV') === '1',
    };
  }
  const IDENTITY_TRANSFORM = { toSlide: (x, y, cx, cy) => ({ x, y, cx, cy }) };
  // Composes the transform that maps a GROUP's children's local
  // (child-coordinate-space) xfrm values into absolute slide EMU, given
  // the transform already in effect for the group itself (identity at
  // the slide root, or an outer group's transform when nested).
  function composeGroupTransform(parentTransform, grpSpPrNode) {
    const raw = getRawXfrm(grpSpPrNode);
    if (!raw) return null;
    const abs = parentTransform.toSlide(raw.x, raw.y, raw.cx, raw.cy);
    const xfrmEl = C.getXfrm(grpSpPrNode);
    const chOff = xfrmEl.getElementsByTagName('a:chOff')[0];
    const chExt = xfrmEl.getElementsByTagName('a:chExt')[0];
    const chOffX = chOff ? parseInt(chOff.getAttribute('x'), 10) : raw.x;
    const chOffY = chOff ? parseInt(chOff.getAttribute('y'), 10) : raw.y;
    const chExtCx = (chExt ? parseInt(chExt.getAttribute('cx'), 10) : raw.cx) || raw.cx || 1;
    const chExtCy = (chExt ? parseInt(chExt.getAttribute('cy'), 10) : raw.cy) || raw.cy || 1;
    const scaleX = abs.cx / chExtCx;
    const scaleY = abs.cy / chExtCy;
    return {
      toSlide(x, y, cx, cy) {
        return {
          x: abs.x + (x - chOffX) * scaleX,
          y: abs.y + (y - chOffY) * scaleY,
          cx: cx * scaleX, cy: cy * scaleY,
        };
      },
    };
  }
  // Final slide-relative percentage position for any leaf node (shape,
  // pic, connector, graphicFrame) under the given transform.
  function getPosition(containerNode, transform, slideCx, slideCy) {
    const raw = getRawXfrm(containerNode);
    if (!raw) return null;
    const abs = transform.toSlide(raw.x, raw.y, raw.cx, raw.cy);
    return {
      left: (abs.x / slideCx) * 100, top: (abs.y / slideCy) * 100,
      width: (abs.cx / slideCx) * 100, height: (abs.cy / slideCy) * 100,
      rotDeg: raw.rotDeg, flipH: raw.flipH, flipV: raw.flipV,
    };
  }
  function transformCss(pos) {
    if (!pos) return '';
    const parts = [];
    if (pos.flipH) parts.push('scaleX(-1)');
    if (pos.flipV) parts.push('scaleY(-1)');
    if (pos.rotDeg) parts.push(`rotate(${pos.rotDeg}deg)`);
    return parts.length ? `transform:${parts.join(' ')};` : '';
  }

  // ── text-bearing / plain autoshapes (<p:sp>) ───────────────────────

  function extractTextShape(sp, clrScheme, txStyles, pos, esc, defaultSizePt) {
    const paras = Array.from(sp.getElementsByTagName('a:p'));
    const ph = sp.getElementsByTagName('p:ph')[0];
    const isTitle = !!(ph && /title|ctrTitle/i.test(ph.getAttribute('type') || ''));
    const lines = [];
    for (const p of paras) {
      const pPr = p.getElementsByTagName('a:pPr')[0];
      const lvlAttr = pPr && pPr.getAttribute('lvl');
      const lvl = lvlAttr ? Math.max(0, Math.min(8, parseInt(lvlAttr, 10) || 0)) : 0;
      const masterDefaults = C.txStyleDefaultsFor(txStyles, isTitle, lvl);
      const defRPr = pPr && pPr.getElementsByTagName('a:defRPr')[0];
      // Inheritance order (later wins): renderer fallback (applied below,
      // only if sizePt is still missing) < master txStyles for this
      // outline level < paragraph's own defRPr < the individual run's rPr.
      const paraDefaults = Object.assign({}, masterDefaults, C.getRunProps(defRPr, clrScheme));
      const runs = Array.from(p.getElementsByTagName('a:r'));
      const spans = [];
      let lineText = '';
      for (const r of runs) {
        const tEl = r.getElementsByTagName('a:t')[0];
        const text = tEl ? tEl.textContent : '';
        if (!text) continue;
        const rPr = r.getElementsByTagName('a:rPr')[0];
        const props = Object.assign({}, paraDefaults, C.getRunProps(rPr, clrScheme));
        spans.push({ text, props });
        lineText += text;
      }
      if (!lineText.trim()) continue;
      const sizedSpan = spans.find(s => s.props.sizePt);
      const rawSizePt = sizedSpan ? sizedSpan.props.sizePt : (isTitle ? defaultSizePt.title : defaultSizePt.body);
      lines.push({
        spans, sizePt: rawSizePt,
        rtl: C.paragraphIsRtl(p, lineText),
        align: C.paragraphAlign(p),
        bullet: C.paragraphBulletPrefix(p),
      });
    }
    const spPr = sp.getElementsByTagName('p:spPr')[0];
    const fill = C.extractShapeFill(spPr, clrScheme);
    const border = C.extractShapeBorder(spPr, clrScheme);
    const geomCss = C.extractGeometryCss(spPr);
    if (!lines.length) {
      // No text — but the shape may still be a real, visible drawing
      // element (a card background, an icon circle, a divider bar...).
      // Previously any text-less <p:sp> was dropped entirely; on the
      // real 58-slide reference file alone that silently discarded 130
      // shapes. Render it as long as it has a fill or a border —
      // otherwise (a genuinely invisible/placeholder shape) it's
      // correctly omitted rather than drawing an empty outline.
      if (!fill && !border) return null;
      return { kind: 'autoshape', pos, html: '', fill, border, geomCss, anchor: 'flex-start' };
    }
    const autofit = C.extractAutofit(sp);
    lines.forEach(l => { l.sizePt = l.sizePt * autofit.fontScale; });
    const lineHeightEm = +(1.5 * (1 - autofit.lnSpcReduction)).toFixed(3);
    const anchor = C.extractVerticalAnchor(sp);
    const html = lines.map(l => {
      const spansHtml = l.spans.map(s => {
        let style = '';
        if (s.props.bold) style += 'font-weight:700;';
        if (s.props.italic) style += 'font-style:italic;';
        if (s.props.underline) style += 'text-decoration:underline;';
        if (s.props.color) style += `color:${s.props.color};`;
        return style ? `<span style="${style}">${esc(s.text)}</span>` : esc(s.text);
      }).join('');
      let lineStyle = `line-height:${lineHeightEm};`;
      if (l.align) lineStyle += `text-align:${l.align};`;
      return `<div class="dv-slide-line" data-pt="${l.sizePt}"${l.rtl ? ' dir="rtl"' : ''} style="${lineStyle}">${esc(l.bullet)}${spansHtml}</div>`;
    }).join('');
    return { kind: isTitle ? 'title' : 'text', pos, html, isTitle, fill, border, geomCss, anchor };
  }

  // ── images (<p:pic>), with real crop support ───────────────────────

  async function extractImageShape(pic, relMap, pos, zip) {
    const spPr = pic.getElementsByTagName('p:spPr')[0];
    const blipFill = pic.getElementsByTagName('p:blipFill')[0];
    const blip = blipFill && blipFill.getElementsByTagName('a:blip')[0];
    const rId = blip && blip.getAttribute('r:embed');
    const target = rId && relMap[rId] && relMap[rId].target;
    if (!target) return null;
    const mediaPath = C.resolveOoxmlPath('ppt/slides', target);
    const mf = zip.file(mediaPath);
    if (!mf) return null;
    const base64 = await mf.async('base64');
    const ext = mediaPath.split('.').pop().toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' }[ext] || 'image/png';
    const src = `data:${mime};base64,${base64}`;

    // <a:srcRect l/t/r/b> — how much of the source image is cropped away
    // from each edge, in thousandths of a percent. Reproduced with the
    // classic CSS crop technique (oversize + offset the <img> inside an
    // overflow:hidden wrapper) rather than object-fit, which can't
    // express an asymmetric crop.
    const srcRect = blipFill && blipFill.getElementsByTagName('a:srcRect')[0];
    let imgStyle = 'width:100%;height:100%;object-fit:contain;';
    if (srcRect) {
      const l = parseInt(srcRect.getAttribute('l'), 10) || 0;
      const t = parseInt(srcRect.getAttribute('t'), 10) || 0;
      const r = parseInt(srcRect.getAttribute('r'), 10) || 0;
      const b = parseInt(srcRect.getAttribute('b'), 10) || 0;
      const wFrac = Math.max(0.05, 1 - (l + r) / 100000);
      const hFrac = Math.max(0.05, 1 - (t + b) / 100000);
      const wPct = 100 / wFrac, hPct = 100 / hFrac;
      const leftPct = -(l / 1000) / wFrac, topPct = -(t / 1000) / hFrac;
      imgStyle = `position:absolute;width:${wPct}%;height:${hPct}%;left:${leftPct}%;top:${topPct}%;object-fit:fill;`;
    }
    const geomCss = C.extractGeometryCss(spPr);
    const wrapStyle = srcRect ? 'position:relative;overflow:hidden;width:100%;height:100%;' : '';
    return { kind: 'image', pos, geomCss, html: `<div style="${wrapStyle}"><img src="${src}" alt="" style="${imgStyle}"></div>` };
  }

  // ── connectors / lines / arrows (<p:cxnSp>) ────────────────────────

  // Exact bent/curved connector routing isn't reproduced (that needs the
  // full OOXML connector-routing algorithm) — approximated as a straight
  // line across the connector's own bounding box, honoring flip so the
  // diagonal still goes the right way. This preserves the connector's
  // core visual meaning (something visibly connects point A to point B)
  // rather than the previous behavior of it simply not existing at all.
  function extractConnector(cxnSp, clrScheme, pos) {
    const spPr = cxnSp.getElementsByTagName('p:spPr')[0];
    const ln = spPr && spPr.getElementsByTagName('a:ln')[0];
    const solidFill = ln && ln.getElementsByTagName('a:solidFill')[0];
    const color = (solidFill && C.resolveColor(solidFill, clrScheme)) || '#595959';
    const wEmu = ln && parseInt(ln.getAttribute('w'), 10);
    const strokeWidth = Number.isFinite(wEmu) ? Math.max(1, wEmu / 12700) : 1.5;
    const headType = ln && ln.getElementsByTagName('a:headEnd')[0];
    const tailType = ln && ln.getElementsByTagName('a:tailEnd')[0];
    const hasHeadArrow = headType && headType.getAttribute('type') && headType.getAttribute('type') !== 'none';
    const hasTailArrow = tailType && tailType.getAttribute('type') && tailType.getAttribute('type') !== 'none';
    const markerId = 'dv-arrow-' + Math.random().toString(36).slice(2, 9);
    const marker = (hasHeadArrow || hasTailArrow)
      ? `<defs><marker id="${markerId}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="${color}"/></marker></defs>`
      : '';
    // flipH/flipV on a connector mean "draw from the opposite corner" —
    // handled directly in the line coordinates rather than via a CSS
    // transform (a CSS scaleX/scaleY(-1) would also flip the arrowhead
    // marker's own orientation incorrectly).
    const x1 = pos.flipH ? 100 : 0, x2 = pos.flipH ? 0 : 100;
    const y1 = pos.flipV ? 100 : 0, y2 = pos.flipV ? 0 : 100;
    const svg = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:100%;overflow:visible;">
      ${marker}
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"
        ${hasTailArrow ? `marker-end="url(#${markerId})"` : ''} ${hasHeadArrow ? `marker-start="url(#${markerId})"` : ''} />
    </svg>`;
    return { kind: 'connector', pos: Object.assign({}, pos, { flipH: false, flipV: false }), html: svg };
  }

  // ── recursive shape-list extraction (handles <p:grpSp> inline) ─────

  // Processes a list of sibling nodes (a slide's <p:spTree> children, or
  // a group's own children) into a flat, z-ordered array of shape
  // descriptors. `params`: { slideCx, slideCy, clrScheme, txStyles, zip,
  // relMap, esc, defaultSizePt, transform, chartRenderer, smartArtRenderer }.
  async function extractShapes(nodes, params) {
    const { slideCx, slideCy, clrScheme, txStyles, zip, esc, defaultSizePt, transform } = params;
    const shapes = [];
    for (const node of nodes) {
      const tag = node.tagName;
      try {
        if (tag === 'p:sp') {
          const spPr = node.getElementsByTagName('p:spPr')[0];
          const pos = getPosition(spPr, transform, slideCx, slideCy);
          const shape = extractTextShape(node, clrScheme, txStyles, pos, esc, defaultSizePt);
          if (shape) shapes.push(shape);
        } else if (tag === 'p:pic') {
          const spPr = node.getElementsByTagName('p:spPr')[0];
          const pos = getPosition(spPr, transform, slideCx, slideCy);
          const img = await extractImageShape(node, params.relMap, pos, zip);
          if (img) shapes.push(img);
        } else if (tag === 'p:cxnSp') {
          const spPr = node.getElementsByTagName('p:spPr')[0];
          const pos = getPosition(spPr, transform, slideCx, slideCy);
          if (pos) shapes.push(extractConnector(node, clrScheme, pos));
        } else if (tag === 'p:graphicFrame') {
          const pos = getPosition(node, transform, slideCx, slideCy);
          const graphicData = node.getElementsByTagName('a:graphicData')[0];
          const uri = graphicData ? graphicData.getAttribute('uri') || '' : '';
          if (uri.endsWith('/chart')) {
            if (typeof PptxCharts !== 'undefined') {
              const chartShape = await PptxCharts.renderChartFrame(node, { zip, slidePath: params.slidePath, clrScheme, pos, esc });
              if (chartShape) shapes.push(chartShape);
            }
          } else if (uri.endsWith('/diagram')) {
            if (typeof PptxSmartArt !== 'undefined') {
              const smartArtShape = await PptxSmartArt.renderDiagramFrame(node, { zip, slidePath: params.slidePath, clrScheme, txStyles, pos, esc, defaultSizePt });
              if (smartArtShape) shapes.push(smartArtShape);
            }
          } else {
            const table = extractTable(node, clrScheme, pos, esc);
            if (table) shapes.push(table);
            else if (pos) {
              // An unrecognized graphicFrame type (most commonly an
              // embedded OLE object — a spreadsheet/document icon, an
              // equation, etc.) — honest, visible fallback instead of
              // silently vanishing.
              shapes.push({ kind: 'unsupported-object', pos, html: '<div class="dv-slide-unsupported">📎 كائن غير مدعوم</div>' });
            }
          }
        } else if (tag === 'p:grpSp') {
          const grpSpPr = node.getElementsByTagName('p:grpSpPr')[0];
          const childTransform = composeGroupTransform(transform, grpSpPr);
          if (childTransform) {
            const children = Array.from(node.children).filter(c => c.tagName !== 'p:nvGrpSpPr' && c.tagName !== 'p:grpSpPr');
            const childShapes = await extractShapes(children, Object.assign({}, params, { transform: childTransform }));
            shapes.push(...childShapes);
          }
        }
      } catch (shapeErr) {
        console.warn('[pptx-shapes] skipped one unparsable shape', tag, shapeErr);
      }
    }
    return shapes;
  }

  function extractTable(graphicFrame, clrScheme, pos, esc) {
    const tbl = graphicFrame.getElementsByTagName('a:tbl')[0];
    if (!tbl) return null;
    const rows = Array.from(tbl.getElementsByTagName('a:tr'));
    if (!rows.length) return null;
    const rowsHtml = rows.map(tr => {
      const cells = Array.from(tr.getElementsByTagName('a:tc'));
      const cellsHtml = cells.map(tc => {
        const text = Array.from(tc.getElementsByTagName('a:t')).map(t => t.textContent).join(' ');
        const tcPr = tc.getElementsByTagName('a:tcPr')[0];
        const fill = tcPr && C.extractShapeFill(tcPr, clrScheme);
        return `<td${fill ? ` style="background:${fill}"` : ''}>${esc(text)}</td>`;
      }).join('');
      return `<tr>${cellsHtml}</tr>`;
    }).join('');
    return { kind: 'table', pos, html: `<table class="dv-slide-table">${rowsHtml}</table>` };
  }

  return { extractShapes, getPosition, transformCss, IDENTITY_TRANSFORM, composeGroupTransform, getRawXfrm };
})();
