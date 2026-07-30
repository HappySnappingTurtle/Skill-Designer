import { AlertTriangle, Ban, Check, FileImage, FolderOpen, Image, Link2, LoaderCircle, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetChangePreview, ProjectAssetEntry, ProjectAssetFile, ProjectChangeSet, WorkspaceMember } from "@skill-designer/engine";
import { api, ApiError } from "../api";
import { ChangeSetConflictPanel, readConflictedChangeSet } from "./ChangeSetConflictPanel";
import { ChangeSetMetadata } from "./ChangeSetMetadata";

interface Props {
  open: boolean;
  workspaceId: string;
  skill: WorkspaceMember;
  onClose: () => void;
  onProjectChanged: () => Promise<void>;
}

const previewableImages = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function ProjectAssetsModal({ open, workspaceId, skill, onClose, onProjectChanged }: Props) {
  const [assets, setAssets] = useState<ProjectAssetEntry[]>([]);
  const [selected, setSelected] = useState<ProjectAssetFile | null>(null);
  const [activeRevision, setActiveRevision] = useState(skill.activeRevision);
  const [upload, setUpload] = useState<{ name: string; size: number; type: string; contentBase64: string } | null>(null);
  const [targetPath, setTargetPath] = useState("");
  const [query, setQuery] = useState("");
  const [changeSet, setChangeSet] = useState<ProjectChangeSet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setUpload(null);
    setTargetPath("");
    setChangeSet(null);
    setQuery("");
    setError(null);
    void loadAssets();
  }, [open, skill.projectId]);

  async function loadAssets(preferredPath?: string) {
    setBusy(true);
    try {
      const [entries, manifest] = await Promise.all([api.listAssets(skill.projectId), api.getSkillManifest(skill.projectId)]);
      setAssets(entries);
      setActiveRevision(manifest.activeRevision);
      const nextPath = preferredPath ?? selected?.path;
      if (nextPath && entries.some((entry) => entry.path === nextPath)) {
        setSelected(await api.readAsset(skill.projectId, nextPath));
      } else {
        setSelected(null);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function selectAsset(assetPath: string) {
    setBusy(true);
    setError(null);
    try {
      setSelected(await api.readAsset(skill.projectId, assetPath));
      setUpload(null);
      setTargetPath("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size === 0) {
      setError("资产文件不能为空");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("单个资产不能超过 2 MiB");
      return;
    }
    try {
      const contentBase64 = await fileToBase64(file);
      setUpload({ name: file.name, size: file.size, type: file.type || "application/octet-stream", contentBase64 });
      setTargetPath(`assets/${file.name.normalize("NFC")}`);
      setSelected(null);
      setChangeSet(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function proposeUpload() {
    if (!upload || !targetPath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setChangeSet(await api.createChangeSet(skill.projectId, {
        workspaceId,
        baseRevision: activeRevision,
        reason: `${assets.some((asset) => asset.path === targetPath.trim()) ? "替换" : "添加"}项目资产：${targetPath.trim()}`,
        source: { kind: "manual", label: "项目资产面板" },
        evidence: [{ kind: "user-request", ref: targetPath.trim(), summary: `用户选择本地文件 ${upload.name}` }],
        operations: [{ op: "asset.copy", target: targetPath.trim(), value: { contentBase64: upload.contentBase64 } }]
      }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function proposeDelete() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      setChangeSet(await api.createChangeSet(skill.projectId, {
        workspaceId,
        baseRevision: activeRevision,
        reason: `删除项目资产：${selected.path}`,
        source: { kind: "manual", label: "项目资产面板" },
        evidence: [{ kind: "project-fact", ref: selected.path, summary: `当前资产存在 ${selected.referenceCount} 处 Markdown 引用` }],
        operations: [{ op: "asset.delete", target: selected.path }]
      }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function applyChange() {
    if (!changeSet) return;
    const preview = assetPreview(changeSet);
    setBusy(true);
    setError(null);
    try {
      const result = await api.confirmAndApplyChangeSet(changeSet.changeSetId, { digest: changeSet.digest, baseRevision: changeSet.baseRevision });
      setChangeSet(null);
      setUpload(null);
      setTargetPath("");
      await onProjectChanged();
      await loadAssets(preview?.action === "delete" ? undefined : result.asset?.path);
    } catch (cause) {
      if (cause instanceof ApiError && (cause.code.endsWith("conflict") || cause.code.endsWith("changed") || cause.code.endsWith("mismatch"))) {
        setChangeSet(await readConflictedChangeSet(changeSet));
      }
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function rejectChange() {
    if (!changeSet) return;
    setBusy(true);
    setError(null);
    try {
      setChangeSet(await api.rejectChangeSet(changeSet.changeSetId, {
        digest: changeSet.digest,
        baseRevision: changeSet.baseRevision,
        reason: "用户拒绝资产变更提案"
      }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function repropose() {
    if (!changeSet) return;
    setBusy(true);
    setError(null);
    try {
      setChangeSet(await api.reproposeChangeSet(changeSet.changeSetId, { digest: changeSet.digest, baseRevision: changeSet.baseRevision }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const visibleAssets = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return needle ? assets.filter((asset) => asset.path.toLocaleLowerCase("zh-CN").includes(needle)) : assets;
  }, [assets, query]);
  if (!open) return null;
  const preview = changeSet ? assetPreview(changeSet) : undefined;

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <section className="modal project-assets-modal" role="dialog" aria-modal="true" aria-labelledby="project-assets-title">
      <div className="modal-header"><div><h2 id="project-assets-title">项目资产</h2><span>{skill.displayName} · {assets.length} 个文件</span></div><button className="icon-button subtle" title="关闭" disabled={busy} onClick={onClose}><X size={18} /></button></div>
      {error && <div className="docs-error" role="alert"><AlertTriangle size={15} />{error}</div>}
      {preview ? <AssetChangeSetView changeSet={changeSet!} preview={preview} /> : <div className="project-assets-body">
        <section className="asset-browser" aria-label="资产列表">
          <div className="asset-browser-toolbar">
            <label className="search-shell"><Image size={15} /><input aria-label="搜索资产" placeholder="搜索资产" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            <input ref={fileInput} data-testid="asset-file-input" type="file" hidden onChange={(event) => void chooseFile(event.target.files?.[0])} />
            <button className="button secondary" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={15} />选择文件</button>
          </div>
          <div className="asset-list">
            {visibleAssets.map((asset) => <button key={asset.path} className={selected?.path === asset.path ? "active" : ""} onClick={() => void selectAsset(asset.path)}>
              <FileImage size={16} /><span><strong>{asset.path.slice("assets/".length)}</strong><small>{formatBytes(asset.size)} · {asset.referenceCount} 引用</small></span>
            </button>)}
            {!visibleAssets.length && <div className="asset-list-empty"><FolderOpen size={24} /><span>{assets.length ? "没有匹配资产" : "暂无项目资产"}</span></div>}
          </div>
        </section>
        <section className="asset-detail" aria-label="资产详情">
          {upload ? <>
            <div className="asset-detail-heading"><div><span>待上传</span><h3>{upload.name}</h3></div><strong>{formatBytes(upload.size)}</strong></div>
            {previewableImages.has(upload.type) && <img className="asset-image-preview" alt={upload.name} src={`data:${upload.type};base64,${upload.contentBase64}`} />}
            <label className="field"><span>项目路径</span><input data-testid="asset-target-path" value={targetPath} onChange={(event) => setTargetPath(event.target.value)} /></label>
            <dl className="asset-facts"><div><dt>本地类型</dt><dd>{upload.type}</dd></div><div><dt>大小</dt><dd>{formatBytes(upload.size)}</dd></div></dl>
          </> : selected ? <>
            <div className="asset-detail-heading"><div><span>当前资产</span><h3>{selected.path}</h3></div><strong>{formatBytes(selected.size)}</strong></div>
            {previewableImages.has(selected.mimeType) && <img className="asset-image-preview" data-testid="asset-image-preview" alt={selected.path} src={`data:${selected.mimeType};base64,${selected.contentBase64}`} />}
            <dl className="asset-facts"><div><dt>类型</dt><dd>{selected.mimeType}</dd></div><div><dt>SHA-256</dt><dd title={selected.sha256}>{shortHash(selected.sha256)}</dd></div><div><dt>Markdown 引用</dt><dd>{selected.referenceCount}</dd></div><div><dt>更新时间</dt><dd>{formatTime(selected.updatedAt)}</dd></div></dl>
          </> : <div className="asset-detail-empty"><FileImage size={28} /><span>选择或上传资产</span></div>}
        </section>
      </div>}
      <div className="modal-actions proposal-actions">{!preview
        ? <><button className="button secondary" disabled={busy} onClick={onClose}>关闭</button>{selected && <button className="button danger proposal-reject" disabled={busy} onClick={() => void proposeDelete()}><Trash2 size={16} />预览删除</button>}<button className="button primary" disabled={busy || !upload || !targetPath.trim()} onClick={() => void proposeUpload()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />}预览上传</button></>
        : changeSet?.status === "proposed"
          ? <><button className="button danger proposal-reject" disabled={busy} onClick={() => void rejectChange()}><Ban size={16} />拒绝提案</button><button className="button secondary" disabled={busy} onClick={() => setChangeSet(null)}>返回资产</button><button className="button primary" disabled={busy} onClick={() => void applyChange()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}确认并应用</button></>
          : changeSet?.status === "conflicted"
            ? <><button className="button secondary" onClick={() => setChangeSet(null)}>返回资产</button><button className="button primary" disabled={busy} onClick={() => void repropose()}><RotateCcw size={16} />重新预演</button></>
            : <button className="button secondary" onClick={() => setChangeSet(null)}>返回资产</button>}
      </div>
    </section>
  </div>;
}

function AssetChangeSetView({ changeSet, preview }: { changeSet: ProjectChangeSet; preview: AssetChangePreview }) {
  const action = preview.action === "create" ? "新增" : preview.action === "replace" ? "替换" : "删除";
  return <div className="asset-changeset-view">
    {changeSet.status === "conflicted" && <ChangeSetConflictPanel changeSet={changeSet} />}
    {changeSet.status === "rejected" && <div className="proposal-state-banner rejected"><Ban size={15} /><span>该提案已拒绝，项目资产未修改。</span></div>}
    <section className="asset-change-summary" data-testid="asset-change-preview">
      <header><FileImage size={17} /><div><span>{action}项目资产</span><strong>{preview.target}</strong></div></header>
      <div className="asset-fact-columns">
        <AssetFact title="应用前" fact={preview.before} empty="不存在" />
        <AssetFact title="应用后" fact={preview.after} empty="将删除" />
      </div>
    </section>
    <section className="asset-reference-impact">
      <header><div><Link2 size={15} /><span>Markdown 引用</span></div><strong>{preview.references.length}</strong></header>
      {preview.references.length
        ? <div>{preview.references.map((reference, index) => <p key={`${reference.sourcePath}:${reference.startLine}:${index}`}><code>{reference.sourcePath}:{reference.startLine}</code><span>{reference.kind}</span><strong>{reference.rawTarget}</strong></p>)}</div>
        : <span className="asset-no-references">无项目内 Markdown 引用</span>}
    </section>
    <ChangeSetMetadata changeSet={changeSet} />
  </div>;
}

function AssetFact({ title, fact, empty }: { title: string; fact?: AssetChangePreview["before"]; empty: string }) {
  return <section><header>{title}</header>{fact ? <dl><div><dt>类型</dt><dd>{fact.mimeType}</dd></div><div><dt>大小</dt><dd>{formatBytes(fact.size)}</dd></div><div><dt>SHA-256</dt><dd title={fact.sha256}>{shortHash(fact.sha256)}</dd></div></dl> : <span>{empty}</span>}</section>;
}

function assetPreview(changeSet: ProjectChangeSet): AssetChangePreview | undefined {
  return changeSet.preview.find((item): item is AssetChangePreview => item.kind === "asset");
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

function shortHash(value: string): string { return value.length > 28 ? `${value.slice(0, 18)}…${value.slice(-8)}` : value; }
function formatTime(value: string): string { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : "操作失败"; }
