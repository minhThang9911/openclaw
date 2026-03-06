import { html, nothing, type TemplateResult } from "lit";
import type { UploadedFileEntry } from "../ui-types.ts";

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileTypeChip(entry: UploadedFileEntry): TemplateResult {
  const ext = entry.convertedFrom.toLowerCase();
  let cls = "chip";
  if (ext === "docx" || ext === "doc") {
    cls = "chip chip-ok";
  } else if (ext === "xlsx" || ext === "xls") {
    cls = "chip chip-info";
  } else if (ext === "pdf") {
    cls = "chip chip-warn";
  } else if (ext === "csv") {
    cls = "chip chip-cyan";
  }
  return html`<span class="${cls}">${entry.convertedFrom}</span>`;
}

export function renderUploadedFiles(params: {
  agentId: string;
  files: UploadedFileEntry[];
  checkedPaths: Set<string>;
  uploading: boolean;
  onToggle: (workspacePath: string, checked: boolean) => void;
  onDelete: (fileId: string, agentId: string) => void;
  onAddFiles: () => void;
}): TemplateResult {
  const { agentId, files, checkedPaths, uploading, onToggle, onDelete, onAddFiles } = params;
  const agentFiles = files.filter((f) => f.agentId === agentId);

  return html`
    <div class="uploaded-files-panel">
      <div class="uploaded-files-header">
        <div class="uploaded-files-title">📂 Uploaded Files</div>
        <div class="uploaded-files-sub muted">Agent: ${agentId}</div>
      </div>

      ${
        agentFiles.length === 0
          ? html`
              <div class="muted" style="margin-top: 8px; font-size: 0.85em">No files uploaded yet.</div>
            `
          : html`
              <div class="uploaded-files-list">
                ${agentFiles.map((entry) => renderFileRow(entry, checkedPaths, onToggle, onDelete))}
              </div>
            `
      }

      <div style="margin-top: 10px;">
        <button
          class="btn btn--sm"
          ?disabled=${uploading}
          @click=${onAddFiles}
          id="upload-files-btn"
        >
          ${uploading ? "Uploading…" : "+ Add Files"}
        </button>
      </div>
    </div>
  `;
}

function renderFileRow(
  entry: UploadedFileEntry,
  checkedPaths: Set<string>,
  onToggle: (path: string, checked: boolean) => void,
  onDelete: (fileId: string, agentId: string) => void,
): TemplateResult {
  const isChecked = checkedPaths.has(entry.workspacePath);
  const isUploading = entry.status === "uploading";
  const isError = entry.status === "error";

  return html`
    <div class="uploaded-file-row ${isChecked ? "checked" : ""}">
      <label class="uploaded-file-check">
        <input
          type="checkbox"
          ?checked=${isChecked}
          ?disabled=${isUploading || isError}
          @change=${(e: Event) =>
            onToggle(entry.workspacePath, (e.target as HTMLInputElement).checked)}
        />
      </label>
      <div class="uploaded-file-info">
        <div class="uploaded-file-name mono" title=${entry.originalName}>${entry.savedName}</div>
        <div class="uploaded-file-meta muted">
          ${formatBytes(entry.sizeBytes)} · ${fileTypeChip(entry)}
          ${
            isUploading
              ? html`
                  <span class="chip">uploading…</span>
                `
              : nothing
          }
          ${
            isError
              ? html`<span class="chip chip-danger" title=${entry.errorMessage ?? ""}>⚠ error</span>`
              : nothing
          }
          ${
            entry.errorMessage?.includes("scan")
              ? html`
                  <span class="chip chip-warn">⚠ Scan PDF</span>
                `
              : nothing
          }
        </div>
      </div>
      <button
        class="uploaded-file-delete btn-icon"
        title="Remove file"
        ?disabled=${isUploading}
        @click=${() => onDelete(entry.fileId, entry.agentId)}
        aria-label="Delete ${entry.savedName}"
      >
        🗑
      </button>
    </div>
  `;
}
