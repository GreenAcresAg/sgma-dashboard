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

1. **Create a bucket** (Cloudflare R2 free tier, or Backblaze B2). Enable public read.
2. **Upload the PDFs** (filenames must match `local_filename` in `source_documents.csv`). From the
   Drive-synced folder or local copies:
   ```bash
   rclone copy "<local docs folder>" r2:sgma-docs --transfers 4
   ```
3. Set `PDF_BASE` in `config.js`, e.g. `"https://pub-xxxx.r2.dev/sgma-docs"` (no trailing slash).

Until `PDF_BASE` is set, links fall back to the shared **Drive folder** (opens the document; the
page number is shown as text). Add a `drive_url` column to `source_documents.csv` to deep-link
individual Drive files instead of the folder.

## Deploy
GitHub Pages, served from `main` / root. Vanilla HTML/JS + vendored MapLibre GL — no build step.
