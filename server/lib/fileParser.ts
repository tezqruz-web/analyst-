import ExcelJS from "exceljs";
import path from "path";

export interface ParsedSheetFile {
  name: string;
  originalName: string;
  sheetName?: string;
  content: string;
  size: number;
  rowCount: number;
  columnCount: number;
  columns: string[];
  fileType: "csv" | "excel";
}

const MAX_ROWS_PER_SHEET = 50000;
const MAX_COLUMNS = 250;

function csvEscapeCell(val: unknown): string {
  if (val === null || val === undefined) return "";
  let str: string;
  if (val instanceof Date) {
    str = val.toISOString();
  } else if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if ("result" in obj && obj.result !== undefined && obj.result !== null) {
      return csvEscapeCell(obj.result);
    }
    if (Array.isArray(obj.richText)) {
      str = obj.richText
        .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
    } else if (typeof obj.text === "string") {
      str = obj.text;
    } else if (typeof obj.hyperlink === "string") {
      str = typeof obj.text === "string" ? obj.text : obj.hyperlink;
    } else if ("error" in obj) {
      str = "";
    } else {
      str = String(val);
    }
  } else {
    str = String(val);
  }

  str = str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * RFC 4180 compliant CSV / TSV parser supporting quoted fields & embedded newlines.
 */
export function parseDelimitedText(
  text: string,
  delimiter = ",",
): { headers: string[]; rows: string[][] } {
  const clean = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = "";
    } else if (ch === "\r" && next === "\n") {
      row.push(field.trim());
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      field = "";
      i++;
      if (rows.length > MAX_ROWS_PER_SHEET + 1) break;
    } else if (ch === "\n" || ch === "\r") {
      row.push(field.trim());
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      field = "";
      if (rows.length > MAX_ROWS_PER_SHEET + 1) break;
    } else {
      field += ch;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field.trim());
    if (row.some((cell) => cell !== "")) rows.push(row);
  }

  if (rows.length === 0) {
    return { headers: [], rows: [] };
  }

  const rawHeaders = rows[0].slice(0, MAX_COLUMNS);
  const seen = new Map<string, number>();
  const headers = rawHeaders.map((h, idx) => {
    const base = h || `Column_${idx + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });

  const dataRows = rows.slice(1).map((r) => {
    const normalized = new Array<string>(headers.length);
    for (let c = 0; c < headers.length; c++) {
      normalized[c] = r[c] ?? "";
    }
    return normalized;
  });

  return { headers, rows: dataRows };
}

function sanitizeSheetSuffix(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "Sheet";
}

export function isSupportedSpreadsheetFile(filename: string): boolean {
  return /\.(csv|tsv|xlsx|xlsm)$/i.test(filename);
}

/**
 * Parses an uploaded CSV, TSV, or Excel (.xlsx / .xlsm) buffer into one or more
 * normalized CSV datasets (one per non-empty Excel worksheet).
 */
export async function parseUploadedSpreadsheet(
  buffer: Buffer,
  originalName: string,
): Promise<ParsedSheetFile[]> {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === ".csv" || ext === ".tsv") {
    const text = buffer.toString("utf-8").replace(/^\uFEFF/, "");
    const delimiter = ext === ".tsv" ? "\t" : ",";
    const parsed = parseDelimitedText(text, delimiter);
    const csvContent =
      ext === ".tsv"
        ? [
            parsed.headers.map(csvEscapeCell).join(","),
            ...parsed.rows.map((r) => r.map(csvEscapeCell).join(",")),
          ].join("\n")
        : text;

    const outName =
      ext === ".tsv" ? originalName.replace(/\.tsv$/i, ".csv") : originalName;

    return [
      {
        name: outName,
        originalName,
        content: csvContent,
        size: Buffer.byteLength(csvContent, "utf-8"),
        rowCount: parsed.rows.length,
        columnCount: parsed.headers.length,
        columns: parsed.headers,
        fileType: "csv",
      },
    ];
  }

  if (ext === ".xlsx" || ext === ".xlsm") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    const baseName = originalName.replace(/\.(xlsx|xlsm)$/i, "");
    const sheets: ParsedSheetFile[] = [];

    for (const worksheet of workbook.worksheets) {
      const rawRows: string[][] = [];
      let maxCol = 0;

      worksheet.eachRow({ includeEmpty: false }, (row) => {
        if (rawRows.length > MAX_ROWS_PER_SHEET) return;
        const values = row.values;
        if (!Array.isArray(values)) return;
        // ExcelJS row.values is 1-indexed (index 0 is undefined)
        const cells: string[] = [];
        const colLimit = Math.min(values.length - 1, MAX_COLUMNS);
        for (let c = 1; c <= colLimit; c++) {
          cells.push(csvEscapeCell(values[c]));
        }
        if (cells.some((c) => c !== "")) {
          maxCol = Math.max(maxCol, cells.length);
          rawRows.push(cells);
        }
      });

      if (rawRows.length === 0 || maxCol === 0) continue;

      const paddedRows = rawRows.map((r) => {
        const out = [...r];
        while (out.length < maxCol) out.push("");
        return out;
      });

      const headerRow = paddedRows[0].map((h, i) => {
        const unquoted = h.replace(/^"|"$/g, "").replace(/""/g, '"').trim();
        return unquoted || `Column_${i + 1}`;
      });
      const csvLines = [
        headerRow.map(csvEscapeCell).join(","),
        ...paddedRows.slice(1).map((r) => r.join(",")),
      ];
      const csvContent = csvLines.join("\n");

      const sheetSuffix = sanitizeSheetSuffix(worksheet.name);
      const outFileName =
        workbook.worksheets.length === 1
          ? `${baseName}.csv`
          : `${baseName}_${sheetSuffix}.csv`;

      sheets.push({
        name: outFileName,
        originalName,
        sheetName: worksheet.name,
        content: csvContent,
        size: Buffer.byteLength(csvContent, "utf-8"),
        rowCount: Math.max(0, paddedRows.length - 1),
        columnCount: headerRow.length,
        columns: headerRow,
        fileType: "excel",
      });
    }

    if (sheets.length === 0) {
      throw new Error(
        `The Excel workbook "${originalName}" does not contain any readable data rows.`,
      );
    }

    return sheets;
  }

  throw new Error(
    `Unsupported file type "${ext}". Please upload CSV, TSV, or Excel (.xlsx, .xlsm) files.`,
  );
}
