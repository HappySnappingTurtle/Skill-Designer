import { AlertTriangle, Ban, Check, FileClock, RefreshCw, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectChangeSet, ProjectRestoreChangePreview, ProjectRevision, ProjectRevisionStatus, ProjectTransactionJournal, WorkspaceMember } from "@skill-designer/engine";
import { api, ApiError } from "../api";
import { Modal } from "./Modal";
import { ChangeSetConflictPanel, readConflictedChangeSet } from "./ChangeSetConflictPanel";
import { ChangeSetMetadata } from "./ChangeSetMetadata";

interface RevisionHistoryModalProps {
  open: boolean;
  workspaceId: string;
  skill: WorkspaceMember;
  onClose: () => void;
  onProjectChanged: () => Promise<void>;
}

export function RevisionHistoryModal({ open, workspaceId, skill, onClose, onProjectChanged }: RevisionHistoryModalProps) {
  const [status, setStatus] = useState<ProjectRevisionStatus | null>(null);
  const [revisions, setRevisions] = useState<ProjectRevision[]>([]);
  const [transactions, setTransactions] = useState<ProjectTransactionJournal[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoChangeSet, setUndoChangeSet] = useState<ProjectChangeSet | null>(null);

  useEffect(() => {
    if (!open) return;
    setUndoChangeSet(null);
    setError(null);
    void loadHistory(true).catch((cause) => setError(messageOf(cause)));
  }, [open, skill.projectId, skill.activeRevision]);

  async function loadHistory(reset = false) {
    if (reset) setStatus(null);
    const [nextStatus, nextRevisions, nextTransactions] = await Promise.all([
      api.getRevisionStatus(skill.projectId),
      api.listRevisions(skill.projectId),
      api.listProjectTransactions(skill.projectId)
    ]);
    setStatus(nextStatus);
    setRevisions(nextRevisions);
    setTransactions(nextTransactions);
  }

  async function acknowledge() {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.acknowledgeBaseline(skill.projectId, {
        workspaceId,
        revisionId: status.activeRevision.revisionId,
        snapshotId: status.currentSnapshot.snapshotId
      }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function proposeUndo() {
    if (!status?.activeRevision.parentRevision) return;
    setBusy(true);
    setError(null);
    try {
      setUndoChangeSet(await api.createUndoChangeSet(skill.projectId, {
        workspaceId,
        baseRevision: status.activeRevision.revisionId
      }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function rejectUndo() {
    if (!undoChangeSet) return;
    setBusy(true);
    setError(null);
    try {
      await api.rejectChangeSet(undoChangeSet.changeSetId, {
        digest: undoChangeSet.digest,
        baseRevision: undoChangeSet.baseRevision,
        reason: "用户在版本历史中拒绝撤销提案"
      });
      setUndoChangeSet(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmUndo() {
    if (!undoChangeSet) return;
    setBusy(true);
    setError(null);
    try {
      await api.confirmAndApplyChangeSet(undoChangeSet.changeSetId, {
        digest: undoChangeSet.digest,
        baseRevision: undoChangeSet.baseRevision
      });
      setUndoChangeSet(null);
      await onProjectChanged();
      await loadHistory();
    } catch (cause) {
      const conflicted = await readConflictedChangeSet(undoChangeSet);
      if (conflicted) setUndoChangeSet(conflicted);
      else setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reproposeConflict() {
    if (!undoChangeSet || undoChangeSet.status !== "conflicted") return;
    setBusy(true);
    setError(null);
    try {
      setUndoChangeSet(await api.reproposeChangeSet(undoChangeSet.changeSetId, {
        digest: undoChangeSet.digest,
        baseRevision: undoChangeSet.baseRevision
      }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const undoPreview = undoChangeSet?.preview.find((preview): preview is ProjectRestoreChangePreview => preview.kind === "project-restore") ?? null;
  const recoveries = transactions.filter((transaction) => transaction.recoveryAction === "rolled-back");

  return <>
    <Modal title="版本与基线" open={open} onClose={onClose} className="revision-modal">
      <div className="revision-modal-body">
        {error && <div className="revision-error" role="alert">{error}</div>}
        {!status && !error ? (
          <div className="revision-loading"><RefreshCw size={17} className="spin" />读取项目历史</div>
        ) : status ? (
          <>
            <section className="revision-facts" aria-label="当前版本事实">
              <div><span>当前 Revision</span><code title={status.activeRevision.revisionId}>{shortId(status.activeRevision.revisionId)}</code></div>
              <div><span>当前 Snapshot</span><code title={status.currentSnapshot.snapshotId}>{shortId(status.currentSnapshot.snapshotId)}</code></div>
              <div><span>已阅基线</span><code title={status.baseline.revisionId}>{shortId(status.baseline.revisionId)}</code></div>
            </section>

            <section className="baseline-section">
              <header>
                <div><h3>相对已阅基线</h3><span>{status.changedFiles.length} 个文件变化</span></div>
                <button className="button primary" onClick={() => void acknowledge()} disabled={busy || status.changedFiles.length === 0}>
                  <Check size={15} />{busy ? "确认中" : "将当前设为已阅"}
                </button>
              </header>
              {status.changedFiles.length ? (
                <ul className="changed-file-list">
                  {status.changedFiles.map((file) => (
                    <li key={file.path}><span className={`file-status ${file.status}`}>{statusLabel(file.status)}</span><code>{file.path}</code></li>
                  ))}
                </ul>
              ) : (
                <div className="baseline-empty"><Check size={18} />当前快照与已阅基线一致</div>
              )}
            </section>

            <section className="revision-history-section">
              <header><h3>项目历史</h3><span>{revisions.length} 个不可变版本</span></header>
              <ol className="revision-list">
                {revisions.map((revision) => (
                  <li key={revision.revisionId}>
                    <FileClock size={16} />
                    <div><code title={revision.revisionId}>{shortId(revision.revisionId)}</code><span>{sourceLabel(revision.source)} · {formatTime(revision.createdAt)}</span></div>
                    <small title={revision.parentRevision ?? "初始版本"}>{revision.parentRevision ? `父 ${shortId(revision.parentRevision)}` : "初始版本"}</small>
                  </li>
                ))}
              </ol>
            </section>

            {recoveries.length > 0 && <section className="transaction-recovery-section" aria-label="异常恢复记录">
              <header><div><h3>异常恢复</h3><span>{recoveries.length} 次事务已安全回滚</span></div><AlertTriangle size={17} /></header>
              <ol className="transaction-recovery-list">
                {recoveries.map((transaction) => <li key={transaction.transactionId}>
                  <AlertTriangle size={15} />
                  <div>
                    <strong>已恢复确认前版本</strong>
                    <span>中断阶段：{transactionStageLabel(transaction.recoveredFromStage)}{transaction.recoveredFromFileMutation ? ` · 文件步骤：${fileMutationLabel(transaction.recoveredFromFileMutation)}` : ""} · {formatTime(transaction.recoveredAt ?? transaction.updatedAt)}</span>
                    <p>{transaction.recoveryReason}</p>
                  </div>
                  <code title={transaction.changeSetId}>{shortId(transaction.changeSetId)}</code>
                </li>)}
              </ol>
            </section>}
          </>
        ) : null}
      </div>
      <footer className="modal-actions revision-actions">
        <button className="button secondary undo-trigger" disabled={busy || !status?.activeRevision.parentRevision} onClick={() => void proposeUndo()}><Undo2 size={15} />撤销最近提交</button>
        <button className="button secondary" onClick={onClose}>关闭</button>
      </footer>
    </Modal>
    {undoChangeSet && undoPreview && <div className="modal-backdrop" role="presentation">
      <div className="modal undo-change-modal" role="dialog" aria-modal="true" aria-label="确认撤销最近提交">
        <div className="modal-header"><div><h2>{undoChangeSet.status === "conflicted" ? "处理撤销提案冲突" : "确认撤销最近提交"}</h2><span>{shortId(undoPreview.fromRevision)} → {shortId(undoPreview.toRevision)}</span></div><button className="icon-button subtle" title="关闭" disabled={busy} onClick={() => setUndoChangeSet(null)}><X size={18} /></button></div>
        {undoChangeSet.status === "conflicted" && <ChangeSetConflictPanel changeSet={undoChangeSet} />}
        <div className="undo-change-summary"><Undo2 size={18} /><div><strong>恢复父 Snapshot 的完整项目内容</strong><span>确认后创建新的撤销 revision，现有历史不会删除或改写。</span></div></div>
        <div className="undo-change-files"><header><span>文件变化</span><strong>{undoPreview.files.length}</strong></header><ul className="changed-file-list">{undoPreview.files.map((file) => <li key={file.path}><span className={`file-status ${file.status}`}>{statusLabel(file.status)}</span><code>{file.path}</code></li>)}</ul></div>
        <ChangeSetMetadata changeSet={undoChangeSet} />
        <div className="change-reason"><span>目标 Snapshot</span><p><code>{undoPreview.toSnapshotId}</code></p></div>
        {undoChangeSet.status === "conflicted"
          ? <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setUndoChangeSet(null)}>关闭并保留当前项目</button><button className="button primary" disabled={busy} onClick={() => void reproposeConflict()}><RefreshCw size={16} className={busy ? "spin" : ""} />基于当前版本重新预演</button></div>
          : <div className="modal-actions proposal-actions"><button className="button danger proposal-reject" disabled={busy} onClick={() => void rejectUndo()}><Ban size={16} />拒绝撤销</button><button className="button secondary" disabled={busy} onClick={() => setUndoChangeSet(null)}>返回历史</button><button className="button primary" disabled={busy} onClick={() => void confirmUndo()}>{busy ? <RefreshCw size={16} className="spin" /> : <Undo2 size={16} />}确认撤销</button></div>}
      </div>
    </div>}
  </>;
}

function shortId(value: string): string {
  return value.length > 24 ? `${value.slice(0, 16)}…${value.slice(-6)}` : value;
}

function sourceLabel(source: ProjectRevision["source"]): string {
  return { initial: "初始创建", changeset: "确认提交", undo: "撤销提交", recovered: "历史补建" }[source];
}

function statusLabel(status: ProjectRevisionStatus["changedFiles"][number]["status"]): string {
  return { added: "新增", modified: "修改", deleted: "删除" }[status];
}

function transactionStageLabel(stage: ProjectTransactionJournal["recoveredFromStage"]): string {
  if (!stage) return "未知";
  return {
    prepared: "准备写入",
    "files-written": "文件已写入",
    "revision-captured": "版本快照已生成",
    "state-committed": "项目状态已提交"
  }[stage];
}

function fileMutationLabel(step: NonNullable<ProjectTransactionJournal["recoveredFromFileMutation"]>): string {
  return {
    "document-rename-destination": "写入重命名目标文档",
    "document-rename-source": "移除重命名源文档",
    "document-rename-graph": "更新文档图引用"
  }[step];
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : "读取版本历史失败";
}
