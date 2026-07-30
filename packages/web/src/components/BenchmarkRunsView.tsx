import { AlertTriangle, Ban, Bug, CheckCircle2, CircleStop, FlaskConical, Gauge, GitCompareArrows, History, ListChecks, LoaderCircle, Play, RefreshCw, RotateCcw, Save, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BenchmarkCapabilityReport, BenchmarkCaseEntry, BenchmarkHumanVerdict, BenchmarkRunRecord, ModelReasoningEffort, WorkspaceMember } from "@skill-designer/engine";
import { api } from "../api";
import { BugReportModal } from "./BugReportModal";

interface Props {
  workspaceId: string;
  skill: WorkspaceMember;
  onOpenDiagnosis: () => void;
}

const activeStatuses = new Set<BenchmarkRunRecord["status"]>(["queued", "preparing", "running"]);

export function BenchmarkRunsView({ workspaceId, skill, onOpenDiagnosis }: Props) {
  const [capability, setCapability] = useState<BenchmarkCapabilityReport | null>(null);
  const [cases, setCases] = useState<BenchmarkCaseEntry[]>([]);
  const [runs, setRuns] = useState<BenchmarkRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [runMode, setRunMode] = useState<"single" | "batch">("single");
  const [caseId, setCaseId] = useState("");
  const [batchCaseIds, setBatchCaseIds] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ModelReasoningEffort>("low");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewVerdict, setReviewVerdict] = useState<BenchmarkHumanVerdict>("inconclusive");
  const [reviewNote, setReviewNote] = useState("");
  const [reportOpen, setReportOpen] = useState(false);

  const selectedRun = runs.find((run) => run.benchmarkRunId === selectedRunId) ?? runs[0] ?? null;
  const comparisonBase = selectedRun?.lineage ? runs.find((run) => run.benchmarkRunId === selectedRun.lineage!.parentBenchmarkRunId) ?? null : null;
  const readyCases = useMemo(() => cases.filter((item) => item.status === "ready" && item.valid), [cases]);

  useEffect(() => {
    setCapability(null);
    setCases([]);
    setRuns([]);
    setSelectedRunId("");
    setRunMode("single");
    setCaseId("");
    setBatchCaseIds([]);
    setModel("");
    setError(null);
    void load();
  }, [skill.projectId]);

  useEffect(() => {
    setReviewVerdict("inconclusive");
    setReviewNote("");
  }, [selectedRun?.benchmarkRunId]);

  useEffect(() => {
    if (!runs.some((run) => activeStatuses.has(run.status))) return;
    const timer = window.setInterval(() => void refreshRuns(false), 750);
    return () => window.clearInterval(timer);
  }, [skill.projectId, runs.map((run) => `${run.benchmarkRunId}:${run.status}`).join("|")]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [nextCapability, nextCases, nextRuns] = await Promise.all([
        api.getBenchmarkCapabilities(),
        api.listBenchmarkCases(skill.projectId),
        api.listBenchmarkRuns(skill.projectId)
      ]);
      setCapability(nextCapability);
      setCases(nextCases);
      setRuns(nextRuns);
      setModel((current) => current || nextCapability.provider.defaultModel);
      const firstReady = nextCases.find((item) => item.status === "ready" && item.valid);
      setCaseId((current) => current || firstReady?.caseId || "");
      setSelectedRunId((current) => current || nextRuns[0]?.benchmarkRunId || "");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  async function refreshRuns(showBusy = true) {
    if (showBusy) setLoading(true);
    try {
      const nextRuns = await api.listBenchmarkRuns(skill.projectId);
      setRuns(nextRuns);
      if (!selectedRunId && nextRuns[0]) setSelectedRunId(nextRuns[0].benchmarkRunId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      if (showBusy) setLoading(false);
    }
  }

  async function start() {
    if (!model.trim() || (runMode === "single" ? !caseId : batchCaseIds.length === 0)) return;
    setBusy(true);
    setError(null);
    try {
      const queued = runMode === "single"
        ? [await api.startBenchmarkRun(skill.projectId, { workspaceId, caseId, model: model.trim(), reasoningEffort })]
        : await api.startBenchmarkBatch(skill.projectId, { workspaceId, caseIds: batchCaseIds, model: model.trim(), reasoningEffort });
      setSelectedRunId(queued[0]!.benchmarkRunId);
      const queuedIds = new Set(queued.map((run) => run.benchmarkRunId));
      setRuns((current) => [...queued, ...current.filter((run) => !queuedIds.has(run.benchmarkRunId))]);
      window.setTimeout(() => void refreshRuns(false), 100);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!selectedRun || !activeStatuses.has(selectedRun.status)) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancelBenchmarkRun(skill.projectId, selectedRun.benchmarkRunId);
      await refreshRuns(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function rerun() {
    if (!selectedRun || activeStatuses.has(selectedRun.status)) return;
    setBusy(true);
    setError(null);
    try {
      const queued = await api.startBenchmarkRun(skill.projectId, {
        workspaceId,
        caseId: selectedRun.caseId,
        model: selectedRun.fingerprint.requestedModel,
        reasoningEffort: selectedRun.fingerprint.reasoningEffort,
        parentBenchmarkRunId: selectedRun.benchmarkRunId
      });
      setSelectedRunId(queued.benchmarkRunId);
      setRuns((current) => [queued, ...current.filter((run) => run.benchmarkRunId !== queued.benchmarkRunId)]);
      window.setTimeout(() => void refreshRuns(false), 100);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveReview() {
    if (!selectedRun || selectedRun.status !== "completed") return;
    setBusy(true);
    setError(null);
    try {
      const reviewed = await api.reviewBenchmarkRun(skill.projectId, selectedRun.benchmarkRunId, { verdict: reviewVerdict, note: reviewNote });
      setRuns((items) => items.map((item) => item.benchmarkRunId === reviewed.benchmarkRunId ? reviewed : item));
      setReviewNote("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  function toggleBatchCase(nextCaseId: string) {
    setBatchCaseIds((current) => current.includes(nextCaseId) ? current.filter((item) => item !== nextCaseId) : [...current, nextCaseId]);
  }

  if (skill.capability === "content-only") return <div className="empty-state full-height"><FlaskConical size={34} /><h1>内容型 Skill 没有可执行流程</h1><p>真实 Benchmark 需要已确认的 workflow 图和 ready 用例。</p></div>;

  return <div className="benchmark-run-page">
    <header className="benchmark-run-toolbar">
      <div><Gauge size={18} /><span>{skill.displayName}</span><strong>真实模型与沙箱</strong></div>
      <button className="icon-button" title="刷新 Benchmark" onClick={() => void load()} disabled={loading}><RefreshCw size={17} className={loading ? "spin" : ""} /></button>
    </header>
    {error && <div className="docs-error" role="alert">{error}<button title="关闭" onClick={() => setError(null)}><X size={15} /></button></div>}
    {capability && <section className={`benchmark-preflight ${capability.ready ? "ready" : "blocked"}`} data-testid="benchmark-preflight">
      <div><span>模型 Provider</span><strong>{capability.provider.label}</strong><small>{capability.provider.keyConfigured ? `${capability.provider.defaultModel} · 服务端密钥已配置` : capability.provider.reason}</small></div>
      <div><span>隔离执行</span><strong>{capability.sandbox.readyForBenchmark ? "Docker Desktop 自检通过" : "真实沙箱未就绪"}</strong><small>{capability.sandbox.platform} · {capability.sandbox.arch}</small></div>
      <div className="benchmark-preflight-result">{capability.ready ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}<strong>{capability.ready ? "可以启动真实 Benchmark" : "运行将记录为 blocked"}</strong></div>
      {capability.blockers.length > 0 && <ul>{capability.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
    </section>}
    <section className="benchmark-launcher">
      <div className="field benchmark-run-mode"><span>运行方式</span><div className="segmented-control" aria-label="Benchmark 运行方式"><button className={runMode === "single" ? "selected" : ""} onClick={() => setRunMode("single")}>单用例</button><button className={runMode === "batch" ? "selected" : ""} onClick={() => setRunMode("batch")}>批量</button></div></div>
      {runMode === "single"
        ? <label className="field"><span>已确认用例</span><select aria-label="Benchmark 用例" value={caseId} onChange={(event) => setCaseId(event.target.value)}><option value="">选择 ready 用例</option>{readyCases.map((item) => <option key={item.caseId} value={item.caseId}>{item.title}</option>)}</select></label>
        : <div className="field benchmark-batch-picker"><span>批量用例 <small>{batchCaseIds.length}/{readyCases.length}</small></span><div role="group" aria-label="批量 Benchmark 用例">{readyCases.map((item) => <label key={item.caseId}><input type="checkbox" checked={batchCaseIds.includes(item.caseId)} onChange={() => toggleBatchCase(item.caseId)} /><span>{item.title}</span></label>)}</div></div>}
      <label className="field"><span>模型</span><input aria-label="Benchmark 模型" value={model} onChange={(event) => setModel(event.target.value)} /></label>
      <label className="field"><span>Reasoning</span><select aria-label="Benchmark Reasoning" value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ModelReasoningEffort)}>{["none", "low", "medium", "high", "xhigh", "max"].map((item) => <option key={item}>{item}</option>)}</select></label>
      <button className="button primary" data-testid="start-real-benchmark" disabled={busy || !model.trim() || (runMode === "single" ? !caseId : batchCaseIds.length === 0)} onClick={() => void start()}>{busy ? <LoaderCircle size={16} className="spin" /> : runMode === "batch" ? <ListChecks size={16} /> : <Play size={16} />}{runMode === "batch" ? `批量入队 ${batchCaseIds.length}` : "启动真实 Benchmark"}</button>
    </section>
    <div className="benchmark-run-layout">
      <aside className="benchmark-run-list">
        <header><span>运行记录</span><strong>{runs.length}</strong></header>
        <div>{runs.map((run) => <button key={run.benchmarkRunId} className={selectedRun?.benchmarkRunId === run.benchmarkRunId ? "active" : ""} onClick={() => setSelectedRunId(run.benchmarkRunId)}><span className={`run-status-dot ${run.status}`} /><div><strong>{benchmarkStatusLabel(run.status)}</strong><small>{caseTitle(cases, run.caseId)}</small><code>{shortId(run.benchmarkRunId)}</code></div><time>{formatTime(run.updatedAt)}</time></button>)}{!runs.length && !loading && <p>暂无真实 Benchmark 记录</p>}</div>
      </aside>
      <main className="benchmark-run-detail">
        {loading && !selectedRun ? <div className="runtime-loading"><LoaderCircle size={18} className="spin" />加载 Benchmark</div> : selectedRun ? <>
          <section className="benchmark-run-summary">
            <div><span>运行状态</span><strong className={selectedRun.status}>{benchmarkStatusLabel(selectedRun.status)}</strong></div>
            <div><span>自动断言</span><strong>{verdictLabel(selectedRun.automaticVerdict)}</strong></div>
            <div><span>人工判定</span><strong>{selectedRun.humanReviews.at(-1) ? humanVerdictLabel(selectedRun.humanReviews.at(-1)!.verdict) : "未判定"}</strong></div>
            <div><span>模型调用</span><strong>{selectedRun.modelCallCount}</strong></div>
            <div><span>Token</span><strong>{selectedRun.usage.totalTokens}</strong></div>
            <div><span>缓存输入</span><strong>{selectedRun.usage.cachedInputTokens}</strong></div>
            <div><span>耗时范围</span><strong>{formatTime(selectedRun.createdAt)} - {formatTime(selectedRun.completedAt ?? selectedRun.updatedAt)}</strong></div>
          </section>
          {selectedRun.failure && <div className={`benchmark-run-failure ${selectedRun.status}`}><Ban size={17} /><div><strong>{failureLabel(selectedRun.failure.category)}</strong><p>{selectedRun.failure.message}</p></div></div>}
          {selectedRun.lineage && <section className="benchmark-comparison" data-testid="benchmark-comparison"><header><GitCompareArrows size={15} /><strong>关联运行对比</strong></header>{comparisonBase ? <div><span>父运行</span><code>{shortId(comparisonBase.benchmarkRunId)}</code><span>技术状态</span><strong>{benchmarkStatusLabel(comparisonBase.status)} {" -> "} {benchmarkStatusLabel(selectedRun.status)}</strong><span>自动断言</span><strong>{verdictLabel(comparisonBase.automaticVerdict)} {" -> "} {verdictLabel(selectedRun.automaticVerdict)}</strong><span>Artifact</span><strong>{artifactComparison(comparisonBase, selectedRun)}</strong><span>Token</span><strong>{comparisonBase.usage.totalTokens} {" -> "} {selectedRun.usage.totalTokens}</strong></div> : <p>父运行记录未加载，保留关系 ID：{selectedRun.lineage.parentBenchmarkRunId}</p>}</section>}
          <section className="benchmark-fingerprint"><header><ShieldCheck size={15} /><strong>Runtime Fingerprint</strong></header><dl><dt>Provider / Model</dt><dd>{selectedRun.fingerprint.providerId} · {selectedRun.fingerprint.requestedModel}</dd><dt>Resolved</dt><dd>{selectedRun.fingerprint.resolvedModels.join(", ") || "尚未调用模型"}</dd><dt>Artifact / Revision</dt><dd>{selectedRun.fingerprint.runtimeArtifactId ? `${shortId(selectedRun.fingerprint.runtimeArtifactId)} · ${selectedRun.fingerprint.revision}` : "preflight 前阻断，未冻结"}</dd><dt>Sandbox</dt><dd>{selectedRun.fingerprint.sandboxBackendId} · {selectedRun.sandboxHandleIds.length} handles</dd><dt>Prompt</dt><dd>{selectedRun.fingerprint.promptTemplateVersion} · {selectedRun.fingerprint.reasoningEffort}</dd></dl></section>
          <section className="benchmark-assertions"><header><CheckCircle2 size={15} /><strong>自动断言</strong><span>{selectedRun.assertions.length}</span></header>{selectedRun.assertions.length ? selectedRun.assertions.map((assertion) => <div key={assertion.assertionId} className={assertion.status}><span /> <strong>{assertion.kind}</strong><p>{assertion.message}</p></div>) : <p>运行未完成，不生成自动断言。</p>}</section>
          <section className="benchmark-reviews" data-testid="benchmark-reviews"><header><History size={15} /><strong>人工判定</strong><span>{selectedRun.humanReviews.length}</span></header>
            {selectedRun.humanReviews.length > 0 && <div className="benchmark-review-history">{[...selectedRun.humanReviews].reverse().map((review) => <article key={review.reviewId}><strong className={review.verdict}>{humanVerdictLabel(review.verdict)}</strong><p>{review.note || "未填写备注"}</p><time>{formatTime(review.createdAt)}</time></article>)}</div>}
            <div className="benchmark-review-form">
              <div className="segmented-control" aria-label="人工判定结果">{(["passed", "failed", "inconclusive"] as const).map((verdict) => <button key={verdict} disabled={selectedRun.status !== "completed"} className={reviewVerdict === verdict ? "selected" : ""} onClick={() => setReviewVerdict(verdict)}>{humanVerdictLabel(verdict)}</button>)}</div>
              <label className="field"><span>判定备注</span><textarea aria-label="人工判定备注" disabled={selectedRun.status !== "completed"} maxLength={4000} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="记录通过依据、失败原因或仍缺少的证据" /></label>
              <button className="button secondary" data-testid="save-benchmark-review" disabled={busy || selectedRun.status !== "completed"} onClick={() => void saveReview()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}保存人工判定</button>
            </div>
            {selectedRun.status !== "completed" && <p className="benchmark-review-unavailable">只有技术执行完成的运行可以人工判定；条件阻断或技术失败不能手工改成通过。</p>}
          </section>
          <section className="benchmark-trace"><header><FlaskConical size={15} /><strong>Execution Trace</strong><span>{selectedRun.events.length}</span></header><div>{selectedRun.events.map((event) => <article key={event.seq}><code>{event.seq}</code><span className={event.type.split(".")[0]}>{event.type}</span><small>{event.nodeId ?? "-"}</small><time>{formatTime(event.at)}</time></article>)}</div></section>
          {(activeStatuses.has(selectedRun.status) || reportEligible(selectedRun)) && <div className="benchmark-run-actions">
            {reportEligible(selectedRun) && <button className="button secondary" data-testid="benchmark-bug-report" onClick={() => setReportOpen(true)}><Bug size={16} />生成 Bug Report</button>}
            {activeStatuses.has(selectedRun.status) && <button className="button danger" disabled={busy} onClick={() => void cancel()}><CircleStop size={16} />取消运行</button>}
          </div>}
          {!activeStatuses.has(selectedRun.status) && <div className="benchmark-run-actions"><button className="button secondary" data-testid="rerun-benchmark" disabled={busy} onClick={() => void rerun()}><RotateCcw size={16} />按本次配置重跑</button></div>}
          {reportEligible(selectedRun) && <BugReportModal open={reportOpen} workspaceId={workspaceId} skill={skill} benchmarkRun={selectedRun} onClose={() => setReportOpen(false)} onOpenDiagnosis={onOpenDiagnosis} />}
        </> : <div className="empty-state"><Gauge size={30} /><h1>选择一次运行</h1><p>运行记录会冻结模型、Prompt、Revision、沙箱策略和 token usage。</p></div>}
      </main>
    </div>
  </div>;
}

function benchmarkStatusLabel(status: BenchmarkRunRecord["status"]): string { return { queued: "排队中", preparing: "前置检查", running: "运行中", completed: "已完成", failed: "技术失败", cancelled: "已取消", blocked: "条件阻断" }[status]; }
function verdictLabel(value: BenchmarkRunRecord["automaticVerdict"]): string { return { passed: "通过", failed: "失败", inconclusive: "无法判定", "not-run": "未运行" }[value]; }
function humanVerdictLabel(value: BenchmarkHumanVerdict): string { return { passed: "成功", failed: "失败", inconclusive: "待定" }[value]; }
function failureLabel(value: NonNullable<BenchmarkRunRecord["failure"]>["category"]): string { return { "sandbox-unavailable": "沙箱不可用", "provider-unavailable": "模型 Provider 不可用", "case-invalid": "用例无效", "model-error": "模型调用失败", "model-protocol-error": "模型协议错误", "engine-error": "引擎错误", "tool-error": "工具错误", "usage-missing": "缺少真实 usage", cancelled: "用户取消", "internal-error": "内部错误" }[value]; }
function caseTitle(cases: BenchmarkCaseEntry[], caseId: string): string { return cases.find((item) => item.caseId === caseId)?.title ?? caseId; }
function shortId(value: string): string { return value.length > 22 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value; }
function formatTime(value: string): string { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : "Benchmark 操作失败"; }
function reportEligible(run: BenchmarkRunRecord): boolean {
  if (!run.fingerprint.runtimeArtifactId) return false;
  if (run.status === "failed" || run.status === "cancelled") return true;
  const latestReview = run.humanReviews.at(-1)?.verdict;
  return run.status === "completed" && (run.automaticVerdict === "failed" || run.automaticVerdict === "inconclusive" || latestReview === "failed" || latestReview === "inconclusive");
}
function artifactComparison(base: BenchmarkRunRecord, current: BenchmarkRunRecord): string {
  const before = base.fingerprint.runtimeArtifactId;
  const after = current.fingerprint.runtimeArtifactId;
  if (!before && !after) return "两次均在 Artifact 冻结前结束";
  if (!before || !after) return "仅一次运行冻结了 Artifact";
  return before === after ? "相同（异常）" : `不同 · ${shortId(before)} -> ${shortId(after)}`;
}
