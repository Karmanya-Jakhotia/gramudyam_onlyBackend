/**
 * A minimal, dependency-free PDF (1.4) writer.
 *
 * Why hand-rolled: this project intentionally has zero runtime
 * dependencies beyond what's already in package.json, and adding a PDF
 * library is out of scope for this environment. PDF's core structure
 * (objects, an xref table, a trailer) plus the 14 standard fonts (which
 * every PDF viewer must support without embedding) is a well-documented,
 * small surface area — enough to produce a correct, real PDF with
 * headings, paragraphs, and simple tables, without any external package.
 *
 * Known limitation (documented, not hidden): standard PDF fonts only
 * support the WinAnsi (Latin-1-ish) subset. Text is sanitized to that
 * subset — see `sanitizeText` — so Devanagari (Hindi/Marathi script)
 * content is not rendered here. Report content passed to the PDF is
 * therefore expected in romanized/English form (this is also why
 * reportNarrative.js's prompt is written in English). A future
 * improvement would embed a Unicode TrueType font; that requires a real
 * font-subsetting library and is out of scope here.
 */

const PAGE_WIDTH = 595.28; // A4 in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Approximate average glyph widths (in units of font size) for the
// standard Helvetica metrics, used only to decide word-wrap points.
// Deliberately conservative (slightly wide) so lines never overflow the
// content width even without real AFM metrics.
const AVG_CHAR_WIDTH_FACTOR = { regular: 0.52, bold: 0.56 };

function sanitizeText(input) {
  const str = String(input ?? '');
  // Normalize common "smart" punctuation to WinAnsi-safe equivalents, then
  // drop anything outside the printable Latin-1 range PDF's base fonts
  // support, rather than emitting bytes that would corrupt the file.
  const normalized = str
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u20B9/g, 'Rs. '); // rupee sign has no glyph in base14 fonts
  let out = '';
  for (const ch of normalized) {
    const code = ch.codePointAt(0);
    out += code >= 0x20 && code <= 0xff ? ch : '';
  }
  return out;
}

function escapePdfString(str) {
  return str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapText(text, maxWidth, fontSize, bold = false) {
  const factor = bold ? AVG_CHAR_WIDTH_FACTOR.bold : AVG_CHAR_WIDTH_FACTOR.regular;
  const avgCharWidth = fontSize * factor;
  const maxChars = Math.max(1, Math.floor(maxWidth / avgCharWidth));

  const lines = [];
  for (const rawLine of text.split('\n')) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * A small stateful document builder: tracks a cursor (y position) across
 * one or more pages and lays out headings, paragraphs, key/value rows, and
 * rules, creating a new page automatically whenever content would overflow
 * the bottom margin. Call `build()` once, at the end, to get the final
 * PDF bytes.
 */
export class PdfDocument {
  constructor({ title } = {}) {
    this.title = title || 'Document';
    this.pages = [];
    this._newPage();
  }

  _newPage() {
    this.page = { ops: [] };
    this.pages.push(this.page);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  _ensureSpace(neededHeight) {
    if (this.y - neededHeight < MARGIN) {
      this._newPage();
    }
  }

  _drawTextLine(line, { x = MARGIN, size = 11, bold = false } = {}) {
    const font = bold ? 'F2' : 'F1';
    const safe = escapePdfString(sanitizeText(line));
    this.page.ops.push(`BT /${font} ${size} Tf ${x.toFixed(2)} ${this.y.toFixed(2)} Td (${safe}) Tj ET`);
  }

  _drawRect(x, y, w, h, { fill = false } = {}) {
    const op = fill ? 're f' : 're S';
    this.page.ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} ${op}`);
  }

  _drawLine(x1, y1, x2, y2) {
    this.page.ops.push(`${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  heading(text, { size = 16 } = {}) {
    this._ensureSpace(size + 14);
    this._drawTextLine(text, { size, bold: true });
    this.y -= size + 4;
    this._drawLine(MARGIN, this.y, PAGE_WIDTH - MARGIN, this.y);
    this.y -= 14;
  }

  subheading(text, { size = 12.5 } = {}) {
    this._ensureSpace(size + 12);
    this._drawTextLine(text, { size, bold: true });
    this.y -= size + 8;
  }

  paragraph(text, { size = 10.5, lineHeight = 14 } = {}) {
    const lines = wrapText(sanitizeText(text), CONTENT_WIDTH, size, false);
    for (const line of lines) {
      this._ensureSpace(lineHeight);
      this._drawTextLine(line, { size, bold: false });
      this.y -= lineHeight;
    }
    this.y -= 4;
  }

  bulletList(items, { size = 10.5, lineHeight = 14 } = {}) {
    for (const item of items) {
      const lines = wrapText(sanitizeText(item), CONTENT_WIDTH - 14, size, false);
      lines.forEach((line, idx) => {
        this._ensureSpace(lineHeight);
        this._drawTextLine(idx === 0 ? `- ${line}` : `  ${line}`, { x: MARGIN + 4, size, bold: false });
        this.y -= lineHeight;
      });
    }
    this.y -= 4;
  }

  /**
   * A simple two-column key/value table (used for financial values), with
   * a light row separator. `rows` is an array of [label, value] string
   * pairs.
   */
  keyValueTable(rows, { size = 10.5, rowHeight = 20, labelWidth = 260 } = {}) {
    this._ensureSpace(rowHeight * Math.min(rows.length, 3)); // at least room for a few rows before breaking
    for (const [label, value] of rows) {
      this._ensureSpace(rowHeight);
      const topY = this.y;
      this._drawTextLine(sanitizeText(label), { x: MARGIN, size, bold: false });
      this._drawTextLine(sanitizeText(value), { x: MARGIN + labelWidth, size, bold: true });
      this.y -= rowHeight;
      this._drawLine(MARGIN, this.y + 6, PAGE_WIDTH - MARGIN, this.y + 6);
      void topY;
    }
    this.y -= 6;
  }

  spacer(height = 10) {
    this._ensureSpace(height);
    this.y -= height;
  }

  /** Serializes the document to a PDF byte Buffer. */
  build() {
    const objects = [];
    // 1: Catalog, 2: Pages, 3: Font Helvetica, 4: Font Helvetica-Bold,
    // then one Page + one Content stream object per page.
    const catalogRef = 1;
    const pagesRef = 2;
    const fontRegularRef = 3;
    const fontBoldRef = 4;
    let nextRef = 5;

    const pageRefs = [];
    const pageObjects = [];

    for (const page of this.pages) {
      const pageRef = nextRef++;
      const contentRef = nextRef++;
      pageRefs.push(pageRef);
      const stream = page.ops.join('\n');
      pageObjects.push({
        pageRef,
        contentRef,
        dict:
          `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(2)}] ` +
          `/Resources << /Font << /F1 ${fontRegularRef} 0 R /F2 ${fontBoldRef} 0 R >> >> ` +
          `/Contents ${contentRef} 0 R >>`,
        stream,
      });
    }

    objects.push({ ref: catalogRef, body: `<< /Type /Catalog /Pages ${pagesRef} 0 R >>` });
    objects.push({
      ref: pagesRef,
      body: `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`,
    });
    objects.push({ ref: fontRegularRef, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' });
    objects.push({ ref: fontBoldRef, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>' });

    for (const p of pageObjects) {
      objects.push({ ref: p.pageRef, body: p.dict });
      const streamBytes = Buffer.byteLength(p.stream, 'latin1');
      objects.push({
        ref: p.contentRef,
        body: `<< /Length ${streamBytes} >>\nstream\n${p.stream}\nendstream`,
      });
    }

    objects.sort((a, b) => a.ref - b.ref);

    let pdf = '%PDF-1.4\n';
    const offsets = [0]; // object 0 is the free-list head, per the PDF spec
    for (const obj of objects) {
      offsets[obj.ref] = Buffer.byteLength(pdf, 'latin1');
      pdf += `${obj.ref} 0 obj\n${obj.body}\nendobj\n`;
    }

    const xrefOffset = Buffer.byteLength(pdf, 'latin1');
    const totalObjects = objects.length + 1;
    pdf += `xref\n0 ${totalObjects}\n`;
    pdf += '0000000000 65535 f \n';
    for (let i = 1; i < totalObjects; i += 1) {
      pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${totalObjects} /Root ${catalogRef} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    return Buffer.from(pdf, 'latin1');
  }
}
