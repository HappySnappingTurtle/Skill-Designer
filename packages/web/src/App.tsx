import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookOpenText,
  Boxes,
  Bug,
  ChevronDown,
  CircleDot,
  FileText,
  FlaskConical,
  FolderInput,
  FolderGit2,
  GitBranch,
  History,
  Images,
  LayoutDashboard,
  Network,
  Plus,
  PackageOpen,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Settings2,
  SquareStack,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SkillCapability, Workspace, WorkspaceMember, WorkspaceSummary } from "@skill-designer/engine";
import { api, ApiError } from "./api";
import { AddSkillModal } from "./components/AddSkillModal";
import { CreateWorkspaceModal } from "./components/CreateWorkspaceModal";
import { GraphView } from "./components/GraphView";
import { DocumentView } from "./components/DocumentView";
import { TestView } from "./components/TestView";
import { RevisionHistoryModal } from "./components/RevisionHistoryModal";
import { ImportSkillModal } from "./components/ImportSkillModal";
import { ExportSkillModal } from "./components/ExportSkillModal";
import { OpenInPlaceModal } from "./components/OpenInPlaceModal";
import { GitDiffModal } from "./components/GitDiffModal";
import { DiagnosisView } from "./components/DiagnosisView";
import { DesignAssistantDrawer } from "./components/DesignAssistantDrawer";
import { ModelSettingsModal } from "./components/ModelSettingsModal";
import { SkillManifestModal } from "./components/SkillManifestModal";
import { ProjectAssetsModal } from "./components/ProjectAssetsModal";
import { SkillId } from "./components/SkillIdentity";

type View = "workspace" | "graph" | "docs" | "tests" | "diagnosis";

const navigation: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: "workspace", label: "工作区", icon: LayoutDashboard },
  { id: "graph", label: "图谱", icon: Network },
  { id: "docs", label: "文档", icon: FileText },
  { id: "tests", label: "测试", icon: FlaskConical },
  { id: "diagnosis", label: "诊断", icon: Bug }
];

export default function App() {
  const [view, setView] = useState<View>("workspace");
  const [summaries, setSummaries] = useState<WorkspaceSummary[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [workspaceModal, setWorkspaceModal] = useState(false);
  const [skillModal, setSkillModal] = useState(false);
  const [revisionModal, setRevisionModal] = useState(false);
  const [importModal, setImportModal] = useState(false);
  const [exportModal, setExportModal] = useState(false);
  const [inPlaceModal, setInPlaceModal] = useState(false);
  const [gitDiffModal, setGitDiffModal] = useState(false);
  const [skillManifestOpen, setSkillManifestOpen] = useState(false);
  const [projectAssetsOpen, setProjectAssetsOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renameWorkspaceOpen, setRenameWorkspaceOpen] = useState(false);
  const [deleteWorkspaceOpen, setDeleteWorkspaceOpen] = useState(false);
  const [repairMember, setRepairMember] = useState<WorkspaceMember | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const workspaceRequestSequence = useRef(0);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view, workspace?.workspaceId]);

  const currentSkill = useMemo(
    () => workspace?.members.find((member) => member.projectId === workspace.selectedProjectId) ?? null,
    [workspace]
  );

  useEffect(() => {
    void loadInitial();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function loadInitial() {
    const requestSequence = ++workspaceRequestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const items = await api.listWorkspaces();
      if (requestSequence !== workspaceRequestSequence.current) return;
      setSummaries(items);
      if (items[0]) {
        const next = await api.getWorkspace(items[0].workspaceId);
        if (requestSequence !== workspaceRequestSequence.current) return;
        setWorkspace(next);
      }
      else setWorkspaceModal(true);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  async function refreshSummaries(activeWorkspace = workspace) {
    const requestSequence = ++workspaceRequestSequence.current;
    const items = await api.listWorkspaces();
    const nextWorkspace = activeWorkspace ? await api.getWorkspace(activeWorkspace.workspaceId) : null;
    if (requestSequence !== workspaceRequestSequence.current) return;
    setSummaries(items);
    if (nextWorkspace) setWorkspace(nextWorkspace);
  }

  async function chooseWorkspace(workspaceId: string) {
    const requestSequence = ++workspaceRequestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.getWorkspace(workspaceId);
      if (requestSequence !== workspaceRequestSequence.current) return;
      setWorkspace(next);
      setView("workspace");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  async function createWorkspace(name: string) {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createWorkspace({ name });
      setWorkspace(created);
      setWorkspaceModal(false);
      await refreshSummaries(created);
      setNotice("工作区已创建");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function addSkill(input: { name: string; description: string; capability: SkillCapability }) {
    if (!workspace) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.createManagedSkill(workspace.workspaceId, input);
      setWorkspace(updated);
      setSkillModal(false);
      await refreshSummaries(updated);
      setNotice("Skill 已加入工作区");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function selectSkill(projectId: string) {
    if (!workspace || workspace.selectedProjectId === projectId) return;
    const requestSequence = ++workspaceRequestSequence.current;
    setError(null);
    try {
      const next = await api.selectProject(workspace.workspaceId, projectId);
      if (requestSequence !== workspaceRequestSequence.current) return;
      setWorkspace(next);
      setNotice("当前 Skill 已切换");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  async function removeSkill(member: WorkspaceMember) {
    if (!workspace || !window.confirm(`从工作区移除“${member.displayName}”？Skill 文件不会被删除。`)) return;
    try {
      const updated = await api.removeMember(workspace.workspaceId, member.projectId);
      setWorkspace(updated);
      await refreshSummaries(updated);
      setNotice("已移除 Workspace 引用");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  async function renameWorkspace(name: string) {
    if (!workspace) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.renameWorkspace(workspace.workspaceId, name);
      setWorkspace(updated);
      setRenameWorkspaceOpen(false);
      await refreshSummaries(updated);
      setNotice("工作区已重命名");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function deleteWorkspace() {
    if (!workspace) return;
    setBusy(true);
    setError(null);
    try {
      const deleted = await api.deleteWorkspace(workspace.workspaceId);
      const items = await api.listWorkspaces();
      const next = items[0] ? await api.getWorkspace(items[0].workspaceId) : null;
      setSummaries(items);
      setWorkspace(next);
      setDeleteWorkspaceOpen(false);
      setView("workspace");
      setNotice(`工作区已删除，${deleted.preservedProjects.length} 个 Skill Project 已保留`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function moveSkill(member: WorkspaceMember, direction: -1 | 1) {
    if (!workspace) return;
    const currentIndex = workspace.members.findIndex((item) => item.projectId === member.projectId);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= workspace.members.length) return;
    const projectIds = workspace.members.map((item) => item.projectId);
    [projectIds[currentIndex], projectIds[targetIndex]] = [projectIds[targetIndex]!, projectIds[currentIndex]!];
    setError(null);
    try {
      const updated = await api.reorderWorkspaceMembers(workspace.workspaceId, projectIds);
      setWorkspace(updated);
      await refreshSummaries(updated);
      setNotice("Skill 顺序已更新");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  async function repairSkillPath(rootPath: string) {
    if (!workspace || !repairMember) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.repairWorkspaceMember(workspace.workspaceId, repairMember.projectId, rootPath);
      setWorkspace(updated);
      setRepairMember(null);
      await refreshSummaries(updated);
      setNotice("Skill 路径已修复并通过 Revision 校验");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function acceptWorkspaceUpdate(updated: Workspace) {
    setWorkspace(updated);
    await refreshSummaries(updated);
  }

  return (
    <div className={`app-shell ${view === "graph" ? "graph-immersive" : ""}`}>
      <aside className="sidebar">
        <div className="brand" aria-label="Skill Designer">
          <span className="brand-mark"><SquareStack size={20} /></span>
          <span>Skill Designer</span>
        </div>
        <nav className="main-nav" aria-label="主导航">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                aria-label={item.label}
                className={view === item.id ? "active" : ""}
                onClick={() => setView(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <button title="设置" onClick={() => setSettingsOpen(true)}><Settings2 size={18} /><span>设置</span></button>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="workspace-picker-wrap">
            <label htmlFor="workspace-picker">Workspace</label>
            <div className="select-wrap">
              <select
                id="workspace-picker"
                value={workspace?.workspaceId ?? ""}
                onChange={(event) => void chooseWorkspace(event.target.value)}
                disabled={!summaries.length}
              >
                {!summaries.length && <option value="">暂无工作区</option>}
                {summaries.map((summary) => (
                  <option key={summary.workspaceId} value={summary.workspaceId}>{summary.name}</option>
                ))}
              </select>
              <ChevronDown size={16} aria-hidden="true" />
            </div>
          </div>
          <div className="topbar-actions">
            {currentSkill && (
              <div className="current-skill" title={currentSkill.skillId}>
                <CircleDot size={15} />
                <span>{currentSkill.displayName}</span>
                <SkillId value={currentSkill.skillId} />
              </div>
            )}
            <button className="button secondary assistant-trigger" disabled={!currentSkill} onClick={() => setAssistantOpen(true)}><Sparkles size={16} />设计助手</button>
            <button className="icon-button" title="刷新" onClick={() => void refreshSummaries()} disabled={loading}>
              <RefreshCw size={17} className={loading ? "spin" : ""} />
            </button>
          </div>
        </header>

        <main className="content">
          {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError(null)}>关闭</button></div>}
          {loading ? (
            <LoadingState />
          ) : view === "workspace" ? (
            <WorkspaceView
              workspace={workspace}
              currentSkill={currentSkill}
              onCreateWorkspace={() => setWorkspaceModal(true)}
              onAddSkill={() => setSkillModal(true)}
              onImportSkill={() => setImportModal(true)}
              onOpenInPlace={() => setInPlaceModal(true)}
              onSelectSkill={(projectId) => void selectSkill(projectId)}
              onRemoveSkill={(member) => void removeSkill(member)}
              onMoveSkill={(member, direction) => void moveSkill(member, direction)}
              onRepairSkill={setRepairMember}
              onRenameWorkspace={() => setRenameWorkspaceOpen(true)}
              onDeleteWorkspace={() => setDeleteWorkspaceOpen(true)}
              onOpenRevisions={() => setRevisionModal(true)}
              onOpenExport={() => setExportModal(true)}
              onOpenGitDiff={() => setGitDiffModal(true)}
              onEditSkill={() => setSkillManifestOpen(true)}
              onOpenAssets={() => setProjectAssetsOpen(true)}
            />
          ) : (
            <SkillModuleView
              view={view}
              workspaceId={workspace?.workspaceId ?? null}
              skill={currentSkill}
              onOpenWorkspace={() => setView("workspace")}
              onOpenTests={() => setView("tests")}
              onOpenDiagnosis={() => setView("diagnosis")}
              onProjectChanged={() => refreshSummaries()}
            />
          )}
        </main>
      </div>

      <CreateWorkspaceModal
        open={workspaceModal}
        busy={busy}
        onClose={() => summaries.length && setWorkspaceModal(false)}
        onSubmit={createWorkspace}
      />
      <AddSkillModal open={skillModal} busy={busy} onClose={() => setSkillModal(false)} onSubmit={addSkill} />
      {workspace && (
        <ImportSkillModal
          open={importModal}
          workspaceId={workspace.workspaceId}
          onClose={() => setImportModal(false)}
          onWorkspaceUpdated={acceptWorkspaceUpdate}
        />
      )}
      {workspace && (
        <OpenInPlaceModal
          open={inPlaceModal}
          workspaceId={workspace.workspaceId}
          onClose={() => setInPlaceModal(false)}
          onOpened={async (updated) => { await acceptWorkspaceUpdate(updated); setNotice("已原地打开 Git Skill"); }}
        />
      )}
      {workspace && currentSkill && (
        <RevisionHistoryModal
          open={revisionModal}
          workspaceId={workspace.workspaceId}
          skill={currentSkill}
          onClose={() => setRevisionModal(false)}
          onProjectChanged={() => refreshSummaries()}
        />
      )}
      {currentSkill && <GitDiffModal open={gitDiffModal} skill={currentSkill} onClose={() => setGitDiffModal(false)} />}
      {workspace && currentSkill && <SkillManifestModal open={skillManifestOpen} workspaceId={workspace.workspaceId} skill={currentSkill} onClose={() => setSkillManifestOpen(false)} onProjectChanged={() => refreshSummaries()} />}
      {workspace && currentSkill && <ProjectAssetsModal open={projectAssetsOpen} workspaceId={workspace.workspaceId} skill={currentSkill} onClose={() => setProjectAssetsOpen(false)} onProjectChanged={() => refreshSummaries()} />}
      {workspace && currentSkill && (
        <ExportSkillModal
          open={exportModal}
          workspaceId={workspace.workspaceId}
          skill={currentSkill}
          onClose={() => setExportModal(false)}
        />
      )}
      <DesignAssistantDrawer
        open={assistantOpen}
        workspaceId={workspace?.workspaceId ?? null}
        currentSkill={currentSkill}
        onClose={() => setAssistantOpen(false)}
        onProjectChanged={() => refreshSummaries()}
      />
      <ModelSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(message) => setNotice(message)}
      />
      {workspace && (
        <RenameWorkspaceModal
          open={renameWorkspaceOpen}
          busy={busy}
          currentName={workspace.name}
          onClose={() => setRenameWorkspaceOpen(false)}
          onSubmit={renameWorkspace}
        />
      )}
      {workspace && (
        <DeleteWorkspaceModal
          open={deleteWorkspaceOpen}
          busy={busy}
          workspaceName={workspace.name}
          projectCount={workspace.members.length}
          onClose={() => setDeleteWorkspaceOpen(false)}
          onConfirm={deleteWorkspace}
        />
      )}
      {workspace && repairMember && (
        <RepairMemberModal
          member={repairMember}
          busy={busy}
          onClose={() => setRepairMember(null)}
          onSubmit={repairSkillPath}
        />
      )}
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}

interface WorkspaceViewProps {
  workspace: Workspace | null;
  currentSkill: WorkspaceMember | null;
  onCreateWorkspace: () => void;
  onAddSkill: () => void;
  onImportSkill: () => void;
  onOpenInPlace: () => void;
  onSelectSkill: (projectId: string) => void;
  onRemoveSkill: (member: WorkspaceMember) => void;
  onMoveSkill: (member: WorkspaceMember, direction: -1 | 1) => void;
  onRepairSkill: (member: WorkspaceMember) => void;
  onRenameWorkspace: () => void;
  onDeleteWorkspace: () => void;
  onOpenRevisions: () => void;
  onOpenExport: () => void;
  onOpenGitDiff: () => void;
  onEditSkill: () => void;
  onOpenAssets: () => void;
}

function WorkspaceView({
  workspace,
  currentSkill,
  onCreateWorkspace,
  onAddSkill,
  onImportSkill,
  onOpenInPlace,
  onSelectSkill,
  onRemoveSkill,
  onMoveSkill,
  onRepairSkill,
  onRenameWorkspace,
  onDeleteWorkspace,
  onOpenRevisions,
  onOpenExport,
  onOpenGitDiff,
  onEditSkill,
  onOpenAssets
}: WorkspaceViewProps) {
  const [query, setQuery] = useState("");
  if (!workspace) {
    return (
      <div className="empty-state full-height">
        <Boxes size={34} />
        <h1>暂无工作区</h1>
        <button className="button primary" onClick={onCreateWorkspace}><Plus size={17} />新建工作区</button>
      </div>
    );
  }

  const workflowCount = workspace.members.filter((member) => member.capability === "workflow").length;
  const contentCount = workspace.members.filter((member) => member.capability === "content-only").length;
  const issueCount = workspace.members.reduce((sum, member) => sum + member.lint.errors + member.lint.warnings, 0);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleMembers = normalizedQuery
    ? workspace.members.filter((member) => `${member.displayName} ${member.skillId}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    : workspace.members;

  return (
    <div className="workspace-page">
      <div className="page-heading">
        <div className="workspace-title-block">
          <span className="eyebrow">WORKSPACE</span>
          <div className="workspace-title-line">
            <h1>{workspace.name}</h1>
            <button className="icon-button subtle" title="重命名工作区" onClick={onRenameWorkspace}><Pencil size={15} /></button>
            <button className="icon-button subtle danger-icon" title="删除工作区" onClick={onDeleteWorkspace}><Trash2 size={15} /></button>
          </div>
        </div>
        <div className="heading-actions">
          <button className="button secondary" onClick={onCreateWorkspace}><Plus size={17} />新建工作区</button>
          <button className="button secondary" onClick={onImportSkill}><FolderInput size={17} />导入 Skill</button>
          <button className="button secondary" onClick={onOpenInPlace}><FolderGit2 size={17} />原地打开</button>
          <button className="button primary" onClick={onAddSkill}><Plus size={17} />添加 Skill</button>
        </div>
      </div>

      <section className="metrics" aria-label="工作区摘要">
        <Metric label="Skill 总数" value={workspace.members.length} />
        <Metric label="工作流" value={workflowCount} accent="green" />
        <Metric label="内容型" value={contentCount} accent="blue" />
        <Metric label="待处理问题" value={issueCount} accent={issueCount ? "red" : ""} />
      </section>

      <div className="workspace-grid">
        <section className="skill-list-section">
          <div className="section-toolbar">
            <div>
              <h2>Skill 项目</h2>
              <span>{workspace.members.length} 个成员</span>
            </div>
            <div className="search-shell"><Search size={15} /><input aria-label="搜索 Skill" placeholder="搜索" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          </div>

          {workspace.members.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Skill</th><th>类型</th><th>状态</th><th>Git</th><th>Revision</th><th aria-label="操作" /></tr></thead>
                <tbody>
                  {visibleMembers.map((member) => {
                    const selected = member.projectId === workspace.selectedProjectId;
                    const index = workspace.members.findIndex((item) => item.projectId === member.projectId);
                    const selectable = member.status === "ready";
                    return (
                      <tr
                        key={member.projectId}
                        className={`${selected ? "selected-row" : ""} ${selectable ? "" : "unavailable-row"}`}
                        onClick={() => selectable && onSelectSkill(member.projectId)}
                      >
                        <td>
                          <div className="skill-name-cell">
                            <span className={`skill-icon ${member.capability}`}>
                              {member.capability === "workflow" ? <GitBranch size={16} /> : <BookOpenText size={16} />}
                            </span>
                            <div><strong>{member.displayName}</strong><small>{shortId(member.skillId)}</small></div>
                          </div>
                        </td>
                        <td><CapabilityBadge capability={member.capability} /></td>
                        <td title={member.statusDetail}><span className={`status-dot ${member.status}`} />{statusLabel(member.status)}</td>
                        <td>{member.git.available ? `${member.git.changedFiles} 处变更` : "未初始化"}</td>
                        <td><code>{member.activeRevision.slice(0, 16)}</code></td>
                        <td>
                          <div className="member-actions">
                            <button className="icon-button subtle" title="上移" disabled={index === 0} onClick={(event) => { event.stopPropagation(); onMoveSkill(member, -1); }}><ArrowUp size={15} /></button>
                            <button className="icon-button subtle" title="下移" disabled={index === workspace.members.length - 1} onClick={(event) => { event.stopPropagation(); onMoveSkill(member, 1); }}><ArrowDown size={15} /></button>
                            {member.mode === "in-place" && (member.status === "missing" || member.status === "error") && (
                              <button className="icon-button subtle repair-icon" title="修复项目路径" onClick={(event) => { event.stopPropagation(); onRepairSkill(member); }}><Wrench size={15} /></button>
                            )}
                            <button className="icon-button subtle danger-icon" title="从工作区移除" onClick={(event) => { event.stopPropagation(); onRemoveSkill(member); }}><Trash2 size={15} /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state list-empty">
              <SquareStack size={30} />
              <h2>工作区中还没有 Skill</h2>
              <button className="button primary" onClick={onAddSkill}><Plus size={17} />添加 Skill</button>
            </div>
          )}
        </section>

        <aside className="detail-panel">
          {currentSkill ? <SkillDetails member={currentSkill} onOpenRevisions={onOpenRevisions} onOpenExport={onOpenExport} onOpenGitDiff={onOpenGitDiff} onEditSkill={onEditSkill} onOpenAssets={onOpenAssets} onRepair={() => onRepairSkill(currentSkill)} /> : <div className="detail-empty">未选择 Skill</div>}
        </aside>
      </div>
    </div>
  );
}

function SkillDetails({ member, onOpenRevisions, onOpenExport, onOpenGitDiff, onEditSkill, onOpenAssets, onRepair }: { member: WorkspaceMember; onOpenRevisions: () => void; onOpenExport: () => void; onOpenGitDiff: () => void; onEditSkill: () => void; onOpenAssets: () => void; onRepair: () => void }) {
  const ready = member.status === "ready";
  return (
    <>
      <div className="detail-heading">
        <span className={`skill-icon large ${member.capability}`}>
          {member.capability === "workflow" ? <GitBranch size={20} /> : <BookOpenText size={20} />}
        </span>
        <div><span>当前 Skill</span><h2>{member.displayName}</h2></div>
      </div>
      <dl className="detail-list">
        <div><dt>Skill ID</dt><dd title={member.skillId}>{shortId(member.skillId)}</dd></div>
        <div><dt>项目模式</dt><dd>{member.mode === "managed-copy" ? "管理副本" : "原地打开"}</dd></div>
        <div><dt>状态</dt><dd>{statusLabel(member.status)}</dd></div>
        {member.sourcePath && <div><dt>项目路径</dt><dd title={member.sourcePath}>{member.sourcePath}</dd></div>}
        <div><dt>Lint</dt><dd>{member.lint.errors} 错误 · {member.lint.warnings} 警告</dd></div>
        <div><dt>最近运行</dt><dd>{member.lastRunAt ?? "暂无"}</dd></div>
      </dl>
      {!ready && member.statusDetail && <div className="member-status-detail"><AlertTriangle size={16} /><span>{member.statusDetail}</span></div>}
      <div className="detail-actions">
        {!ready && member.mode === "in-place" && <button className="button secondary full" onClick={onRepair}><Wrench size={16} />修复项目路径</button>}
        <button className="button secondary full" disabled={!ready} onClick={onEditSkill}><Pencil size={16} />编辑 Skill 信息</button>
        <button className="button secondary full" disabled={!ready} onClick={onOpenAssets}><Images size={16} />项目资产</button>
        <button className="button secondary full" disabled={!ready} onClick={onOpenRevisions}><History size={16} />版本与基线</button>
        <button className="button secondary full" disabled={!ready} onClick={onOpenExport}><PackageOpen size={16} />导出通用包</button>
        <button className="button secondary full" disabled={!ready} onClick={onOpenGitDiff}><GitBranch size={16} />Git 对比</button>
      </div>
    </>
  );
}

function SkillModuleView({
  view,
  workspaceId,
  skill,
  onOpenWorkspace,
  onOpenTests,
  onOpenDiagnosis,
  onProjectChanged
}: {
  view: View;
  workspaceId: string | null;
  skill: WorkspaceMember | null;
  onOpenWorkspace: () => void;
  onOpenTests: () => void;
  onOpenDiagnosis: () => void;
  onProjectChanged: () => Promise<void>;
}) {
  const names: Record<Exclude<View, "workspace">, string> = { graph: "图谱", docs: "文档", tests: "测试", diagnosis: "诊断" };
  if (view === "workspace") return null;
  if (!skill) {
    return <div className="empty-state full-height"><SquareStack size={34} /><h1>未选择 Skill</h1><button className="button primary" onClick={onOpenWorkspace}>返回工作区</button></div>;
  }
  if (skill.status !== "ready") {
    return <div className="empty-state full-height"><AlertTriangle size={34} /><h1>当前 Skill 不可用</h1><p>{skill.statusDetail ?? statusLabel(skill.status)}</p><button className="button primary" onClick={onOpenWorkspace}>返回工作区处理</button></div>;
  }
  if (view === "graph") {
    return workspaceId
      ? <GraphView workspaceId={workspaceId} skill={skill} onBack={onOpenWorkspace} onProjectChanged={onProjectChanged} />
      : <div className="empty-state full-height"><SquareStack size={34} /><h1>未选择 Workspace</h1></div>;
  }
  if (view === "docs" && workspaceId) return <DocumentView workspaceId={workspaceId} skill={skill} onProjectChanged={onProjectChanged} />;
  if (view === "tests" && workspaceId) return <TestView workspaceId={workspaceId} skill={skill} onProjectChanged={onProjectChanged} onOpenDiagnosis={onOpenDiagnosis} />;
  if (view === "diagnosis" && workspaceId) return <DiagnosisView workspaceId={workspaceId} skill={skill} onOpenTests={onOpenTests} onProjectChanged={onProjectChanged} />;
  const icons = { docs: FileText, tests: FlaskConical, diagnosis: Bug };
  const Icon = icons[view];
  return (
    <div className="module-page">
      <div className="page-heading"><div><span className="eyebrow">{skill.displayName}</span><h1>{names[view]}</h1></div></div>
      <div className="module-surface"><Icon size={32} /><span>暂无记录</span></div>
    </div>
  );
}

function RenameWorkspaceModal({ open, busy, currentName, onClose, onSubmit }: { open: boolean; busy: boolean; currentName: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(currentName);
  useEffect(() => { if (open) setName(currentName); }, [open, currentName]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <form className="modal workspace-lifecycle-modal" role="dialog" aria-modal="true" aria-labelledby="rename-workspace-title" onSubmit={(event) => { event.preventDefault(); void onSubmit(name.trim()); }}>
        <div className="modal-header"><h2 id="rename-workspace-title">重命名工作区</h2><button type="button" className="icon-button subtle" title="关闭" disabled={busy} onClick={onClose}><X size={17} /></button></div>
        <div className="modal-body"><label className="field"><span>工作区名称</span><input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label></div>
        <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy || !name.trim() || name.trim() === currentName}>保存</button></div>
      </form>
    </div>
  );
}

function DeleteWorkspaceModal({ open, busy, workspaceName, projectCount, onClose, onConfirm }: { open: boolean; busy: boolean; workspaceName: string; projectCount: number; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => { if (open) setConfirmation(""); }, [open, workspaceName]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <form className="modal workspace-lifecycle-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-workspace-title" onSubmit={(event) => { event.preventDefault(); void onConfirm(); }}>
        <div className="modal-header"><h2 id="delete-workspace-title">删除工作区</h2><button type="button" className="icon-button subtle" title="关闭" disabled={busy} onClick={onClose}><X size={17} /></button></div>
        <div className="modal-body workspace-delete-body">
          <div className="destructive-note"><AlertTriangle size={18} /><div><strong>仅删除 Workspace 引用</strong><span>{projectCount} 个 Skill 的源文件、Git 仓库和版本历史都会保留。</span></div></div>
          <label className="field"><span>输入“{workspaceName}”确认</span><input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        </div>
        <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button danger" disabled={busy || confirmation !== workspaceName}>删除工作区</button></div>
      </form>
    </div>
  );
}

function RepairMemberModal({ member, busy, onClose, onSubmit }: { member: WorkspaceMember; busy: boolean; onClose: () => void; onSubmit: (rootPath: string) => Promise<void> }) {
  const [rootPath, setRootPath] = useState(member.sourcePath ?? "");
  useEffect(() => setRootPath(member.sourcePath ?? ""), [member.projectId, member.sourcePath]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <form className="modal workspace-lifecycle-modal" role="dialog" aria-modal="true" aria-labelledby="repair-member-title" onSubmit={(event) => { event.preventDefault(); void onSubmit(rootPath.trim()); }}>
        <div className="modal-header"><div><h2 id="repair-member-title">修复项目路径</h2><span>{member.displayName}</span></div><button type="button" className="icon-button subtle" title="关闭" disabled={busy} onClick={onClose}><X size={17} /></button></div>
        <div className="modal-body">
          <label className="field"><span>新的 Skill 根路径</span><input autoFocus value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="/path/to/skill" /></label>
          <p className="modal-note">目录必须保留相同 skillId，并与当前 Revision 的文件内容完全一致。工具不会自动修改或覆盖该目录。</p>
        </div>
        <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy || !rootPath.trim()}><Wrench size={16} />校验并修复</button></div>
      </form>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return <div className={`metric ${accent ?? ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function CapabilityBadge({ capability }: { capability: SkillCapability }) {
  return <span className={`capability-badge ${capability}`}>{capability === "workflow" ? "工作流" : "内容型"}</span>;
}

function LoadingState() {
  return <div className="loading-state"><RefreshCw size={22} className="spin" /><span>正在加载工作区</span></div>;
}

function statusLabel(status: WorkspaceMember["status"]): string {
  return { "pending-import": "待确认", ready: "就绪", missing: "路径失联", error: "异常" }[status];
}

function shortId(id: string): string {
  return `${id.slice(0, 14)}…${id.slice(-6)}`;
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError || cause instanceof Error) return cause.message;
  return "发生未知错误";
}
