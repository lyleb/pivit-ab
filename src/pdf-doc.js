// Small PDF 1.4 writer. Helvetica is a standard font, so the file does not
// depend on a browser, a font file, or a machine-specific install.

function pdfString(text) {
  const folded = String(text == null ? '' : text);
  let out = '';
  for (const ch of folded) {
    if (ch === '\\' || ch === '(' || ch === ')') {
      out += `\\${ch}`;
      continue;
    }
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126) {
      out += ch;
      continue;
    }
    if (ch === '£') { out += '\\243'; continue; }
    if (ch === '·') { out += '\\267'; continue; }
    if (ch === '\n' || ch === '\r' || ch === '\t') { out += ' '; continue; }
    if (ch === '–' || ch === '—') { out += '-'; continue; }
    if (ch === '‘' || ch === '’') { out += "'"; continue; }
    if (ch === '“' || ch === '”') { out += '"'; continue; }
    out += '?';
  }
  return out;
}

function wrapText(text, size, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const widthOf = (word) => word.length * size * 0.5;
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (widthOf(next) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function renderDocument(items) {
  const pageWidth = 595;
  const pageHeight = 842;
  const marginX = 48;
  const maxWidth = pageWidth - marginX * 2;
  const pages = [];
  let ops = [];
  let y = 786;

  function newPage() {
    pages.push(ops);
    ops = [];
    y = 786;
  }

  for (const item of items) {
    const size = item.size || 11;
    const gap = item.gapBefore || 0;
    const lines = wrapText(item.text, size, maxWidth);
    const needed = gap + lines.length * (size + 3);
    if (y - needed < 64 && ops.length) newPage();
    y -= gap;
    const font = item.bold ? 'F2' : 'F1';
    for (const line of lines) {
      y -= size;
      ops.push(`BT /${font} ${size} Tf ${marginX} ${y.toFixed(2)} Td (${pdfString(line)}) Tj ET`);
      y -= 3;
    }
  }
  if (!pages.length || ops.length) pages.push(ops);

  const total = pages.length;
  const pageObjs = [];
  const kids = [];
  let nextId = 5;
  for (let i = 0; i < pages.length; i += 1) {
    const contentId = nextId;
    nextId += 1;
    const pageId = nextId;
    nextId += 1;
    const footer = `BT /F1 9 Tf ${marginX} 36 Td (${pdfString(`pivitlab  ·  page ${i + 1} of ${total}`)}) Tj ET`;
    const stream = pages[i].concat(footer).join('\n');
    pageObjs.push({ contentId, pageId, stream });
    kids.push(`${pageId} 0 R`);
  }

  const objects = [
    { id: 1, raw: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, raw: `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${total} >>` },
    { id: 3, raw: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
    { id: 4, raw: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>' },
  ];
  for (const page of pageObjs) {
    objects.push({
      id: page.contentId,
      raw: `<< /Length ${Buffer.byteLength(page.stream)} >>\nstream\n${page.stream}\nendstream`,
    });
    objects.push({
      id: page.pageId,
      raw: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${page.contentId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`,
    });
  }

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const obj of objects) {
    offsets[obj.id] = Buffer.byteLength(pdf);
    pdf += `${obj.id} 0 obj\n${obj.raw}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  const size = objects.length + 1;
  pdf += `xref\n0 ${size}\n`;
  pdf += '0000000000 65535 f \n';
  for (let id = 1; id < size; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

module.exports = {
  pdfString,
  wrapText,
  renderDocument,
};
