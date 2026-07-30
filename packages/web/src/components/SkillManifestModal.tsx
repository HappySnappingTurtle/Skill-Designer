import { AlertTriangle, Ban, Check, FilePenLine, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectChangeSet, SkillManifest, SkillManifestChangePreview, WorkspaceMember } from "@skill-designer/engine";
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

export function SkillManifestModal({ open, workspaceId, skill, onClose, onProjectChanged }: Props) {
  const [manifest, setManifest] = useState<SkillManifest | null>(null);
  const [activeRevision, setActiveRevision] = useState("");
  const [draft, setDraft] = useState({ name: "", version: "", description: "" });
  const [changeSet, setChangeSet] = useState<ProjectChangeSet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setManifest(null);
    setChangeSet(null);
    setError(null);
    void load();
  }, [open, skill.projectId, skill.activeRevision]);

  async function load() {
    setBusy(true);
    try {
      const result = await api.getSkillManifest(skill.projectId);
      setManifest(result.manifest);
      setActiveRevision(result.activeRevision);
      setDraft({ name: result.manifest.name, version: result.manifest.version, description: result.manifest.description });
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  async function propose() {
    if (!manifest) return;
    setBusy(true);
    setError(null);
    try {
      setChangeSet(await api.createChangeSet(skill.projectId, {
        workspaceId,
        baseRevision: activeRevision,
        reason: `更新 Skill 信息：${draft.name.trim()}`,
        operations: [{ op: "skill.update", target: "skill.json", value: { name: draft.name.trim(), version: draft.version.trim(), description: draft.description.trim() } }]
      }));
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  async function apply() {
    if (!changeSet) return;
    setBusy(true);
    setError(null);
    try {
      await api.confirmAndApplyChangeSet(changeSet.changeSetId, { digest: changeSet.digest, baseRevision: changeSet.baseRevision });
      await onProjectChanged();
      onClose();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code.endsWith("conflict")) setChangeSet(await readConflictedChangeSet(changeSet));
      setError(messageOf(cause));
    } finally { setBusy(false); }
  }

  async function reject() {
    if (!changeSet) return;
    setBusy(true);
    try { setChangeSet(await api.rejectChangeSet(changeSet.changeSetId, { digest: changeSet.digest, baseRevision: changeSet.baseRevision, reason: "用户拒绝 Skill 信息修改提案" })); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  async function repropose() {
    if (!changeSet) return;
    setBusy(true);
    try { setChangeSet(await api.reproposeChangeSet(changeSet.changeSetId, { digest: changeSet.digest, baseRevision: changeSet.baseRevision })); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  }

  if (!open) return null;
  const preview = changeSet?.preview.find((item): item is SkillManifestChangePreview => item.kind === "skill-manifest");
  const dirty = Boolean(manifest && (manifest.name !== draft.name.trim() || manifest.version !== draft.version.trim() || manifest.description !== draft.description.trim()));
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <section className="modal skill-manifest-modal" role="dialog" aria-modal="true" aria-labelledby="skill-manifest-title">
      <div className="modal-header"><div><h2 id="skill-manifest-title">Skill 信息</h2><span>{skill.skillId}</span></div><button className="icon-button subtle" title="关闭" disabled={busy} onClick={onClose}><X size={18} /></button></div>
      {error && <div className="docs-error" role="alert"><AlertTriangle size={15} />{error}</div>}
      {busy && !manifest ? <div className="pane-loading"><LoaderCircle size={18} className="spin" />读取 skill.json</div> : !preview ? <div className="skill-manifest-form">
        <div className="skill-manifest-identity"><FilePenLine size={17} /><div><span>稳定身份</span><code>{manifest?.skillId}</code></div><strong>{manifest?.capability === "workflow" ? "工作流" : "内容型"}</strong></div>
        <label className="field"><span>名称</span><input aria-label="Skill 名称" maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="field"><span>版本</span><input aria-label="Skill 版本" maxLength={50} value={draft.version} onChange={(event) => setDraft({ ...draft, version: event.target.value })} /></label>
        <label className="field"><span>说明</span><textarea aria-label="Skill 说明" rows={7} maxLength={4000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      </div> : <>
        {changeSet?.status === "conflicted" && <ChangeSetConflictPanel changeSet={changeSet} />}
        {changeSet?.status === "rejected" && <div className="proposal-state-banner rejected"><Ban size={15} /><span>该提案已拒绝，Skill 信息未修改。</span></div>}
        <div className="skill-manifest-diff"><ManifestColumn title="应用前" manifest={preview.before} /><ManifestColumn title="应用后" manifest={preview.after} /></div>
        <ChangeSetMetadata changeSet={changeSet!} />
      </>}
      <div className="modal-actions proposal-actions">{!preview
        ? <><button className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy || !dirty || !draft.name.trim() || !draft.version.trim()} onClick={() => void propose()}>{busy ? <LoaderCircle size={16} className="spin" /> : <FilePenLine size={16} />}预览修改</button></>
        : changeSet?.status === "proposed"
          ? <><button className="button danger proposal-reject" disabled={busy} onClick={() => void reject()}><Ban size={16} />拒绝提案</button><button className="button secondary" disabled={busy} onClick={() => setChangeSet(null)}>返回编辑</button><button className="button primary" disabled={busy} onClick={() => void apply()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}确认并应用</button></>
          : changeSet?.status === "conflicted"
            ? <><button className="button secondary" onClick={onClose}>关闭</button><button className="button primary" disabled={busy} onClick={() => void repropose()}><RotateCcw size={16} />重新预演</button></>
            : <button className="button secondary" onClick={onClose}>关闭</button>}
      </div>
    </section>
  </div>;
}

function ManifestColumn({ title, manifest }: { title: string; manifest: SkillManifest }) {
  return <section><header>{title}</header><dl><div><dt>名称</dt><dd>{manifest.name}</dd></div><div><dt>版本</dt><dd>{manifest.version}</dd></div><div><dt>说明</dt><dd>{manifest.description || "（空）"}</dd></div></dl></section>;
}

function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : "操作失败"; }
