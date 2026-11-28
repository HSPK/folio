import { crc32 } from "node:zlib";

// A real, uncompressed two-sheet OOXML fixture without a runtime Excel dependency.
export function workbook(total = 105, groups = 0) {
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const relationships = (body) =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
  const relationship = (id, type, target) => `<Relationship Id="${id}" Type="${rel}/${type}" Target="${target}"/>`;
  const parts = {
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    "_rels/.rels": relationships(relationship("id1", "officeDocument", "xl/workbook.xml")),
    "xl/workbook.xml": `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="North" sheetId="1" r:id="id1"/><sheet name="South" sheetId="2" r:id="id2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": relationships(
      [1, 2].map((i) => relationship(`id${i}`, "worksheet", `worksheets/sheet${i}.xml`)).join(""),
    ),
  };
  for (const i of [1, 2]) {
    const inline = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
    const records = Array.from({ length: total }, (_, n) => {
      const row = n + 2;
      return `<row r="${row}"${n === total - 1 ? ' ht="36" customHeight="1"' : ""}>${inline(`A${row}`, n === total - 1 ? "Beyond page" : n === 0 ? `Region ${i}` : `Item ${groups ? n % groups : n}`)}<c r="B${row}"><v>${total - n}</v></c></row>`;
    }).join("");
    parts[`xl/worksheets/sheet${i}.xml`] =
      `<worksheet xmlns="${ns}"><sheetFormatPr defaultRowHeight="21" defaultColWidth="16"/><cols><col min="1" max="1" width="28" customWidth="1"/></cols><sheetData><row r="1">${inline("A1", "Region")}${inline("B1", "Count")}</row>${records}</sheetData></worksheet>`;
  }
  const data = [],
    central = [];
  let offset = 0;
  for (const [filename, text] of Object.entries(parts)) {
    const name = Buffer.from(filename),
      bytes = Buffer.from(text),
      h = Buffer.alloc(30),
      c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc32(bytes), 14);
    h.writeUInt32LE(bytes.length, 18);
    h.writeUInt32LE(bytes.length, 22);
    h.writeUInt16LE(name.length, 26);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    h.copy(c, 6, 4, 30);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    data.push(h, name, bytes);
    offset += h.length + name.length + bytes.length;
  }
  const end = Buffer.alloc(22),
    index = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(data.length / 3, 8);
  end.writeUInt16LE(data.length / 3, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...data, index, end]);
}

export function largePdf(bytes) {
  const xref = bytes.toString("latin1").match(/startxref\s+(\d+)\s+%%EOF\s*$/)?.[1];
  if (!xref) throw new Error("Missing PDF cross-reference.");
  return Buffer.concat([bytes, Buffer.from("\n%"), Buffer.alloc(17 << 20, 32),
    Buffer.from(`\nstartxref\n${xref}\n%%EOF\n`)]);
}

