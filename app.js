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

/* Resolve a value's source to a URL: R2 page-jump if PDF_BASE set, else the Drive folder. */
function srcLink(sourceDoc, page) {
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
  const bit = (o, lbl) => o ? `${Number(o.value).toLocaleString()} ac ${lbl} ` +
    `<a class="src" href="${srcLink(o.source_doc, o.page).url}" target="_blank">p${pageNum(o.page)}</a>` : "";
  const parts = [bit(a.total_area, "total"), bit(a.irrigated_area, "irrigated")].filter(Boolean);
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
  let html = `<div class="gsa-list"><h4>${gsas.length} GSAs — grouped by GSP</h4>` +
    `<div class="gsa-note">⚠ GSA acreage auto-extracted from GSPs — page-linked, being verified</div>`;
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
  html += gsaGroups(name);
  panel.innerHTML = html;
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

function renderCharts() {
  document.getElementById("charts-grid").innerHTML = [
    barChart("Sustainable yield (per acre)", "sustainable_yield", { perArea: true, fmt: v => v.toFixed(2) + " AF/ac" }),
    barChart("Overdraft — change in storage (per acre)", "change_in_storage", { perArea: true, fmt: v => v.toFixed(2) + " AF/ac" }),
    barChart("Sustainable yield (total)", "sustainable_yield", { perArea: false, fmt: v => Math.round(v).toLocaleString() + " AFY" }),
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
]).then(([mText, dText, geo, aText]) => {
  parseCSV(mText).forEach(r => { (METRICS[r.subbasin_name] = METRICS[r.subbasin_name] || []).push(r); });
  parseCSV(dText).forEach(r => {
    DOCS[r.canonical_name] = r;
    if (r.doc_type === "GSP") { const n = B118_NAME[r.subbasin]; if (n) (GSPS_BY_SUB[n] = GSPS_BY_SUB[n] || []).push(r); }
  });
  if (aText) parseCSV(aText).forEach(r => {
    (GSA_ACREAGE[r.gsa] = GSA_ACREAGE[r.gsa] || {})[r.metric] = { value: r.value, page: r.page, source_doc: r.source_doc };
  });
  document.getElementById("link-mode").textContent =
    CFG.PDF_BASE ? "(links jump to the exact page)" : "(links open the source document in Drive)";
  document.getElementById("drive-link").href = CFG.DRIVE_FOLDER;
  initMap(geo);
  renderCharts();
});
