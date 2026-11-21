// Minimal .xlsx writer (no dependencies). Builds an Office Open XML workbook
// with bold headers, number/date formats, frozen header row, autofilter and
// SUM totals, then downloads it.
//
// sheet = {
//   name, title?, subtitle?,
//   columns: [{ header, width?, type?: 'text' | 'number' | 'date' }],
//   rows: [[value, ...]],
//   totals?: { label, columns: [columnIndex, ...] }   // SUM rows for those columns
// }

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Store-only ZIP archive (xlsx readers accept uncompressed entries).
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

const xml = value => String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// Style ids defined in STYLES below.
const S = { text: 9, header: 1, number: 2, date: 3, totalLabel: 4, totalNumber: 5, title: 6, subtitle: 7, totalBlank: 8, decimal: 10, totalDecimal: 11 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\-mmm\\-yyyy"/></numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><color rgb="FF1D2633"/><name val="Calibri"/></font>
<font><i/><sz val="10"/><color rgb="FF5B6573"/><name val="Calibri"/></font>
</fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1D2633"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"/><bottom style="double"/><diagonal/></border><border><left style="thin"><color rgb="FFD0D5DD"/></left><right style="thin"><color rgb="FFD0D5DD"/></right><top style="thin"><color rgb="FFD0D5DD"/></top><bottom style="thin"><color rgb="FFD0D5DD"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="3" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="4" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="4" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function excelDate(value) {
  if (value == null || value === '') return null;
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])) : new Date(text);
  if (Number.isNaN(date.valueOf())) return null;
  const utc = match ? date.valueOf() : Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((utc - Date.UTC(1899, 11, 30)) / 86400000);
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim();
  if (!/^(MMK\s*)?-?[\d,]*\.?\d+$/i.test(text)) return null;
  const cleaned = text.replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function cell(ref, value, type, style, numberStyle = S.number) {
  if (value == null || value === '' || value === '—') return `<c r="${ref}" s="${style ?? S.text}"/>`;
  if (type === 'number') {
    const number = toNumber(value);
    if (number != null) return `<c r="${ref}" s="${style ?? numberStyle}"><v>${number}</v></c>`;
  }
  if (type === 'date') {
    const serial = excelDate(value);
    if (serial != null) return `<c r="${ref}" s="${style ?? S.date}"><v>${serial}</v></c>`;
  }
  const text = String(value).replace(/\r\n?/g, '\n').slice(0, 32000);
  return `<c r="${ref}" t="inlineStr" s="${style ?? S.text}"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}

const hasDecimals = (rows, index) => rows.some(row => { const n = toNumber(row[index]); return n != null && !Number.isInteger(n); });

// Column width (characters) from the longest line of header / values, clamped so long text wraps.
function autoWidth(column, index, rows) {
  if (column.width) return column.width;
  let longest = String(column.header ?? '').length + 2;
  for (const row of rows.slice(0, 500)) {
    const value = row[index];
    if (value == null || value === '') continue;
    const number = column.type === 'number' ? toNumber(value) : null;
    const length = column.type === 'date' ? 12
      : number != null ? Math.round(Math.abs(number)).toLocaleString('en-US').length + 5
      : Math.max(...String(value).split(/\r?\n/).map(line => line.length + 1));
    if (length > longest) longest = length;
  }
  const min = column.type === 'date' ? 13 : column.type === 'number' ? 12 : 10;
  return Math.min(Math.max(longest, min), 50);
}

function sheetLayout(sheet) {
  const headerRow = (sheet.title ? 1 : 0) + (sheet.subtitle ? 1 : 0) + (sheet.title || sheet.subtitle ? 1 : 0) + 1;
  return { headerRow, lastData: headerRow + sheet.rows.length, lastColumn: columnName(Math.max(sheet.columns.length - 1, 0)) };
}

function sheetXml(sheet) {
  const columns = sheet.columns;
  const rowsXml = [];
  let r = 0;
  if (sheet.title) { r += 1; rowsXml.push(`<row r="${r}">${cell(`A${r}`, sheet.title, 'text', S.title)}</row>`); }
  if (sheet.subtitle) { r += 1; rowsXml.push(`<row r="${r}">${cell(`A${r}`, sheet.subtitle, 'text', S.subtitle)}</row>`); }
  if (sheet.title || sheet.subtitle) r += 1;
  const headerRow = r + 1;
  r = headerRow;
  rowsXml.push(`<row r="${r}">${columns.map((column, index) => cell(`${columnName(index)}${r}`, column.header, 'text', S.header)).join('')}</row>`);
  const firstData = r + 1;
  const decimals = columns.map((column, index) => column.type === 'number' && hasDecimals(sheet.rows, index));
  for (const row of sheet.rows) {
    r += 1;
    rowsXml.push(`<row r="${r}">${columns.map((column, index) => cell(`${columnName(index)}${r}`, row[index], column.type || 'text', undefined, decimals[index] ? S.decimal : S.number)).join('')}</row>`);
  }
  const lastData = r;
  if (sheet.totals && sheet.rows.length) {
    r += 1;
    const sums = new Set(sheet.totals.columns);
    rowsXml.push(`<row r="${r}">${columns.map((column, index) => {
      const ref = `${columnName(index)}${r}`;
      if (index === 0) return cell(ref, sheet.totals.label || 'Total', 'text', S.totalLabel);
      if (!sums.has(index)) return `<c r="${ref}" s="${S.totalBlank}"/>`;
      const total = sheet.rows.reduce((sum, row) => sum + (toNumber(row[index]) || 0), 0);
      const letter = columnName(index);
      return `<c r="${ref}" s="${decimals[index] ? S.totalDecimal : S.totalNumber}"><f>SUM(${letter}${firstData}:${letter}${lastData})</f><v>${total}</v></c>`;
    }).join('')}</row>`);
  }
  const lastColumn = columnName(Math.max(columns.length - 1, 0));
  const cols = columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${autoWidth(column, index, sheet.rows)}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:${lastColumn}${Math.max(r, 1)}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${rowsXml.join('')}</sheetData>
${sheet.rows.length ? `<autoFilter ref="A${headerRow}:${lastColumn}${lastData}"/>` : ''}
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter>&amp;L${xml(sheet.name || '')}&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter>
</worksheet>`;
}

function safeSheetName(name, used) {
  let base = String(name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || 'Sheet';
  let candidate = base; let n = 2;
  while (used.has(candidate.toLowerCase())) { const suffix = ` (${n})`; candidate = base.slice(0, 31 - suffix.length) + suffix; n += 1; }
  used.add(candidate.toLowerCase());
  return candidate;
}

export function buildXlsx(sheets) {
  const used = new Set();
  const names = sheets.map(sheet => safeSheetName(sheet.name, used));
  const files = [
    { name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${sheets.map((sheet, i) => { const { headerRow, lastData, lastColumn } = sheetLayout(sheet); const ref = `'${xml(names[i].replace(/'/g, "''"))}'`; return `${sheet.rows.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${ref}!$A$${headerRow}:$${lastColumn}$${lastData}</definedName>` : ''}<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${ref}!$${headerRow}:$${headerRow}</definedName>`; }).join('')}</definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', content: STYLES },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(sheet) })),
  ];
  return zip(files);
}

export function downloadXlsx(filename, sheets) {
  const blob = buildXlsx(sheets);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Guess a column type from header + values (used for generic module exports).
// Identifier-like columns (phone, invoice no., codes, NRC...) stay text so leading zeros and formatting survive.
const IDENTIFIER_HEADER = /phone|mobile|\btel\b|contact|nrc|passport|\bid\b|code|number|\bno\.?$|\bref|serial|account|bank|postal|username|email/i;
const DATE_HEADER = /date|issued|\bdue\b|paid on|created at|updated at|^created$|^updated$|purchased|delivered|valid|joined|last login/i;
export function guessColumnType(header, values) {
  const filled = values.map(value => String(value ?? '').trim()).filter(value => value && value !== '—');
  if (!filled.length) return 'text';
  if (DATE_HEADER.test(header) && filled.every(value => /^\d{4}-\d{2}-\d{2}/.test(value))) return 'date';
  if (IDENTIFIER_HEADER.test(header)) return 'text';
  if (filled.every(value => /^(MMK\s*)?-?[\d,]+(\.\d+)?$/i.test(value) && !/^0\d/.test(value.replace(/^MMK\s*/i, '')))) return 'number';
  return 'text';
}
