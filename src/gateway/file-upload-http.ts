import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { convertToMarkdown, ScannedPdfError, SUPPORTED_MIME_TYPES } from "./file-convert.js";

const MAX_FILES_PER_REQUEST = 5;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

export type UploadedFile = {
  fileId: string;
  agentId: string;
  originalName: string;
  savedName: string;
  /** Relative to workspace dir, e.g. "uploads/main/report.md" */
  workspacePath: string;
  sizeBytes: number;
  convertedFrom: string;
};

type UploadError = {
  originalName: string;
  error: string;
};

function sanitizeFilename(name: string): string {
  // Keep alphanumeric, dots, hyphens, underscores only
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

function buildSavedName(originalName: string, _convertedFrom: string): string {
  const base = path.basename(originalName, path.extname(originalName));
  const safe = sanitizeFilename(base);
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  return `${safe}_${ts}.md`;
}

function resolveAgentId(rawAgentId: string | undefined): string {
  const trimmed = rawAgentId?.trim();
  if (!trimmed || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return "main";
  }
  return trimmed;
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Minimal multipart/form-data parser — no external deps, handles binary. */
function parseMultipart(
  body: Buffer,
  boundary: string,
): Array<{ name: string; filename?: string; contentType?: string; data: Buffer }> {
  const sep = Buffer.from(`--${boundary}`);
  const parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer }> = [];
  let start = 0;

  while (start < body.length) {
    const boundaryStart = body.indexOf(sep, start);
    if (boundaryStart === -1) {
      break;
    }
    const lineEnd = body.indexOf(Buffer.from("\r\n"), boundaryStart + sep.length);
    if (lineEnd === -1) {
      break;
    }
    const lineAfterBoundary = body.slice(boundaryStart + sep.length, lineEnd).toString("ascii");
    if (lineAfterBoundary === "--") {
      break;
    } // final boundary

    const headerStart = lineEnd + 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) {
      break;
    }
    const headerBlock = body.slice(headerStart, headerEnd).toString("utf-8");

    // Find next boundary to determine data end
    const nextBoundary = body.indexOf(sep, headerEnd + 4);
    const dataEnd = nextBoundary === -1 ? body.length : nextBoundary - 2; // strip trailing \r\n
    const data = body.slice(headerEnd + 4, dataEnd);

    // Parse headers
    let name = "";
    let filename: string | undefined;
    let contentType: string | undefined;
    for (const line of headerBlock.split("\r\n")) {
      const lLine = line.toLowerCase();
      if (lLine.startsWith("content-disposition:")) {
        const nameMatch = /name="([^"]+)"/.exec(line);
        if (nameMatch) {
          name = nameMatch[1];
        }
        const fileMatch = /filename="([^"]+)"/.exec(line);
        if (fileMatch) {
          filename = fileMatch[1];
        }
      } else if (lLine.startsWith("content-type:")) {
        contentType = line.split(":")[1]?.trim();
      }
    }
    if (name) {
      parts.push({ name, filename, contentType, data });
    }
    start = nextBoundary === -1 ? body.length : nextBoundary;
  }
  return parts;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function isFileUploadRequest(req: http.IncomingMessage): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  return req.method === "POST" && url.pathname === "/api/files/upload";
}

function isFileListRequest(req: http.IncomingMessage): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  return req.method === "GET" && url.pathname === "/api/files/list";
}

function isFileDeleteRequest(req: http.IncomingMessage): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  return req.method === "DELETE" && url.pathname.startsWith("/api/files/");
}

/**
 * Return the agent workspace uploads directory, creating it if needed.
 */
async function resolveUploadsDir(agentId: string, workspaceDir?: string): Promise<string> {
  const base = workspaceDir ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const uploadsDir = path.join(base, "uploads", agentId);
  await fs.mkdir(uploadsDir, { recursive: true });
  return uploadsDir;
}

/**
 * Handle all /api/files/* requests. Returns true if handled.
 */
export async function handleFileUploadRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    workspaceDir?: string;
  },
): Promise<boolean> {
  // ── Guard: only handle our paths ────────────────────────────────────────────
  if (!isFileUploadRequest(req) && !isFileListRequest(req) && !isFileDeleteRequest(req)) {
    return false;
  }

  // ── Auth check ──────────────────────────────────────────────────────────────
  const authHeader = req.headers["authorization"] ?? "";
  const isAuthorized = (() => {
    if (!opts.auth.required) {
      return true;
    }
    if (opts.auth.type === "password") {
      // Bearer <password>
      const bearer = authHeader.replace(/^Bearer\s+/i, "");
      return bearer === opts.auth.password;
    }
    return false;
  })();

  if (!isAuthorized) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  // ── GET /api/files/list ──────────────────────────────────────────────────────
  if (isFileListRequest(req)) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const agentId = resolveAgentId(url.searchParams.get("agentId") ?? undefined);
    try {
      const uploadsDir = await resolveUploadsDir(agentId, opts.workspaceDir);
      const entries = await fs.readdir(uploadsDir, { withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter((e) => e.isFile() && e.name.endsWith(".md"))
          .map(async (e) => {
            const filePath = path.join(uploadsDir, e.name);
            const stat = await fs.stat(filePath);
            return {
              fileId: e.name,
              agentId,
              originalName: e.name,
              savedName: e.name,
              workspacePath: `uploads/${agentId}/${e.name}`,
              sizeBytes: stat.size,
              convertedFrom: "md",
              modifiedAt: stat.mtimeMs,
            };
          }),
      );
      // Sort by modification time descending (newest first)
      files.sort((a, b) => b.modifiedAt - a.modifiedAt);
      sendJson(res, 200, { agentId, files });
    } catch {
      sendJson(res, 500, { error: "Failed to list files" });
    }
    return true;
  }

  // ── DELETE /api/files/:filename ───────────────────────────────────────────────
  if (isFileDeleteRequest(req)) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const agentId = resolveAgentId(url.searchParams.get("agentId") ?? undefined);
    const filename = path.basename(url.pathname);
    if (!filename || !filename.endsWith(".md")) {
      sendJson(res, 400, { error: "Invalid filename" });
      return true;
    }
    try {
      const uploadsDir = await resolveUploadsDir(agentId, opts.workspaceDir);
      const filePath = path.join(uploadsDir, path.basename(filename));
      await fs.unlink(filePath);
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 404, { error: "File not found" });
    }
    return true;
  }

  // ── POST /api/files/upload ───────────────────────────────────────────────────
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("multipart/form-data")) {
    sendJson(res, 400, { error: "Expected multipart/form-data" });
    return true;
  }

  const boundaryMatch = /boundary=([^\s;]+)/.exec(contentType);
  if (!boundaryMatch) {
    sendJson(res, 400, { error: "Missing multipart boundary" });
    return true;
  }
  const boundary = boundaryMatch[1];

  let body: Buffer;
  try {
    body = await readBody(req, MAX_FILES_PER_REQUEST * MAX_FILE_BYTES + 65536);
  } catch {
    sendJson(res, 413, { error: "Request too large" });
    return true;
  }

  const parts = parseMultipart(body, boundary);
  const agentIdPart = parts.find((p) => p.name === "agentId" && !p.filename);
  const agentId = resolveAgentId(agentIdPart?.data.toString("utf-8"));
  const fileParts = parts.filter((p) => p.filename);

  if (fileParts.length === 0) {
    sendJson(res, 400, { error: "No files found in request" });
    return true;
  }
  if (fileParts.length > MAX_FILES_PER_REQUEST) {
    sendJson(res, 400, {
      error: `Tối đa ${MAX_FILES_PER_REQUEST} file mỗi lần upload. Bạn đã gửi ${fileParts.length} file.`,
    });
    return true;
  }

  // Check individual file sizes
  for (const part of fileParts) {
    if (part.data.length > MAX_FILE_BYTES) {
      sendJson(res, 413, {
        error: `File "${part.filename}" vượt quá giới hạn 50MB.`,
      });
      return true;
    }
  }

  // Validate MIME types
  const { fileTypeFromBuffer } = await import("file-type");
  const uploadedFiles: UploadedFile[] = [];
  const uploadErrors: UploadError[] = [];

  let uploadsDir: string;
  try {
    uploadsDir = await resolveUploadsDir(agentId, opts.workspaceDir);
  } catch {
    sendJson(res, 500, { error: "Failed to create uploads directory" });
    return true;
  }

  // Process files sequentially to avoid memory spikes
  for (const part of fileParts) {
    const originalName = part.filename ?? "upload";
    try {
      // Detect actual MIME type from buffer (ignore client-claimed type for security)
      const detected = await fileTypeFromBuffer(part.data);
      const mimeType = detected?.mime ?? part.contentType ?? "application/octet-stream";

      // Check if supported
      const ext = path.extname(originalName).toLowerCase();
      const isTextType = ext === ".txt" || ext === ".md" || ext === ".xml" || ext === ".csv";
      const isSupportedMime = SUPPORTED_MIME_TYPES.has(mimeType);
      if (!isSupportedMime && !isTextType) {
        uploadErrors.push({
          originalName,
          error: `Định dạng '${ext}' không được hỗ trợ.`,
        });
        continue;
      }

      const { markdown, convertedFrom } = await convertToMarkdown(
        part.data,
        mimeType,
        originalName,
      );

      const savedName = buildSavedName(originalName, convertedFrom);
      const filePath = path.join(uploadsDir, savedName);
      await fs.writeFile(filePath, markdown, "utf-8");
      const stat = await fs.stat(filePath);

      uploadedFiles.push({
        fileId: savedName,
        agentId,
        originalName,
        savedName,
        workspacePath: `uploads/${agentId}/${savedName}`,
        sizeBytes: stat.size,
        convertedFrom,
      });
    } catch (err) {
      const message =
        err instanceof ScannedPdfError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Lỗi không xác định khi xử lý file";
      uploadErrors.push({ originalName, error: message });
    }
  }

  sendJson(res, 200, {
    agentId,
    files: uploadedFiles,
    errors: uploadErrors,
  });
  return true;
}
