import path from "node:path";

// Minimum characters-per-page threshold for a PDF to be considered digital (not scanned).
const PDF_MIN_CHARS_PER_PAGE = 50;

/**
 * Error thrown when a scanned PDF is detected (image-only, no text layer).
 */
export class ScannedPdfError extends Error {
  constructor() {
    super(
      "File này là PDF scan (ảnh), không hỗ trợ trích xuất text. Chỉ hỗ trợ PDF xuất từ Word/Excel.",
    );
    this.name = "ScannedPdfError";
  }
}

/**
 * Supported input MIME types and their extension aliases.
 */
export const SUPPORTED_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/vnd.ms-excel", // xls
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/xml",
  "application/xml",
  "text/csv",
  "text/comma-separated-values",
]);

/** Extensions that cannot be supported (no library available) */
const UNSUPPORTED_EXTENSIONS = new Set([".doc", ".ppt", ".pptx"]);

export type ConvertResult = {
  markdown: string;
  /** Final output extension (.md for all converted, .txt for raw text pass-through) */
  convertedFrom: string;
};

/**
 * Convert a file buffer to Markdown text.
 * Throws `ScannedPdfError` for image-only PDFs.
 * Throws `Error` for unsupported formats.
 */
export async function convertToMarkdown(
  buffer: Buffer,
  mimeType: string,
  originalName: string,
): Promise<ConvertResult> {
  const ext = path.extname(originalName).toLowerCase();

  // Reject unsupported legacy binary formats early.
  if (UNSUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Định dạng '${ext}' không được hỗ trợ. Vui lòng chuyển sang .docx hoặc .xlsx trước.`,
    );
  }

  // .docx
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx"
  ) {
    return convertDocx(buffer);
  }

  // .xlsx / .xls
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel" ||
    ext === ".xlsx" ||
    ext === ".xls"
  ) {
    return convertExcel(buffer, originalName);
  }

  // .pdf
  if (mimeType === "application/pdf" || ext === ".pdf") {
    return convertPdf(buffer);
  }

  // .csv
  if (mimeType === "text/csv" || mimeType === "text/comma-separated-values" || ext === ".csv") {
    const text = buffer.toString("utf-8");
    return { markdown: csvToMarkdown(text), convertedFrom: "csv" };
  }

  // Plain text formats: txt, md, xml, etc.
  const text = buffer.toString("utf-8");
  return { markdown: text, convertedFrom: ext.replace(".", "") || "txt" };
}

// ──────────────────────────────────────────────────────────────────────────────
// .docx → Markdown via mammoth
// ──────────────────────────────────────────────────────────────────────────────

async function convertDocx(buffer: Buffer): Promise<ConvertResult> {
  // Dynamic import to avoid loading at startup
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToMarkdown(
    { buffer },
    {
      styleMap: [
        "p[style-name='Heading 1'] => # ",
        "p[style-name='Heading 2'] => ## ",
        "p[style-name='Heading 3'] => ### ",
        "p[style-name='Heading 4'] => #### ",
        "p[style-name='Title'] => # ",
        "p[style-name='Subtitle'] => ## ",
      ],
    },
  );
  const markdown = result.value.trim();
  return { markdown, convertedFrom: "docx" };
}

// ──────────────────────────────────────────────────────────────────────────────
// .xlsx / .xls → Markdown table via exceljs
// ──────────────────────────────────────────────────────────────────────────────

async function convertExcel(buffer: Buffer, originalName: string): Promise<ConvertResult> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const ext = path.extname(originalName).toLowerCase();

  if (ext === ".xlsx" || ext === ".xls") {
    await workbook.xlsx.load(buffer);
  } else {
    // Fallback: try xlsx parser
    await workbook.xlsx.load(buffer);
  }

  const sections: string[] = [];

  workbook.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        // Convert cell value to string representation
        let val = "";
        if (cell.value === null || cell.value === undefined) {
          val = "";
        } else if (typeof cell.value === "object" && "richText" in cell.value) {
          // Rich text — flatten to plain text
          val = (cell.value as { richText: Array<{ text: string }> }).richText
            .map((r) => r.text)
            .join("");
        } else if (typeof cell.value === "object" && "formula" in cell.value) {
          // Formula: use result if available (only stringify primitives)
          const fVal = (cell.value as { result?: unknown }).result;
          if (fVal == null) {
            val = "";
          } else if (
            typeof fVal === "string" ||
            typeof fVal === "number" ||
            typeof fVal === "boolean"
          ) {
            val = String(fVal);
          } else {
            val = "";
          }
        } else {
          // Stringify only primitives; objects shouldn't reach here but guard anyway
          const cv = cell.value;
          val =
            typeof cv === "string" || typeof cv === "number" || typeof cv === "boolean"
              ? String(cv)
              : "";
        }
        cells.push(val.replace(/\|/g, "\\|").replace(/\n/g, " "));
      });
      rows.push(cells);
    });

    if (rows.length === 0) {
      return;
    }

    const colCount = Math.max(...rows.map((r) => r.length));
    // Pad all rows to same width
    const padded = rows.map((r) => {
      while (r.length < colCount) {
        r.push("");
      }
      return r;
    });

    const header = padded[0];
    const separator = header.map(() => "---");
    const body = padded.slice(1);

    const tableLines = [
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`,
      ...body.map((r) => `| ${r.join(" | ")} |`),
    ];

    sections.push(`## ${sheet.name}\n\n${tableLines.join("\n")}`);
  });

  const markdown = sections.join("\n\n").trim();
  const convertedFrom = path.extname(originalName).replace(".", "") || "xlsx";
  return { markdown, convertedFrom };
}

// ──────────────────────────────────────────────────────────────────────────────
// .pdf → text via pdfjs-dist
// ──────────────────────────────────────────────────────────────────────────────

async function convertPdf(buffer: Buffer): Promise<ConvertResult> {
  // pdfjs-dist is already in dependencies
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const uint8 = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({
    data: uint8,
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;

  const pageTexts: string[] = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => {
        if ("str" in item) {
          return (item as { str: string }).str;
        }
        return "";
      })
      .join(" ")
      .trim();
    pageTexts.push(pageText);
  }

  const totalChars = pageTexts.reduce((sum, t) => sum + t.length, 0);
  const charsPerPage = numPages > 0 ? totalChars / numPages : 0;

  // Heuristic: if very few characters per page, likely a scanned PDF
  if (charsPerPage < PDF_MIN_CHARS_PER_PAGE) {
    throw new ScannedPdfError();
  }

  const markdown = pageTexts
    .map((text, i) => `## Page ${i + 1}\n\n${text}`)
    .join("\n\n")
    .trim();

  return { markdown, convertedFrom: "pdf" };
}

// ──────────────────────────────────────────────────────────────────────────────
// .csv → Markdown table
// ──────────────────────────────────────────────────────────────────────────────

function csvToMarkdown(csv: string): string {
  // Detect delimiter (comma or semicolon)
  const firstLine = csv.split("\n")[0] ?? "";
  const delimiter = firstLine.includes(";") ? ";" : ",";

  const lines = csv
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return "";
  }

  const parseRow = (line: string): string[] =>
    line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, "").replace(/\|/g, "\\|"));

  const header = parseRow(lines[0]);
  const separator = header.map(() => "---");
  const rows = lines.slice(1).map(parseRow);

  return [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}
