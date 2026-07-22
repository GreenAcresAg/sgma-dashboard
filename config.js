/* Dashboard config.
 * PDF_BASE: set to your Cloudflare R2 / Backblaze B2 public bucket base URL to enable true
 *   page-jump links (opens the raw PDF at file.pdf#page=N in the browser's PDF viewer). The PDF
 *   filenames must match `local_filename` in data/source_documents.csv. Leave "" to fall back to
 *   the Drive folder (opens the document, no page jump — Drive can't deep-link a page).
 * DRIVE_FOLDER: the shared Google Drive folder that houses every GSP + annual report. */
window.DASH_CONFIG = {
  PDF_BASE: "",   // e.g. "https://pub-xxxxxxxx.r2.dev/sgma-docs"  (no trailing slash)
  DRIVE_FOLDER: "https://drive.google.com/drive/folders/12mUnbM_7podiWyyj2vviOV9u3gkkQLhp",
};
