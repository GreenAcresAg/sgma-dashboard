/* SJV GSP comparison dashboard. Loads the normalized gsp_metrics.csv + the source-document
   registry, renders a clickable subbasin map + cross-subbasin charts, and links every value to
   its GSP page (R2 page-jump if configured, else the Drive folder). */

const CFG = window.DASH_CONFIG;
const SUBBASINS = {           // canonical name -> {b118, color}; geojson "subbasin" mapped in NORM
  "Westside":     { b118: "5-022.09", color: "#3b82f6" },
  "Tulare Lake":  { b118: "5-022.12", color: "#ef4444" },
  "Kaweah":       { b118: "5-022.11", color: "#22c55e" },
  "Kings":        { b118: "5-022.08", color: "#a855f7" },
  "Tule":         { b118: "5-022.13", color: "#f59e0b" },
  "Kern":         { b118: "5-022.14", color: "#14b8a6" },
  "Pleasant Valley": { b118: "5-022.10", color: "#94a3b8" },
};
const NORM = { "Kern County": "Kern" };   // geojson subbasin value -> our name
const norm = (s) => NORM[s] || s;

// order + friendly labels for panel metrics
const METRIC_LABEL = {
  sustainable_yield: "Sustainable yield", change_in_storage: "Change in storage (overdraft)",
  total_extraction: "Groundwater pumping", basin_area: "Subbasin area", n_gsas: "GSAs",
  smc_subsidence_mt_annual: "Subsidence MT (annual)", smc_subsidence_mt_cumulative: "Subsidence MT (cumulative)",
  smc_gwl_mt: "Groundwater-level MT", smc_storage_ur: "Storage undesirable result",
  smc_wq_mt: "Water-quality MT", pma_count: "Projects & mgmt actions",
  rms_count_subsidence: "Subsidence RMS", rms_count_gwl: "GW-level RMS", consultant: "Prepared by",
  gsp_date: "GSP date",
};
const PANEL_ORDER = ["gsp_date", "consultant", "n_gsas", "basin_area", "sustainable_yield",
  "total_extraction", "change_in_storage", "smc_subsidence_mt_cumulative", "smc_subsidence_mt_annual",
  "smc_gwl_mt", "smc_storage_ur", "smc_wq_mt", "rms_count_subsidence", "rms_count_gwl", "pma_count"];

let METRICS = {};        // subbasin -> [rows]
let DOCS = {};           // canonical_name -> {local_filename, drive_url}
let GSPS_BY_SUB = {};    // subbasin name -> [registry GSP rows]
let GSA_ACREAGE = {};    // GSA name -> {total_area:{value,page,source_doc}, irrigated_area:{...}}
let CROP = [];           // rows: {subbasin,gsa,year,cropped_acres,...crop cats}
const CROP_YEARS = [2020, 2021, 2022, 2023, 2024];
let WELLS_BY_GSA = {};   // gsa name -> {wells_pip, gears_reported, by-purpose...} (Tule/Tulare Lake, GEARS)

/* ---- CSV parsing (quote-aware) ---- */
function parseCSV(text) {
  const rows = []; let i = 0, field = "", row = [], q = false;
  const pushF = () => { row.push(field); field = ""; };
  const pushR = () => { pushF(); rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") pushF();
    else if (c === "\r") {}
    else if (c === "\n") pushR();
    else field += c;
    i++;
  }
  if (field.length || row.length) pushR();
  const hdr = rows.shift();
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(hdr.map((h, j) => [h, r[j] ?? ""])));
}

function pageNum(s) {
  if (!s) return "";
  let m = s.match(/pp?\.?\s*(\d{1,4})/i);        // "p169", "pp52-53"
  if (m) return m[1];
  m = s.match(/(?:^|\s)(\d{2,4})(?=\s|$)/);       // a standalone page number ("146")
  return m ? m[1] : "";
}

// DWR-sourced metrics (extractions, wells, storage) link to the public CNRA SGMA dataset portal.
const DWR_DATA_URL = "https://data.cnra.ca.gov/dataset/sgma-groundwater-management/resource";
const DWR_PORTAL = "https://data.cnra.ca.gov/dataset/sgma-groundwater-management";

/* Resolve a value's source to a URL: R2 page-jump if PDF_BASE set, else the Drive folder. */
function srcLink(sourceDoc, page) {
  if (/^DWR\b/.test(sourceDoc || "")) return { url: DWR_PORTAL, label: "DWR data ↗" };
  const doc = DOCS[sourceDoc];
  const file = doc && doc.local_filename;
  const pg = pageNum(page);
  if (CFG.PDF_BASE && file)
    return { url: `${CFG.PDF_BASE}/${encodeURIComponent(file)}${pg ? "#page=" + pg : ""}`, label: page || "source" };
  if (doc && doc.drive_url)
    return { url: doc.drive_url, label: (page || "source") + " ↗ Drive" };
  return { url: CFG.DRIVE_FOLDER, label: (page || "source") + " ↗ Drive" };
}

function fmt(v, units) {
  if (units === "AF/yr" || units === "acres") {
    const n = Number(v); if (!isNaN(n)) return n.toLocaleString();
  }
  return v;
}

// Eastern Tule GSA is a JPA — these member GSAs are covered by its GSP.
const ET_MEMBERS = ["Terra Bella Irrigation District GSA", "Porterville Irrigation District GSA",
  "Saucelito Irrigation District GSA", "Tea Pot Dome Water District GSA", "Vandalia Water District GSA",
  "County of Tulare GSA - Tule", "Tule East GSA JPA"];
const escA = (s) => (s || "").replace(/"/g, "'");

/* Full-document link (page 1) for a GSP's "Full GSP" link. */
function fullGspLink(canon) {
  const doc = DOCS[canon];
  if (CFG.PDF_BASE && doc && doc.local_filename) return `${CFG.PDF_BASE}/${encodeURIComponent(doc.local_filename)}`;
  return (doc && doc.drive_url) || CFG.DRIVE_FOLDER;
}

/* Second line under each GSA: total + irrigated acreage (from the catalogue), each page-linked. */
function acreageLine(gsa) {
  const a = GSA_ACREAGE[gsa] || {};
  const tag = { derived: ' <i title="subbasin residual — GSP states only sub-areas">(derived)</i>',
                crossref: ' <i title="stated in a neighboring GSP">(cross-ref)</i>',
                gis: ' <i title="geodesic area of the official DWR GSA boundary">(DWR boundary)</i>' };
  const bit = (o, lbl) => {
    if (!o) return "";
    const linkText = o.status === "landiq" ? "LandIQ 2024"
      : o.status === "gis" && !pageNum(o.page) ? "boundary"
      : "p" + pageNum(o.page);
    return `${Number(o.value).toLocaleString()} ac ${lbl} ` +
      `<a class="src" href="${srcLink(o.source_doc, o.page).url}" target="_blank">${linkText}</a>` + (tag[o.status] || "");
  };
  const parts = [bit(a.total_area, "total"), bit(a.irrigated_area, "irrigated")].filter(Boolean);
  // If no catalogued irrigated figure, fall back to the latest LandIQ cropped acres for this GSA.
  if (!a.irrigated_area) {
    const c = CROP.filter(r => r.gsa === gsa).sort((x, y) => Number(y.year) - Number(x.year))[0];
    if (c) parts.push(`${Math.round(Number(c.cropped_acres)).toLocaleString()} ac cropped ` +
      `<a class="src" href="${DWR_PORTAL}" target="_blank" title="DWR LandIQ ${c.year}">${c.year}</a>`);
  }
  // GEARS extraction wells (Tule/Tulare Lake only).
  const w = WELLS_BY_GSA[gsa];
  if (w && Number(w.wells_pip) > 0) parts.push(`${Number(w.wells_pip).toLocaleString()} GEARS wells`);
  return parts.length ? `<div class="gsa-ac">${parts.join(" · ")}</div>` : "";
}

/* GSAs grouped by the GSP that covers them, each group with a Full GSP link. */
function gsaGroups(name) {
  const gsas = (window.GSA_BY_SUB[name] || []).slice().sort();
  if (!gsas.length) return "";
  const gsps = GSPS_BY_SUB[name] || [];
  const coord = gsps.find(g => /Subbasin|coordinated/i.test(g.gsa_or_area));
  const groups = {};
  for (const g of gsas) {
    let gsp = gsps.find(x => x.gsa_or_area === g);
    if (!gsp && ET_MEMBERS.includes(g)) gsp = gsps.find(x => x.gsa_or_area === "Eastern Tule GSA");
    if (!gsp) gsp = coord;
    const k = gsp ? gsp.canonical_name : "__none__";
    (groups[k] = groups[k] || []).push(g);
  }
  const acr = gsas.map(g => GSA_ACREAGE[g]).filter(Boolean);
  const anyTotal = acr.some(a => a.total_area);
  const note = anyTotal
    ? `✓ Total area = official DWR GSA boundary (geodesic; sums to subbasin). Cropped acres = DWR LandIQ (latest yr).`
    : `Acreage cataloguing in progress.`;
  let html = `<div class="gsa-list"><h4>${gsas.length} GSAs — grouped by GSP</h4>` +
    `<div class="gsa-note"${anyTotal ? ' style="color:#15803d"' : ''}>${note}</div>`;
  for (const [canon, list] of Object.entries(groups)) {
    const head = canon === "__none__" ? "<i>GSA GSP not yet cataloged</i>"
      : `${canon} <a class="src" href="${fullGspLink(canon)}" target="_blank">Full GSP ↗</a>`;
    html += `<div class="gsp-group"><div class="gsp-head">${head}</div><ul>` +
      list.map(g => `<li>${g}${acreageLine(g)}</li>`).join("") + `</ul></div>`;
  }
  return html + `</div>`;
}

/* ---- Detail panel ---- */
function showPanel(name) {
  const sb = SUBBASINS[name];
  const subRows = (METRICS[name] || []).filter(r => (r.area_name || "Subbasin") === "Subbasin");
  const panel = document.getElementById("panel");
  if (!subRows.length && !(window.GSA_BY_SUB[name] || []).length) {
    panel.innerHTML = `<h3>${name}</h3><div class="b118">${sb ? sb.b118 : ""}</div>
      <div class="panel-empty">No GSP metrics cataloged for this subbasin yet.</div>`;
    return;
  }
  const by = {}; subRows.forEach(r => { by[r.metric] = r; });
  let html = `<h3>${name} Subbasin</h3><div class="b118">${sb.b118}</div>`;
  for (const m of PANEL_ORDER) {
    const r = by[m]; if (!r || r.value === "") continue;
    const s = srcLink(r.source_doc, r.page || r.source_ref);
    const per = r.per_area ? ` <small>(${r.per_area} ${r.units === "AF/yr" ? "AF/ac" : "/ac"})</small>` : "";
    const caution = /CAUTION/i.test(r.notes) ? ` <span class="caution">⚠ verify</span>` : "";
    html += `<div class="stat"><div class="stat-k">${METRIC_LABEL[m] || m}${r.period && r.period !== "-" ? " · " + r.period : ""}</div>
      <div class="stat-v">${fmt(r.value, r.units)}${r.units && r.units !== "text" && r.units !== "date" ? " <small>" + r.units + "</small>" : ""}${per}${caution}
      <a class="src" href="${s.url}" target="_blank" title="${escA((r.page || r.source_ref) + " — " + r.notes)}">GSP Source Page →</a></div></div>`;
  }
  html += cropTrendSection(name);
  html += gearsWellsSection(name);
  html += breakdownSection(name, "extraction", "Groundwater pumping by sector",
    "gw_extraction_total", "gw_extraction_", "AF/yr");
  html += breakdownSection(name, "monitoring", "Monitoring wells by use",
    "rms_wells_total", "rms_wells_", "count");
  html += gsaGroups(name);
  panel.innerHTML = html;
}

/* GEARS extraction wells by purpose (Tule & Tulare Lake only — the GEARS coverage area), summed
   from the per-GSA GEARS well data, with the map's point-in-polygon total cross-checked against
   GEARS' own reported total. */
const GEARS_PURPOSES = [["irrigated_agriculture", "Irrigated Ag"], ["household", "Household"],
  ["livestock", "Livestock"], ["public_supply", "Public Supply"], ["industrial", "Industrial"],
  ["other", "Other"], ["unknown", "Unknown"]];
function gearsWellsSection(name) {
  const rows = Object.values(WELLS_BY_GSA).filter(r => r.subbasin === name);
  if (!rows.length) return "";
  const N = k => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  const pip = N("wells_pip"), gears = N("gears_reported"), dm = N("de_minimis");
  const purp = GEARS_PURPOSES.map(([k, lbl]) => ({ lbl, n: N(k) })).filter(p => p.n > 0)
    .sort((a, b) => b.n - a.n);
  const gearsUrl = "https://greenacresag.github.io/GEARS-map/";
  return `<div class="gsa-list"><h4>GEARS extraction wells
      <a class="src" href="${gearsUrl}" target="_blank" title="GreenAcresAg GEARS map">GEARS ↗</a></h4>
    <div class="stat-v" style="font-size:15px">${pip.toLocaleString()} <small>wells · ${dm.toLocaleString()} de minimis</small></div>
    <div class="gsa-ac" style="color:#15803d">✓ map point-in-polygon ${pip.toLocaleString()} vs GEARS-reported ${gears.toLocaleString()} (±${Math.abs(pip - gears)})</div>
    <ul>${purp.map(p => `<li>${p.lbl}: <b>${p.n.toLocaleString()}</b> <small>(${Math.round(p.n / pip * 100)}%)</small></li>`).join("")}</ul></div>`;
}

/* Cropped-acre trend (2020–2024) for a subbasin: a small year-by-year bar sparkline, sourced
   from DWR LandIQ crop mapping. Shows drought-fallowing / wet-year recovery. */
function cropTrendSection(name) {
  const rows = CROP.filter(c => c.subbasin === name);
  if (!rows.length) return "";
  const byYear = {};
  rows.forEach(c => { byYear[c.year] = (byYear[c.year] || 0) + Number(c.cropped_acres || 0); });
  const series = CROP_YEARS.map(y => ({ y, v: byYear[y] || 0 })).filter(d => d.v > 0);
  if (!series.length) return "";
  const max = Math.max(...series.map(d => d.v));
  const bars = series.map(d => {
    const h = Math.round((d.v / max) * 46) + 2;
    return `<div class="ct-col" title="${d.y}: ${Math.round(d.v).toLocaleString()} cropped ac">
      <div class="ct-bar" style="height:${h}px"></div><div class="ct-yr">${String(d.y).slice(2)}</div></div>`;
  }).join("");
  const last = series[series.length - 1], first = series[0];
  const chg = first.v ? Math.round((last.v - first.v) / first.v * 100) : 0;
  return `<div class="gsa-list"><h4>Cropped acres · ${first.y}–${last.y}
      <a class="src" href="${DWR_PORTAL}" target="_blank" title="DWR i15 Statewide Crop Mapping (LandIQ)">LandIQ ↗</a></h4>
    <div class="ct-wrap">${bars}</div>
    <div class="gsa-ac">${Math.round(last.v).toLocaleString()} ac cropped in ${last.y}
      <span style="color:${chg < 0 ? '#b45309' : '#15803d'}">(${chg >= 0 ? '+' : ''}${chg}% since ${first.y})</span></div></div>`;
}

/* Latest (2024) cropped acres for a subbasin, from the LandIQ crop series. */
function subCropped(name, year) {
  const rows = CROP.filter(c => c.subbasin === name && (year ? Number(c.year) === year : true));
  if (!rows.length) return 0;
  const y = year || Math.max(...rows.map(c => Number(c.year)));
  return CROP.filter(c => c.subbasin === name && Number(c.year) === y)
    .reduce((a, c) => a + Number(c.cropped_acres || 0), 0);
}

/* A titled block: a total row + its component breakdown, all sharing one (DWR) source link.
   Rows are category-matched; `totalMetric` is the sum row, `prefix`+X are the components.
   For AF/yr sectors, also shows AF per cropped acre (dual normalization). */
function breakdownSection(name, category, title, totalMetric, prefix, units) {
  const rows = (METRICS[name] || []).filter(r => r.category === category &&
    (r.area_name || "Subbasin") === "Subbasin" && r.metric.startsWith(prefix) && r.value !== "");
  if (!rows.length) return "";
  const total = rows.find(r => r.metric === totalMetric);
  const parts = rows.filter(r => r !== total).sort((a, b) => Number(b.value) - Number(a.value));
  const s = total ? srcLink(total.source_doc, total.page) : srcLink(parts[0].source_doc, parts[0].page);
  const period = total && total.period && total.period !== "current" ? " · " + total.period : "";
  const label = m => m.replace(prefix, "").replace(/_/g, " ");
  const num = v => Number(v).toLocaleString();
  const cropped = units === "AF/yr" ? subCropped(name) : 0;   // dual-normalize AF metrics per cropped acre
  const perCrop = v => cropped ? ` <small>· ${(Number(v) / cropped).toFixed(2)} AF/cropped-ac</small>` : "";
  let html = `<div class="gsa-list"><h4>${title}${period}` +
    ` <a class="src" href="${s.url}" target="_blank" title="${escA((total || parts[0]).notes)}">${s.label}</a></h4>`;
  if (total) html += `<div class="stat-v" style="font-size:15px">${num(total.value)} <small>${units}</small>${perCrop(total.value)}</div>`;
  html += `<ul>` + parts.map(r => {
    const pct = total && Number(total.value) ? ` <small>(${Math.round(Number(r.value) / Number(total.value) * 100)}%)</small>` : "";
    const pc = /agricultural/.test(r.metric) ? perCrop(r.value) : "";
    return `<li>${label(r.metric)}: <b>${num(r.value)}</b>${units === "count" ? "" : " " + units}${pct}${pc}</li>`;
  }).join("") + `</ul></div>`;
  return html;
}

/* ---- Comparison charts (per-acre bars) ---- */
function barChart(title, metric, opts) {
  const data = Object.keys(SUBBASINS).map(name => {
    const r = (METRICS[name] || []).find(x => x.metric === metric && x.value !== "" &&
      (opts.period ? x.period === opts.period : true));
    return r ? { name, val: parseFloat(opts.perArea ? r.per_area : r.value), row: r } : null;
  }).filter(Boolean).sort((a, b) => opts.asc ? a.val - b.val : Math.abs(b.val) - Math.abs(a.val));
  if (!data.length) return "";
  const max = Math.max(...data.map(d => Math.abs(d.val)));
  const rows = data.map(d => {
    const s = srcLink(d.row.source_doc, d.row.page || d.row.source_ref);
    const w = max ? (Math.abs(d.val) / max * 100) : 0;
    return `<div class="bar-row"><span class="lbl">${d.name}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${w}%;background:${SUBBASINS[d.name].color}"></span></span>
      <span class="val">${opts.fmt(d.val)} <a class="src" href="${s.url}" target="_blank" title="${d.row.source_doc}">↗</a></span></div>`;
  }).join("");
  return `<div class="chart-card"><h3>${title}</h3>${rows}</div>`;
}

/* Cross-subbasin AF/yr metric normalized per cropped acre (LandIQ), not per total subbasin area —
   a truer "applied groundwater depth" comparison. */
function perCroppedAcreChart(title, metric) {
  const data = Object.keys(SUBBASINS).map(name => {
    const r = (METRICS[name] || []).find(x => x.metric === metric && x.value !== "");
    const crop = subCropped(name);
    return r && crop ? { name, val: Number(r.value) / crop, row: r } : null;
  }).filter(Boolean).sort((a, b) => b.val - a.val);
  if (!data.length) return "";
  const max = Math.max(...data.map(d => d.val));
  const rows = data.map(d => {
    const s = srcLink(d.row.source_doc, d.row.page);
    const w = max ? (d.val / max * 100) : 0;
    return `<div class="bar-row"><span class="lbl">${d.name}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${w}%;background:${SUBBASINS[d.name].color}"></span></span>
      <span class="val">${d.val.toFixed(2)} <a class="src" href="${s.url}" target="_blank" title="ag pumping ÷ 2024 cropped acres">↗</a></span></div>`;
  }).join("");
  return `<div class="chart-card"><h3>${title} <small style="font-weight:400;color:#64748b">AF/cropped-ac</small></h3>${rows}</div>`;
}

/* Cross-subbasin cropped acres (2024) with a 2020→2024 change indicator. */
function cropCompareChart() {
  const data = Object.keys(SUBBASINS).map(name => {
    const rows = CROP.filter(c => c.subbasin === name);
    if (!rows.length) return null;
    const sum = y => rows.filter(c => Number(c.year) === y).reduce((a, c) => a + Number(c.cropped_acres || 0), 0);
    const v = sum(2024), base = sum(2020);
    return v ? { name, val: v, chg: base ? Math.round((v - base) / base * 100) : 0 } : null;
  }).filter(Boolean).sort((a, b) => b.val - a.val);
  if (!data.length) return "";
  const max = Math.max(...data.map(d => d.val));
  const rows = data.map(d => {
    const w = max ? (d.val / max * 100) : 0;
    const chg = `<span style="color:${d.chg < 0 ? '#b45309' : '#15803d'}">${d.chg >= 0 ? '+' : ''}${d.chg}%</span>`;
    return `<div class="bar-row"><span class="lbl">${d.name}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${w}%;background:${SUBBASINS[d.name].color}"></span></span>
      <span class="val">${Math.round(d.val / 1000)}k ${chg}</span></div>`;
  }).join("");
  return `<div class="chart-card"><h3>Cropped acres — 2024 (Δ vs 2020)
    <a class="src" href="${DWR_PORTAL}" target="_blank" title="DWR LandIQ crop mapping">↗</a></h3>${rows}</div>`;
}

function renderCharts() {
  document.getElementById("charts-grid").innerHTML = [
    barChart("Sustainable yield (per acre)", "sustainable_yield", { perArea: true, fmt: v => v.toFixed(2) + " AF/ac" }),
    barChart("Overdraft — change in storage (per acre)", "change_in_storage", { perArea: true, fmt: v => v.toFixed(2) + " AF/ac" }),
    barChart("Sustainable yield (total)", "sustainable_yield", { perArea: false, fmt: v => Math.round(v).toLocaleString() + " AFY" }),
    perCroppedAcreChart("Ag pumping per cropped acre", "gw_extraction_agricultural"),
    barChart("Total groundwater pumping", "gw_extraction_total", { perArea: false, fmt: v => Math.round(v).toLocaleString() + " AFY" }),
    cropCompareChart(),
    barChart("Subbasin area", "basin_area", { perArea: false, fmt: v => Math.round(v).toLocaleString() + " ac" }),
  ].join("");
}

/* ---- Map ---- */
function initMap(geo) {
  window.GSA_BY_SUB = {};
  geo.features.forEach(f => {
    const s = norm(f.properties.subbasin);
    (window.GSA_BY_SUB[s] = window.GSA_BY_SUB[s] || []).push(f.properties.GSA_Name);
    f.properties._sub = s;
  });
  const colorExpr = ["match", ["get", "_sub"]];
  Object.entries(SUBBASINS).forEach(([n, v]) => colorExpr.push(n, v.color));
  colorExpr.push("#cbd5e1");

  const map = new maplibregl.Map({
    container: "map", center: [-119.6, 36.2], zoom: 6.6,
    style: { version: 8, sources: {
      osm: { type: "raster", tiles: ["https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
             tileSize: 256, attribution: "© OpenStreetMap © CARTO" } },
      layers: [{ id: "bg", type: "raster", source: "osm" }] },
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.on("load", () => {
    map.addSource("sub", { type: "geojson", data: geo });
    map.addLayer({ id: "fill", type: "fill", source: "sub",
      paint: { "fill-color": colorExpr, "fill-opacity": 0.55 } });
    map.addLayer({ id: "line", type: "line", source: "sub",
      paint: { "line-color": "#334155", "line-width": 0.6 } });
    map.on("click", "fill", (e) => showPanel(e.features[0].properties._sub));
    map.on("mouseenter", "fill", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "fill", () => map.getCanvas().style.cursor = "");
  });
}

/* ---- boot ---- */
const B118_NAME = Object.fromEntries(Object.entries(SUBBASINS).map(([n, v]) => [v.b118, n]));
Promise.all([
  fetch("data/gsp_metrics.csv").then(r => r.text()),
  fetch("data/source_documents.csv").then(r => r.text()),
  fetch("data/subbasins_gsas.geojson").then(r => r.json()),
  fetch("data/gsa_acreage.csv").then(r => r.ok ? r.text() : ""),
  fetch("data/crop_acres_by_gsa.csv").then(r => r.ok ? r.text() : ""),
  fetch("data/wells_by_gsa.csv").then(r => r.ok ? r.text() : ""),
]).then(([mText, dText, geo, aText, cText, wText]) => {
  if (cText) CROP = parseCSV(cText);
  if (wText) parseCSV(wText).forEach(r => { WELLS_BY_GSA[r.gsa] = r; });
  parseCSV(mText).forEach(r => { (METRICS[r.subbasin_name] = METRICS[r.subbasin_name] || []).push(r); });
  parseCSV(dText).forEach(r => {
    DOCS[r.canonical_name] = r;
    if (r.doc_type === "GSP") { const n = B118_NAME[r.subbasin]; if (n) (GSPS_BY_SUB[n] = GSPS_BY_SUB[n] || []).push(r); }
  });
  if (aText) parseCSV(aText).forEach(r => {
    (GSA_ACREAGE[r.gsa] = GSA_ACREAGE[r.gsa] || {})[r.metric] =
      { value: r.value, page: r.page, source_doc: r.source_doc, status: r.status || "" };
  });
  document.getElementById("link-mode").textContent =
    CFG.PDF_BASE ? "(links jump to the exact page)" : "(links open the source document in Drive)";
  document.getElementById("drive-link").href = CFG.DRIVE_FOLDER;
  initMap(geo);
  renderCharts();
});
