import { AlertTriangle, Archive, CheckCircle2, Download, History, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { GenericExportRecord, WorkspaceMember } from "@skill-designer/engine";
import { api, ApiError } from "../api";
import { Modal } from "./Modal";

interface ExportSkillModalProps {
  open: boolean;
  workspaceId: string;
  skill: WorkspaceMember;
  onClose: () => void;
}

export function ExportSkillModal({ open, workspaceId, skill, onClose }: ExportSkillModalProps) {
  const [record, setRecord] = useState<GenericExportRecord | null>(null);
  const [history, setHistory] = useState<GenericExportRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRecord(null);
    setHistory([]);
    setError(null);
    setBusy(true);
    void api.listGenericExports(skill.projectId, workspaceId)
      .then(async (items) => {
        const current = items.find((item) => item.revisionId === skill.activeRevision && item.status !== "conflicted");
        if (current) {
          setHistory(items);
          setRecord(current);
          return;
        }
        const created = await api.createGenericExport(skill.projectId, { workspaceId, revisionId: skill.activeRevision, profile: "generic/1" });
        setHistory([created, ...items]);
        setRecord(created);
      })
      .catch((cause) => setError(messageOf(cause)))
      .finally(() => setBusy(false));
  }, [open, skill.projectId, skill.activeRevision, workspaceId]);

  async function createPreview() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createGenericExport(skill.projectId, { workspaceId, revisionId: skill.activeRevision, profile: "generic/1" });
      setHistory((items) => [created, ...items]);
      setRecord(created);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: GenericExportRecord) {
    if (!window.confirm(`删除导出记录“${item.archiveName ?? shortId(item.exportId)}”？已生成的 ZIP 也会被清理。`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteGenericExport(item.exportId, workspaceId);
      const next = history.filter((candidate) => candidate.exportId !== item.exportId);
      setHistory(next);
      if (record?.exportId === item.exportId) setRecord(next[0] ?? null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!record) return;
    setBusy(true);
    setError(null);
    try {
      const ready = await api.confirmGenericExport(record.exportId, { digest: record.digest, revisionId: record.revisionId });
      setRecord(ready);
      setHistory((items) => items.map((item) => item.exportId === ready.exportId ? ready : item));
    } catch (cause) {
      setError(messageOf(cause));
      if (cause instanceof ApiError && cause.code === "export_revision_changed") {
        const items = await api.listGenericExports(skill.projectId, workspaceId).catch(() => []);
        setHistory(items);
        setRecord(items.find((item) => item.exportId === record.exportId) ?? record);
      }
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (!record || record.status !== "ready") return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.downloadGenericExport(record.exportId);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="导出通用 Skill 包" open={open} onClose={onClose} className="export-modal">
      <div className="export-modal-body">
        {error && <div className="import-error" role="alert">{error}</div>}
        {busy && !record ? <div className="revision-loading"><RefreshCw size={17} className="spin" />正在构建导出预览</div> : record ? (
          <>
            <section className="export-facts">
              <div><span>Profile</span><strong>{record.profile}</strong></div>
              <div><span>Revision</span><code title={record.revisionId}>{shortId(record.revisionId)}</code></div>
              <div><span>Content Hash</span><code title={record.contentHash}>{shortId(record.contentHash)}</code></div>
            </section>
            {record.warnings.map((warning) => <div className="export-warning" key={warning}><AlertTriangle size={15} />{warning}</div>)}
            <section className="export-file-section">
              <header><strong>包内容</strong><span>{record.files.length} 个文件</span></header>
              <div>{record.files.map((file) => <code key={file.path}><span className={file.source}>{file.source === "generated" ? "生成" : "快照"}</span>{file.path}<small>{formatBytes(file.size)}</small></code>)}</div>
            </section>
            <div className={`export-result ${record.status}`}>
              {record.status === "ready" ? <CheckCircle2 size={18} /> : record.status === "conflicted" ? <AlertTriangle size={18} /> : <Archive size={18} />}
              <span>{record.status === "ready" ? `${record.archiveName} · ${formatBytes(record.archiveSize ?? 0)}` : record.status === "conflicted" ? "项目版本已变化；此预览保留为历史，但不能再生成 ZIP" : "确认后从此 Snapshot 生成 ZIP；后续编辑不会混入本次预览"}</span>
            </div>
            <section className="export-history-section">
              <header><div><History size={15} /><strong>导出记录</strong><span>{history.length}</span></div><button className="icon-button subtle" title="为当前版本新建导出预览" disabled={busy || record.revisionId === skill.activeRevision && record.status === "proposed"} onClick={() => void createPreview()}><Plus size={15} /></button></header>
              <div>{history.map((item) => <div key={item.exportId} className={record.exportId === item.exportId ? "selected" : ""}>
                <button onClick={() => setRecord(item)}><span className={`export-history-status ${item.status}`}>{exportStatusLabel(item.status)}</span><div><code>{shortId(item.revisionId)}</code><small>{item.archiveName ?? shortId(item.exportId)} · {formatTime(item.completedAt ?? item.createdAt)}</small></div>{item.revisionId === skill.activeRevision && <strong>当前版本</strong>}</button>
                <button className="icon-button subtle" title="删除导出记录" disabled={busy} onClick={() => void remove(item)}><Trash2 size={14} /></button>
              </div>)}</div>
            </section>
          </>
        ) : !busy ? <div className="export-empty"><Archive size={28} /><strong>暂无导出记录</strong><button className="button primary" onClick={() => void createPreview()}><Plus size={15} />新建当前版本预览</button></div> : null}
      </div>
      <footer className="modal-actions">
        <button className="button secondary" onClick={onClose} disabled={busy}>关闭</button>
        {record?.status === "ready" ? (
          <button className="button primary" onClick={() => void download()} disabled={busy}><Download size={15} />{busy ? "准备下载" : "下载 ZIP"}</button>
        ) : record?.status === "proposed" ? (
          <button className="button primary" onClick={() => void generate()} disabled={busy || !record}><Archive size={15} />{busy ? "生成中" : "确认并生成"}</button>
        ) : null}
      </footer>
    </Modal>
  );
}

function shortId(value: string): string {
  return value.length > 28 ? `${value.slice(0, 18)}…${value.slice(-7)}` : value;
}

function formatBytes(size: number): string {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KiB`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function exportStatusLabel(value: GenericExportRecord["status"]): string {
  return { proposed: "待确认", ready: "可下载", conflicted: "已冲突" }[value];
}

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : "导出失败";
}
