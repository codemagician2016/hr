#!/usr/bin/env node
/*
 * Theme → layout preview report (no rendering / no deploy required).
 *
 * Reads the live web theme catalog (apps/web/themes/_shared/staticThemes.js,
 * already enhanced + diversified) and the layout-preset registry, then emits a
 * single static HTML page grouping every theme under the layout preset it now
 * resolves to. For each preset it shows the layout composition (hero / services
 * variants + section order), a swatch of the themes' colours, and the theme
 * keys assigned to it — so you can see, per category, how varied the layouts are
 * and which theme gets which look.
 *
 * Usage:  node scripts/preview-theme-layouts.js
 * Output: scripts/out/theme-layouts-preview.html  (open in a browser)
 *
 * Where a rendered thumbnail already exists in
 * apps/platform/public/preset-thumbs/<key>.png it is embedded; otherwise the
 * structural breakdown stands in. Re-run the Playwright harness
 * (business/scripts/take-preset-screenshots.js) against a deploy of this branch
 * for pixel-accurate thumbnails of the new/changed presets.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const cat = require(path.join(ROOT, 'apps/web/themes/_shared/staticThemes.js'));
const lp = require(path.join(ROOT, 'packages/theme-engine/layout-presets.cjs'));

const byKey = Object.fromEntries(lp.LAYOUT_PRESETS.map((p) => [p.key, p]));
const THUMB_DIR = path.join(ROOT, 'apps/platform/public/preset-thumbs');
const hasThumb = (k) => fs.existsSync(path.join(THUMB_DIR, `${k}.png`));

// Group themes by their resolved preset.
const themes = Object.entries(cat).filter(([, t]) => t && t.vertical === 'web');
const byPreset = {};
for (const [key, t] of themes) {
  const pk = t.defaultDesignPreset || '(none)';
  (byPreset[pk] = byPreset[pk] || []).push({ key, color: t.primaryColor, accent: t.accentColor, style: t.defaultThemeStyle });
}

// Distinct layout signatures (preset variants + order) → cluster sizes.
const sig = {};
for (const [key, t] of themes) {
  const p = byKey[t.defaultDesignPreset];
  if (!p) continue;
  const s = JSON.stringify({ v: p.variants, o: p.sectionOrder });
  (sig[s] = sig[s] || []).push(key);
}
const clusterSizes = Object.values(sig).map((g) => g.length).sort((a, b) => b - a);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Order presets by aesthetic group, then by usage.
const presetsByAes = {};
for (const p of lp.LAYOUT_PRESETS) (presetsByAes[p.aesthetic] = presetsByAes[p.aesthetic] || []).push(p);

function presetCard(p) {
  const used = byPreset[p.key] || [];
  const v = p.variants || {};
  const swatches = used.slice(0, 60).map((u) =>
    `<span class="sw" title="${esc(u.key)} · ${esc(u.color)} · ${esc(u.style || '')}" style="background:${esc(u.color)}"></span>`
  ).join('');
  const thumb = hasThumb(p.key)
    ? `<img class="thumb" src="${path.join('..', '..', 'apps/platform/public/preset-thumbs', p.key + '.png')}" alt="${esc(p.key)}"/>`
    : `<div class="thumb noimg">no thumbnail<br/><small>structure only</small></div>`;
  const keys = used.map((u) => esc(u.key)).join(', ') || '<em>— not used —</em>';
  return `
  <div class="card${used.length === 0 ? ' empty' : ''}">
    ${thumb}
    <div class="meta">
      <div class="hd"><b>${esc(p.name)}</b> <code>${esc(p.key)}</code> <span class="badge">${used.length} themes</span></div>
      <div class="comp">
        <span>hero: <b>${esc(v.hero || '—')}</b></span>
        <span>services: <b>${esc(v.services || '—')}</b></span>
        <span>order: ${esc((p.sectionOrder || []).join(' › '))}</span>
      </div>
      <div class="sw-row">${swatches}</div>
      <details><summary>${used.length} theme${used.length === 1 ? '' : 's'}</summary><div class="keys">${keys}</div></details>
    </div>
  </div>`;
}

const flagships = ['corporate', 'legal', 'architect', 'real_estate', 'accountant', 'designer', 'consultant'];
const flagRows = flagships.map((k) => {
  const t = cat[k];
  return t ? `<tr><td>${esc(k)}</td><td><code>${esc(t.defaultDesignPreset)}</code></td><td><span class="sw" style="background:${esc(t.primaryColor)}"></span> ${esc(t.primaryColor)}</td></tr>` : '';
}).join('');

const aesOrder = ['modern', 'editorial', 'minimal', 'bold', 'wellness', 'tech', 'luxury'];
const groups = aesOrder.filter((a) => presetsByAes[a]).map((a) => {
  const cards = presetsByAes[a].sort((x, y) => (byPreset[y.key] || []).length - (byPreset[x.key] || []).length).map(presetCard).join('');
  return `<h2>${esc(a)} <small>(${presetsByAes[a].length} layouts)</small></h2><div class="grid">${cards}</div>`;
}).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Theme → Layout preview</title>
<style>
  body{font:14px/1.45 system-ui,sans-serif;margin:0;background:#0f1115;color:#e6e8eb}
  header{padding:24px 32px;background:#161922;border-bottom:1px solid #262b36}
  h1{margin:0 0 6px;font-size:20px} h2{margin:32px 32px 8px;text-transform:capitalize}
  .sub{color:#9aa3b2}
  .stats{display:flex;gap:28px;margin-top:14px;flex-wrap:wrap}
  .stat b{display:block;font-size:24px} .stat span{color:#9aa3b2;font-size:12px}
  table{margin:14px 0 0;border-collapse:collapse} td{padding:3px 12px 3px 0}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;padding:0 32px}
  .card{background:#161922;border:1px solid #262b36;border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
  .card.empty{opacity:.5}
  .thumb{width:100%;height:150px;object-fit:cover;background:#0b0d11;display:block}
  .thumb.noimg{display:flex;flex-direction:column;align-items:center;justify-content:center;color:#5b6472;font-size:12px;text-align:center}
  .meta{padding:10px 12px}
  .hd code{color:#8ab4f8;font-size:12px} .badge{float:right;background:#222836;border-radius:10px;padding:1px 8px;font-size:11px;color:#9aa3b2}
  .comp{display:flex;flex-direction:column;gap:2px;color:#9aa3b2;font-size:12px;margin:6px 0}
  .comp b{color:#cdd3dc}
  .sw-row{display:flex;flex-wrap:wrap;gap:3px;margin:6px 0}
  .sw{width:14px;height:14px;border-radius:3px;display:inline-block;border:1px solid #00000055}
  details{margin-top:4px} summary{cursor:pointer;color:#9aa3b2;font-size:12px}
  .keys{font-size:12px;color:#aeb6c2;margin-top:6px;word-break:break-word}
  code{font-family:ui-monospace,monospace}
</style></head><body>
<header>
  <h1>Theme → Layout preview <span class="sub">— ${themes.length} web themes across ${Object.keys(byPreset).length} layouts</span></h1>
  <div class="sub">Each card = one layout preset. Swatches show the colours of the themes using it. Open a card's disclosure to see which themes.</div>
  <div class="stats">
    <div class="stat"><b>${themes.length}</b><span>web themes</span></div>
    <div class="stat"><b>${clusterSizes.length}</b><span>distinct layouts (was 71)</span></div>
    <div class="stat"><b>${clusterSizes[0]}</b><span>largest cluster (was 57)</span></div>
    <div class="stat"><b>${Object.keys(byPreset).length}/100</b><span>presets in use</span></div>
  </div>
  <table><tr><th align=left>Flagship</th><th align=left>Layout</th><th align=left>Colour (preserved)</th></tr>${flagRows}</table>
</header>
${groups}
<p style="padding:24px 32px;color:#5b6472">Structural preview — thumbnails shown where a rendered PNG already exists. For pixel-accurate thumbs of new/changed presets, run business/scripts/take-preset-screenshots.js against a deploy of this branch.</p>
</body></html>`;

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'theme-layouts-preview.html');
fs.writeFileSync(outFile, html);
console.log('Wrote', outFile);
console.log('Themes:', themes.length, '| distinct layouts:', clusterSizes.length, '| largest cluster:', clusterSizes[0], '| presets used:', Object.keys(byPreset).length);
