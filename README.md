# SJV Subbasin GSP Dashboard

Interactive comparison of Groundwater Sustainability Plan (GSP) metrics across the southern San
Joaquin Valley subbasins (Westside, Tulare Lake, Kaweah, Kings, Tule, Kern). Static site — click a
subbasin for its headline stats, compare across subbasins in the charts, and every number links to
the exact GSP page it came from.

Live: https://greenacresag.github.io/sgma-dashboard/

## Data
Pulled from the [`sgma-annual-report-data`](https://github.com/GreenAcresAg/sgma-annual-report-data)
repo (the normalized catalog):
- `data/gsp_metrics.csv` — the comparison table (one row per subbasin × metric, with `per_area`,
  `source_doc`, `page`).
- `data/source_documents.csv` — the document registry (canonical GSP name → `local_filename`).
- `data/subbasins_gsas.geojson` — GSA boundaries (from the InSAR map repo).

Refresh with:
```bash
cp ../sgma-annual-report-data/gsp/gsp_metrics.csv data/
cp ../sgma-annual-report-data/docs/source_documents.csv data/
```

## Linking to the exact GSP page (`config.js`)
Google Drive's viewer can't deep-link to a page, so page-jump links need the raw PDFs served from
object storage that supports HTTP range requests. Set `PDF_BASE` in `config.js` to your public
bucket and links become `…/<local_filename>#page=<page>`:

1. **Create a public bucket** (Cloudflare R2 free tier, or Backblaze B2). Note its public base URL
   (e.g. `https://pub-xxxxxxxx.r2.dev`).
2. **Configure an rclone remote** for it named `r2`: `rclone config` → `s3` / provider `Cloudflare`
   (or B2). You'll need the bucket's Access Key ID + Secret from the Cloudflare dashboard.
3. **Upload the PDFs** — the helper stages exactly the files named in the registry and pushes them
   flat (the dashboard expects `${PDF_BASE}/<local_filename>`):
   ```bash
   scripts/upload-r2.sh ~/Downloads r2:sgma-gsp-data
   ```
4. Set `PDF_BASE` in `config.js` (e.g. `"https://pub-xxxxxxxx.r2.dev"`, no trailing slash) and push.

Until `PDF_BASE` is set, links fall back to each document's **Drive file** (`drive_url` in
`source_documents.csv`, auto-populated from the shared folder) — opens the document; the page is
shown as text. Two docs (2022 Tulare Lake GSP, GKGSA Draft) aren't in the Drive folders yet, so
those fall back to the folder link.

## Deploy
GitHub Pages, served from `main` / root. Vanilla HTML/JS + vendored MapLibre GL — no build step.
