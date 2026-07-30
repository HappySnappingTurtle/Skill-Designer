import { Focus, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import ForceGraph3D from "react-force-graph-3d";
import { CanvasTexture, LinearFilter, Sprite, SpriteMaterial } from "three";
import { graphNodeTypeRegistry, type GraphEdge, type GraphEdgeKind, type GraphNode, type GraphNodeKind, type SkillGraph, type TraceNodeState } from "@skill-designer/engine";

export type GraphViewMode = "3d" | "2d";
export type GraphTheme = "light" | "dark";
export type GraphNodeChangeState = "added" | "modified";

export interface SkillGraphCanvasHandle {
  focusNode(nodeId: string): void;
  focusEdge(edgeId: string): void;
  fitGraph(): void;
  exitFocus(): void;
  setMode(mode: GraphViewMode): void;
  setTheme(theme: GraphTheme): void;
  mode(): GraphViewMode;
  theme(): GraphTheme;
}

interface Props {
  graph: SkillGraph;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  query: string;
  kindFilter: GraphNodeKind | "all";
  planeFilter?: "all" | "flow" | "knowledge";
  edgeKindFilter: GraphEdgeKind | GraphEdgeKind[] | "all";
  largeGraph: boolean;
  embeddedControls?: boolean;
  onSelectNode: (nodeId: string) => void;
  onSelectEdge: (edgeId: string) => void;
  onClearSelection: () => void;
  onModeChange?: (mode: GraphViewMode) => void;
  onThemeChange?: (theme: GraphTheme) => void;
  onKindFilterChange?: (kind: GraphNodeKind | "all") => void;
  traceNodeStates?: Record<string, TraceNodeState>;
  traceTraversedEdgeIds?: string[];
  traceMissingNodeIds?: string[];
  changeNodeStates?: Record<string, GraphNodeChangeState>;
  fitPadding?: number;
  embeddedTitle?: string;
}

interface GraphNodeDatum extends GraphNode {
  degree: number;
  x?: number;
  y?: number;
  z?: number;
}

interface GraphLinkDatum extends GraphEdge {
  source: string | GraphNodeDatum;
  target: string | GraphNodeDatum;
}

const nodeColors: Record<GraphNodeKind, string> = {
  start: "#1a7f37",
  end: "#57606a",
  step: "#316dca",
  decision: "#bf8700",
  gate: "#d1242f",
  lookup: "#6e7781",
  dispatcher: "#8250df",
  action: "#bc4c00",
  terminal: "#1a7f37",
  knowledge: "#0969da"
};

const edgeColors: Record<GraphEdgeKind, string> = {
  flow: "#6e7781",
  condition: "#bf8700",
  back: "#99a1aa",
  continue: "#8250df",
  knowledge: "#5f7f93"
};
const MAX_2D_FIT_ZOOM = 3.2;
const ORIGINAL_3D_FIT_DISTANCE_SCALE = 0.48;

const legendNodeKinds: GraphNodeKind[] = [...graphNodeTypeRegistry]
  .sort((left, right) => left.legendOrder - right.legendOrder)
  .map((item) => item.kind);

const graphThemes = {
  light: { label: "#2a3340", labelBg: "rgba(255,255,255,0.82)", nodeStroke: "rgba(255,255,255,0.85)", faded: "#e3e7eb", ring: "#1f2328", dimAlpha: 0.14, dimBackground: "#eef1f6" },
  dark: { label: "#cdd6e0", labelBg: "rgba(10,14,22,0.72)", nodeStroke: "rgba(0,0,0,0.35)", faded: "#1a2030", ring: "#f0f6fc", dimAlpha: 0.10, dimBackground: "#0b101c" }
} as const;

export const SkillGraphCanvas = forwardRef<SkillGraphCanvasHandle, Props>(function SkillGraphCanvas({
  graph,
  selectedNodeId,
  selectedEdgeId,
  kindFilter,
  planeFilter = "all",
  edgeKindFilter,
  largeGraph,
  embeddedControls = true,
  onSelectNode,
  onSelectEdge,
  onClearSelection,
  onModeChange,
  onThemeChange,
  onKindFilterChange,
  traceNodeStates,
  traceTraversedEdgeIds = [],
  traceMissingNodeIds = [],
  changeNodeStates = {},
  fitPadding,
  embeddedTitle
}, forwardedRef) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const graph2DRef = useRef<any>(null);
  const graph3DRef = useRef<any>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [mode, setMode] = useState<GraphViewMode>(() => initialMode());
  const [theme, setTheme] = useState<GraphTheme>(() => initialTheme());
  const [focusRootId, setFocusRootId] = useState<string | null>(null);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [settledMode, setSettledMode] = useState<GraphViewMode | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [embeddedQuery, setEmbeddedQuery] = useState("");
  const [paintReady, setPaintReady] = useState(false);
  const clickRef = useRef({ nodeId: "", at: 0 });
  const backgroundClickRef = useRef(0);
  const fittedKeyRef = useRef("");
  const previousFocusRef = useRef<string | null>(null);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.max(1, Math.floor(entry.contentRect.width));
      const height = Math.max(1, Math.floor(entry.contentRect.height));
      setSize((current) => current.width === width && current.height === height ? current : { width, height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setFocusRootId(null);
  }, [graph.skillId]);

  useEffect(() => onModeChange?.(mode), [mode, onModeChange]);
  useEffect(() => onThemeChange?.(theme), [theme, onThemeChange]);
  useEffect(() => {
    setPaintReady(false);
    const timer = window.setTimeout(() => setPaintReady(true), 120);
    return () => window.clearTimeout(timer);
  }, [mode, graph.skillId]);

  const neighbors = useMemo(() => {
    const result = new Map<string, Set<string>>(graph.nodes.map((node) => [node.id, new Set([node.id])]));
    for (const edge of graph.edges) {
      result.get(edge.from)?.add(edge.to);
      result.get(edge.to)?.add(edge.from);
    }
    return result;
  }, [graph]);

  const focusSet = useMemo(() => {
    if (!focusRootId) return null;
    const result = new Set([focusRootId]);
    let frontier = [focusRootId];
    for (let depth = 0; depth < 2; depth += 1) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const adjacent of neighbors.get(nodeId) ?? []) {
          if (result.has(adjacent)) continue;
          result.add(adjacent);
          next.push(adjacent);
        }
      }
      frontier = next;
    }
    return result;
  }, [focusRootId, neighbors]);

  useEffect(() => {
    if (previousFocusRef.current === focusRootId) return;
    previousFocusRef.current = focusRootId;
    const timer = window.setTimeout(() => {
      if (mode === "2d") fit2DGraph(600, focusRootId ? 90 : 70);
      else fit3DGraph(600, focusRootId ? 90 : 70);
    }, 650);
    return () => window.clearTimeout(timer);
  }, [focusRootId, mode]);

  const graphData = useMemo(() => {
    const degree = new Map<string, number>();
    for (const edge of graph.edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    const nodes: GraphNodeDatum[] = graph.nodes
      .filter((node) => kindFilter === "all" || node.kind === kindFilter)
      .filter((node) => planeFilter === "all" || (planeFilter === "knowledge" ? node.kind === "knowledge" : node.kind !== "knowledge"))
      .filter((node) => !focusSet || focusSet.has(node.id))
      .map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 }));
    const visible = new Set(nodes.map((node) => node.id));
    const links: GraphLinkDatum[] = graph.edges
      .filter((edge) => visible.has(edge.from) && visible.has(edge.to))
      .filter((edge) => edgeKindFilter === "all" || (Array.isArray(edgeKindFilter) ? edgeKindFilter.includes(edge.kind) : edge.kind === edgeKindFilter))
      .map((edge) => ({ ...edge, source: edge.from, target: edge.to }));
    return { nodes, links };
  }, [edgeKindFilter, focusSet, graph, kindFilter, planeFilter]);

  const nodesById = useMemo(() => new Map(graphData.nodes.map((node) => [node.id, node])), [graphData.nodes]);
  const traversedEdgeIds = useMemo(() => new Set(traceTraversedEdgeIds), [traceTraversedEdgeIds]);
  const missingNodeIds = useMemo(() => new Set(traceMissingNodeIds), [traceMissingNodeIds]);

  useEffect(() => {
    if (mode !== "3d" || largeGraph || size.width <= 0 || size.height <= 0) return;
    const timer = window.setTimeout(() => fit3DGraph(700, fitPadding ?? 80), 650);
    return () => window.clearTimeout(timer);
  }, [fitPadding, graphData, largeGraph, mode, size.height, size.width]);

  useEffect(() => {
    setSettledMode(null);
    const timer = window.setTimeout(() => {
      const instance = mode === "2d" ? graph2DRef.current : graph3DRef.current;
      if (!instance) return;
      const charge = instance?.d3Force?.("charge");
      const link = instance?.d3Force?.("link");
      charge?.strength?.(largeGraph ? -55 : mode === "3d" ? -210 : -190);
      link?.distance?.(largeGraph ? 32 : (edge: GraphLinkDatum) => mode === "3d" ? edge.kind === "flow" ? 82 : 62 : edge.kind === "flow" ? 75 : 50);

      instance?.d3ReheatSimulation?.();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [edgeKindFilter, focusRootId, graph.skillId, graphData, kindFilter, largeGraph, mode, planeFilter]);

  function nodeInContext(node: GraphNodeDatum): boolean {
    const contextNodeId = hoveredNodeId ?? selectedNodeId;
    if (!contextNodeId) return true;
    return node.id === contextNodeId || Boolean(neighbors.get(contextNodeId)?.has(node.id));
  }

  function linkInContext(link: GraphLinkDatum): boolean {
    if (link.id === selectedEdgeId) return true;
    const contextNodeId = hoveredNodeId ?? selectedNodeId;
    if (!contextNodeId) return true;
    return endpointId(link.source) === contextNodeId || endpointId(link.target) === contextNodeId;
  }

  function visualState(nodeId: string): TraceNodeState | "missing" | null {
    if (missingNodeIds.has(nodeId)) return "missing";
    return traceNodeStates?.[nodeId] ?? null;
  }

  function focusNode(nodeId: string) {
    const node = nodesById.get(nodeId);
    if (!node || typeof node.x !== "number" || typeof node.y !== "number") return;
    if (mode === "2d") {
      graph2DRef.current?.centerAt(node.x, node.y, 550);
      graph2DRef.current?.zoom(2.4, 550);
      return;
    }
    const z = node.z ?? 0;
    const distance = Math.hypot(node.x, node.y, z) || 1;
    const ratio = 1 + 150 / distance;
    graph3DRef.current?.cameraPosition(
      { x: node.x * ratio, y: node.y * ratio, z: z * ratio },
      { x: node.x, y: node.y, z },
      900
    );
  }

  function focusEdge(edgeId: string) {
    const edge = graphData.links.find((candidate) => candidate.id === edgeId);
    if (!edge) return;
    const source = nodesById.get(endpointId(edge.source));
    const target = nodesById.get(endpointId(edge.target));
    if (!source || !target || typeof source.x !== "number" || typeof target.x !== "number" || typeof source.y !== "number" || typeof target.y !== "number") return;
    const midpoint = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2, z: ((source.z ?? 0) + (target.z ?? 0)) / 2 };
    if (mode === "2d") {
      graph2DRef.current?.centerAt(midpoint.x, midpoint.y, 500);
      graph2DRef.current?.zoom(1.3, 500);
    } else {
      graph3DRef.current?.cameraPosition({ x: midpoint.x, y: midpoint.y, z: midpoint.z + 170 }, midpoint, 650);
    }
  }

  function fitGraph() {
    if (mode === "2d") {
      fit2DGraph(600, fitPadding ?? 60);
    } else {
      fit3DGraph(600, fitPadding ?? 60);
    }
  }

  function fit3DGraph(duration: number, padding: number) {
    const instance = graph3DRef.current;
    if (!instance) return;
    instance.zoomToFit(duration, padding);
    if (largeGraph || graphData.nodes.length < 12) return;
    window.setTimeout(() => {
      const camera = instance.camera?.();
      const target = instance.controls?.()?.target;
      if (!camera?.position || !target) return;
      instance.cameraPosition({
        x: target.x + (camera.position.x - target.x) * ORIGINAL_3D_FIT_DISTANCE_SCALE,
        y: target.y + (camera.position.y - target.y) * ORIGINAL_3D_FIT_DISTANCE_SCALE,
        z: target.z + (camera.position.z - target.z) * ORIGINAL_3D_FIT_DISTANCE_SCALE
      }, { x: target.x, y: target.y, z: target.z }, 220);
    }, duration + 30);
  }

  function fit2DGraph(duration: number, padding: number) {
    const instance = graph2DRef.current;
    if (!instance) return;
    instance.zoomToFit(duration, padding);
    window.setTimeout(() => {
      const fittedZoom = instance.zoom?.();
      if (typeof fittedZoom === "number" && fittedZoom > MAX_2D_FIT_ZOOM) {
        instance.zoom(MAX_2D_FIT_ZOOM, 220);
      }
    }, duration + 20);
  }

  function changeTheme(nextTheme: GraphTheme) {
    setTheme(nextTheme);
    localStorage.setItem("skill-designer.graph-theme", nextTheme);
  }

  useImperativeHandle(forwardedRef, () => ({
    focusNode,
    focusEdge,
    fitGraph,
    exitFocus: () => setFocusRootId(null),
    setMode: changeMode,
    setTheme: changeTheme,
    mode: () => mode,
    theme: () => theme
  }));

  function changeMode(nextMode: GraphViewMode) {
    if (nextMode === mode) return;
    if (nextMode === "3d" && !supportsWebgl()) {
      setWebglError("当前设备无法初始化 WebGL，已保留 2D 平面模式");
      setMode("2d");
      return;
    }
    setWebglError(null);
    setHoveredNodeId(null);
    setMode(nextMode);
    localStorage.setItem("skill-designer.graph-mode", nextMode);
  }

  function handleNodeClick(node: GraphNodeDatum) {
    const now = Date.now();
    if (clickRef.current.nodeId === node.id && now - clickRef.current.at < 360) {
      setFocusRootId(node.id);
      clickRef.current = { nodeId: "", at: 0 };
      return;
    }
    clickRef.current = { nodeId: node.id, at: now };
    onSelectNode(node.id);
    if (mode === "2d") graph2DRef.current?.centerAt(node.x, node.y, 600);
    else focusNode(node.id);
  }

  function handleBackgroundClick() {
    const now = Date.now();
    if (focusRootId && now - backgroundClickRef.current < 360) {
      backgroundClickRef.current = 0;
      setFocusRootId(null);
      return;
    }
    backgroundClickRef.current = now;
    onClearSelection();
  }

  const focusTitle = focusRootId ? graph.nodes.find((node) => node.id === focusRootId)?.title ?? focusRootId : "";
  // The source viewer keeps a viewport-height canvas below its 46px toolbar.
  const graphHeight = embeddedControls ? size.height : size.height + 46;

  function locateEmbeddedNode() {
    const normalized = embeddedQuery.trim().toLocaleLowerCase();
    if (!normalized) return;
    const node = graphData.nodes.find((candidate) => candidate.id.toLocaleLowerCase().includes(normalized) || candidate.title.toLocaleLowerCase().includes(normalized));
    if (!node) return;
    onSelectNode(node.id);
    window.setTimeout(() => focusNode(node.id), 30);
  }

  return <div
    className={`skill-force-graph mode-${mode} theme-${theme} ${paintReady ? "is-ready" : ""} ${embeddedControls ? "with-embedded-toolbar" : ""}`}
    ref={hostRef}
    data-graph-mode={mode}
    data-render-state={settledMode === mode ? "settled" : "simulating"}
    data-node-count={graphData.nodes.length}
    data-edge-count={graphData.links.length}
  >
    {embeddedControls && <div className="graph-embedded-toolbar">
      <strong title={embeddedTitle ?? `${graph.skillId} 知识图谱`}>{embeddedTitle ?? `${graph.skillId} 知识图谱`}</strong>
      <input aria-label="搜索图节点" autoComplete="off" placeholder="搜索节点，Enter 定位" value={embeddedQuery} onChange={(event) => setEmbeddedQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") locateEmbeddedNode(); }} />
      <div className="graph-toolbar-segment" role="group" aria-label="图谱显示模式">
        <button className={mode === "3d" ? "active" : ""} aria-pressed={mode === "3d"} onClick={() => changeMode("3d")}>3D 立体</button>
        <button className={mode === "2d" ? "active" : ""} aria-pressed={mode === "2d"} onClick={() => changeMode("2d")}>2D 平面</button>
      </div>
      <button className="graph-embedded-theme" title="深浅主题切换" aria-label="深浅主题切换" onClick={() => changeTheme(theme === "light" ? "dark" : "light")}>🌓</button>
      <button className="graph-embedded-fit" title="适应全图" aria-label="适应全图" onClick={fitGraph}>↗ 适应</button>
    </div>}
    <div className="graph-render-surface" ref={canvasHostRef}>
      {focusRootId && <div className="graph-focus-bar"><Focus size={14} /><span>聚焦：<strong>{focusTitle}</strong> 的两跳邻域</span><button title="退出聚焦" aria-label="退出两跳聚焦" onClick={() => setFocusRootId(null)}><X size={14} /></button></div>}
      {webglError && <div className="graph-webgl-warning" role="status">{webglError}</div>}
    {size.width > 0 && size.height > 0 && mode === "2d" && <ForceGraph2D<GraphNodeDatum, GraphLinkDatum>
      ref={graph2DRef}
      width={size.width}
      height={graphHeight}
      graphData={graphData}
      nodeId="id"
      linkSource="source"
      linkTarget="target"
      backgroundColor="rgba(0,0,0,0)"
      nodeLabel={() => ""}
      nodeCanvasObject={(node, context, scale) => draw2DNode(node, context, scale, theme, {
        selected: node.id === selectedNodeId,
        dimmed: !nodeInContext(node),
        showLabel: !largeGraph || scale >= 1.15 || node.id === selectedNodeId,
        traceState: visualState(node.id),
        ...(changeNodeStates[node.id] ? { changeState: changeNodeStates[node.id] } : {})
      })}
      nodePointerAreaPaint={(node, color, context) => {
        const radius = nodeRadius(node);
        context.fillStyle = color;
        context.beginPath();
        context.arc(node.x ?? 0, node.y ?? 0, radius + 5, 0, Math.PI * 2);
        context.fill();
      }}
      linkColor={(link) => traversedEdgeIds.has(link.id) ? "#238362" : linkColor(link, selectedEdgeId, linkInContext(link), theme, "2d", Boolean(hoveredNodeId ?? selectedNodeId))}
      linkWidth={(link) => traversedEdgeIds.has(link.id) ? 2.4 : link.id === selectedEdgeId ? 1.7 : selectedNodeId && linkInContext(link) ? 1.7 : 0.7}
      linkLineDash={(link) => isForwardEdge(link.kind) ? null : link.kind === "back" ? [2, 3] : [4, 3]}
      linkCurvature={(link) => isForwardEdge(link.kind) ? 0 : link.kind === "back" ? 0.25 : 0.15}
      linkDirectionalArrowLength={(link) => isForwardEdge(link.kind) ? 3.5 : 0}
      linkDirectionalArrowRelPos={0.9}
      linkDirectionalParticles={(link) => !largeGraph && isForwardEdge(link.kind) ? 2 : 0}
      linkDirectionalParticleWidth={2}
      linkDirectionalParticleSpeed={0.0045}
      linkDirectionalParticleColor={(link) => edgeColors[link.kind]}
      linkLabel={(link) => `${edgeKindLabel(link.kind)}${link.label ? ` · ${link.label}` : ""}`}
      onNodeClick={(node) => handleNodeClick(node)}
      onNodeHover={(node) => {
        setHoveredNodeId(node?.id ?? null);
        if (hostRef.current) hostRef.current.style.cursor = node ? "pointer" : "";
      }}
      onLinkClick={(link) => onSelectEdge(link.id)}
      onNodeDragEnd={(node) => { delete node.fx; delete node.fy; }}
      onBackgroundClick={handleBackgroundClick}
      onEngineStop={() => {
        const fittedKey = `2d:${graph.skillId}:${graph.nodes.length}:${graph.edges.length}`;
        if (fittedKeyRef.current !== fittedKey) {
          fittedKeyRef.current = fittedKey;
          fit2DGraph(500, fitPadding ?? 70);
        }
        window.setTimeout(() => setSettledMode("2d"), 760);
      }}
      {...(largeGraph
        ? { warmupTicks: 40, cooldownTicks: 70, cooldownTime: 0, d3AlphaDecay: 0.08, d3VelocityDecay: 0.28 }
        : { cooldownTime: 12_000, d3AlphaDecay: 0.02, d3VelocityDecay: 0.25 })}
      minZoom={0.02}
      maxZoom={30}
    />}
    {size.width > 0 && size.height > 0 && mode === "3d" && <ForceGraph3D<GraphNodeDatum, GraphLinkDatum>
      ref={graph3DRef}
      width={size.width}
      height={graphHeight}
      graphData={graphData}
      nodeId="id"
      linkSource="source"
      linkTarget="target"
      backgroundColor="rgba(0,0,0,0)"
      showNavInfo={false}
      rendererConfig={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
      nodeLabel={() => ""}
      nodeThreeObject={(node) => makeNodeSprite(node, node.id === selectedNodeId, node.id === hoveredNodeId, nodeInContext(node), theme, largeGraph, visualState(node.id), changeNodeStates[node.id])}
      linkColor={(link) => traversedEdgeIds.has(link.id) ? "#238362" : linkColor(link, selectedEdgeId, linkInContext(link), theme, "3d", Boolean(hoveredNodeId ?? selectedNodeId))}
      linkWidth={(link) => traversedEdgeIds.has(link.id) ? 2.4 : link.id === selectedEdgeId ? 1.5 : selectedNodeId && linkInContext(link) ? 1.5 : 0.4}
      linkOpacity={0.85}
      linkCurvature={(link) => isForwardEdge(link.kind) ? 0 : 0.2}
      linkDirectionalArrowLength={(link) => isForwardEdge(link.kind) ? 3 : 0}
      linkDirectionalArrowRelPos={0.9}
      linkDirectionalParticles={(link) => !largeGraph && isForwardEdge(link.kind) ? 2 : 0}
      linkDirectionalParticleWidth={1.3}
      linkDirectionalParticleSpeed={0.0045}
      linkDirectionalParticleColor={(link) => edgeColors[link.kind]}
      linkLabel={(link) => `${edgeKindLabel(link.kind)}${link.label ? ` · ${link.label}` : ""}`}
      onNodeClick={(node) => handleNodeClick(node)}
      onNodeHover={(node) => {
        setHoveredNodeId(node?.id ?? null);
        if (hostRef.current) hostRef.current.style.cursor = node ? "pointer" : "";
      }}
      onLinkClick={(link) => onSelectEdge(link.id)}
      onBackgroundClick={handleBackgroundClick}
      onEngineStop={() => {
        const fittedKey = `3d:${graph.skillId}:${graph.nodes.length}:${graph.edges.length}`;
        if (fittedKeyRef.current !== fittedKey) {
          fittedKeyRef.current = fittedKey;
          fit3DGraph(700, fitPadding ?? 80);
        }
        window.setTimeout(() => setSettledMode("3d"), 680);
      }}
      {...(largeGraph
        ? { warmupTicks: 45, cooldownTicks: 75, cooldownTime: 0, d3AlphaDecay: 0.08 }
        : { cooldownTime: 11_000, d3AlphaDecay: 0.0228 })}
    />}
    <div className="graph-kind-legend" aria-label="节点类型图例">
      {legendNodeKinds.filter((kind) => graph.nodes.some((node) => node.kind === kind)).map((kind) => <button className={kindFilter !== "all" && kindFilter !== kind ? "off" : ""} key={kind} onClick={() => onKindFilterChange?.(kindFilter === kind ? "all" : kind)}><i style={{ backgroundColor: nodeColors[kind] }} />{kindLabel(kind)}</button>)}
    </div>
    </div>
  </div>;
});

function initialMode(): GraphViewMode {
  if (window.innerWidth <= 760) return "2d";
  const saved = localStorage.getItem("skill-designer.graph-mode");
  if (saved === "2d" || saved === "3d") return saved;
  return supportsWebgl() ? "3d" : "2d";
}

function initialTheme(): GraphTheme {
  return localStorage.getItem("skill-designer.graph-theme") === "dark" ? "dark" : "light";
}

function supportsWebgl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function endpointId(endpoint: string | GraphNodeDatum): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

function nodeRadius(node: GraphNodeDatum): number {
  return 2.5 + Math.sqrt(node.degree + 1) * 1.5;
}

function draw2DNode(
  node: GraphNodeDatum,
  context: CanvasRenderingContext2D,
  scale: number,
  themeName: GraphTheme,
  state: { selected: boolean; dimmed: boolean; showLabel: boolean; traceState: TraceNodeState | "missing" | null; changeState?: GraphNodeChangeState }
) {
  const graphTheme = graphThemes[themeName];
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const radius = nodeRadius(node);
  const color = nodeColors[node.kind];
  context.save();
  context.globalAlpha = state.dimmed ? graphTheme.dimAlpha : 1;
  const glow = context.createRadialGradient(x, y, radius * 0.3, x, y, radius * 2.1);
  glow.addColorStop(0, `${color}42`);
  glow.addColorStop(1, `${color}00`);
  context.fillStyle = glow;
  context.beginPath();
  context.arc(x, y, radius * 2.1, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = color;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.lineWidth = 0.7 / scale;
  context.strokeStyle = graphTheme.nodeStroke;
  context.stroke();
  if (state.selected) {
    context.beginPath();
    context.arc(x, y, radius + 2.6, 0, Math.PI * 2);
    context.lineWidth = 1.6 / scale;
    context.strokeStyle = graphTheme.ring;
    context.stroke();
  }
  if (state.changeState) {
    const badgeRadius = Math.max(1.6, radius * 0.4);
    context.beginPath();
    context.arc(x + radius * 0.8, y - radius * 0.8, badgeRadius, 0, Math.PI * 2);
    context.fillStyle = state.changeState === "added" ? "#2da44e" : "#bf8700";
    context.fill();
    context.lineWidth = 0.8 / scale;
    context.strokeStyle = "#ffffff";
    context.stroke();
  }
  const traceColor = traceStateColor(state.traceState);
  if (traceColor) {
    context.beginPath();
    context.arc(x, y, radius + (state.selected ? 5.8 : 3.2) / scale, 0, Math.PI * 2);
    context.lineWidth = (state.traceState === "current" || state.traceState === "rejected" ? 2.4 : 1.7) / scale;
    context.strokeStyle = traceColor;
    if (state.traceState === "missing") context.setLineDash([3 / scale, 2 / scale]);
    context.stroke();
    context.setLineDash([]);
  }
  if (state.showLabel && !state.dimmed) {
    const fontSize = 11 / Math.max(scale, 0.9);
    context.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    const width = context.measureText(node.title).width + 8 / scale;
    const height = fontSize * 1.5;
    const top = y + radius + 2.5 / scale;
    context.fillStyle = graphTheme.labelBg;
    context.beginPath();
    context.roundRect(x - width / 2, top, width, height, height / 2);
    context.fill();
    context.fillStyle = graphTheme.label;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(node.title, x, top + height / 2);
  }
  context.restore();
}

function makeNodeSprite(node: GraphNodeDatum, selected: boolean, hovered: boolean, active: boolean, themeName: GraphTheme, largeGraph: boolean, traceState: TraceNodeState | "missing" | null, changeState?: GraphNodeChangeState): Sprite {
  const graphTheme = graphThemes[themeName];
  const color = nodeColors[node.kind];
  const oversample = 2;
  const radius = (5 + Math.sqrt(node.degree + 1) * 2.3) * oversample;
  const glowRadius = radius * 2.1;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  const fontSize = (largeGraph && !selected ? 11.5 : 12.5) * oversample;
  const padding = 4 * oversample;
  context.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
  const textWidth = Math.ceil(context.measureText(node.title).width);
  const pillWidth = textWidth + 10 * oversample;
  const pillHeight = fontSize * 1.5;
  canvas.width = Math.ceil(Math.max(pillWidth, glowRadius * 2) + padding * 2);
  canvas.height = Math.ceil(glowRadius + radius + 5 * oversample + pillHeight + padding * 2);
  const cx = canvas.width / 2;
  const cy = padding + glowRadius;
  const glow = context.createRadialGradient(cx, cy, radius * 0.3, cx, cy, glowRadius);
  glow.addColorStop(0, `${color}4d`);
  glow.addColorStop(0.55, `${color}1a`);
  glow.addColorStop(1, `${color}00`);
  context.fillStyle = glow;
  context.beginPath();
  context.arc(cx, cy, glowRadius, 0, Math.PI * 2);
  context.fill();
  const dot = context.createRadialGradient(cx - radius * 0.35, cy - radius * 0.35, radius * 0.15, cx, cy, radius);
  dot.addColorStop(0, mixColor(color, "#ffffff", 0.28));
  dot.addColorStop(1, color);
  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  context.fillStyle = dot;
  context.fill();
  context.lineWidth = 1.4 * oversample;
  context.strokeStyle = graphTheme.nodeStroke;
  context.stroke();
  if (selected) {
    context.lineWidth = 2 * oversample;
    context.strokeStyle = graphTheme.ring;
    context.beginPath();
    context.arc(cx, cy, radius + 3.2 * oversample, 0, Math.PI * 2);
    context.stroke();
  }
  if (changeState) {
    const badgeX = cx + radius * 0.82;
    const badgeY = cy - radius * 0.82;
    const badgeRadius = Math.max(3 * oversample, radius * 0.34);
    context.beginPath();
    context.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
    context.fillStyle = changeState === "added" ? "#2da44e" : "#bf8700";
    context.fill();
    context.lineWidth = 1.2 * oversample;
    context.strokeStyle = "#ffffff";
    context.stroke();
  }
  const traceColor = traceStateColor(traceState);
  if (traceColor) {
    context.lineWidth = (traceState === "current" || traceState === "rejected" ? 2.4 : 1.7) * oversample;
    context.strokeStyle = traceColor;
    if (traceState === "missing") context.setLineDash([3 * oversample, 2 * oversample]);
    context.beginPath();
    context.arc(cx, cy, radius + (selected ? 6 : 3.2) * oversample, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);
  }
  const pillY = cy + radius + 5 * oversample;
  context.beginPath();
  context.roundRect(cx - pillWidth / 2, pillY, pillWidth, pillHeight, pillHeight / 2);
  context.fillStyle = graphTheme.labelBg;
  context.fill();
  context.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
  context.fillStyle = graphTheme.label;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(node.title, cx, pillY + pillHeight / 2 + oversample * 0.5);
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, opacity: active ? 1 : graphTheme.dimAlpha });
  const sprite = new Sprite(material);
  const scale = 0.235;
  const hoverScale = hovered ? 1.14 : 1;
  sprite.scale.set(canvas.width * scale / oversample * hoverScale, canvas.height * scale / oversample * hoverScale, 1);
  return sprite;
}

function linkColor(link: GraphLinkDatum, selectedEdgeId: string | null, inContext: boolean, themeName: GraphTheme, mode: GraphViewMode, hasContext: boolean): string {
  if (link.id === selectedEdgeId) return graphThemes[themeName].ring;
  if (hasContext) return inContext ? edgeColors[link.kind] : graphThemes[themeName].faded;
  return mode === "2d" ? `${edgeColors[link.kind]}73` : mixColor(edgeColors[link.kind], graphThemes[themeName].dimBackground, 0.42);
}

function mixColor(left: string, right: string, amount: number): string {
  const channels = (color: string) => [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  const from = channels(left);
  const to = channels(right);
  return `#${from.map((value, index) => Math.round(value + (to[index]! - value) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function traceStateColor(state: TraceNodeState | "missing" | null): string | null {
  if (!state || state === "unvisited") return null;
  return { visited: "#3b8067", current: "#16835e", rejected: "#b6423a", completed: "#2d759f", stopped: "#929d98", missing: "#a56b27" }[state];
}

function kindLabel(kind: GraphNodeKind): string {
  return { start: "开始", end: "结束", step: "步骤", decision: "判断", gate: "闸门", lookup: "联查", dispatcher: "调度", action: "执行", terminal: "终点", knowledge: "知识" }[kind];
}

function edgeKindLabel(kind: GraphEdgeKind): string {
  return { flow: "流程", condition: "条件", back: "回退", continue: "继续", knowledge: "知识关系" }[kind];
}

function isForwardEdge(kind: GraphEdgeKind): boolean {
  return kind === "flow" || kind === "condition" || kind === "continue";
}
