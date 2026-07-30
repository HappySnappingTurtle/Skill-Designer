import { AlertTriangle, CheckCircle2, FileArchive, FileDiff, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { GitBinaryChange, GitDiffResult, GitFileChange, GitReferencesResult, WorkspaceMember } from "@skill-designer/engine";
import { api, ApiError } from "../api";
import { Modal } from "./Modal";

interface GitDiffModalProps {
  open: boolean;
  skill: WorkspaceMember;
  onClose: () => void;
}

export function GitDiffModal({ open, skill, onClose }: GitDiffModalProps) {
  const [result, setResult] = useState<GitDiffResult | null>(null);
  const [references, setReferences] = useState<GitReferencesResult | null>(null);
  const [base, setBase] = useState("HEAD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setReferences(null);
    setBase("HEAD");
    setError(null);
    setBusy(true);
    void Promise.all([api.getProjectGitReferences(skill.projectId), api.getProjectGitDiff(skill.projectId)])
      .then(([nextReferences, nextResult]) => { setReferences(nextReferences); setResult(nextResult); })
      .catch((cause) => setError(messageOf(cause)))
      .finally(() => setBusy(false));
  }, [open, skill.projectId]);

  async function selectBase(nextBase: string) {
    setBase(nextBase);
    setBusy(true);
    setError(null);
    try {
      setResult(await api.getProjectGitDiff(skill.projectId, nextBase));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const [nextReferences, nextResult] = await Promise.all([
        api.getProjectGitReferences(skill.projectId),
        api.getProjectGitDiff(skill.projectId, base)
      ]);
      setReferences(nextReferences);
      setResult(nextResult);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Git 对比" open={open} onClose={onClose} className="git-diff-modal">
      <div className="git-diff-body">
        {error && <div className="import-error" role="alert">{error}</div>}
        {!result && !error ? <div className="revision-loading"><RefreshCw size={17} className="spin" />读取只读 Git 差异</div> : result && !result.capability.available ? (
          <div className="git-unavailable"><AlertTriangle size={24} /><strong>当前 Skill 无 Git 对比</strong><span>{result.capability.reason}</span></div>
        ) : result ? (
          <>
            <div className="git-readonly-note"><GitBranch size={15} /><span>仓库事实只读对比，不是待确认的 ChangeSet 提案</span><button className="icon-button subtle" title="刷新 Git 对比" aria-label="刷新 Git 对比" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy ? "spin" : ""} /></button></div>
            <section className="git-facts">
              <label><span>比较基准</span><select aria-label="Git 比较基准" value={base} disabled={busy || !references?.capability.available} onChange={(event) => void selectBase(event.target.value)}>
                <option value="HEAD">HEAD · 当前提交</option>
                {references?.refs.some((item) => item.kind === "tag") && <optgroup label="标签">{references.refs.filter((item) => item.kind === "tag").map((item) => <option key={`tag:${item.name}:${item.oid}`} value={item.oid}>{item.name} · {item.shortOid}{item.subject ? ` · ${item.subject}` : ""}</option>)}</optgroup>}
                {references?.refs.some((item) => item.kind === "commit") && <optgroup label="最近提交">{references.refs.filter((item) => item.kind === "commit").map((item) => <option key={`commit:${item.oid}`} value={item.oid}>{item.shortOid}{item.subject ? ` · ${item.subject}` : ""}</option>)}</optgroup>}
              </select></label>
              <div><span>分支</span><strong>{result.capability.branch}</strong></div>
              <div><span>HEAD</span><code title={result.capability.head}>{shortHash(result.capability.head ?? "")}</code></div>
              <div><span>基准 OID</span><code title={result.baseOid}>{shortHash(result.baseOid ?? "")}</code></div>
            </section>
            <section className="git-file-section">
              <header><strong>工作树变化</strong><span>{result.files.length} 个文件</span></header>
              {result.files.length ? <ul>{result.files.map((file) => <GitFileRow file={file} key={`${file.path}-${file.previousPath ?? ""}`} />)}</ul> : <div className="git-clean"><CheckCircle2 size={17} />工作树与 HEAD 一致</div>}
            </section>
            <section className="git-patch-section">
              <header><FileDiff size={15} /><strong>文本 Patch</strong>{result.truncated && <span>内容过长，已截断</span>}</header>
              {result.patch ? <pre>{result.patch}</pre> : <div className="git-clean">没有可显示的已跟踪文本差异</div>}
            </section>
            {result.binaryChanges.length > 0 && <section className="git-binary-section">
              <header><FileArchive size={15} /><strong>二进制摘要</strong><span>{result.binaryChanges.length} 个文件{result.binaryTruncated ? "，其余已截断" : ""}</span></header>
              <ul>{result.binaryChanges.map((file) => <GitBinaryRow file={file} key={`${file.path}-${file.previousPath ?? ""}`} />)}</ul>
            </section>}
          </>
        ) : null}
      </div>
      <footer className="modal-actions"><button className="button secondary" onClick={onClose}>关闭</button></footer>
    </Modal>
  );
}

function GitFileRow({ file }: { file: GitFileChange }) {
  return (
    <li>
      <span className={`git-file-status ${file.status}`}>{statusLabel(file.status)}</span>
      <code>{file.path}</code>
      {file.binary && <em>二进制</em>}
      <small>{file.staged ? "暂存区" : file.worktree ? "工作树" : ""}</small>
    </li>
  );
}

function GitBinaryRow({ file }: { file: GitBinaryChange }) {
  return <li><span className={`git-file-status ${file.status}`}>{statusLabel(file.status)}</span><code>{file.path}</code><small>{sizeLabel(file.baseBytes)} → {sizeLabel(file.currentBytes)}</small></li>;
}

function statusLabel(status: GitFileChange["status"]): string {
  return { modified: "修改", added: "新增", deleted: "删除", renamed: "改名", untracked: "未跟踪", conflicted: "冲突" }[status];
}

function shortHash(value: string): string {
  return value.slice(0, 12);
}

function sizeLabel(value: number | null): string {
  if (value === null) return "不存在";
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`;
}

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : "Git 对比失败";
}
