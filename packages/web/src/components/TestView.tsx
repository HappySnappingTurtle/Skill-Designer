import {
  AlertTriangle,
  ArrowRight,
  Bug,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  FlaskConical,
  Fingerprint,
  GitCompareArrows,
  LoaderCircle,
  MessageSquareText,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  ShieldAlert,
  Square,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  reduceTrace,
  compareTraceRuns,
  projectTraceAt,
  type ProjectRun,
  type ProjectRunView,
  type ProjectFactQueryResult,
  type RuntimeDialogSession,
  type RuntimeTraceEvent,
  type SandboxCapabilityReport,
  type SandboxSelfTestRecord,
  type SkillGraph,
  type TraceProjection,
  type TraceRunComparison,
  type WorkspaceMember
} from "@skill-designer/engine";
import { api, ApiError } from "../api";
import { BenchmarkCasesView } from "./BenchmarkCasesView";
import { BenchmarkRunsView } from "./BenchmarkRunsView";
import { BugReportModal } from "./BugReportModal";
import { SkillGraphCanvas, type GraphViewMode, type SkillGraphCanvasHandle } from "./SkillGraphCanvas";
import { SkillId } from "./SkillIdentity";

interface TestViewProps {
  workspaceId: string;
  skill: WorkspaceMember;
  onProjectChanged: () => Promise<void>;
  onOpenDiagnosis: () => void;
}

export function TestView(props: TestViewProps) {
  const [mode, setMode] = useState<"cases" | "runs" | "benchmark">("runs");
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [sandboxCapability, setSandboxCapability] = useState<SandboxCapabilityReport | null>(null);
  const [sandboxSelfTest, setSandboxSelfTest] = useState<SandboxSelfTestRecord | null>(null);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  useEffect(() => setMode("runs"), [props.skill.projectId]);

  async function loadSandboxCapabilities() {
    setSandboxBusy(true);
    setSandboxError(null);
    try {
      const [capability, selfTest] = await Promise.all([api.getSandboxCapabilities(), api.getSandboxSelfTest()]);
      setSandboxCapability(capability);
      setSandboxSelfTest(selfTest);
    } catch (cause) {
      setSandboxError(messageOf(cause));
    } finally {
      setSandboxBusy(false);
    }
  }

  async function runSandboxSelfTest() {
    setSandboxBusy(true);
    setSandboxError(null);
    try {
      const selfTest = await api.runSandboxSelfTest();
      setSandboxSelfTest(selfTest);
      setSandboxCapability(await api.getSandboxCapabilities());
    } catch (cause) {
      setSandboxError(messageOf(cause));
    } finally {
      setSandboxBusy(false);
    }
  }

  function openSandboxCapabilities() {
    setSandboxOpen(true);
    void loadSandboxCapabilities();
  }

  return <div className="test-workbench">
    <div className="test-mode-bar">
      <div className="test-skill-context"><span>{props.skill.displayName}</span><SkillId value={props.skill.skillId} className="test-skill-id" /></div>
      <div className="segmented-control" aria-label="测试工作台模式">
        <button className={mode === "cases" ? "selected" : ""} onClick={() => setMode("cases")}>用例编写</button>
        <button className={mode === "runs" ? "selected" : ""} onClick={() => setMode("runs")}>手动运行</button>
        <button className={mode === "benchmark" ? "selected" : ""} title="真实 Benchmark" onClick={() => setMode("benchmark")}>真实测试</button>
      </div>
      <button className={`icon-button sandbox-capability-button ${sandboxCapability?.readyForBenchmark ? "ready" : ""}`} title="查看沙箱能力" aria-label="查看沙箱能力" onClick={openSandboxCapabilities}><ShieldCheck size={17} /></button>
    </div>
    {mode === "cases" ? <BenchmarkCasesView {...props} /> : mode === "benchmark" ? <BenchmarkRunsView {...props} /> : <RuntimeView {...props} />}
    {sandboxOpen && <div className="modal-backdrop" role="presentation"><div className="modal sandbox-capability-modal" role="dialog" aria-modal="true" aria-labelledby="sandbox-capability-title">
      <div className="modal-header"><div><h2 id="sandbox-capability-title">沙箱能力</h2><span>Windows / macOS 统一隔离契约</span></div><button className="icon-button subtle" title="关闭" onClick={() => setSandboxOpen(false)}><X size={18} /></button></div>
      {sandboxBusy && !sandboxCapability ? <div className="sandbox-capability-loading"><LoaderCircle size={18} className="spin" />检测本机能力</div> : sandboxError ? <div className="sandbox-capability-error"><ShieldAlert size={17} />{sandboxError}</div> : sandboxCapability && <div className="sandbox-capability-body">
        <section className={`sandbox-capability-summary ${sandboxCapability.status}`}>
          {sandboxCapability.readyForBenchmark ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />}
          <div><span>{sandboxCapability.platform} · {sandboxCapability.arch}</span><strong>{sandboxCapability.readyForBenchmark ? "真实 Benchmark 沙箱已就绪" : sandboxStatusLabel(sandboxCapability.status)}</strong></div>
          <small>{formatTime(sandboxCapability.checkedAt)}</small>
        </section>
        <section className="sandbox-policy-grid" aria-label="强制沙箱策略">
          <div><span>文件</span><strong>输入只读 · 产物独立</strong><small>根文件系统只读，拒绝其他宿主路径</small></div>
          <div><span>网络</span><strong>{sandboxCapability.policy.network.mode === "none" ? "完全禁用" : "受控白名单"}</strong><small>模型请求由宿主 Provider 发起</small></div>
          <div><span>进程</span><strong>最多 {sandboxCapability.policy.process.maxProcesses}</strong><small>丢弃 capabilities，禁止提权</small></div>
          <div><span>资源</span><strong>{sandboxCapability.policy.resources.memoryMiB} MiB · {sandboxCapability.policy.resources.cpuCores} CPU</strong><small>{Math.round(sandboxCapability.policy.resources.timeoutMs / 1000)} 秒超时</small></div>
        </section>
        <section className={`sandbox-self-test ${sandboxSelfTest?.status ?? "not-run"}`} data-testid="sandbox-self-test">
          <header><div><ShieldCheck size={15} /><strong>隔离生命周期自检</strong></div><span>{sandboxSelfTest ? sandboxSelfTestStatusLabel(sandboxSelfTest.status) : "未运行"}</span></header>
          {sandboxSelfTest ? <><p>{sandboxSelfTest.reason}</p>{sandboxSelfTest.checks.length > 0 && <ul className="sandbox-checks">{sandboxSelfTest.checks.map((check) => <li key={check.id} className={check.status}><span />{check.message}</li>)}</ul>}<small>{sandboxSelfTest.selfTestId} · {formatTime(sandboxSelfTest.updatedAt)}</small></> : <p>尚无真实容器的文件、网络、取消和清理证据。</p>}
        </section>
        <section className="sandbox-backends"><header><span>后端评估</span><strong>{sandboxCapability.backends.length}</strong></header>{sandboxCapability.backends.map((backend) => <article key={backend.backendId}>
          <header><div><ShieldCheck size={15} /><strong>{backend.label}</strong></div><span className={`sandbox-backend-status ${backend.status}`}>{sandboxBackendStatusLabel(backend.status)}</span></header>
          <p>{backend.reason}</p>
          {backend.checks.length > 0 && <ul className="sandbox-checks">{backend.checks.map((check) => <li key={check.id} className={check.status}><span />{check.message}</li>)}</ul>}
          <ul className="sandbox-limitations">{backend.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        </article>)}</section>
      </div>}
      <div className="modal-actions"><button className="button secondary" onClick={() => setSandboxOpen(false)}>关闭</button><button className="button secondary" disabled={sandboxBusy} onClick={() => void loadSandboxCapabilities()}><RefreshCw size={16} />重新检测</button><button className="button primary" data-testid="run-sandbox-self-test" disabled={sandboxBusy} onClick={() => void runSandboxSelfTest()}>{sandboxBusy ? <LoaderCircle size={16} className="spin" /> : <ShieldCheck size={16} />}运行隔离自检</button></div>
    </div></div>}
  </div>;
}

function sandboxStatusLabel(status: SandboxCapabilityReport["status"]): string {
  return { ready: "真实 Benchmark 沙箱已就绪", degraded: "能力已检测，生命周期尚未验证", unavailable: "当前机器没有可用沙箱", unsupported: "当前平台不受支持" }[status];
}

function sandboxBackendStatusLabel(status: SandboxCapabilityReport["backends"][number]["status"]): string {
  return { ready: "可检测", degraded: "能力不足", unavailable: "不可用", unsupported: "不采用" }[status];
}

function sandboxSelfTestStatusLabel(status: SandboxSelfTestRecord["status"]): string {
  return { unavailable: "无法运行", running: "运行中", passed: "已通过", failed: "失败" }[status];
}

function RuntimeView({ workspaceId, skill, onProjectChanged, onOpenDiagnosis }: TestViewProps) {
  const [runs, setRuns] = useState<ProjectRun[]>([]);
  const [view, setView] = useState<ProjectRunView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestedNodeId, setRequestedNodeId] = useState("");
  const [startDialog, setStartDialog] = useState(false);
  const [variablesText, setVariablesText] = useState("{}");
  const [replaySeq, setReplaySeq] = useState<number | null>(null);
  const [replaySpeed, setReplaySpeed] = useState(700);
  const [playing, setPlaying] = useState(false);
  const [comparisonRunId, setComparisonRunId] = useState("");
  const [reportDialog, setReportDialog] = useState(false);
  const controlPanelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setView(null);
    setRuns([]);
    setError(null);
    setRequestedNodeId("");
    setReplaySeq(null);
    setPlaying(false);
    setComparisonRunId("");
    setReportDialog(false);
    void loadRuns();
  }, [skill.projectId]);

  useEffect(() => {
    const runId = view?.run.runId;
    if (!runId) return;
    const afterSeq = view.run.events.at(-1)?.seq ?? 0;
    return api.subscribeTrace(
      skill.projectId,
      runId,
      afterSeq,
      (page) => {
        if (page.events.length === 0) return;
        void api.getRun(skill.projectId, runId).then((updated) => {
          setView((current) => {
            if (current?.run.runId !== runId) return current;
            return { ...updated, ...(current.artifact ? { artifact: current.artifact } : {}) };
          });
          setRuns((items) => items.map((run) => run.runId === updated.run.runId ? updated.run : run));
        }).catch((cause) => setError(messageOf(cause)));
      },
      (cause) => setError(messageOf(cause))
    );
  }, [skill.projectId, view?.run.runId]);

  useEffect(() => {
    controlPanelRef.current?.scrollTo({ top: 0 });
  }, [view?.run.runId, view?.run.state.status]);

  useEffect(() => {
    if (!playing || replaySeq === null || !view) return;
    const latestSeq = view.run.events.at(-1)?.seq ?? 0;
    const timer = window.setInterval(() => {
      setReplaySeq((current) => {
        if (current === null) return null;
        const nextEvent = view.run.events.find((event) => event.seq > current);
        if (!nextEvent || current >= latestSeq) {
          setPlaying(false);
          return current;
        }
        return nextEvent.seq;
      });
    }, replaySpeed);
    return () => window.clearInterval(timer);
  }, [playing, replaySeq, replaySpeed, view?.run.runId, view?.run.events]);

  async function loadRuns() {
    setLoading(true);
    setError(null);
    try {
      const items = await api.listRuns(skill.projectId);
      setRuns(items);
      if (items[0]) setView(await api.getRun(skill.projectId, items[0].runId));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  async function openRun(runId: string) {
    setLoading(true);
    setError(null);
    try {
      setView(await api.getRun(skill.projectId, runId));
      setRequestedNodeId("");
      setReplaySeq(null);
      setPlaying(false);
      setComparisonRunId("");
      setReportDialog(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  async function startRun() {
    let initialVariables: Record<string, unknown>;
    try {
      const parsed = JSON.parse(variablesText) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      initialVariables = parsed as Record<string, unknown>;
    } catch {
      setError("初始变量必须是 JSON 对象");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const started = await api.createRun(skill.projectId, { workspaceId, initialVariables });
      setView(started);
      setRuns(await api.listRuns(skill.projectId));
      setStartDialog(false);
      setRequestedNodeId("");
      setReplaySeq(null);
      setPlaying(false);
      setComparisonRunId("");
      await onProjectChanged();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function command(command: "next" | "pause" | "resume" | "stop", nextNodeId?: string) {
    if (!view) return;
    const artifact = view.artifact;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.commandRun(
        skill.projectId,
        view.run.runId,
        command,
        nextNodeId ? { nextNodeId } : {}
      );
      setView({ ...updated, ...(artifact ? { artifact } : {}) });
      setRuns((items) => items.map((run) => run.runId === updated.run.runId ? updated.run : run));
      if (command === "next") setRequestedNodeId("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const graph = view?.artifact?.graph;
  const replayFrame = useMemo(
    () => graph && view && replaySeq !== null ? projectTraceAt(graph, view.run.events, replaySeq) : null,
    [graph, view?.run.events, replaySeq]
  );
  const traceProjection = useMemo(
    () => replayFrame?.projection ?? (graph && view ? reduceTrace(graph, view.run.events) : null),
    [graph, view?.run.events, replayFrame]
  );
  const visibleEvents = replaySeq === null ? (view?.run.events ?? []) : (view?.run.events.filter((event) => event.seq <= replaySeq) ?? []);
  const displayedNodeId = traceProjection?.currentNodeId ?? view?.run.state.currentNodeId ?? "";
  const currentNode = graph?.nodes.find((node) => node.id === displayedNodeId);
  const latestTransitionEvent = [...visibleEvents].reverse().find((event) => event.type === "engine.reject" || event.type === "engine.enter") ?? null;
  const latestReject = latestTransitionEvent?.type === "engine.reject" ? latestTransitionEvent : null;
  const latestModelOutput = [...visibleEvents].reverse().find((event) => event.type === "llm.response")?.data ?? null;
  const revisionDrift = Boolean(view && view.run.revision !== skill.activeRevision);
  const comparisonRun = runs.find((run) => run.runId === comparisonRunId);
  const comparison = useMemo(
    () => view && comparisonRun ? compareTraceRuns(view.run, comparisonRun) : null,
    [view?.run, comparisonRun]
  );
  const comparisonMissingNodeIds = useMemo(
    () => graph && comparison
      ? comparison.rightPathNodeIds.filter((nodeId) => !graph.nodes.some((node) => node.id === nodeId))
      : [],
    [graph, comparison]
  );

  if (skill.capability === "content-only") {
    return <div className="empty-state full-height"><FlaskConical size={34} /><h1>当前 Skill 没有可执行流程</h1><p>内容型 Skill 可以编辑和检索文档，但不能启动流程运行。</p></div>;
  }

  return <div className="test-page">
    <header className="test-toolbar">
      <div className="test-title"><FlaskConical size={19} /><div><span>{skill.displayName}</span><strong>运行与调试</strong></div></div>
      <div className="test-actions">
        {view && (view.run.state.status === "completed" || view.run.state.status === "stopped") && <button className="button secondary" onClick={() => setReportDialog(true)}><Bug size={16} />生成报告</button>}
        <button className="icon-button" title="刷新运行" onClick={() => void loadRuns()} disabled={loading}><RefreshCw size={17} className={loading ? "spin" : ""} /></button>
        <button className="button primary" onClick={() => setStartDialog(true)}><Plus size={16} />新建运行</button>
      </div>
    </header>

    {error && <div className="docs-error" role="alert">{error}<button title="关闭" onClick={() => setError(null)}><X size={15} /></button></div>}
    {revisionDrift && <div className="runtime-drift"><AlertTriangle size={15} /><span>当前 Skill 已变化；此运行继续使用创建时的 RuntimeArtifact。使用新版本需要新建运行。</span><button onClick={() => { setVariablesText(JSON.stringify(view?.artifact?.initialVariables ?? {}, null, 2)); setStartDialog(true); }}>新建当前版本运行</button></div>}

    <div className="test-layout">
      <aside className="run-list-panel">
        <div className="run-list-heading"><span>最近运行</span><strong>{runs.length}</strong></div>
        <div className="run-list">
          {runs.map((run) => <button key={run.runId} className={view?.run.runId === run.runId ? "active" : ""} onClick={() => void openRun(run.runId)}>
            <span className={`run-status-dot ${run.state.status}`} />
            <div><strong>{statusLabel(run.state.status)}</strong><small>{shortId(run.runId)}</small><time>{formatTime(run.updatedAt)}</time></div>
          </button>)}
          {!runs.length && !loading && <div className="run-list-empty">暂无运行</div>}
        </div>
      </aside>

      {loading && !view ? <div className="runtime-loading"><LoaderCircle size={20} className="spin" />加载运行</div> : view && graph ? (
        <main className="runtime-main">
          <section className="runtime-summary">
            <div><span>{replaySeq === null ? "状态" : "回放状态"}</span><strong className={`runtime-status ${traceProjection?.status ?? view.run.state.status}`}>{statusLabel(traceProjection?.status ?? view.run.state.status)}</strong></div>
            <div><span>Revision</span><code title={view.run.revision}>{shortRevision(view.run.revision)}</code></div>
            <div><span>Artifact</span><code title={view.run.artifactId}>{shortId(view.run.artifactId)}</code></div>
            <div><span>{replaySeq === null ? "步骤" : "回放序号"}</span><strong>{replaySeq === null ? view.run.state.step : replaySeq}</strong></div>
          </section>

          <RuntimeArtifactInspector view={view} latestModelOutput={latestModelOutput} />

          <TraceReplayControls
            run={view.run}
            runs={runs}
            replaySeq={replaySeq}
            replaySpeed={replaySpeed}
            playing={playing}
            comparisonRunId={comparisonRunId}
            comparison={comparison}
            onLive={() => { setReplaySeq(null); setPlaying(false); controlPanelRef.current?.scrollTo({ top: 0 }); }}
            onReplay={() => { setReplaySeq(view.run.events[0]?.seq ?? 0); setPlaying(false); controlPanelRef.current?.scrollTo({ top: 0 }); }}
            onSeq={(seq) => { setReplaySeq(seq); setPlaying(false); }}
            onStep={(direction) => {
              const events = view.run.events;
              const current = replaySeq ?? (events.at(-1)?.seq ?? 0);
              const candidate = direction < 0
                ? [...events].reverse().find((event) => event.seq < current)
                : events.find((event) => event.seq > current);
              if (candidate) setReplaySeq(candidate.seq);
            }}
            onPlaying={setPlaying}
            onSpeed={setReplaySpeed}
            onComparison={setComparisonRunId}
          />

          {comparison && <TraceComparisonDetail comparison={comparison} />}

          {traceProjection && <TraceGraph graph={graph} projection={traceProjection} comparisonMissingNodeIds={comparisonMissingNodeIds} />}

          <div className="runtime-columns">
            <section className="runtime-control-panel" ref={controlPanelRef}>
              <div className="current-node-block">
                <span>当前节点</span>
                <h1>{currentNode?.title ?? (displayedNodeId || "尚未进入节点")}</h1>
                <code>{displayedNodeId || "-"}</code>
                {currentNode?.description && <p>{currentNode.description}</p>}
              </div>
              {view.contextFacts?.length ? <RuntimeContextFacts facts={view.contextFacts} /> : null}

              {replaySeq !== null && <div className="replay-readonly-note">回放只读取已记录事件，不会改变运行或验证状态。</div>}
              <RuntimeDialogPanel
                workspaceId={workspaceId}
                projectId={skill.projectId}
                view={view}
                disabled={replaySeq !== null}
                onView={(updated) => {
                  setView({ ...updated, ...(view.artifact ? { artifact: view.artifact } : {}) });
                  setRuns((items) => items.map((run) => run.runId === updated.run.runId ? updated.run : run));
                }}
              />
              <div className="runtime-buttons" aria-label="运行控制">
                {view.run.state.status === "running" && <button className="button secondary" disabled={busy || replaySeq !== null} onClick={() => void command("pause")}><Pause size={16} />暂停</button>}
                {view.run.state.status === "paused" && <button className="button secondary" disabled={busy || replaySeq !== null} onClick={() => void command("resume")}><Play size={16} />继续</button>}
                {(view.run.state.status === "running" || view.run.state.status === "paused") && <button className="button secondary" disabled={busy || replaySeq !== null} onClick={() => void command("stop")}><CircleStop size={16} />停止</button>}
                {(view.run.state.status === "completed" || view.run.state.status === "stopped") && <button className="button secondary" onClick={() => setStartDialog(true)}><RotateCcw size={16} />重新运行</button>}
              </div>

              <div className="legal-transitions">
                <div className="runtime-section-heading"><span>当前合法出口</span><strong>{view.allowedTransitions.length}</strong></div>
                {view.allowedTransitions.length ? <div className="transition-list">{view.allowedTransitions.map((transition) => {
                  const target = graph.nodes.find((node) => node.id === transition.to);
                  return <button key={transition.edgeId} disabled={busy || replaySeq !== null || view.run.state.status !== "running"} onClick={() => void command("next", transition.to)}>
                    <div><span>{target?.title ?? transition.to}</span><small>{transition.edgeId}</small></div><ArrowRight size={17} />
                  </button>;
                })}</div> : <p className="no-transitions">当前没有可用出口</p>}
              </div>

              <div className="manual-transition">
                <div className="runtime-section-heading"><span>提交下一节点</span><small>用于模拟 Agent 回执</small></div>
                <div><input aria-label="下一节点 ID" value={requestedNodeId} placeholder="flow.next-node" disabled={replaySeq !== null} onChange={(event) => setRequestedNodeId(event.target.value)} /><button className="button primary" disabled={busy || replaySeq !== null || !requestedNodeId.trim() || view.run.state.status !== "running"} onClick={() => void command("next", requestedNodeId.trim())}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}提交</button></div>
              </div>

              {latestReject && <RejectExplanation event={latestReject} graph={graph} />}
            </section>

            <aside className="runtime-events">
              <div className="runtime-section-heading"><span>{replaySeq === null ? "事件" : "回放事件"}</span><strong>{visibleEvents.length}</strong></div>
              <ol>{[...visibleEvents].reverse().map((event) => <li key={event.seq} className={event.type === "engine.reject" ? "rejected" : ""}>
                <span>{event.seq}</span><div><strong>{eventLabel(event.type)}</strong><code>{event.nodeId}</code><time>{formatTime(event.at)}</time></div>
              </li>)}</ol>
            </aside>
          </div>
        </main>
      ) : (
        <div className="runtime-empty"><FlaskConical size={32} /><h1>创建一次可追踪运行</h1><p>运行会冻结当前已确认 revision，不读取后续编辑中的工作树。</p><button className="button primary" onClick={() => setStartDialog(true)}><Play size={16} />启动运行</button></div>
      )}
    </div>

    {startDialog && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setStartDialog(false)}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="新建运行">
        <div className="modal-header"><h2>新建运行</h2><button className="icon-button subtle" title="关闭" disabled={busy} onClick={() => setStartDialog(false)}><X size={18} /></button></div>
        <div className="modal-body"><label className="field"><span>初始 skill 变量（JSON）</span><textarea rows={7} spellCheck={false} value={variablesText} onChange={(event) => setVariablesText(event.target.value)} /></label><p className="modal-note">运行输入将写入私有 Artifact，不修改 Skill 项目文件。</p></div>
        <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setStartDialog(false)}>取消</button><button className="button primary" disabled={busy} onClick={() => void startRun()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}启动</button></div>
      </div>
    </div>}
    {view && <BugReportModal open={reportDialog} workspaceId={workspaceId} skill={skill} view={view} onClose={() => setReportDialog(false)} onOpenDiagnosis={onOpenDiagnosis} />}
  </div>;
}

function RuntimeContextFacts({ facts }: { facts: ProjectFactQueryResult[] }) {
  return <section className="runtime-context-facts" aria-label="声明式运行上下文">
    <div className="runtime-section-heading"><span>声明式上下文</span><strong>{facts.length}</strong></div>
    <div>{facts.map((fact) => <details key={fact.queryId} className={`fact-status-${fact.status}`}>
      <summary><code>{fact.queryId}</code><span>{factKindLabel(fact.kind)}</span><strong>{factStatusLabel(fact.status)}</strong></summary>
      {fact.diagnostic && <p>{fact.diagnostic}</p>}
      {fact.degradation && <div className="runtime-fact-degradation">{fact.degradation.requestedAnchor} → {fact.degradation.resolvedPath}</div>}
      {fact.candidates?.length ? <ul>{fact.candidates.map((candidate) => <li key={`${candidate.path}-${candidate.startLine}`}><code>{candidate.path}</code><span>L{candidate.startLine}</span></li>)}</ul> : null}
      {fact.value !== undefined && <pre>{JSON.stringify(fact.value, null, 2)}</pre>}
    </details>)}</div>
  </section>;
}

function factKindLabel(kind: ProjectFactQueryResult["kind"]): string {
  return { "graph.node": "精确节点", "graph.neighborhood": "节点邻域", "graph.search": "图谱搜索", "document.slice": "文档切片" }[kind];
}

function factStatusLabel(status: ProjectFactQueryResult["status"]): string {
  return { found: "命中", empty: "空结果", missing: "缺失", ambiguous: "歧义", degraded: "已降级" }[status];
}

function RuntimeArtifactInspector({ view, latestModelOutput }: { view: ProjectRunView; latestModelOutput: Record<string, unknown> | null }) {
  const artifact = view.artifact;
  if (!artifact) return null;
  const output = {
    status: view.run.state.status,
    currentNodeId: view.run.state.currentNodeId,
    step: view.run.state.step,
    skillVariables: view.run.state.skillVariables
  };
  return <details className="runtime-artifact-inspector">
    <summary><div><Fingerprint size={15} /><strong>运行事实</strong><code title={artifact.fingerprint.value}>{shortHash(artifact.fingerprint.value)}</code></div><span>输入 / 输出</span></summary>
    <div>
      <section><header><span>Artifact 指纹</span><small>{artifact.fingerprint.algorithm}</small></header><dl>
        <div><dt>运行指纹</dt><dd><code>{artifact.fingerprint.value}</code></dd></div>
        <div><dt>项目内容</dt><dd><code>{artifact.fingerprint.projectContentHash}</code></dd></div>
        <div><dt>输入</dt><dd><code>{artifact.fingerprint.inputHash}</code></dd></div>
      </dl></section>
      <section><header><span>冻结输入</span><small>initialVariables</small></header><pre>{JSON.stringify(artifact.initialVariables, null, 2)}</pre></section>
      <section><header><span>当前输出</span><small>runtime state</small></header><pre>{JSON.stringify(output, null, 2)}</pre></section>
      <section><header><span>最近模型回执</span><small>llm.response</small></header><pre>{latestModelOutput ? JSON.stringify(latestModelOutput, null, 2) : "null"}</pre></section>
    </div>
  </details>;
}

function RuntimeDialogPanel({ workspaceId, projectId, view, disabled, onView }: {
  workspaceId: string;
  projectId: string;
  view: ProjectRunView;
  disabled: boolean;
  onView: (view: ProjectRunView) => void;
}) {
  const [session, setSession] = useState<RuntimeDialogSession | null>(null);
  const [content, setContent] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<"none" | "low" | "medium" | "high">("low");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setSession(null);
    setContent("");
    setError(null);
    void api.getRuntimeDialog(projectId, view.run.runId, workspaceId)
      .then((value) => { if (active) setSession(value); })
      .catch((cause) => { if (active) setError(messageOf(cause)); });
    return () => { active = false; };
  }, [workspaceId, projectId, view.run.runId]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [session?.messages.length, busy]);

  async function send(retryContent?: string) {
    const message = (retryContent ?? content).trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.sendRuntimeDialogMessage(projectId, view.run.runId, { workspaceId, content: message, reasoningEffort });
      setSession(result.session);
      setContent("");
      onView(result.view);
    } catch (cause) {
      setError(messageOf(cause));
      try { setSession(await api.getRuntimeDialog(projectId, view.run.runId, workspaceId)); } catch { /* keep the actionable request error */ }
    } finally {
      setBusy(false);
      setCancelling(false);
    }
  }

  async function cancel() {
    setCancelling(true);
    setError(null);
    try { await api.cancelRuntimeDialog(projectId, view.run.runId, workspaceId); }
    catch (cause) { setError(messageOf(cause)); setCancelling(false); }
  }

  const canSend = view.run.state.status === "running" && !disabled && !busy && Boolean(content.trim());
  return <section className="runtime-dialog-panel" aria-label="模型运行对话">
    <header>
      <div><MessageSquareText size={15} /><strong>模型调试</strong><span>{session?.messages.length ?? 0}</span></div>
      <select aria-label="运行对话推理强度" value={reasoningEffort} disabled={busy} onChange={(event) => setReasoningEffort(event.target.value as typeof reasoningEffort)}>
        <option value="none">不推理</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option>
      </select>
    </header>
    <div className="runtime-dialog-messages" ref={messagesRef} aria-live="polite">
      {session?.messages.map((message, index) => {
        const retrySource = message.role === "assistant" && (message.kind === "cancelled" || message.kind === "error")
          ? [...session.messages.slice(0, index)].reverse().find((item) => item.role === "user")
          : undefined;
        return <article key={message.messageId} className={`runtime-dialog-message ${message.role} ${message.kind}`}>
        <div><strong>{message.role === "user" ? "你" : "模型"}</strong><span>{runtimeDialogKindLabel(message.kind)}</span><time>{formatTime(message.createdAt)}</time></div>
        <p>{message.content}</p>
        {message.decision && <small>{message.decision.action === "advance" ? `下一节点 ${message.decision.nextNodeId ?? "-"}` : message.decision.action === "stop" ? "停止运行" : "保持当前节点"}{message.decision.accepted === false ? " · 引擎已拒绝" : ""}</small>}
        {message.model && <small>{message.model.resolvedModel} · {message.model.usage.totalTokens} token · {message.model.durationMs}ms</small>}
        {retrySource && index === session.messages.length - 1 && view.run.state.status === "running" && <button className="runtime-dialog-retry" disabled={busy || disabled} onClick={() => void send(retrySource.content)}><RotateCcw size={12} />重试</button>}
      </article>;})}
      {!session?.messages.length && !busy && <div className="runtime-dialog-empty"><MessageSquareText size={18} />等待本轮输入</div>}
      {busy && <div className="runtime-dialog-generating"><LoaderCircle size={14} className="spin" />模型处理中</div>}
    </div>
    {error && <div className="runtime-dialog-error" role="alert">{error}</div>}
    <div className="runtime-dialog-compose">
      <textarea aria-label="运行对话消息" rows={2} value={content} maxLength={4000} disabled={busy || disabled || view.run.state.status !== "running"} onChange={(event) => setContent(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (canSend) void send(); }
      }} />
      {busy ? <button className="icon-button danger" title="停止模型生成" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? <LoaderCircle size={16} className="spin" /> : <Square size={15} />}</button>
        : <button className="icon-button primary" title="发送消息" disabled={!canSend} onClick={() => void send()}><Send size={16} /></button>}
    </div>
  </section>;
}

function runtimeDialogKindLabel(kind: import("@skill-designer/engine").RuntimeDialogMessageKind): string {
  return { input: "输入", reply: "回复", advanced: "已推进", rejected: "被拒绝", stopped: "已停止", cancelled: "已取消", error: "错误" }[kind];
}

function TraceReplayControls({
  run,
  runs,
  replaySeq,
  replaySpeed,
  playing,
  comparisonRunId,
  comparison,
  onLive,
  onReplay,
  onSeq,
  onStep,
  onPlaying,
  onSpeed,
  onComparison
}: {
  run: ProjectRun;
  runs: ProjectRun[];
  replaySeq: number | null;
  replaySpeed: number;
  playing: boolean;
  comparisonRunId: string;
  comparison: TraceRunComparison | null;
  onLive: () => void;
  onReplay: () => void;
  onSeq: (seq: number) => void;
  onStep: (direction: -1 | 1) => void;
  onPlaying: (playing: boolean) => void;
  onSpeed: (speed: number) => void;
  onComparison: (runId: string) => void;
}) {
  const latestSeq = run.events.at(-1)?.seq ?? 0;
  return <section className="trace-tools" aria-label="Trace 回放与对比">
    <div className="trace-replay-row">
      <div className="segmented-control trace-mode" aria-label="Trace 查看模式">
        <button className={replaySeq === null ? "selected" : ""} onClick={onLive}>实时</button>
        <button className={replaySeq !== null ? "selected" : ""} onClick={onReplay}>回放</button>
      </div>
      {replaySeq !== null && <>
        <button className="icon-button subtle" title="上一个事件" onClick={() => onStep(-1)}><ChevronLeft size={17} /></button>
        <button className="icon-button subtle" title={playing ? "暂停回放" : "播放回放"} onClick={() => onPlaying(!playing)}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
        <button className="icon-button subtle" title="下一个事件" onClick={() => onStep(1)}><ChevronRight size={17} /></button>
        <input aria-label="Trace 回放时间轴" type="range" min={0} max={latestSeq} step={1} value={replaySeq} onChange={(event) => onSeq(Number(event.target.value))} />
        <code>seq {replaySeq}/{latestSeq}</code>
        <select aria-label="回放速度" value={replaySpeed} onChange={(event) => onSpeed(Number(event.target.value))}>
          <option value={1200}>0.5x</option><option value={700}>1x</option><option value={350}>2x</option>
        </select>
      </>}
    </div>
    <div className="trace-compare-row">
      <GitCompareArrows size={16} />
      <label><span>对比运行</span><select aria-label="对比运行" value={comparisonRunId} onChange={(event) => onComparison(event.target.value)}>
        <option value="">不对比</option>
        {runs.filter((item) => item.runId !== run.runId).map((item) => <option key={item.runId} value={item.runId}>{statusLabel(item.state.status)} · {shortId(item.runId)}</option>)}
      </select></label>
      {comparison && <TraceComparisonSummary comparison={comparison} />}
    </div>
  </section>;
}

function TraceComparisonSummary({ comparison }: { comparison: TraceRunComparison }) {
  const divergence = comparison.firstPathDivergence;
  return <div className="trace-comparison-summary" role="status">
    <span>{comparison.sameSkill ? "同一 Skill" : "Skill 不同"}</span>
    <span className={comparison.revisionDrift ? "warning" : ""}>{comparison.revisionDrift ? "Revision 不同" : "Revision 相同"}</span>
    <span>{comparison.artifactDrift ? "独立 Artifact" : "同一 Artifact"}</span>
    <strong>{divergence
      ? `首个路径偏差 #${divergence.index + 1}：${divergence.leftNodeId ?? "结束"} / ${divergence.rightNodeId ?? "结束"}`
      : `路径一致 · ${comparison.sharedPrefixNodeIds.length} 个节点`}</strong>
  </div>;
}

function TraceComparisonDetail({ comparison }: { comparison: TraceRunComparison }) {
  const left = comparison.leftSnapshot;
  const right = comparison.rightSnapshot;
  return <section className="trace-comparison-detail" aria-label="运行状态对比">
    <header><GitCompareArrows size={15} /><strong>运行事实对比</strong><span>只展示持久化状态与事件计数</span></header>
    <div className="trace-snapshot-grid">
      <span />
      <strong>当前运行</strong>
      <strong>对比运行</strong>
      <span>状态</span><code>{statusLabel(left.status)}</code><code>{statusLabel(right.status)}</code>
      <span>当前节点</span><code title={left.currentNodeId}>{left.currentNodeId}</code><code title={right.currentNodeId}>{right.currentNodeId}</code>
      <span>步数 / seq</span><code>{left.step} / {left.eventSeq}</code><code>{right.step} / {right.eventSeq}</code>
    </div>
    <div className="trace-difference-groups">
      <section>
        <header><span>变量差异</span><strong>{comparison.variableDifferences.length}</strong></header>
        {comparison.variableDifferences.length ? <div>{comparison.variableDifferences.map((difference) => <article key={difference.key}>
          <code>{difference.key}</code>
          <span title={traceValue(difference.leftValue, difference.leftPresent)}>{traceValue(difference.leftValue, difference.leftPresent)}</span>
          <span title={traceValue(difference.rightValue, difference.rightPresent)}>{traceValue(difference.rightValue, difference.rightPresent)}</span>
        </article>)}</div> : <p>变量一致</p>}
      </section>
      <section>
        <header><span>事件类型差异</span><strong>{comparison.eventTypeDifferences.length}</strong></header>
        {comparison.eventTypeDifferences.length ? <div>{comparison.eventTypeDifferences.map((difference) => <article key={difference.type}>
          <code>{difference.type}</code><span>{difference.leftCount}</span><span>{difference.rightCount}</span>
        </article>)}</div> : <p>事件类型计数一致</p>}
      </section>
    </div>
  </section>;
}

function traceValue(value: unknown, present: boolean): string {
  if (!present) return "<不存在>";
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

export function TraceGraph({ graph, projection, comparisonMissingNodeIds = [] }: { graph: SkillGraph; projection: TraceProjection; comparisonMissingNodeIds?: string[] }) {
  const graphRef = useRef<SkillGraphCanvasHandle>(null);
  const [mode, setMode] = useState<GraphViewMode>("3d");
  const allMissingNodeIds = useMemo(() => [...new Set([...projection.missingNodeIds, ...comparisonMissingNodeIds])], [projection.missingNodeIds, comparisonMissingNodeIds]);
  const projectedGraph = useMemo<SkillGraph>(() => ({
    ...graph,
    nodes: [
      ...graph.nodes,
      ...allMissingNodeIds.map((nodeId, index) => ({
        id: nodeId,
        title: nodeId,
        kind: "knowledge" as const,
        description: "原图缺失，使用回放降级占位",
        position: { x: 80 + index * 160, y: 160 }
      }))
    ]
  }), [graph, allMissingNodeIds]);
  const activeStates = Object.entries(projection.nodeStates).filter(([, state]) => state !== "unvisited");
  return <section className="trace-graph-panel">
    <header><div><span>ExecutionTrace</span><strong>节点路径</strong></div><div className="trace-graph-actions"><div className="trace-graph-mode" role="group" aria-label="Trace 图谱显示模式"><button className={mode === "3d" ? "active" : ""} onClick={() => graphRef.current?.setMode("3d")}>3D</button><button className={mode === "2d" ? "active" : ""} onClick={() => graphRef.current?.setMode("2d")}>2D</button></div><button title="Trace 适应全图" aria-label="Trace 适应全图" onClick={() => graphRef.current?.fitGraph()}>适应</button><code>seq {projection.latestSeq}</code></div></header>
    <div className="trace-graph-canvas" aria-label="运行 Trace 图">
      <SkillGraphCanvas
        ref={graphRef}
        graph={projectedGraph}
        selectedNodeId={null}
        selectedEdgeId={null}
        query=""
        kindFilter="all"
        edgeKindFilter="all"
        largeGraph={projectedGraph.nodes.length > 200}
        embeddedControls={false}
        fitPadding={24}
        onSelectNode={() => undefined}
        onSelectEdge={() => undefined}
        onClearSelection={() => undefined}
        onModeChange={setMode}
        traceNodeStates={projection.nodeStates}
        traceTraversedEdgeIds={projection.traversedEdgeIds}
        traceMissingNodeIds={allMissingNodeIds}
      />
      <div className="trace-state-strip" aria-label="Trace 节点状态">{activeStates.map(([nodeId, state]) => <span key={nodeId} className={`trace-flow-node ${state}`}><i />{graph.nodes.find((node) => node.id === nodeId)?.title ?? nodeId}<small>{stateLabel(state)}</small></span>)}{allMissingNodeIds.map((nodeId) => <span key={`missing:${nodeId}`} className="trace-flow-node missing"><i />{nodeId}<small>{comparisonMissingNodeIds.includes(nodeId) ? "对比图缺失" : "原图缺失"}</small></span>)}</div>
      <div className="trace-edge-facts" aria-hidden="true">{projection.traversedEdgeIds.map((edgeId) => <i key={edgeId} className="trace-flow-edge traversed" />)}</div>
    </div>
  </section>;
}

function stateLabel(state: TraceProjection["nodeStates"][string]): string {
  return { unvisited: "未访问", visited: "已访问", current: "当前", rejected: "已拒绝", completed: "已完成", stopped: "已停止" }[state];
}

function RejectExplanation({ event, graph }: { event: RuntimeTraceEvent; graph: NonNullable<ProjectRunView["artifact"]>["graph"] }) {
  const requested = typeof event.data.requestedNodeId === "string" ? event.data.requestedNodeId : "未提供";
  const code = typeof event.data.code === "string" ? event.data.code : "next_node_not_allowed";
  const allowed = Array.isArray(event.data.allowedNodeIds) ? event.data.allowedNodeIds.filter((item): item is string => typeof item === "string") : [];
  return <div className="reject-explanation" role="status">
    <ShieldAlert size={19} />
    <div><strong>下一节点被拒绝，运行仍停留在当前节点</strong><p>提交目标 <code>{requested}</code> 不属于当前合法出口。引擎没有自动修复或改走其他路线。</p><span>错误码：<code>{code}</code></span>{allowed.length > 0 && <span>合法出口：{allowed.map((id) => graph.nodes.find((node) => node.id === id)?.title ?? id).join("、")}</span>}</div>
  </div>;
}

function statusLabel(status: ProjectRun["state"]["status"]): string {
  return { running: "运行中", paused: "已暂停", completed: "已完成", stopped: "已停止" }[status];
}

function eventLabel(type: RuntimeTraceEvent["type"]): string {
  return {
    "engine.start": "运行启动", "engine.enter": "进入节点", "engine.reject": "拒绝跳转", "engine.pause": "运行暂停", "engine.resume": "运行继续", "engine.stop": "运行停止", "engine.complete": "运行完成",
    "condition.evaluated": "条件计算", "document.context": "文档上下文", "context.queried": "项目事实查询",
    "conversation.user": "用户消息", "conversation.assistant": "模型回复", "llm.request": "模型请求", "llm.response": "模型回执", "llm.error": "模型错误"
  }[type] ?? type;
}

function shortId(id: string): string {
  return id.length > 22 ? `${id.slice(0, 11)}…${id.slice(-7)}` : id;
}

function shortRevision(revision: string): string {
  return revision.length > 22 ? `${revision.slice(0, 22)}…` : revision;
}

function shortHash(value: string): string {
  return value.length > 28 ? `${value.slice(0, 15)}…${value.slice(-9)}` : value;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError || cause instanceof Error) return cause.message;
  return "运行操作失败";
}
