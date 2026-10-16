// Small PDF 1.4 writer. Helvetica is a standard font, so the file does not
// depend on a browser, a font file, or a machine-specific install.
// Pages use the pivitlab brand as accents on a light, print-friendly ground.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;
const MAX_W = PAGE_W - MARGIN * 2;
const HEADER_H = 72;
const TOP = PAGE_H - HEADER_H - 22;
const BOTTOM = 56;

const INK = '#1c1f2a';
const MUTED = '#5c6578';
const PAPER = '#f7f8fb';
const HEADER = '#0c0e14';
const MINT = '#02DEB5';
const HEADING = '#0b6b56';
const LINE = '#d9dde6';
const WHITE = '#ffffff';

const TONES = {
  win: { fill: '#e7f8f3', border: '#8ad9c6', bar: '#02DEB5', ink: '#0b6b56', track: '#d5f3ea' },
  loss: { fill: '#fdeeee', border: '#f0b4b8', bar: '#e15b64', ink: '#9a3038', track: '#f8dcdf' },
  inconclusive: { fill: '#fbf6ea', border: '#e6d0a0', bar: '#d4a656', ink: '#8a6420', track: '#f3e7cc' },
  neutral: { fill: '#f4f5f8', border: '#d5d8e2', bar: '#7d8499', ink: '#3d4254', track: '#e4e6ee' },
};

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

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return `${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}`;
}

function num(value) {
  return Number(value).toFixed(2);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  let width = 0;
  let height = 0;
  let colour = 0;
  const idats = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colour = data[9];
      if (data[12] !== 0) throw new Error(`interlaced PNG is not supported: ${file}`);
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const bpp = colour === 6 ? 4 : colour === 2 ? 3 : 0;
  if (!bpp) throw new Error(`unsupported PNG colour type ${colour}: ${file}`);
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = width * bpp;
  const rgba = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p];
    p += 1;
    const row = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      const x = raw[p + i];
      if (filter === 0) row[i] = x;
      else if (filter === 1) row[i] = (x + left) & 255;
      else if (filter === 2) row[i] = (x + up) & 255;
      else if (filter === 3) row[i] = (x + Math.floor((left + up) / 2)) & 255;
      else row[i] = (x + paeth(left, up, ul)) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * bpp;
      const d = (y * width + x) * 4;
      rgba[d] = row[s];
      rgba[d + 1] = row[s + 1];
      rgba[d + 2] = row[s + 2];
      rgba[d + 3] = bpp === 4 ? row[s + 3] : 255;
    }
    row.copy(prev);
    p += stride;
  }
  return { width, height, rgba };
}

function compositeOn(image, backdrop) {
  const { width, height, rgba } = image;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    minX = 0;
    minY = 0;
    maxX = width - 1;
    maxY = height - 1;
  }
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const rgbBuf = Buffer.alloc(cropW * cropH * 3);
  for (let y = 0; y < cropH; y += 1) {
    for (let x = 0; x < cropW; x += 1) {
      const s = ((y + minY) * width + (x + minX)) * 4;
      const a = rgba[s + 3] / 255;
      const d = (y * cropW + x) * 3;
      rgbBuf[d] = Math.round(rgba[s] * a + backdrop[0] * (1 - a));
      rgbBuf[d + 1] = Math.round(rgba[s + 1] * a + backdrop[1] * (1 - a));
      rgbBuf[d + 2] = Math.round(rgba[s + 2] * a + backdrop[2] * (1 - a));
    }
  }
  return { width: cropW, height: cropH, rgb: rgbBuf };
}

let brandCache = null;
function brandImages() {
  if (brandCache) return brandCache;
  const backdrop = [0x0c, 0x0e, 0x14];
  const root = path.join(__dirname, '../public');
  brandCache = {
    logo: compositeOn(decodePng(path.join(root, 'assets/logo-white.png')), backdrop),
    mark: compositeOn(decodePng(path.join(root, 'favicon-32.png')), backdrop),
  };
  return brandCache;
}

function imageObject(image) {
  const compressed = zlib.deflateSync(image.rgb);
  const dict = `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate true /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`;
  return Buffer.concat([
    Buffer.from(dict, 'latin1'),
    compressed,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

function parseRange(label) {
  const match = String(label || '').match(/([+-]?\d+(?:\.\d+)?)%\s+to\s+([+-]?\d+(?:\.\d+)?)%/);
  if (!match) return null;
  const low = Number(match[1]);
  const high = Number(match[2]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { low, high };
}

function formatPct(value) {
  const rounded = Math.round(value * 10) / 10;
  const body = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${rounded > 0 ? '+' : ''}${body}%`;
}

function renderDocument(items, options) {
  const images = brandImages();
  const pages = [];
  let ops = [];
  let y = TOP;

  function breakPage() {
    pages.push(ops);
    ops = [];
    y = TOP;
  }

  function place(height, gap) {
    let lead = gap || 0;
    if (y - lead - height < BOTTOM && ops.length) {
      breakPage();
      lead = 0;
    }
    y -= lead;
    const top = y;
    y -= height;
    return top;
  }

  function text(value, x, baseline, size, bold, colour) {
    const font = bold ? 'F2' : 'F1';
    ops.push(`${rgb(colour || INK)} rg`);
    ops.push(`BT /${font} ${size} Tf ${num(x)} ${num(baseline)} Td (${pdfString(value)}) Tj ET`);
  }

  function drawTextItem(item) {
    const size = item.size || 11;
    const lines = wrapText(item.text, size, MAX_W);
    let lead = item.gapBefore || 0;
    if (lead && y - lead < BOTTOM && ops.length) {
      breakPage();
      lead = 0;
    }
    y -= lead;
    lines.forEach((line) => {
      const need = size + 3;
      if (y - need < BOTTOM && ops.length) breakPage();
      y -= size;
      text(line, MARGIN, y, size, !!item.bold, item.color);
      y -= 3;
    });
  }

  function drawTitle(item) {
    const subtitle = item.subtitle ? wrapText(item.subtitle, 12, MAX_W) : [];
    const height = 26 + (subtitle.length ? 8 + subtitle.length * 16 : 0);
    const top = place(height, item.gapBefore || 0);
    text(item.text, MARGIN, top - 22, 22, true, INK);
    subtitle.forEach((line, index) => {
      text(line, MARGIN, top - 44 - index * 16, 12, true, MUTED);
    });
  }

  function drawHeading(item, follow) {
    const gap = item.gapBefore == null ? 16 : item.gapBefore;
    const need = gap + 16 + Math.min(follow || 36, 96);
    let lead = gap;
    if (y - need < BOTTOM && ops.length) {
      breakPage();
      lead = 0;
    }
    const top = place(16, lead);
    const baseline = top - 13;
    ops.push(`${rgb(MINT)} rg`);
    ops.push(`${num(MARGIN)} ${num(baseline - 1)} 3 12 re f`);
    text(item.text, MARGIN + 10, baseline, 13, true, HEADING);
  }

  function drawCallout(item) {
    const inner = MAX_W - 28;
    const lines = wrapText(item.text, 10, inner);
    const height = 12 + 14 + lines.length * 13 + 10;
    const top = place(height, item.gapBefore == null ? 10 : item.gapBefore);
    const bottom = top - height;
    ops.push(`${rgb('#f3fbf8')} rg`);
    ops.push(`${num(MARGIN)} ${num(bottom)} ${num(MAX_W)} ${num(height)} re f`);
    ops.push(`${rgb(MINT)} rg`);
    ops.push(`${num(MARGIN)} ${num(bottom)} 4 ${num(height)} re f`);
    text(item.eyebrow || 'Demo', MARGIN + 16, top - 22, 9, true, HEADING);
    lines.forEach((line, index) => {
      text(line, MARGIN + 16, top - 36 - index * 13, 10, false, INK);
    });
  }

  function drawVerdict(item) {
    const tone = TONES[item.tone] || TONES.neutral;
    const inner = MAX_W - 36;
    const summaryLines = item.summary ? wrapText(item.summary, 11, inner) : [];
    const captionLines = item.rangeCaption ? wrapText(item.rangeCaption, 10, inner) : [];
    const extraLines = item.extraLine ? wrapText(item.extraLine, 10, inner) : [];
    const probLines = item.probability ? wrapText(item.probability, 11, inner) : [];
    const range = parseRange(item.rangeLabel);
    const chartH = range ? 46 : 0;
    let height = 18 + 18;
    if (summaryLines.length) height += 8 + summaryLines.length * 14;
    if (captionLines.length) height += 12 + captionLines.length * 13;
    if (chartH) height += 6 + chartH;
    if (extraLines.length) height += 6 + extraLines.length * 13;
    if (probLines.length) height += 8 + probLines.length * 14;
    height += 16;
    const top = place(height, item.gapBefore == null ? 8 : item.gapBefore);
    const bottom = top - height;
    ops.push(`${rgb(tone.fill)} rg`);
    ops.push(`${num(MARGIN)} ${num(bottom)} ${num(MAX_W)} ${num(height)} re f`);
    ops.push(`${rgb(tone.bar)} rg`);
    ops.push(`${num(MARGIN)} ${num(bottom)} 5 ${num(height)} re f`);
    ops.push('0.8 w');
    ops.push(`${rgb(tone.border)} RG`);
    ops.push(`${num(MARGIN)} ${num(bottom)} ${num(MAX_W)} ${num(height)} re S`);
    let cursor = top - 18;
    text(item.title || 'Verdict', MARGIN + 18, cursor - 14, 16, true, tone.ink);
    cursor -= 18;
    if (summaryLines.length) cursor -= 8;
    summaryLines.forEach((line) => {
      cursor -= 14;
      text(line, MARGIN + 18, cursor, 11, false, INK);
    });
    if (captionLines.length) cursor -= 12;
    captionLines.forEach((line) => {
      cursor -= 13;
      text(line, MARGIN + 18, cursor, 10, true, tone.ink);
    });
    if (chartH) {
      const chartTop = cursor - 6;
      drawInterval(range, tone, MARGIN + 18, chartTop - 24, inner);
      cursor = chartTop - chartH;
    }
    if (extraLines.length) cursor -= 6;
    extraLines.forEach((line) => {
      cursor -= 13;
      text(line, MARGIN + 18, cursor, 10, false, MUTED);
    });
    if (probLines.length) cursor -= 8;
    probLines.forEach((line) => {
      cursor -= 14;
      text(line, MARGIN + 18, cursor, 11, false, INK);
    });
  }

  function drawInterval(range, tone, x, barBottom, width) {
    let min = Math.min(0, range.low, range.high);
    let max = Math.max(0, range.low, range.high);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;
    const span = max - min || 1;
    const map = (value) => x + ((value - min) / span) * width;
    const barTop = barBottom + 8;
    ops.push(`${rgb(tone.track)} rg`);
    ops.push(`${num(x)} ${num(barBottom)} ${num(width)} 8 re f`);
    const start = Math.min(map(range.low), map(range.high));
    const end = Math.max(map(range.low), map(range.high));
    const barW = Math.max(2, end - start);
    ops.push(`${rgb(tone.bar)} rg`);
    ops.push(`${num(start)} ${num(barBottom)} ${num(barW)} 8 re f`);
    if (min < 0 && max > 0) {
      const zero = map(0);
      ops.push(`${rgb(INK)} rg`);
      ops.push(`${num(zero - 0.6)} ${num(barBottom - 3)} 1.2 14 re f`);
      text('0', zero - 3, barTop + 4, 8, false, MUTED);
    }
    if (barW >= 72) {
      text(formatPct(range.low), start, barBottom - 12, 8, true, tone.ink);
      const highLabel = formatPct(range.high);
      const highX = end - highLabel.length * 4;
      text(highLabel, Math.max(start + 28, highX), barBottom - 12, 8, true, tone.ink);
    }
  }

  function drawTiles(item) {
    const tiles = (item.tiles || []).filter((tile) => tile && tile.value != null && tile.value !== '');
    if (!tiles.length) return;
    const gap = 8;
    const tileW = (MAX_W - gap * (tiles.length - 1)) / tiles.length;
    const wrapped = tiles.map((tile) => wrapText(String(tile.value), 12, tileW - 16).slice(0, 2));
    const lineCount = wrapped.reduce((max, lines) => Math.max(max, lines.length), 1);
    const height = 16 + lineCount * 15 + 12;
    const top = place(height, item.gapBefore == null ? 12 : item.gapBefore);
    const bottom = top - height;
    tiles.forEach((tile, index) => {
      const left = MARGIN + index * (tileW + gap);
      ops.push(`${rgb(WHITE)} rg`);
      ops.push(`${num(left)} ${num(bottom)} ${num(tileW)} ${num(height)} re f`);
      ops.push(`${rgb(MINT)} rg`);
      ops.push(`${num(left)} ${num(top - 3)} ${num(tileW)} 3 re f`);
      ops.push('0.8 w');
      ops.push(`${rgb(LINE)} RG`);
      ops.push(`${num(left)} ${num(bottom)} ${num(tileW)} ${num(height)} re S`);
      text(tile.label, left + 8, top - 16, 8, true, MUTED);
      wrapped[index].forEach((line, lineIndex) => {
        text(line, left + 8, top - 32 - lineIndex * 15, 12, true, INK);
      });
    });
  }

  function drawTable(item) {
    const headers = item.headers || [];
    const rows = item.rows || [];
    if (!headers.length) return;
    const weights = item.weights || headers.map((_, index) => (index === 0 ? 2.1 : 1));
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
    const cols = weights.map((weight) => (MAX_W * weight) / weightSum);
    const colX = [];
    let running = MARGIN;
    cols.forEach((width) => {
      colX.push(running);
      running += width;
    });
    const headerH = 20;
    const rowH = 18;

    function drawHeader() {
      const top = place(headerH, 0);
      const bottom = top - headerH;
      ops.push(`${rgb(HEADER)} rg`);
      ops.push(`${num(MARGIN)} ${num(bottom)} ${num(MAX_W)} ${num(headerH)} re f`);
      headers.forEach((header, index) => {
        text(header, colX[index] + 6, bottom + 6, 8, true, WHITE);
      });
    }

    place(0, item.gapBefore == null ? 8 : item.gapBefore);
    drawHeader();
    rows.forEach((row, rowIndex) => {
      if (y - rowH < BOTTOM && ops.length) {
        breakPage();
        drawHeader();
      }
      const top = place(rowH, 0);
      const bottom = top - rowH;
      ops.push(`${rgb(rowIndex % 2 ? '#f3f5f8' : WHITE)} rg`);
      ops.push(`${num(MARGIN)} ${num(bottom)} ${num(MAX_W)} ${num(rowH)} re f`);
      row.forEach((cell, index) => {
        text(String(cell == null ? '' : cell), colX[index] + 6, bottom + 5, 10, false, INK);
      });
    });
  }

  function followHeight(item) {
    if (!item) return 0;
    if (item.kind === 'table') return 24 + 18 * Math.min(3, (item.rows || []).length || 1);
    if (item.kind === 'tiles') return 56;
    if (item.kind === 'verdict' || item.kind === 'callout') return 80;
    if (item.text) {
      const size = item.size || 11;
      const lines = Math.min(3, wrapText(item.text, size, MAX_W).length);
      return (item.gapBefore || 0) + lines * (size + 3);
    }
    return 32;
  }

  const list = items || [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (!item) continue;
    if (item.kind === 'title') drawTitle(item);
    else if (item.kind === 'heading') drawHeading(item, followHeight(list[index + 1]));
    else if (item.kind === 'callout') drawCallout(item);
    else if (item.kind === 'verdict') drawVerdict(item);
    else if (item.kind === 'tiles') drawTiles(item);
    else if (item.kind === 'table') drawTable(item);
    else if (item.text) drawTextItem(item);
  }
  if (!pages.length || ops.length) pages.push(ops);

  const watermark = options && options.watermark ? String(options.watermark) : '';
  const mark = watermark
    ? `q\n0.82 0.83 0.86 rg\nBT\n/F2 34 Tf\n0.7071 0.7071 -0.7071 0.7071 230 360 Tm\n(${pdfString(watermark)}) Tj\nET\nQ\n`
    : '';
  const total = pages.length;
  const pageObjs = [];
  const kids = [];
  let nextId = 7;
  for (let i = 0; i < pages.length; i += 1) {
    const contentId = nextId;
    nextId += 1;
    const pageId = nextId;
    nextId += 1;
    const logoH = 30;
    const logoW = logoH * (images.logo.width / images.logo.height);
    const bandBottom = PAGE_H - HEADER_H;
    const logoY = bandBottom + 3.5 + (HEADER_H - 3.5 - logoH) / 2;
    const markH = 22;
    const markW = markH * (images.mark.width / images.mark.height);
    const markX = PAGE_W - MARGIN - markW;
    const markY = bandBottom + 3.5 + (HEADER_H - 3.5 - markH) / 2;
    const pageLabel = `${i + 1} of ${total}`;
    const pageX = PAGE_W - MARGIN - pageLabel.length * 4;
    const chrome = [
      `${rgb(PAPER)} rg`,
      `0 0 ${PAGE_W} ${PAGE_H} re f`,
      mark,
      `${rgb(HEADER)} rg`,
      `0 ${PAGE_H - HEADER_H} ${PAGE_W} ${HEADER_H} re f`,
      `${rgb(MINT)} rg`,
      `0 ${PAGE_H - HEADER_H} ${PAGE_W} 3.5 re f`,
      `q ${num(logoW)} 0 0 ${num(logoH)} ${num(MARGIN)} ${num(logoY)} cm /ImLogo Do Q`,
      `q ${num(markW)} 0 0 ${num(markH)} ${num(markX)} ${num(markY)} cm /ImMark Do Q`,
      `${rgb(LINE)} rg`,
      `${MARGIN} 40 ${MAX_W} 0.6 re f`,
      `${rgb(MUTED)} rg`,
      `BT /F1 8 Tf ${MARGIN} 26 Td (Built by Heclr) Tj ET`,
      `BT /F1 8 Tf ${num(pageX)} 26 Td (${pdfString(pageLabel)}) Tj ET`,
    ].join('\n');
    const stream = `${chrome}\n${pages[i].join('\n')}`;
    pageObjs.push({ contentId, pageId, stream });
    kids.push(`${pageId} 0 R`);
  }

  const objects = [
    { id: 1, raw: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, raw: `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${total} >>` },
    { id: 3, raw: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
    { id: 4, raw: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>' },
    { id: 5, raw: imageObject(images.logo) },
    { id: 6, raw: imageObject(images.mark) },
  ];
  for (const page of pageObjs) {
    objects.push({
      id: page.contentId,
      raw: `<< /Length ${Buffer.byteLength(page.stream, 'latin1')} >>\nstream\n${page.stream}\nendstream`,
    });
    objects.push({
      id: page.pageId,
      raw: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${page.contentId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << /ImLogo 5 0 R /ImMark 6 0 R >> >> >>`,
    });
  }

  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const sizeOf = () => chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const offsets = [];
  for (const obj of objects) {
    offsets[obj.id] = sizeOf();
    chunks.push(Buffer.from(`${obj.id} 0 obj\n`, 'latin1'));
    chunks.push(Buffer.isBuffer(obj.raw) ? obj.raw : Buffer.from(obj.raw, 'latin1'));
    chunks.push(Buffer.from('\nendobj\n', 'latin1'));
  }
  const xref = sizeOf();
  const size = objects.length + 1;
  let trailer = `xref\n0 ${size}\n`;
  trailer += '0000000000 65535 f \n';
  for (let id = 1; id < size; id += 1) {
    trailer += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  trailer += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer, 'latin1'));
  return Buffer.concat(chunks);
}

module.exports = {
  pdfString,
  wrapText,
  renderDocument,
};
