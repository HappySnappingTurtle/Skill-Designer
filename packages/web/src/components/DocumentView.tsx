import {
  AlertTriangle,
  Ban,
  Check,
  Eye,
  FilePenLine,
  FilePlus2,
  FileText,
  LoaderCircle,
  PencilLine,
  Save,
  Search,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentEntry, DocumentFile, DocumentReference, ProjectChangeSet, WorkspaceMember } from "@skill-designer/engine";
import ReactMarkdown from "react-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { api, ApiError } from "../api";
import { ChangeSetConflictPanel, readConflictedChangeSet } from "./ChangeSetConflictPanel";
import { ChangeSetMetadata } from "./ChangeSetMetadata";
import { SkillId } from "./SkillIdentity";

interface DocumentViewProps {
  workspaceId: string;
  skill: WorkspaceMember;
  onProjectChanged: () => Promise<void>;
}

export function DocumentView({ workspaceId, skill, onProjectChanged }: DocumentViewProps) {
  const [documents, setDocuments] = useState<DocumentEntry[]>([]);
  const [file, setFile] = useState<DocumentFile | null>(null);
  const [content, setContent] = useState("");
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changeSet, setChangeSet] = useState<ProjectChangeSet | null>(null);
  const [newDocumentOpen, setNewDocumentOpen] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renamePath, setRenamePath] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [references, setReferences] = useState<DocumentReference[]>([]);
  const locallyAppliedRevision = useRef("");

  const dirty = file !== null && content !== file.content;
  const revision = file?.activeRevision ?? skill.activeRevision;
  const filteredDocuments = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase("zh-CN");
    return query ? documents.filter((document) => document.path.toLocaleLowerCase("zh-CN").includes(query)) : documents;
  }, [documents, searchQuery]);

  useEffect(() => {
    const revisionKey = `${skill.projectId}:${skill.activeRevision}`;
    if (locallyAppliedRevision.current === revisionKey) {
      locallyAppliedRevision.current = "";
      return;
    }
    setSelectedPath("SKILL.md");
    setFile(null);
    setContent("");
    setError(null);
    setChangeSet(null);
    void loadDocuments("SKILL.md");
  }, [skill.projectId, skill.activeRevision]);

  async function loadDocuments(preferredPath?: string) {
    setLoading(true);
    setError(null);
    try {
      const entries = await api.listDocuments(skill.projectId);
      setDocuments(entries);
      const target = preferredPath && entries.some((entry) => entry.path === preferredPath)
        ? preferredPath
        : entries[0]?.path;
      if (target) await loadFile(target, false);
      else setFile(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  async function loadFile(path: string, guardDirty = true) {
    if (path === selectedPath && file && !dirty) return;
    if (guardDirty && dirty && !window.confirm("当前文档有未确认的修改，确定放弃并切换吗？")) return;
    setLoading(true);
    setError(null);
    try {
      const next = await api.readDocument(skill.projectId, path);
      setSelectedPath(path);
      setFile(next);
      setContent(next.content);
      setChangeSet(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  function prepareNewDocument() {
    const normalized = normalizeDocumentPath(newPath);
    if (!normalized) {
      setError("请输入 docs/ 下的 Markdown 路径，例如 docs/guide.md");
      return;
    }
    if (documents.some((entry) => entry.path === normalized)) {
      setError("该文档已经存在");
      return;
    }
    const title = normalized.split("/").at(-1)!.replace(/\.md$/i, "").replace(/[-_]/g, " ");
    setSelectedPath(normalized);
    setFile({ path: normalized, content: "", activeRevision: revision });
    setContent(`# ${title}\n\n`);
    setNewPath("");
    setNewDocumentOpen(false);
    setMode("edit");
    setError(null);
  }

  async function proposeChange() {
    if (!file || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const proposed = await api.createChangeSet(skill.projectId, {
        workspaceId,
        baseRevision: file.activeRevision,
        reason: file.content ? `编辑文档 ${file.path}` : `新建文档 ${file.path}`,
        operations: [{ op: "docs.write", target: file.path, value: content }]
      });
      setChangeSet(proposed);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openLifecycleDialog(action: "rename" | "delete") {
    if (!file || file.path === "SKILL.md" || dirty) return;
    setBusy(true);
    setError(null);
    try {
      setReferences(await api.listDocumentReferences(skill.projectId, file.path));
      if (action === "rename") {
        setRenamePath(file.path);
        setRenameOpen(true);
      } else setDeleteOpen(true);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function proposeRename() {
    if (!file) return;
    const normalized = normalizeDocumentPath(renamePath);
    if (!normalized) {
      setError("请输入 docs/ 下的 Markdown 路径，例如 docs/reference.md");
      return;
    }
    if (normalized === file.path) {
      setError("新路径与当前路径相同");
      return;
    }
    if (documents.some((entry) => entry.path === normalized)) {
      setError("目标文档已经存在");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setChangeSet(await api.createChangeSet(skill.projectId, {
        workspaceId,
        baseRevision: file.activeRevision,
        reason: `重命名文档 ${file.path} -> ${normalized} 并同步节点引用`,
        operations: [{ op: "docs.rename", target: file.path, value: normalized }]
      }));
      setRenameOpen(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function proposeDelete() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setChangeSet(await api.createChangeSet(skill.projectId, {
        workspaceId,
        baseRevision: file.activeRevision,
        reason: `删除文档 ${file.path} 并解除 ${references.length} 个节点引用`,
        operations: [{ op: "docs.delete", target: file.path }]
      }));
      setDeleteOpen(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAndApply() {
    if (!changeSet) return;
    setBusy(true);
    setError(null);
    try {
      const applied = await api.confirmAndApplyChangeSet(changeSet.changeSetId, {
        digest: changeSet.digest,
        baseRevision: changeSet.baseRevision
      });
      locallyAppliedRevision.current = `${skill.projectId}:${applied.activeRevision}`;
      setChangeSet(null);
      if (applied.deletedDocumentPath) {
        await loadDocuments("SKILL.md");
      } else {
        if (!applied.document) throw new Error("服务器未返回已应用的文档");
        setSelectedPath(applied.document.path);
        setFile(applied.document);
        setContent(applied.document.content);
        setDocuments(await api.listDocuments(skill.projectId));
      }
      await onProjectChanged();
    } catch (cause) {
      const conflicted = await readConflictedChangeSet(changeSet);
      if (conflicted) setChangeSet(conflicted);
      else setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reproposeConflict() {
    if (!changeSet || changeSet.status !== "conflicted") return;
    setBusy(true);
    setError(null);
    try {
      setChangeSet(await api.reproposeChangeSet(changeSet.changeSetId, {
        digest: changeSet.digest,
        baseRevision: changeSet.baseRevision
      }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function rejectProposal() {
    if (!changeSet) return;
    setBusy(true);
    setError(null);
    try {
      await api.rejectChangeSet(changeSet.changeSetId, { digest: changeSet.digest, baseRevision: changeSet.baseRevision, reason: "用户在文档确认界面拒绝提案" });
      setChangeSet(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const currentPreview = useMemo(() => {
    return changeSet?.preview.find((preview) => preview.kind === "document") ?? null;
  }, [changeSet]);
  const graphPreview = useMemo(() => changeSet?.preview.find((preview) => preview.kind === "graph") ?? null, [changeSet]);

  return (
    <div className="docs-page">
      <header className="docs-toolbar">
        <div className="docs-title">
          <FileText size={19} />
          <div><span>{skill.displayName}</span><strong>{selectedPath}</strong><SkillId value={skill.skillId} className="docs-skill-id" /></div>
        </div>
        <div className="docs-actions">
          <div className="segmented-control docs-mode" aria-label="文档视图">
            <button title="编辑 Markdown" className={mode === "edit" ? "selected" : ""} onClick={() => setMode("edit")}><PencilLine size={15} />编辑</button>
            <button title="预览 Markdown" className={mode === "preview" ? "selected" : ""} onClick={() => setMode("preview")}><Eye size={15} />预览</button>
          </div>
          <button className="icon-button" title="重命名文档" disabled={!file || file.path === "SKILL.md" || dirty || busy} onClick={() => void openLifecycleDialog("rename")}><FilePenLine size={16} /></button>
          <button className="icon-button danger" title="删除文档" disabled={!file || file.path === "SKILL.md" || dirty || busy} onClick={() => void openLifecycleDialog("delete")}><Trash2 size={16} /></button>
          <button className="button primary" disabled={!dirty || busy} onClick={() => void proposeChange()}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}
            预览并保存
          </button>
        </div>
      </header>

      {error && <div className="docs-error" role="alert">{error}<button title="关闭" onClick={() => setError(null)}><X size={15} /></button></div>}

      <div className="docs-layout">
        <aside className="document-tree">
          <div className="document-tree-heading"><span>项目文档</span><button className="icon-button subtle" title="新建文档" onClick={() => setNewDocumentOpen(true)}><FilePlus2 size={17} /></button></div>
          <label className="document-search"><Search size={14} /><input aria-label="搜索文档" value={searchQuery} placeholder="搜索路径" onChange={(event) => setSearchQuery(event.target.value)} />{searchQuery && <button title="清除搜索" onClick={() => setSearchQuery("")}><X size={13} /></button>}</label>
          <div className="document-list">
            {filteredDocuments.map((document) => (
              <button
                key={document.path}
                className={selectedPath === document.path ? "active" : ""}
                onClick={() => void loadFile(document.path)}
                title={document.path}
              >
                <FileText size={15} />
                <span>{document.path}</span>
                {document.referenceCount > 0 && <small>{document.referenceCount} 引用</small>}
              </button>
            ))}
            {file && !documents.some((document) => document.path === file.path) && (
              <button className="active draft-document"><FileText size={15} /><span>{file.path}</span><small>待创建</small></button>
            )}
            {searchQuery && !filteredDocuments.length && <div className="document-list-empty">没有匹配文档</div>}
          </div>
          <div className="document-meta"><span>{documents.length} 篇文档</span><code>{shortRevision(revision)}</code></div>
        </aside>

        <section className={`document-editor ${mode === "edit" ? "visible" : "mobile-hidden"}`}>
          <div className="pane-heading"><span>Markdown</span>{dirty && <small>未确认修改</small>}</div>
          {loading ? <PaneLoading /> : (
            <textarea
              aria-label="Markdown 编辑器"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
              disabled={!file}
            />
          )}
        </section>

        <section className={`document-preview ${mode === "preview" ? "visible" : "mobile-hidden"}`}>
          <div className="pane-heading"><span>安全预览</span><small>不执行 HTML</small></div>
          {loading ? <PaneLoading /> : (
            <article className="markdown-body"><ReactMarkdown remarkPlugins={[remarkFrontmatter, remarkGfm]}>{content}</ReactMarkdown></article>
          )}
        </section>
      </div>

      {newDocumentOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setNewDocumentOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-document-title">
            <div className="modal-header"><h2 id="new-document-title">新建 Markdown 文档</h2><button className="icon-button subtle" title="关闭" onClick={() => setNewDocumentOpen(false)}><X size={18} /></button></div>
            <div className="modal-body"><label className="field"><span>项目内路径</span><input autoFocus value={newPath} placeholder="docs/guide.md" onChange={(event) => setNewPath(event.target.value)} onKeyDown={(event) => event.key === "Enter" && prepareNewDocument()} /></label></div>
            <div className="modal-actions"><button className="button secondary" onClick={() => setNewDocumentOpen(false)}>取消</button><button className="button primary" onClick={prepareNewDocument}><FilePlus2 size={16} />创建草稿</button></div>
          </div>
        </div>
      )}

      {renameOpen && file && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setRenameOpen(false)}>
          <div className="modal document-lifecycle-modal" role="dialog" aria-modal="true" aria-labelledby="rename-document-title">
            <div className="modal-header"><div><h2 id="rename-document-title">重命名文档</h2><span>{file.path}</span></div><button className="icon-button subtle" title="关闭" disabled={busy} onClick={() => setRenameOpen(false)}><X size={18} /></button></div>
            <div className="modal-body">
              <label className="field"><span>新项目内路径</span><input aria-label="文档新路径" autoFocus value={renamePath} onChange={(event) => setRenamePath(event.target.value)} /></label>
              <ReferenceImpact references={references} action="同步更新" />
            </div>
            <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setRenameOpen(false)}>取消</button><button className="button primary" disabled={busy} onClick={() => void proposeRename()}>{busy ? <LoaderCircle size={16} className="spin" /> : <FilePenLine size={16} />}预览重命名</button></div>
          </div>
        </div>
      )}

      {deleteOpen && file && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDeleteOpen(false)}>
          <div className="modal document-lifecycle-modal" role="dialog" aria-modal="true" aria-labelledby="delete-document-title">
            <div className="modal-header"><div><h2 id="delete-document-title">删除文档</h2><span>{file.path}</span></div><button className="icon-button subtle" title="关闭" disabled={busy} onClick={() => setDeleteOpen(false)}><X size={18} /></button></div>
            <div className="modal-body"><div className="document-delete-warning"><AlertTriangle size={18} /><div><strong>确认后文档将从项目中删除</strong><span>该操作形成新 revision，可在版本历史中追溯。</span></div></div><ReferenceImpact references={references} action="解除" /></div>
            <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setDeleteOpen(false)}>取消</button><button className="button danger" disabled={busy} onClick={() => void proposeDelete()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}预览删除</button></div>
          </div>
        </div>
      )}

      {changeSet && currentPreview && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal change-preview-modal" role="dialog" aria-modal="true" aria-labelledby="change-preview-title">
            <div className="modal-header"><div><h2 id="change-preview-title">{changeSet.status === "conflicted" ? "处理文档提案冲突" : "确认文档变更"}</h2><span>{currentPreview.target}{currentPreview.destination ? ` -> ${currentPreview.destination}` : ""}</span></div><button className="icon-button subtle" title="关闭" disabled={busy} onClick={() => setChangeSet(null)}><X size={18} /></button></div>
            {changeSet.status === "conflicted" && <ChangeSetConflictPanel changeSet={changeSet} />}
            <div className="change-summary">
              <span>{{ create: "新建文档", update: "修改文档", rename: "重命名文档", delete: "删除文档" }[currentPreview.action]}</span>
              <strong className="added">+{currentPreview.addedLines}</strong>
              <strong className="removed">-{currentPreview.removedLines}</strong>
              <code>{shortRevision(changeSet.baseRevision)}</code>
            </div>
            <div className="diff-grid">
              <div><div className="diff-heading">应用前</div><pre>{currentPreview.before || "（文件不存在）"}</pre></div>
              <div><div className="diff-heading">应用后</div><pre>{currentPreview.after || "（文档将删除）"}</pre></div>
            </div>
            {graphPreview && <div className="document-reference-preview"><span>节点引用同步</span><strong>{currentPreview.referenceNodeIds.length} 个节点</strong>{currentPreview.referenceNodeIds.length > 0 ? <code>{currentPreview.referenceNodeIds.join(" · ")}</code> : <small>没有节点引用需要修改</small>}</div>}
            <ChangeSetMetadata changeSet={changeSet} />
            {changeSet.status === "conflicted"
              ? <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setChangeSet(null)}>关闭并保留当前项目</button><button className="button primary" disabled={busy} onClick={() => void reproposeConflict()}>{busy ? <LoaderCircle size={16} className="spin" /> : <FilePenLine size={16} />}基于当前版本重新预演</button></div>
              : <div className="modal-actions proposal-actions"><button className="button danger proposal-reject" disabled={busy} onClick={() => void rejectProposal()}><Ban size={16} />拒绝提案</button><button className="button secondary" disabled={busy} onClick={() => setChangeSet(null)}>返回编辑</button><button className="button primary" disabled={busy} onClick={() => void confirmAndApply()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}确认并应用</button></div>}
          </div>
        </div>
      )}
    </div>
  );
}

function PaneLoading() {
  return <div className="pane-loading"><LoaderCircle size={19} className="spin" /><span>加载文档</span></div>;
}

function ReferenceImpact({ references, action }: { references: DocumentReference[]; action: string }) {
  return <div className={`document-reference-impact ${references.length ? "referenced" : ""}`}><div><span>节点引用</span><strong>{references.length ? `${action} ${references.length} 个` : "无引用"}</strong></div>{references.length > 0 && <ul>{references.map((reference) => <li key={reference.nodeId}><code>{reference.nodeId}</code><span>{reference.nodeTitle}{reference.anchor ? ` · ${reference.anchor}` : ""}</span></li>)}</ul>}</div>;
}

function normalizeDocumentPath(value: string): string | null {
  const trimmed = value.trim().replace(/^\/+/, "");
  if (!/^docs\/(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9_\-/ ]+\.md$/i.test(trimmed)) return null;
  return trimmed.replace(/\s+/g, "-");
}

function shortRevision(revision: string): string {
  return revision.length > 18 ? `${revision.slice(0, 18)}…` : revision;
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError || cause instanceof Error) return cause.message;
  return "文档操作失败";
}
