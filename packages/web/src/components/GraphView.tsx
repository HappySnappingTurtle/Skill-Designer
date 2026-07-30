import {
  AlertTriangle,
  Ban,
  Check,
  Eye,
  Link2,
  ListChecks,
  LocateFixed,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  diffGraph,
  graphEdgeTypeRegistry,
  graphNodeTypeRegistry,
  lintGraph,
  validateCondition,
  type ConditionExpression,
  type GraphChangeOperation,
  type GraphChangePreview,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphDiffSummary,
  type GraphLintIssue,
  type GraphNode,
  type GraphNodeKind,
  type ProjectChangeSet,
  type ProjectDocumentSlice,
  type ProjectFactQuery,
  type SkillGraph,
  type WorkspaceMember
} from "@skill-designer/engine";
import { api, ApiError } from "../api";
import { ChangeSetConflictPanel, readConflictedChangeSet } from "./ChangeSetConflictPanel";
import { ChangeSetMetadata } from "./ChangeSetMetadata";
import { SkillGraphCanvas, type GraphTheme, type GraphViewMode, type SkillGraphCanvasHandle } from "./SkillGraphCanvas";

interface Props {
  workspaceId: string;
  skill: WorkspaceMember;
  onBack: () => void;
  onProjectChanged: () => Promise<void>;
}

type DraftDialog = "node" | "edge" | "batch" | null;
type BatchNodePatch = { kind?: GraphNodeKind; description?: string | null };

const workflowNodeKinds: GraphNodeKind[] = graphNodeTypeRegistry.map((item) => item.kind).filter((kind) => kind !== "start");
const workflowEdgeKinds: GraphEdgeKind[] = graphEdgeTypeRegistry.map((item) => item.kind);
const idPattern = /^[a-z][a-z0-9._-]{1,127}$/i;

export function GraphView({ workspaceId, skill, onBack, onProjectChanged }: Props) {
  const [originalGraph, setOriginalGraph] = useState<SkillGraph | null>(null);
  const [draftGraph, setDraftGraph] = useState<SkillGraph | null>(null);
  const [activeRevision, setActiveRevision] = useState(skill.activeRevision);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<GraphNodeKind | "all">("all");
  const [planeFilter, setPlaneFilter] = useState<"all" | "flow" | "knowledge">("all");
  const [activeEdgeKinds, setActiveEdgeKinds] = useState<GraphEdgeKind[]>(workflowEdgeKinds);
  const [matchIndex, setMatchIndex] = useState(-1);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DraftDialog>(null);
  const [edgeDraftEndpoints, setEdgeDraftEndpoints] = useState<{ from?: string; to?: string }>({});
  const [changeSet, setChangeSet] = useState<ProjectChangeSet | null>(null);
  const [canvasMode, setCanvasMode] = useState<GraphViewMode>("3d");
  const [graphTheme, setGraphTheme] = useState<GraphTheme>("light");
  const [lintOpen, setLintOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [relationsOpen, setRelationsOpen] = useState(false);
  const [relationPanelLeft, setRelationPanelLeft] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const graphCanvasRef = useRef<SkillGraphCanvasHandle>(null);
  const graphSearchRef = useRef<HTMLInputElement>(null);
  const relationButtonRef = useRef<HTMLButtonElement>(null);
  const locallyAppliedRevision = useRef("");
  const loadedProjectId = useRef<string | null>(null);

  useEffect(() => {
    const revisionKey = `${skill.projectId}:${skill.activeRevision}`;
    if (locallyAppliedRevision.current === revisionKey) {
      locallyAppliedRevision.current = "";
      return;
    }
    let active = true;
    const projectChanged = loadedProjectId.current !== skill.projectId;
    loadedProjectId.current = skill.projectId;
    setLoading(true);
    setError(null);
    if (projectChanged) {
      setQuery("");
      setKindFilter("all");
      setPlaneFilter("all");
      setActiveEdgeKinds(workflowEdgeKinds);
      setMatchIndex(-1);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    }
    setChangeSet(null);
    setLintOpen(false);
    setChangesOpen(false);
    setRelationsOpen(false);
    setEditorOpen(false);
    setEdgeDraftEndpoints({});
    void api.getProjectGraph(skill.projectId).then(
      (payload) => {
        if (!active) return;
        setOriginalGraph(payload.graph);
        setDraftGraph(structuredClone(payload.graph));
        setActiveRevision(payload.activeRevision);
        setLoading(false);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(messageOf(cause));
        setLoading(false);
      }
    );
    return () => { active = false; };
  }, [skill.projectId, skill.activeRevision]);

  const lint = useMemo<GraphLintIssue[]>(() => draftGraph ? lintGraph(draftGraph) : [], [draftGraph]);
  const graphDiff = useMemo(() => originalGraph && draftGraph ? diffGraph(originalGraph, draftGraph) : null, [originalGraph, draftGraph]);
  const changeNodeStates = useMemo(() => {
    if (!graphDiff) return {};
    return Object.fromEntries([
      ...graphDiff.addedNodeIds.map((id) => [id, "added" as const]),
      ...graphDiff.updatedNodeIds.map((id) => [id, "modified" as const])
    ]);
  }, [graphDiff]);
  const dirty = graphDiff ? Object.values(graphDiff).some((ids) => ids.length > 0) : false;
  const errorCount = lint.filter((issue) => issue.severity === "error").length;
  const warningCount = lint.filter((issue) => issue.severity === "warning").length;
  const changeCount = graphDiff ? Object.values(graphDiff).reduce((total, ids) => total + ids.length, 0) : 0;
  const largeGraph = (draftGraph?.nodes.length ?? 0) > 200;
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const availableEdgeKinds = useMemo(() => workflowEdgeKinds.filter((kind) => draftGraph?.edges.some((edge) => edge.kind === kind)), [draftGraph]);
  const matchingNodeIds = useMemo(() => {
    if (!draftGraph || !normalizedQuery) return [];
    return draftGraph.nodes
      .filter((node) => kindFilter === "all" || node.kind === kindFilter)
      .filter((node) => planeFilter === "all" || (planeFilter === "knowledge" ? node.kind === "knowledge" : node.kind !== "knowledge"))
      .filter((node) => `${node.title} ${node.id}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
      .map((node) => node.id);
  }, [draftGraph, kindFilter, normalizedQuery, planeFilter]);

  const selectedNode = draftGraph?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = draftGraph?.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const graphPreview = useMemo<GraphChangePreview | null>(() => {
    const preview = changeSet?.preview[0];
    return preview?.kind === "graph" ? preview : null;
  }, [changeSet]);

  useEffect(() => {
    setMatchIndex(-1);
    if (kindFilter !== "all" && selectedNode && selectedNode.kind !== kindFilter) setSelectedNodeId(null);
  }, [kindFilter, normalizedQuery]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isField = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable;
      if (event.key === "Escape") {
        if (dialog || changeSet) return;
        if (selectedNodeId || selectedEdgeId) {
          setSelectedNodeId(null);
          setSelectedEdgeId(null);
        } else {
          graphCanvasRef.current?.exitFocus();
        }
        setChangesOpen(false);
        setRelationsOpen(false);
        setEditorOpen(false);
        setLintOpen(false);
        return;
      }
      if (isField) return;
      if (event.key === "/") {
        event.preventDefault();
        graphSearchRef.current?.focus();
      }
      if (event.key.toLocaleLowerCase("en-US") === "f") {
        event.preventDefault();
        graphCanvasRef.current?.fitGraph();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [changeSet, dialog, selectedEdgeId, selectedNodeId]);

  function focusNode(nodeId: string) {
    const node = draftGraph?.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    if (kindFilter !== "all" && node.kind !== kindFilter) setKindFilter("all");
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    window.setTimeout(() => graphCanvasRef.current?.focusNode(nodeId), 40);
  }

  function focusEdge(edgeId: string) {
    if (!draftGraph) return;
    const edge = draftGraph.edges.find((item) => item.id === edgeId);
    if (!edge) return;
    if (kindFilter !== "all") setKindFilter("all");
    if (!activeEdgeKinds.includes(edge.kind)) setActiveEdgeKinds((current) => [...current, edge.kind]);
    setSelectedEdgeId(edgeId);
    setSelectedNodeId(null);
    window.setTimeout(() => graphCanvasRef.current?.focusEdge(edgeId), 40);
  }

  function toggleEdgeKind(kind: GraphEdgeKind) {
    setActiveEdgeKinds((current) => current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind]);
  }

  function openEdgeDialog() {
    setEdgeDraftEndpoints({});
    setDialog("edge");
  }

  function focusLintIssue(issue: GraphLintIssue) {
    if (!draftGraph) return;
    const target = graphLintTarget(draftGraph, issue);
    if (target?.kind === "node") focusNode(target.id);
    if (target?.kind === "edge") focusEdge(target.id);
    const fieldId = graphLintFieldId(issue.path, target?.kind);
    if (fieldId) window.setTimeout(() => document.getElementById(fieldId)?.focus(), 320);
  }

  function repairLintIssue(issue: GraphLintIssue) {
    if (!draftGraph || issue.code !== "self_loop") return;
    const target = graphLintTarget(draftGraph, issue);
    if (!target || target.kind !== "edge") return;
    setDraftGraph({ ...draftGraph, edges: draftGraph.edges.filter((edge) => edge.id !== target.id) });
    if (selectedEdgeId === target.id) setSelectedEdgeId(null);
  }

  function locateMatch(direction: 1 | -1 = 1) {
    if (!draftGraph || !matchingNodeIds.length) return;
    const nextIndex = matchIndex < 0
      ? (direction === 1 ? 0 : matchingNodeIds.length - 1)
      : (matchIndex + direction + matchingNodeIds.length) % matchingNodeIds.length;
    const nodeId = matchingNodeIds[nextIndex]!;
    setMatchIndex(nextIndex);
    focusNode(nodeId);
  }

  function updateNode(patch: Partial<GraphNode>) {
    if (!draftGraph || !selectedNodeId) return;
    setDraftGraph({
      ...draftGraph,
      nodes: draftGraph.nodes.map((node) => node.id === selectedNodeId ? { ...node, ...patch, id: node.id } : node)
    });
  }

  function updateEdge(patch: Partial<GraphEdge>, removeCondition = false) {
    if (!draftGraph || !selectedEdgeId) return;
    setDraftGraph({
      ...draftGraph,
      edges: draftGraph.edges.map((edge) => {
        if (edge.id !== selectedEdgeId) return edge;
        const next = { ...edge, ...patch, id: edge.id };
        if (removeCondition) delete next.condition;
        return next;
      })
    });
  }

  function deleteSelectedNode() {
    if (!draftGraph || !selectedNode || !window.confirm(`删除节点“${selectedNode.title}”及其关联边？`)) return;
    setDraftGraph({
      ...draftGraph,
      nodes: draftGraph.nodes.filter((node) => node.id !== selectedNode.id),
      edges: draftGraph.edges.filter((edge) => edge.from !== selectedNode.id && edge.to !== selectedNode.id)
    });
    setSelectedNodeId(null);
  }

  function deleteSelectedEdge() {
    if (!draftGraph || !selectedEdge || !window.confirm(`删除边“${selectedEdge.id}”？`)) return;
    setDraftGraph({ ...draftGraph, edges: draftGraph.edges.filter((edge) => edge.id !== selectedEdge.id) });
    setSelectedEdgeId(null);
  }

  function discardDraft() {
    if (!originalGraph || !dirty || !window.confirm("放弃当前图草稿的全部修改？")) return;
    setDraftGraph(structuredClone(originalGraph));
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setError(null);
  }

  async function proposeChanges() {
    if (!originalGraph || !draftGraph || !dirty || errorCount) return;
    setBusy(true);
    setError(null);
    try {
      const operations = graphOperations(originalGraph, draftGraph);
      const proposed = await api.createChangeSet(skill.projectId, {
        workspaceId,
        baseRevision: activeRevision,
        reason: graphReason(operations),
        operations
      });
      setChangeSet(proposed);
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
      if (!applied.graph) throw new Error("服务器未返回已应用的图");
      setOriginalGraph(applied.graph);
      setDraftGraph(structuredClone(applied.graph));
      setActiveRevision(applied.activeRevision);
      locallyAppliedRevision.current = `${skill.projectId}:${applied.activeRevision}`;
      setChangeSet(null);
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
      await api.rejectChangeSet(changeSet.changeSetId, { digest: changeSet.digest, baseRevision: changeSet.baseRevision, reason: "用户在图谱确认界面拒绝提案" });
      setChangeSet(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="graph-loading"><LoaderCircle size={20} className="spin" />正在读取 {skill.displayName} 的图谱</div>;
  if (!draftGraph || !originalGraph) return <div className="graph-error"><AlertTriangle size={24} /><strong>{error ?? "图谱加载失败"}</strong></div>;

  return (
    <div className={`graph-page graph-theme-${graphTheme} ${(selectedNode || selectedEdge) ? "panel-open" : ""}`}>
      <div className="graph-toolbar">
        <button className="graph-original-title" data-skill-id={skill.skillId} title={`${skill.displayName} · ${skill.skillId} · 返回工作区`} aria-label="返回工作区" onClick={onBack}>{skill.displayName} 知识图谱</button>
        <div className="graph-toolbar-actions graph-editor-actions">
          <div className="graph-find">
            <input ref={graphSearchRef} className="graph-search" aria-label="搜索图节点" autoComplete="off" placeholder="搜索节点，Enter 定位" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); locateMatch(event.shiftKey ? -1 : 1); } }} />
          </div>
          <div className="graph-toolbar-segment" role="group" aria-label="图谱显示模式">
            <button className={canvasMode === "3d" ? "active" : ""} aria-pressed={canvasMode === "3d"} onClick={() => graphCanvasRef.current?.setMode("3d")}>3D 立体</button>
            <button className={canvasMode === "2d" ? "active" : ""} aria-pressed={canvasMode === "2d"} onClick={() => graphCanvasRef.current?.setMode("2d")}>2D 平面</button>
          </div>
          <div className="graph-toolbar-segment graph-plane-segment" role="group" aria-label="图谱平面筛选">
            <button className={planeFilter === "all" ? "active" : ""} onClick={() => setPlaneFilter("all")}>全部</button>
            <button className={planeFilter === "flow" ? "active" : ""} onClick={() => setPlaneFilter("flow")}>流程面</button>
            <button className={planeFilter === "knowledge" ? "active" : ""} onClick={() => setPlaneFilter("knowledge")}>知识面</button>
          </div>
          <button className={`graph-theme-button ${graphTheme === "dark" ? "active" : ""}`} title="深浅主题切换" aria-label="深浅主题切换" onClick={() => graphCanvasRef.current?.setTheme(graphTheme === "light" ? "dark" : "light")}>🌓</button>
          <button className={`graph-original-button ${changeCount ? "" : "clean"}`} title="查看当前草稿与已确认版本的差异" onClick={() => { setChangesOpen((current) => !current); setRelationsOpen(false); setEditorOpen(false); }}>变更 <span>{changeCount}</span></button>
          <button ref={relationButtonRef} className="graph-original-button" title="按关系类型过滤" onClick={() => {
            const rect = relationButtonRef.current?.getBoundingClientRect();
            if (rect) setRelationPanelLeft(Math.min(rect.left, window.innerWidth - 340));
            setRelationsOpen((current) => !current);
            setChangesOpen(false);
            setEditorOpen(false);
          }}>关系 {relationCountLabel(activeEdgeKinds, availableEdgeKinds)} ▾</button>
          <button className="graph-fit-toolbar" title="适应全图" aria-label="适应全图" onClick={() => graphCanvasRef.current?.fitGraph()}>⤢ 适应</button>
          {largeGraph && <span className="graph-scale-mode" title="仅渲染视口内元素，并简化边与动画">大图模式</span>}
        </div>
      </div>

      {relationsOpen && <div className="graph-relation-panel" style={{ left: relationPanelLeft }} aria-label="关系类型筛选">{availableEdgeKinds.map((kind) => <label key={kind}><input type="checkbox" checked={activeEdgeKinds.includes(kind)} onChange={() => toggleEdgeKind(kind)} /><i style={{ background: edgeKindColor(kind) }} />{edgeKindLabel(kind)}</label>)}</div>}
      {editorOpen && <div className="graph-editor-menu">
        <button onClick={() => { setDialog("node"); setEditorOpen(false); }}><Plus size={15} />新增节点</button>
        <button disabled={draftGraph.nodes.length < 2} onClick={() => { openEdgeDialog(); setEditorOpen(false); }}><Link2 size={15} />新增边</button>
        <button disabled={!draftGraph.nodes.length} onClick={() => { setDialog("batch"); setEditorOpen(false); }}><ListChecks size={15} />批量编辑节点</button>
        <button disabled={!dirty} onClick={() => { discardDraft(); setEditorOpen(false); }}><RotateCcw size={15} />放弃草稿</button>
      </div>}

      {error && <div className="docs-error" role="alert">{error}<button title="关闭" onClick={() => setError(null)}><X size={15} /></button></div>}

      <div className="graph-layout">
        <section className="graph-canvas" aria-label={`${skill.displayName} 图谱`}>
          <SkillGraphCanvas
            ref={graphCanvasRef}
            graph={draftGraph}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            query={query}
            kindFilter={kindFilter}
            planeFilter={planeFilter}
            edgeKindFilter={activeEdgeKinds}
            largeGraph={largeGraph}
            changeNodeStates={changeNodeStates}
            embeddedControls={false}
            onSelectNode={(nodeId) => { setSelectedNodeId(nodeId); setSelectedEdgeId(null); }}
            onSelectEdge={(edgeId) => { setSelectedEdgeId(edgeId); setSelectedNodeId(null); }}
            onClearSelection={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
            onModeChange={setCanvasMode}
            onThemeChange={setGraphTheme}
            onKindFilterChange={setKindFilter}
          />
        </section>
        <button className={`graph-lint-toggle ${errorCount ? "has-error" : ""}`} title={`${errorCount} 个错误，${warningCount} 个警告`} onClick={() => setLintOpen((current) => !current)}>
          <span>{errorCount ? `❌ ${errorCount} 错误` : warningCount ? `⚠️ ${warningCount} 警告` : `✅形状校验通过（${draftGraph.nodes.length} 节点 / ${draftGraph.edges.length} 边）`}</span>
        </button>
        <div className="graph-interaction-hint">无限画布：2D 拖背景平移｜3D 左键旋转 · 右键平移 · 滚轮缩放｜单击看详情 · 双击聚焦 2 跳邻域 · 图例点击过滤 · 快捷键 / 搜索 f 适应 Esc 退出</div>

        {changesOpen && <GraphDraftChanges graph={draftGraph} diff={graphDiff!} dirty={dirty} errorCount={errorCount} busy={busy} onEdit={() => { setChangesOpen(false); setEditorOpen(true); }} onFocusNode={(nodeId) => { setChangesOpen(false); focusNode(nodeId); }} onFocusEdge={(edgeId) => { setChangesOpen(false); focusEdge(edgeId); }} onPreview={() => void proposeChanges()} />}

        {(selectedNode || selectedEdge) && <aside className={`graph-inspector open ${selectedNode ? `kind-${selectedNode.kind}` : "kind-edge"}`}>
          {selectedNode ? (
            <NodeInspector projectId={skill.projectId} graph={draftGraph} node={selectedNode} onChange={updateNode} onDelete={deleteSelectedNode} onSelectNode={focusNode} onSelectEdge={focusEdge} onClose={() => setSelectedNodeId(null)} />
          ) : selectedEdge ? (
            <EdgeInspector graph={draftGraph} edge={selectedEdge} onChange={updateEdge} onDelete={deleteSelectedEdge} onClose={() => setSelectedEdgeId(null)} />
          ) : null}
        </aside>}
        {lintOpen && <div className="graph-lint-float"><GraphLintPanel issues={lint} onLocate={(issue) => { focusLintIssue(issue); setLintOpen(false); }} onRepair={repairLintIssue} /></div>}
      </div>

      {dialog === "node" && <CreateNodeDialog graph={draftGraph} onClose={() => setDialog(null)} onCreate={(node) => {
        setDraftGraph({ ...draftGraph, nodes: [...draftGraph.nodes, node] });
        setSelectedNodeId(node.id);
        setSelectedEdgeId(null);
        setDialog(null);
      }} />}
      {dialog === "edge" && <CreateEdgeDialog graph={draftGraph} initialFrom={edgeDraftEndpoints.from} initialTo={edgeDraftEndpoints.to} onClose={() => { setDialog(null); setEdgeDraftEndpoints({}); }} onCreate={(edge) => {
        setDraftGraph({ ...draftGraph, edges: [...draftGraph.edges, edge] });
        setSelectedEdgeId(edge.id);
        setSelectedNodeId(null);
        setDialog(null);
        setEdgeDraftEndpoints({});
      }} />}
      {dialog === "batch" && <BatchNodeDialog graph={draftGraph} initialNodeId={selectedNodeId} onClose={() => setDialog(null)} onApply={(nodeIds, patch) => {
        const selectedIds = new Set(nodeIds);
        setDraftGraph({ ...draftGraph, nodes: draftGraph.nodes.map((node) => {
          if (!selectedIds.has(node.id)) return node;
          const next = { ...node, ...(patch.kind ? { kind: patch.kind } : {}), ...(typeof patch.description === "string" ? { description: patch.description } : {}) };
          if (patch.description === null) delete next.description;
          return next;
        }) });
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        setDialog(null);
      }} />}

      {changeSet && graphPreview && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal graph-change-modal" role="dialog" aria-modal="true" aria-labelledby="graph-change-title">
            <div className="modal-header"><div><h2 id="graph-change-title">{changeSet.status === "conflicted" ? "处理图谱提案冲突" : "确认图谱变更"}</h2><span>{skill.displayName} · {shortRevision(changeSet.baseRevision)}</span></div><button className="icon-button subtle" title="关闭" disabled={busy} onClick={() => setChangeSet(null)}><X size={18} /></button></div>
            {changeSet.status === "conflicted" && <ChangeSetConflictPanel changeSet={changeSet} />}
            <GraphDiffPreview preview={graphPreview} />
            <ChangeSetMetadata changeSet={changeSet} />
            {changeSet.status === "conflicted"
              ? <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setChangeSet(null)}>关闭并保留当前项目</button><button className="button primary" disabled={busy} onClick={() => void reproposeConflict()}>{busy ? <LoaderCircle size={16} className="spin" /> : <RotateCcw size={16} />}基于当前版本重新预演</button></div>
              : <div className="modal-actions proposal-actions"><button className="button danger proposal-reject" disabled={busy} onClick={() => void rejectProposal()}><Ban size={16} />拒绝提案</button><button className="button secondary" disabled={busy} onClick={() => setChangeSet(null)}>返回编辑</button><button className="button primary" disabled={busy} onClick={() => void confirmAndApply()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}确认并应用</button></div>}
          </div>
        </div>
      )}
    </div>
  );
}

function GraphDraftChanges({ graph, diff, dirty, errorCount, busy, onEdit, onFocusNode, onFocusEdge, onPreview }: {
  graph: SkillGraph;
  diff: GraphDiffSummary;
  dirty: boolean;
  errorCount: number;
  busy: boolean;
  onEdit: () => void;
  onFocusNode: (nodeId: string) => void;
  onFocusEdge: (edgeId: string) => void;
  onPreview: () => void;
}) {
  const nodeRows = [
    ...diff.addedNodeIds.map((id) => ({ id, state: "新增" })),
    ...diff.updatedNodeIds.map((id) => ({ id, state: "修改" })),
    ...diff.removedNodeIds.map((id) => ({ id, state: "删除" }))
  ];
  const edgeRows = [
    ...diff.addedEdgeIds.map((id) => ({ id, state: "新增" })),
    ...diff.updatedEdgeIds.map((id) => ({ id, state: "修改" })),
    ...diff.removedEdgeIds.map((id) => ({ id, state: "删除" }))
  ];
  return <div className="graph-changes-panel">
    <button className="graph-editor-from-changes" title="图谱编辑工具" onClick={onEdit}><Wrench size={14} />编辑图谱</button>
    {!dirty && <p>与当前已确认版本一致。</p>}
    {nodeRows.length > 0 && <section><h4>节点变更（{nodeRows.length}）</h4>{nodeRows.map((row) => {
      const node = graph.nodes.find((item) => item.id === row.id);
      return <button key={row.id} disabled={!node} onClick={() => node && onFocusNode(node.id)}><i data-state={row.state} /><span>{node?.title ?? row.id}</span><code>{row.state}</code></button>;
    })}</section>}
    {edgeRows.length > 0 && <section><h4>关系变更（{edgeRows.length}）</h4>{edgeRows.map((row) => {
      const edge = graph.edges.find((item) => item.id === row.id);
      return <button key={row.id} disabled={!edge} onClick={() => edge && onFocusEdge(edge.id)}><i data-state={row.state} /><span>{edge?.label || row.id}</span><code>{row.state}</code></button>;
    })}</section>}
    {dirty && <button className="graph-preview-save" disabled={Boolean(errorCount) || busy} onClick={onPreview}>{busy ? <LoaderCircle size={15} className="spin" /> : null}{errorCount ? `存在 ${errorCount} 个错误，暂不能保存` : "预览并保存图"}</button>}
  </div>;
}

function NodeInspector({ projectId, graph, node, onChange, onDelete, onSelectNode, onSelectEdge, onClose }: { projectId: string; graph: SkillGraph; node: GraphNode; onChange: (patch: Partial<GraphNode>) => void; onDelete: () => void; onSelectNode: (nodeId: string) => void; onSelectEdge: (edgeId: string) => void; onClose: () => void }) {
  const kinds = graph.capability === "content-only" ? ["knowledge" as const] : ["start" as const, ...workflowNodeKinds];
  const [slice, setSlice] = useState<ProjectDocumentSlice | null>(null);
  const [sliceBusy, setSliceBusy] = useState(false);
  const [sliceError, setSliceError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const inbound = graph.edges.filter((edge) => edge.to === node.id);
  const outbound = graph.edges.filter((edge) => edge.from === node.id);
  const degree = inbound.length + outbound.length;

  useEffect(() => {
    setEditing(false);
  }, [node.id]);

  useEffect(() => {
    setSlice(null);
    setSliceError(null);
    if (node.doc?.trim()) void previewSlice(node.doc.trim(), node.docAnchor?.trim() ?? "");
  }, [node.id, node.doc, node.docAnchor]);

  async function previewSlice(documentPath = node.doc?.trim() ?? "", anchor = node.docAnchor?.trim() ?? "") {
    if (!documentPath) return;
    setSliceBusy(true);
    setSliceError(null);
    try {
      setSlice(await api.getDocumentSlice(projectId, documentPath, anchor));
    } catch (cause) {
      setSlice(null);
      setSliceError(messageOf(cause));
    } finally {
      setSliceBusy(false);
    }
  }

  if (editing) return (
    <div className="inspector-form graph-inspector-editor">
      <div className="inspector-heading"><Pencil size={16} /><div><span>编辑节点</span><h2>{node.title || "未命名节点"}</h2></div><button className="icon-button subtle inspector-close" title="返回节点档案" aria-label="返回节点档案" onClick={() => setEditing(false)}><Eye size={16} /></button></div>
      <label className="field"><span>节点 ID</span><input id="graph-node-id" value={node.id} readOnly /></label>
      <label className="field"><span>节点标题</span><input id="graph-node-title" value={node.title} onChange={(event) => onChange({ title: event.target.value })} /></label>
      <label className="field"><span>节点类型</span><select id="graph-node-kind" value={node.kind} onChange={(event) => onChange({ kind: event.target.value as GraphNodeKind })}>{kinds.map((kind) => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}</select></label>
      <label className="field"><span>节点说明</span><textarea rows={4} value={node.description ?? ""} onChange={(event) => onChange({ description: event.target.value })} /></label>
      <label className="field"><span>关联文档</span><input id="graph-node-doc" placeholder="docs/guide.md" value={node.doc ?? ""} onChange={(event) => onChange({ doc: event.target.value })} /></label>
      <label className="field"><span>标题路径或锚点</span><input placeholder="Guide/macOS/Retry 或 #retry" value={node.docAnchor ?? ""} onChange={(event) => onChange({ docAnchor: event.target.value })} /></label>
      <button className="button secondary full" disabled={!node.doc?.trim() || sliceBusy} onClick={() => void previewSlice()}>{sliceBusy ? <LoaderCircle size={16} className="spin" /> : <Eye size={16} />}预览文档片段</button>
      {sliceError && <div className="document-binding-result error" role="alert">{sliceError}</div>}
      {slice && <DocumentSlicePreview result={slice} />}
      <NodeLookupEditor graph={graph} queries={node.lookup ?? []} onChange={(lookup) => onChange({ lookup })} />
      <div className="inspector-actions"><button className="button secondary full" onClick={() => setEditing(false)}><Eye size={16} />返回节点档案</button><button className="button danger full" onClick={onDelete}><Trash2 size={16} />删除节点</button></div>
    </div>
  );

  return <div className="graph-detail">
    <header className="graph-detail-head">
      <button className="graph-detail-close" title="关闭详情" aria-label="关闭详情" onClick={onClose}><X size={15} /></button>
      <h3>{node.title || "未命名节点"}</h3>
      <code>{node.id}</code>
      <div className="graph-detail-tags">
        <span className="graph-detail-tag" style={{ background: `${nodeKindColor(node.kind)}22`, color: nodeKindColor(node.kind) }}>{kindLabel(node.kind)}</span>
        <span className="graph-detail-tag">{node.kind === "knowledge" ? "知识面" : "流程面"}</span>
        <span className="graph-detail-tag">连接 {degree}</span>
      </div>
    </header>
    <div className="graph-detail-body">
      {(node.description || node.doc || node.docAnchor || node.lookup?.length) && <>
        <div className="graph-detail-section">节点信息</div>
        {node.description && <p className="graph-detail-description">{node.description}</p>}
        {node.doc && <div className="graph-detail-kv">文档：<code>{node.doc}</code></div>}
        {node.docAnchor && <div className="graph-detail-kv">切片：<code>{node.docAnchor}</code></div>}
        {node.lookup?.length ? <div className="graph-detail-kv">声明式查询：<code>{node.lookup.length}</code></div> : null}
      </>}
      {outbound.length > 0 && <>
        <div className="graph-detail-section">出边（点击跳转）</div>
        <GraphRelationChips edges={outbound} graph={graph} peer="to" onSelectNode={onSelectNode} onSelectEdge={onSelectEdge} />
      </>}
      {inbound.length > 0 && <>
        <div className="graph-detail-section">入边（谁指向我）</div>
        <GraphRelationChips edges={inbound} graph={graph} peer="from" inbound onSelectNode={onSelectNode} onSelectEdge={onSelectEdge} />
      </>}
      <div className="graph-detail-section">节点文档{node.docAnchor ? `（切片 §${node.docAnchor}）` : ""}{node.doc && <code>{node.doc}</code>}</div>
      {sliceBusy && <div className="graph-detail-loading"><LoaderCircle size={15} className="spin" />读取文档</div>}
      {sliceError && <div className="graph-detail-degraded" role="alert">【降级】{sliceError}</div>}
      {!sliceBusy && !sliceError && slice && <GraphDocumentPreview result={slice} />}
      {!sliceBusy && !sliceError && !node.doc && <div className="graph-detail-kv muted">本节点无独立文档（{kindLabel(node.kind)}节点，信息全在图数据中）。</div>}
      <div className="graph-detail-actions"><button className="button secondary full" onClick={() => setEditing(true)}><Pencil size={15} />编辑节点</button></div>
    </div>
  </div>;
}

function NodeLookupEditor({ graph, queries, onChange }: { graph: SkillGraph; queries: ProjectFactQuery[]; onChange: (queries: ProjectFactQuery[]) => void }) {
  function update(index: number, query: ProjectFactQuery) {
    onChange(queries.map((item, itemIndex) => itemIndex === index ? query : item));
  }
  function add(kind: ProjectFactQuery["kind"]) {
    const used = new Set(queries.map((query) => query.queryId));
    let sequence = queries.length + 1;
    while (used.has(`query.${sequence}`)) sequence++;
    const queryId = `query.${sequence}`;
    const nodeId = graph.nodes[0]?.id ?? "flow.start";
    const query: ProjectFactQuery = kind === "graph.node"
      ? { queryId, kind, nodeId }
      : kind === "graph.neighborhood"
        ? { queryId, kind, nodeId, direction: "both" }
        : kind === "graph.search"
          ? { queryId, kind, text: "节点", limit: 10 }
          : { queryId, kind, path: "SKILL.md", anchor: "Skill", fallback: "none" };
    onChange([...queries, query]);
  }
  return <section className="node-lookup-editor">
    <header><div><span>声明式查询</span><strong>{queries.length}/20</strong></div><select aria-label="新增查询类型" value="" disabled={queries.length >= 20} onChange={(event) => { if (event.target.value) add(event.target.value as ProjectFactQuery["kind"]); }}><option value="">添加查询…</option><option value="graph.node">精确节点</option><option value="graph.neighborhood">节点邻域</option><option value="graph.search">图谱搜索</option><option value="document.slice">文档切片</option></select></header>
    {queries.map((query, index) => <article key={`${query.queryId}-${index}`}>
      <div className="node-lookup-row-head"><code>{lookupKindLabel(query.kind)}</code><button className="icon-button subtle" title="删除查询" onClick={() => onChange(queries.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={13} /></button></div>
      <label><span>查询 ID</span><input aria-label={`查询 ${index + 1} ID`} value={query.queryId} onChange={(event) => update(index, { ...query, queryId: event.target.value.trim() })} /></label>
      {query.kind === "graph.node" && <label><span>节点</span><select value={query.nodeId} onChange={(event) => update(index, { ...query, nodeId: event.target.value })}>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.title} · {node.id}</option>)}</select></label>}
      {query.kind === "graph.neighborhood" && <><label><span>中心节点</span><select value={query.nodeId} onChange={(event) => update(index, { ...query, nodeId: event.target.value })}>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.title} · {node.id}</option>)}</select></label><label><span>方向</span><select value={query.direction} onChange={(event) => update(index, { ...query, direction: event.target.value as "in" | "out" | "both" })}><option value="both">双向</option><option value="out">出边</option><option value="in">入边</option></select></label></>}
      {query.kind === "graph.search" && <><label><span>搜索文本</span><input value={query.text} onChange={(event) => update(index, { ...query, text: event.target.value })} /></label><label><span>最多结果</span><input type="number" min={1} max={20} value={query.limit ?? 10} onChange={(event) => update(index, { ...query, limit: Number(event.target.value) })} /></label></>}
      {query.kind === "document.slice" && <><label><span>文档</span><input value={query.path} placeholder="docs/guide.md" onChange={(event) => update(index, { ...query, path: event.target.value.trim() })} /></label><label><span>标题路径 / 锚点</span><input value={query.anchor} placeholder="Guide/macOS/Retry" onChange={(event) => update(index, { ...query, anchor: event.target.value })} /></label><label className="node-lookup-toggle"><input type="checkbox" checked={query.fallback === "title"} onChange={(event) => update(index, { ...query, fallback: event.target.checked ? "title" : "none" })} /><span>精确路径缺失时允许按末级标题降级</span></label></>}
    </article>)}
    {!queries.length && <p>未声明项目事实查询。</p>}
  </section>;
}

function lookupKindLabel(kind: ProjectFactQuery["kind"]): string {
  return { "graph.node": "精确节点", "graph.neighborhood": "节点邻域", "graph.search": "图谱搜索", "document.slice": "文档切片" }[kind];
}

function GraphRelationChips({ edges, graph, peer, inbound = false, onSelectNode, onSelectEdge }: { edges: GraphEdge[]; graph: SkillGraph; peer: "from" | "to"; inbound?: boolean; onSelectNode: (nodeId: string) => void; onSelectEdge: (edgeId: string) => void }) {
  return <div className="graph-relation-chips">{edges.map((edge) => {
    const peerNode = graph.nodes.find((node) => node.id === edge[peer]);
    return <span className="graph-relation-chip" key={edge.id} title={`${edgeKindLabel(edge.kind)}${edge.label ? `：${edge.label}` : ""}`}>
      <i style={{ background: edgeKindColor(edge.kind) }} />
      {!inbound && <button className="relation-kind" style={{ color: edgeKindColor(edge.kind) }} onClick={() => onSelectEdge(edge.id)}>{edgeKindLabel(edge.kind)}</button>}
      <button onClick={() => onSelectNode(edge[peer])}>{inbound ? "←" : ""}{peerNode?.title ?? edge[peer]}</button>
    </span>;
  })}</div>;
}

function GraphDocumentPreview({ result }: { result: ProjectDocumentSlice }) {
  if (result.status === "missing") return <div className="graph-detail-degraded">【降级】文档缺失（{result.query}）。图谱结构与数据完好，已记入待修。</div>;
  if (result.status === "ambiguous") return <div className="graph-detail-degraded">文档引用不唯一：{result.candidates.map((candidate) => `${candidate.path} L${candidate.startLine}`).join("、")}</div>;
  const content = result.status === "whole-document" ? result.content : result.slice!.content;
  return <div className="graph-doc-wrap"><div className="graph-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div></div>;
}

function DocumentSlicePreview({ result }: { result: ProjectDocumentSlice }) {
  if (result.status === "missing") return <div className="document-binding-result error"><strong>未找到引用</strong><span>{result.query}</span></div>;
  if (result.status === "ambiguous") return <div className="document-binding-result error"><strong>引用不唯一</strong>{result.candidates.map((candidate) => <code key={`${candidate.path}-${candidate.startLine}`}>{candidate.path} · L{candidate.startLine}</code>)}</div>;
  if (result.status === "whole-document") return <div className="document-binding-preview"><div><strong>完整文档</strong><span>{result.documentPath}</span></div><pre>{result.content}</pre></div>;
  return <div className="document-binding-preview"><div><strong>{result.slice!.heading.path}</strong><span>L{result.slice!.heading.startLine}-L{result.slice!.heading.endLine}</span></div><pre>{result.slice!.content}</pre></div>;
}

function EdgeInspector({ graph, edge, onChange, onDelete, onClose }: { graph: SkillGraph; edge: GraphEdge; onChange: (patch: Partial<GraphEdge>, removeCondition?: boolean) => void; onDelete: () => void; onClose: () => void }) {
  const kinds = graph.capability === "content-only" ? ["knowledge" as const] : workflowEdgeKinds;
  const [conditionOpen, setConditionOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const source = graph.nodes.find((node) => node.id === edge.from);
  const target = graph.nodes.find((node) => node.id === edge.to);
  useEffect(() => { setEditing(false); setConditionOpen(false); }, [edge.id]);

  if (!editing) return <div className="graph-detail">
    <header className="graph-detail-head">
      <button className="graph-detail-close" title="关闭详情" aria-label="关闭详情" onClick={onClose}><X size={15} /></button>
      <h3>{edge.label || edge.id}</h3>
      <code>{edge.id}</code>
      <div className="graph-detail-tags"><span className="graph-detail-tag" style={{ background: `${edgeKindColor(edge.kind)}22`, color: edgeKindColor(edge.kind) }}>{edgeKindLabel(edge.kind)}</span><span className="graph-detail-tag">关系</span></div>
    </header>
    <div className="graph-detail-body">
      <div className="graph-detail-section">关系端点</div>
      <div className="graph-endpoint-table"><span>起点</span><strong>{source?.title ?? edge.from}</strong><code>{edge.from}</code><span>终点</span><strong>{target?.title ?? edge.to}</strong><code>{edge.to}</code></div>
      {edge.condition && <><div className="graph-detail-section">结构化条件</div><pre className="graph-condition-code">{JSON.stringify(edge.condition, null, 2)}</pre></>}
      {!edge.condition && <><div className="graph-detail-section">结构化条件</div><div className="graph-detail-kv muted">未设置</div></>}
      <div className="graph-detail-actions"><button className="button secondary full" onClick={() => setEditing(true)}><Pencil size={15} />编辑关系</button></div>
    </div>
  </div>;

  return (
    <div className="inspector-form graph-inspector-editor">
      <div className="inspector-heading"><Pencil size={17} /><div><span>编辑关系</span><h2>{edge.label || edge.id}</h2></div><button className="icon-button subtle inspector-close" title="返回关系档案" aria-label="返回关系档案" onClick={() => setEditing(false)}><Eye size={16} /></button></div>
      <label className="field"><span>边 ID</span><input id="graph-edge-id" value={edge.id} readOnly /></label>
      <label className="field"><span>起点</span><select id="graph-edge-from" value={edge.from} onChange={(event) => onChange({ from: event.target.value })}>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label>
      <label className="field"><span>终点</span><select id="graph-edge-to" value={edge.to} onChange={(event) => onChange({ to: event.target.value })}>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label>
      <label className="field"><span>边类型</span><select id="graph-edge-kind" value={edge.kind} onChange={(event) => onChange({ kind: event.target.value as GraphEdgeKind })}>{kinds.map((kind) => <option key={kind} value={kind}>{edgeKindLabel(kind)}</option>)}</select></label>
      <label className="field"><span>边标签</span><input id="graph-edge-label" value={edge.label ?? ""} onChange={(event) => onChange({ label: event.target.value })} /></label>
      {graph.capability === "workflow" && <div className="edge-condition-summary"><div><span>结构化条件</span><strong>{edge.condition ? conditionLabel(edge.condition) : "未设置"}</strong></div>{edge.condition && <code>{JSON.stringify(edge.condition)}</code>}<button id="graph-edge-condition" className="button secondary full" onClick={() => setConditionOpen(true)}><Wrench size={15} />{edge.condition ? "编辑条件" : "添加条件"}</button></div>}
      <div className="inspector-actions"><button className="button secondary full" onClick={() => setEditing(false)}><Eye size={16} />返回关系档案</button><button className="button danger full" onClick={onDelete}><Trash2 size={16} />删除边</button></div>
      {conditionOpen && <ConditionDialog condition={edge.condition} onClose={() => setConditionOpen(false)} onApply={(condition) => { onChange({ condition }); setConditionOpen(false); }} onRemove={edge.condition ? () => { onChange({}, true); setConditionOpen(false); } : undefined} />}
    </div>
  );
}

function CreateNodeDialog({ graph, onClose, onCreate }: { graph: SkillGraph; onClose: () => void; onCreate: (node: GraphNode) => void }) {
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<GraphNodeKind>(graph.capability === "content-only" ? "knowledge" : "step");
  const [error, setError] = useState<string | null>(null);
  const kinds = graph.capability === "content-only" ? ["knowledge" as const] : workflowNodeKinds;
  function submit() {
    if (!idPattern.test(id)) return setError("ID 需以字母开头，仅使用字母、数字、点、下划线或连字符");
    if (graph.nodes.some((node) => node.id === id)) return setError("节点 ID 已存在");
    if (!title.trim()) return setError("节点标题不能为空");
    const index = graph.nodes.length;
    const position = graph.capability === "workflow" && index >= 3
      ? { x: 360 + ((index - 3) % 2) * 280, y: 360 + Math.floor((index - 3) / 2) * 180 }
      : { x: 140 + (index % 3) * 240, y: 120 + Math.floor(index / 3) * 180 };
    onCreate({ id, kind, title: title.trim(), position });
  }
  return <EditorDialog title="新增节点" onClose={onClose} onSubmit={submit} submitLabel="加入草稿">
    <label className="field"><span>节点 ID</span><input autoFocus value={id} placeholder="flow.review" onChange={(event) => setId(event.target.value.trim())} /></label>
    <label className="field"><span>节点标题</span><input value={title} placeholder="人工确认" onChange={(event) => setTitle(event.target.value)} /></label>
    <label className="field"><span>节点类型</span><select value={kind} onChange={(event) => setKind(event.target.value as GraphNodeKind)}>{kinds.map((item) => <option key={item} value={item}>{kindLabel(item)}</option>)}</select></label>
    {error && <p className="form-error" role="alert">{error}</p>}
  </EditorDialog>;
}

function CreateEdgeDialog({ graph, initialFrom, initialTo, onClose, onCreate }: { graph: SkillGraph; initialFrom?: string | undefined; initialTo?: string | undefined; onClose: () => void; onCreate: (edge: GraphEdge) => void }) {
  const defaultFrom = initialFrom && graph.nodes.some((node) => node.id === initialFrom) ? initialFrom : graph.nodes[0]?.id ?? "";
  const defaultTo = initialTo && graph.nodes.some((node) => node.id === initialTo) ? initialTo : graph.nodes[1]?.id ?? graph.nodes[0]?.id ?? "";
  const [id, setId] = useState(() => nextEdgeId(graph, defaultFrom, defaultTo));
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [kind, setKind] = useState<GraphEdgeKind>(graph.capability === "content-only" ? "knowledge" : "flow");
  const [label, setLabel] = useState("");
  const [conditionText, setConditionText] = useState(JSON.stringify(defaultCondition(), null, 2));
  const [error, setError] = useState<string | null>(null);
  const kinds = graph.capability === "content-only" ? ["knowledge" as const] : workflowEdgeKinds;
  function submit() {
    if (!idPattern.test(id)) return setError("ID 需以字母开头，仅使用字母、数字、点、下划线或连字符");
    if (graph.edges.some((edge) => edge.id === id)) return setError("边 ID 已存在");
    if (!from || !to) return setError("必须选择起点和终点");
    const parsed = kind === "condition" ? parseConditionText(conditionText) : { value: undefined, error: null };
    if (parsed.error) return setError(parsed.error);
    onCreate({ id, from, to, kind, ...(label.trim() ? { label: label.trim() } : {}), ...(parsed.value ? { condition: parsed.value } : {}) });
  }
  return <EditorDialog title="新增边" onClose={onClose} onSubmit={submit} submitLabel="加入草稿">
    <label className="field"><span>边 ID</span><input autoFocus value={id} placeholder="edge.review-end" onChange={(event) => setId(event.target.value.trim())} /></label>
    <label className="field"><span>起点</span><select value={from} onChange={(event) => setFrom(event.target.value)}>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label>
    <label className="field"><span>终点</span><select value={to} onChange={(event) => setTo(event.target.value)}>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label>
    <label className="field"><span>边类型</span><select value={kind} onChange={(event) => setKind(event.target.value as GraphEdgeKind)}>{kinds.map((item) => <option key={item} value={item}>{edgeKindLabel(item)}</option>)}</select></label>
    <label className="field"><span>边标签</span><input value={label} onChange={(event) => setLabel(event.target.value)} /></label>
    {kind === "condition" && <label className="field"><span>条件表达式 JSON</span><textarea aria-label="条件表达式 JSON" rows={9} spellCheck={false} value={conditionText} onChange={(event) => setConditionText(event.target.value)} /></label>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </EditorDialog>;
}

function ConditionDialog({ condition, onClose, onApply, onRemove }: { condition?: ConditionExpression | undefined; onClose: () => void; onApply: (condition: ConditionExpression) => void; onRemove?: (() => void) | undefined }) {
  const [text, setText] = useState(JSON.stringify(condition ?? defaultCondition(), null, 2));
  const [error, setError] = useState<string | null>(null);
  function submit() {
    const parsed = parseConditionText(text);
    if (parsed.error || !parsed.value) return setError(parsed.error ?? "条件不能为空");
    onApply(parsed.value);
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="modal condition-modal" role="dialog" aria-modal="true" aria-label="编辑边条件">
      <div className="modal-header"><h2>编辑边条件</h2><button className="icon-button subtle" title="关闭" onClick={onClose}><X size={18} /></button></div>
      <div className="modal-body form-stack"><label className="field"><span>条件表达式 JSON</span><textarea aria-label="条件表达式 JSON" rows={13} spellCheck={false} value={text} onChange={(event) => { setText(event.target.value); setError(null); }} /></label>{error && <p className="form-error" role="alert">{error}</p>}</div>
      <div className="modal-actions">{onRemove && <button className="button danger condition-remove" onClick={onRemove}><Trash2 size={15} />移除条件</button>}<button className="button secondary" onClick={onClose}>取消</button><button className="button primary" onClick={submit}><Check size={16} />应用到草稿</button></div>
    </div>
  </div>;
}

function BatchNodeDialog({ graph, initialNodeId, onClose, onApply }: { graph: SkillGraph; initialNodeId: string | null; onClose: () => void; onApply: (nodeIds: string[], patch: BatchNodePatch) => void }) {
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>(initialNodeId ? [initialNodeId] : []);
  const [updateKind, setUpdateKind] = useState(false);
  const [kind, setKind] = useState<GraphNodeKind>(graph.capability === "content-only" ? "knowledge" : "step");
  const [descriptionMode, setDescriptionMode] = useState<"keep" | "set" | "clear">("keep");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleNodes = graph.nodes.filter((node) => !normalizedQuery || `${node.title} ${node.id}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
  const selectedSet = new Set(selectedIds);
  const kinds = graph.capability === "content-only" ? ["knowledge" as const] : workflowNodeKinds;

  function toggle(nodeId: string) {
    setSelectedIds((current) => current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId]);
    setError(null);
  }
  function submit() {
    if (!selectedIds.length) return setError("至少选择一个节点");
    if (!updateKind && descriptionMode === "keep") return setError("至少选择一个要批量修改的字段");
    if (descriptionMode === "set" && !description.trim()) return setError("统一说明不能为空；如需清空请选择“清空说明”");
    const patch: BatchNodePatch = {};
    if (updateKind) patch.kind = kind;
    if (descriptionMode === "set") patch.description = description.trim();
    if (descriptionMode === "clear") patch.description = null;
    onApply(selectedIds, patch);
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="modal graph-batch-modal" role="dialog" aria-modal="true" aria-label="批量编辑节点">
      <div className="modal-header"><div><h2>批量编辑节点</h2><span>已选择 {selectedIds.length} 个节点</span></div><button className="icon-button subtle" title="关闭" onClick={onClose}><X size={18} /></button></div>
      <div className="graph-batch-body">
        <section className="graph-batch-picker">
          <div className="search-shell"><Search size={15} /><input aria-label="搜索批量节点" placeholder="搜索标题或 ID" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <div className="graph-batch-select-actions"><button onClick={() => setSelectedIds([...new Set([...selectedIds, ...visibleNodes.map((node) => node.id)])])}>选择搜索结果</button><button onClick={() => setSelectedIds([])}>清空</button></div>
          <div className="graph-batch-list" role="group" aria-label="批量节点列表">{visibleNodes.map((node) => <label key={node.id}><input type="checkbox" checked={selectedSet.has(node.id)} onChange={() => toggle(node.id)} /><span><strong>{node.title}</strong><code>{node.id}</code></span><small>{kindLabel(node.kind)}</small></label>)}</div>
        </section>
        <section className="graph-batch-fields">
          <label className="batch-field-toggle"><input type="checkbox" checked={updateKind} onChange={(event) => setUpdateKind(event.target.checked)} /><span>更新节点类型</span></label>
          <label className="field"><span>统一类型</span><select aria-label="批量节点类型" disabled={!updateKind} value={kind} onChange={(event) => setKind(event.target.value as GraphNodeKind)}>{kinds.map((item) => <option key={item} value={item}>{kindLabel(item)}</option>)}</select></label>
          <label className="field"><span>节点说明</span><select aria-label="批量节点说明操作" value={descriptionMode} onChange={(event) => setDescriptionMode(event.target.value as "keep" | "set" | "clear")}><option value="keep">保留原说明</option><option value="set">统一设置说明</option><option value="clear">清空说明</option></select></label>
          {descriptionMode === "set" && <label className="field"><span>统一说明内容</span><textarea aria-label="批量节点说明" rows={6} value={description} onChange={(event) => setDescription(event.target.value)} /></label>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </section>
      </div>
      <div className="modal-actions"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" onClick={submit}><ListChecks size={16} />应用到草稿</button></div>
    </div>
  </div>;
}

function GraphLintPanel({ issues, onLocate, onRepair }: { issues: GraphLintIssue[]; onLocate: (issue: GraphLintIssue) => void; onRepair: (issue: GraphLintIssue) => void }) {
  return <section className="graph-lint-panel" aria-label="图谱问题面板">
    <header><strong>持续检查</strong><span>{issues.length} 项</span></header>
    <div>{issues.map((issue, index) => <article key={`${issue.path}-${issue.code}-${index}`} className={issue.severity}>
      <AlertTriangle size={14} />
      <button className="graph-lint-copy" title={`定位问题 ${issue.path}`} onClick={() => onLocate(issue)}><code>{issue.path}</code><span>{issue.message}</span></button>
      <button className="icon-button subtle" title={`定位问题 ${issue.path}`} aria-label={`定位问题 ${issue.path}`} onClick={() => onLocate(issue)}><LocateFixed size={14} /></button>
      {issue.code === "self_loop" && <button className="icon-button subtle repair" title="移除自环到草稿" aria-label="移除自环到草稿" onClick={() => onRepair(issue)}><Wrench size={14} /></button>}
    </article>)}</div>
  </section>;
}

function EditorDialog({ title, submitLabel, onClose, onSubmit, children }: { title: string; submitLabel: string; onClose: () => void; onSubmit: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-header"><h2>{title}</h2><button className="icon-button subtle" title="关闭" onClick={onClose}><X size={18} /></button></div>
      <div className="modal-body"><div className="form-stack compact">{children}</div></div>
      <div className="modal-actions"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" onClick={onSubmit}><Plus size={16} />{submitLabel}</button></div>
    </div>
  </div>;
}

export function GraphDiffPreview({ preview }: { preview: GraphChangePreview }) {
  const groups = [
    ["新增节点", preview.addedNodeIds, "added"],
    ["修改节点", preview.updatedNodeIds, "updated"],
    ["删除节点", preview.removedNodeIds, "removed"],
    ["新增边", preview.addedEdgeIds, "added"],
    ["修改边", preview.updatedEdgeIds, "updated"],
    ["删除边", preview.removedEdgeIds, "removed"]
  ] as const;
  return <div className="graph-diff-preview">
    <div className="graph-diff-metrics">
      <span>节点 {preview.before.nodes.length} → {preview.after.nodes.length}</span>
      <span>边 {preview.before.edges.length} → {preview.after.edges.length}</span>
      <span>{preview.lint.length ? `${preview.lint.length} 个提示` : "Lint 通过"}</span>
    </div>
    <div className="graph-diff-groups">
      {groups.map(([label, ids, tone]) => <section key={label} className={tone}><div><strong>{label}</strong><span>{ids.length}</span></div>{ids.length ? <ul>{ids.map((id) => <li key={id}><code title={id}>{id}</code></li>)}</ul> : <p>无</p>}</section>)}
    </div>
  </div>;
}

function graphOperations(before: SkillGraph, after: SkillGraph): GraphChangeOperation[] {
  const diff = diffGraph(before, after);
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  return [
    ...diff.removedEdgeIds.map((target): GraphChangeOperation => ({ op: "graph.edge.delete", target })),
    ...diff.removedNodeIds.map((target): GraphChangeOperation => ({ op: "graph.node.delete", target })),
    ...diff.updatedNodeIds.map((target): GraphChangeOperation => ({ op: "graph.node.update", target, value: afterNodes.get(target)! })),
    ...diff.addedNodeIds.map((target): GraphChangeOperation => ({ op: "graph.node.create", target, value: afterNodes.get(target)! })),
    ...diff.updatedEdgeIds.map((target): GraphChangeOperation => ({ op: "graph.edge.update", target, value: afterEdges.get(target)! })),
    ...diff.addedEdgeIds.map((target): GraphChangeOperation => ({ op: "graph.edge.create", target, value: afterEdges.get(target)! }))
  ];
}

function graphReason(operations: GraphChangeOperation[]): string {
  const nodes = operations.filter((operation) => operation.op.startsWith("graph.node.")).length;
  const edges = operations.length - nodes;
  return `页面编辑图谱：${nodes} 个节点操作，${edges} 个边操作`;
}

function nextEdgeId(graph: SkillGraph, from: string, to: string): string {
  const slug = (value: string) => value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || "node";
  const stem = `edge.${slug(from)}-${slug(to)}`.slice(0, 118).replace(/-+$/gu, "");
  let candidate = stem;
  let sequence = 2;
  while (graph.edges.some((edge) => edge.id === candidate)) {
    candidate = `${stem.slice(0, 118 - String(sequence).length)}-${sequence}`;
    sequence += 1;
  }
  return candidate;
}

function defaultCondition(): ConditionExpression {
  return { op: "equals", left: { kind: "ref", path: "skill.approved" }, right: { kind: "literal", value: true } };
}

function parseConditionText(text: string): { value?: ConditionExpression; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "条件必须是有效 JSON" };
  }
  const issues = validateCondition(parsed);
  if (issues.length) return { error: `${issues[0]!.path}：${issues[0]!.message}` };
  return { value: parsed as ConditionExpression, error: null };
}

function conditionLabel(condition: ConditionExpression): string {
  return { boolean: "布尔值", not: "否定", equals: "相等", notEquals: "不相等", contains: "包含", and: "全部满足", or: "任一满足" }[condition.op];
}

type GraphLintTarget = { kind: "node" | "edge"; id: string };

function graphLintTarget(graph: SkillGraph, issue: GraphLintIssue): GraphLintTarget | null {
  const nodeIndex = issue.path.match(/^nodes\[(\d+)\]/u);
  if (nodeIndex) {
    const node = graph.nodes[Number(nodeIndex[1])];
    return node ? { kind: "node", id: node.id } : null;
  }
  if (issue.path.startsWith("nodes.")) {
    const id = issue.path.slice("nodes.".length);
    return graph.nodes.some((node) => node.id === id) ? { kind: "node", id } : null;
  }
  const edgeIndex = issue.path.match(/^edges\[(\d+)\]/u);
  if (edgeIndex) {
    const edge = graph.edges[Number(edgeIndex[1])];
    return edge ? { kind: "edge", id: edge.id } : null;
  }
  return null;
}

function graphLintFieldId(path: string, targetKind?: "node" | "edge"): string | null {
  const field = path.match(/\.([A-Za-z]+)$/u)?.[1];
  if (targetKind === "node") {
    if (field === "id") return "graph-node-id";
    if (field === "kind") return "graph-node-kind";
    if (field === "doc" || field === "docAnchor") return "graph-node-doc";
    return "graph-node-title";
  }
  if (targetKind === "edge") {
    if (field === "from") return "graph-edge-from";
    if (field === "to") return "graph-edge-to";
    if (field === "kind") return "graph-edge-kind";
    if (field?.startsWith("condition") || path.includes(".condition")) return "graph-edge-condition";
    return "graph-edge-id";
  }
  return null;
}

function kindLabel(kind: GraphNodeKind): string {
  return { start: "开始", end: "结束", step: "步骤", decision: "判断", gate: "闸门", lookup: "联查", dispatcher: "调度", action: "执行", terminal: "终点", knowledge: "知识" }[kind];
}

function edgeKindLabel(kind: GraphEdgeKind): string {
  return { flow: "流程", condition: "条件", back: "回退", continue: "继续", knowledge: "知识关系" }[kind];
}

function edgeKindColor(kind: GraphEdgeKind): string {
  return { flow: "#6e7781", condition: "#bf8700", back: "#99a1aa", continue: "#8250df", knowledge: "#5f7f93" }[kind];
}

function nodeKindColor(kind: GraphNodeKind): string {
  return { start: "#1a7f37", end: "#57606a", step: "#316dca", decision: "#bf8700", gate: "#d1242f", lookup: "#6e7781", dispatcher: "#8250df", action: "#bc4c00", terminal: "#1a7f37", knowledge: "#0969da" }[kind];
}

function relationCountLabel(active: GraphEdgeKind[], available: GraphEdgeKind[]): string {
  const selected = active.filter((kind) => available.includes(kind)).length;
  return selected === available.length ? String(available.length) : `${selected}/${available.length}`;
}

function shortRevision(revision: string): string {
  return revision.length > 20 ? `${revision.slice(0, 20)}…` : revision;
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError || cause instanceof Error) return cause.message;
  return "图谱操作失败";
}
