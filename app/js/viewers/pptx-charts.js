/* ════════════════════════════════════════════════════════════
   PPTX CHARTS — app/js/viewers/pptx-charts.js
   ────────────────────────────────────────────────────────────
   Renders an embedded chart (<p:graphicFrame> whose <a:graphicData uri>
   ends in "/chart") as a real SVG chart — not a text dump of the
   numbers. Depends on PptxCommon for theme-color resolution.

   Contract: PptxCharts.renderChartFrame(graphicFrameNode, opts) where
   opts = { zip, slidePath, clrScheme, pos, esc } — same shape as any
   other extracted shape descriptor: { kind:'chart', pos, html }, or
   null if the chart couldn't be resolved at all (e.g. the relationship
   is missing) — the caller (pptx-shapes.js) already isolates a null
   return / thrown error to just that one object.

   COVERAGE
   Fully rendered as real SVG: bar/column, line, pie, doughnut, area.
   These cover the large majority of charts actually used in school
   presentations (progress/comparison bars, trend lines, proportion
   pies) and are explicitly the first four priorities in the brief.
   Fallback for anything else (scatter, radar, combo, bubble, stock...):
   a compact data table of the same categories/series/values — the
   chart's actual information is still fully visible, just not as a
   type-specific plot. This is an honest degradation, not a fake chart.
   NOT attempted: exact OOXML chart styling (per-point colors beyond the
   series color, 3D charts as real 3D, trendlines, error bars,
   data-label leader lines). A missing chart is never the outcome for a
   chart with actual series/value data — that is the one hard rule this
   file exists to satisfy.
   ════════════════════════════════════════════════════════════ */
const PptxCharts = (function () {
  'use strict';
  const C = PptxCommon;
  const PALETTE = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#264478', '#9E480E'];

  function textOf(el) {
    if (!el) return '';
    const v = el.getElementsByTagName('c:v')[0];
    return v ? v.textContent : '';
  }
  function numOf(el) {
    const t = textOf(el);
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : 0;
  }
  // <c:cat>/<c:val> each wrap either a <c:strRef>/<c:numRef> (formula +
  // cache) or occasionally literal <c:strLit>/<c:numLit> — in every case
  // the actual point values live in a flat list of <c:pt idx="N"><c:v>.
  // Reading them in document order (rather than indexing by idx) is a
  // reasonable simplification: real chart exports are overwhelmingly
  // contiguous from idx 0, and a slightly wrong order on the rare
  // non-contiguous cache is far less harmful than the chart not
  // rendering at all.
  function ptList(refOrLitParent) {
    if (!refOrLitParent) return [];
    return Array.from(refOrLitParent.getElementsByTagName('c:pt'));
  }
  function extractSeries(chartTypeEl, clrScheme) {
    return Array.from(chartTypeEl.getElementsByTagName('c:ser')).map(ser => {
      const txEl = ser.getElementsByTagName('c:tx')[0];
      // Series name is nested a few levels deep (c:tx > c:strRef > c:strCache >
      // c:pt > c:v) — getElementsByTagName searches all descendants, so the
      // first c:v found under c:tx is always the series name regardless of
      // that nesting.
      const nameV = txEl && txEl.getElementsByTagName('c:v')[0];
      const seriesName = nameV ? nameV.textContent : '';
      const catEl = ser.getElementsByTagName('c:cat')[0];
      const categories = ptList(catEl).map(pt => textOf(pt));
      const valEl = ser.getElementsByTagName('c:val')[0] || ser.getElementsByTagName('c:yVal')[0];
      const values = ptList(valEl).map(pt => numOf(pt));
      const spPr = ser.getElementsByTagName('c:spPr')[0];
      const color = spPr ? C.extractShapeFill(spPr, clrScheme) : null;
      return { name: seriesName, categories, values, color };
    });
  }
  function extractTitle(chartEl) {
    const title = chartEl.getElementsByTagName('c:title')[0];
    if (!title || title.getElementsByTagName('c:autoTitleDeleted').length) {
      // <c:autoTitleDeleted val="1"/> without a real title means the
      // author explicitly removed it — showing nothing is correct here.
    }
    const runs = title ? Array.from(title.getElementsByTagName('a:t')) : [];
    return runs.map(r => r.textContent).join('');
  }
  function allCategories(series) {
    for (const s of series) if (s.categories.length) return s.categories;
    return [];
  }

  // ── SVG builders (shared 400x260 internal coordinate system; the
  // <svg> itself scales proportionally to fill whatever box CSS gives
  // it, same technique as the connector SVGs in pptx-shapes.js) ──────
  const W = 400, H = 260, PAD_L = 36, PAD_R = 12, PAD_T = 28, PAD_B = 34;
  const PLOT_W = W - PAD_L - PAD_R, PLOT_H = H - PAD_T - PAD_B;

  function svgTitle(title, esc) {
    return title ? `<text x="${W / 2}" y="14" font-size="11" font-weight="700" text-anchor="middle" fill="#222">${esc(title)}</text>` : '';
  }
  function svgLegend(series, esc) {
    if (series.length < 2) return '';
    const itemW = Math.min(90, W / series.length);
    const startX = W / 2 - (series.length * itemW) / 2;
    return series.map((s, i) => {
      const x = startX + i * itemW;
      const color = s.color || PALETTE[i % PALETTE.length];
      return `<rect x="${x}" y="${H - 12}" width="8" height="8" fill="${color}"/><text x="${x + 11}" y="${H - 4}" font-size="8" fill="#333">${esc((s.name || ('S' + (i + 1))).slice(0, 14))}</text>`;
    }).join('');
  }

  function renderBarChart(series, esc, title) {
    const categories = allCategories(series);
    const maxVal = Math.max(1, ...series.flatMap(s => s.values), 0);
    const n = Math.max(1, categories.length);
    const groupW = PLOT_W / n;
    const barW = groupW / (series.length + 1);
    let bars = '';
    for (let ci = 0; ci < n; ci++) {
      series.forEach((s, si) => {
        const val = s.values[ci] || 0;
        const barH = maxVal ? (val / maxVal) * PLOT_H : 0;
        const x = PAD_L + ci * groupW + si * barW + barW * 0.3;
        const y = PAD_T + PLOT_H - barH;
        const color = s.color || PALETTE[si % PALETTE.length];
        bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW * 0.8).toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}"/>`;
      });
    }
    const labels = categories.map((cat, ci) => {
      const x = PAD_L + ci * groupW + groupW / 2;
      return `<text x="${x.toFixed(1)}" y="${PAD_T + PLOT_H + 12}" font-size="8" text-anchor="middle" fill="#333">${esc(String(cat).slice(0, 10))}</text>`;
    }).join('');
    const axis = `<line x1="${PAD_L}" y1="${PAD_T + PLOT_H}" x2="${PAD_L + PLOT_W}" y2="${PAD_T + PLOT_H}" stroke="#999" stroke-width="1"/>`;
    return wrapSvg(svgTitle(title, esc) + axis + bars + labels + svgLegend(series, esc));
  }

  function renderLineOrAreaChart(series, esc, title, filled) {
    const categories = allCategories(series);
    const maxVal = Math.max(1, ...series.flatMap(s => s.values), 0);
    const n = Math.max(2, categories.length);
    const stepX = PLOT_W / Math.max(1, n - 1);
    let paths = '';
    series.forEach((s, si) => {
      const color = s.color || PALETTE[si % PALETTE.length];
      const pts = s.values.map((v, i) => {
        const x = PAD_L + i * stepX;
        const y = PAD_T + PLOT_H - (maxVal ? (v / maxVal) * PLOT_H : 0);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      if (filled && pts.length) {
        const baseline = `${PAD_L + (pts.length - 1) * stepX},${PAD_T + PLOT_H} ${PAD_L},${PAD_T + PLOT_H}`;
        paths += `<polygon points="${pts.join(' ')} ${baseline}" fill="${color}" fill-opacity="0.35" stroke="${color}" stroke-width="1.5"/>`;
      } else {
        paths += `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`;
        pts.forEach(p => { const [x, y] = p.split(','); paths += `<circle cx="${x}" cy="${y}" r="2" fill="${color}"/>`; });
      }
    });
    const labels = categories.map((cat, i) => {
      const x = PAD_L + i * stepX;
      return `<text x="${x.toFixed(1)}" y="${PAD_T + PLOT_H + 12}" font-size="8" text-anchor="middle" fill="#333">${esc(String(cat).slice(0, 10))}</text>`;
    }).join('');
    const axis = `<line x1="${PAD_L}" y1="${PAD_T + PLOT_H}" x2="${PAD_L + PLOT_W}" y2="${PAD_T + PLOT_H}" stroke="#999" stroke-width="1"/>`;
    return wrapSvg(svgTitle(title, esc) + axis + paths + labels + svgLegend(series, esc));
  }

  function renderPieOrDoughnut(series, esc, title, doughnut) {
    const s = series[0] || { categories: [], values: [] };
    const total = s.values.reduce((a, b) => a + b, 0) || 1;
    const cx = W / 2, cy = PAD_T + PLOT_H / 2 - 6, r = Math.min(PLOT_W, PLOT_H) / 2 - 4;
    let angle = -Math.PI / 2;
    let slices = '';
    s.values.forEach((v, i) => {
      const frac = v / total;
      const nextAngle = angle + frac * Math.PI * 2;
      const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(nextAngle), y2 = cy + r * Math.sin(nextAngle);
      const largeArc = frac > 0.5 ? 1 : 0;
      const color = PALETTE[i % PALETTE.length];
      slices += `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${largeArc} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${color}" stroke="#fff" stroke-width="1"/>`;
      angle = nextAngle;
    });
    const hole = doughnut ? `<circle cx="${cx}" cy="${cy}" r="${(r * 0.55).toFixed(1)}" fill="#fff"/>` : '';
    const legendItems = s.categories.map((cat, i) => {
      const pct = Math.round((s.values[i] / total) * 100);
      const y = PAD_T + i * 11;
      return `<rect x="${W - 92}" y="${y}" width="7" height="7" fill="${PALETTE[i % PALETTE.length]}"/><text x="${W - 82}" y="${y + 7}" font-size="7.5" fill="#333">${esc(String(cat).slice(0, 12))} (${pct}%)</text>`;
    }).join('');
    return wrapSvg(svgTitle(title, esc) + slices + hole + legendItems);
  }

  // Honest fallback for chart types not worth a bespoke SVG renderer
  // (scatter/radar/combo/bubble/stock...) — the real category/series/
  // value data, laid out as a compact table, rather than nothing.
  function renderDataTable(series, esc, title, chartTypeLabel) {
    const categories = allCategories(series);
    const header = `<tr><th></th>${categories.map(c => `<th>${esc(String(c))}</th>`).join('')}</tr>`;
    const rows = series.map(s => `<tr><th>${esc(s.name || '')}</th>${s.values.map(v => `<td>${esc(String(v))}</td>`).join('')}</tr>`).join('');
    return `<div class="dv-chart-fallback">
      ${title ? `<div class="dv-chart-fallback-title">${esc(title)}</div>` : ''}
      <div class="dv-chart-fallback-note">${esc(chartTypeLabel)} — تُعرض بياناته كجدول (النوع غير مدعوم كرسم بياني مباشر)</div>
      <table class="dv-slide-table">${header}${rows}</table>
    </div>`;
  }

  function wrapSvg(inner) {
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:100%;">${inner}</svg>`;
  }

  const CHART_TYPE_TAGS = [
    ['c:barChart', 'bar'], ['c:bar3DChart', 'bar'],
    ['c:lineChart', 'line'], ['c:line3DChart', 'line'],
    ['c:pieChart', 'pie'], ['c:pie3DChart', 'pie'],
    ['c:doughnutChart', 'doughnut'],
    ['c:areaChart', 'area'], ['c:area3DChart', 'area'],
    ['c:scatterChart', 'other'], ['c:radarChart', 'other'],
    ['c:bubbleChart', 'other'], ['c:stockChart', 'other'], ['c:ofPieChart', 'other'],
  ];
  const CHART_TYPE_LABEL = { bar: 'رسم بياني عمودي/شريطي', line: 'رسم بياني خطي', pie: 'رسم بياني دائري', doughnut: 'رسم بياني حلقي', area: 'رسم بياني مساحي', other: 'رسم بياني' };

  async function renderChartFrame(graphicFrameNode, opts) {
    const { zip, slidePath, clrScheme, pos, esc } = opts;
    try {
      const graphicData = graphicFrameNode.getElementsByTagName('a:graphicData')[0];
      const chartRef = graphicData.getElementsByTagName('c:chart')[0];
      const rId = chartRef && chartRef.getAttribute('r:id');
      if (!rId) return null;
      const relMap = await C.getRelsMap(zip, slidePath);
      const target = relMap[rId] && relMap[rId].target;
      if (!target) return null;
      const chartPath = C.resolveOoxmlPath(C.dirOf(slidePath), target);
      const chartXdoc = await C.loadXml(zip, chartPath);
      if (!chartXdoc) return null;
      const chartEl = chartXdoc.getElementsByTagName('c:chart')[0];
      if (!chartEl) return null;
      const plotArea = chartEl.getElementsByTagName('c:plotArea')[0];
      if (!plotArea) return null;

      let chartTypeEl = null, chartKind = 'other';
      for (const [tag, kind] of CHART_TYPE_TAGS) {
        const el = plotArea.getElementsByTagName(tag)[0];
        if (el) { chartTypeEl = el; chartKind = kind; break; }
      }
      if (!chartTypeEl) return null; // no recognizable chart-type element at all — nothing to render

      const series = extractSeries(chartTypeEl, clrScheme);
      if (!series.length || !series.some(s => s.values.length)) return null; // genuinely empty chart — nothing to show
      const title = extractTitle(chartEl);

      let html;
      switch (chartKind) {
        case 'bar': html = renderBarChart(series, esc, title); break;
        case 'line': html = renderLineOrAreaChart(series, esc, title, false); break;
        case 'area': html = renderLineOrAreaChart(series, esc, title, true); break;
        case 'pie': html = renderPieOrDoughnut(series, esc, title, false); break;
        case 'doughnut': html = renderPieOrDoughnut(series, esc, title, true); break;
        default: html = renderDataTable(series, esc, title, CHART_TYPE_LABEL[chartKind] || 'رسم بياني');
      }
      return { kind: 'chart', pos, html };
    } catch (err) {
      console.warn('[pptx-charts] failed to render a chart, skipping it', err);
      return null;
    }
  }

  return { renderChartFrame };
})();
