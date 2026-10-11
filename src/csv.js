// CSV downloads are real HTTP attachments. The dashboard must not rebuild
// them as blob: or data: URLs: those skip the headers below, often lose the
// .csv name, and are what endpoint scanners treat as a scripted download.

const UTF8_BOM = '\uFEFF';

// Spreadsheet apps treat a cell that starts with one of these as a formula.
// A leading single quote forces the cell to be text (OWASP CSV injection).
const FORMULA_START = /^[=+\-@\t\r]/;

const KIND = {
  results: 'results',
  progress: 'progress',
  'test-traffic': 'test-traffic',
};

function csvField(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  const text = FORMULA_START.test(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function renderCsv(rows) {
  const lines = (rows || []).map((row) => row.map((cell) => csvField(cell)).join(','));
  return UTF8_BOM + lines.join('\n');
}

function formatUtcDay(date) {
  const day = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const month = String(day.getUTCMonth() + 1).padStart(2, '0');
  const dateNum = String(day.getUTCDate()).padStart(2, '0');
  return `${day.getUTCFullYear()}-${month}-${dateNum}`;
}

function collapseSlug(value, pattern) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(pattern, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

// Letters from any script, so filename* can keep the experiment's real name.
function slugUnicode(name) {
  const cleaned = String(name || '').replace(/[\u0000-\u001f\u007f"/\\?%*:|<>]/g, ' ');
  return collapseSlug(cleaned, /[^\p{L}\p{N}]+/gu) || 'experiment';
}

// Quoted filename= is ASCII only. Accents fold; everything else drops.
function slugAscii(name) {
  const folded = String(name || '').normalize('NFKD').replace(/\p{M}/gu, '');
  return collapseSlug(folded, /[^a-z0-9]+/g) || 'experiment';
}

function csvFilename(experimentName, kind, date) {
  const token = KIND[kind] || 'results';
  const tail = `${token}-${formatUtcDay(date)}.csv`;
  return {
    ascii: `${slugAscii(experimentName)}-${tail}`,
    utf8: `${slugUnicode(experimentName)}-${tail}`,
  };
}

// RFC 5987 attr-chars. encodeURIComponent leaves !'()*~ unescaped.
function encodeRfc5987(value) {
  return encodeURIComponent(String(value)).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function contentDispositionAttachment(names) {
  const ascii = String(names.ascii || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'experiment-results.csv';
  const utf8 = String(names.utf8 || ascii).replace(/[\r\n]/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(utf8)}`;
}

function sendCsv(res, filename, rows) {
  const names = typeof filename === 'string' ? { ascii: filename, utf8: filename } : filename;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', contentDispositionAttachment(names));
  res.send(renderCsv(rows));
}

module.exports = {
  UTF8_BOM,
  csvField,
  renderCsv,
  csvFilename,
  contentDispositionAttachment,
  sendCsv,
};
