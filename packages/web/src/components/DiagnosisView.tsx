import { AlertTriangle, Ban, Bug, Check, CheckCircle2, ChevronLeft, ChevronRight, FileCheck2, FileUp, Fingerprint, FlaskConical, Info, LoaderCircle, PlayCircle, SearchCheck, ShieldAlert, Trash2, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { projectTraceAt, type BenchmarkCaseChangePreview, type BenchmarkRunRecord, type DiagnosisRecord, type DiagnosisRepairProposal, type DiagnosisRepairRecord, type GraphChangePreview, type ImportedBugReport, type ProjectChangeSet, type ProjectRun, type ReportBenchmarkCandidate, type ReportFixture, type WorkspaceMember } from "@skill-designer/engine";
import { api, ApiError } from "../api";
import { GraphDiffPreview } from "./GraphView";
import { TraceGraph } from "./TestView";
import { ChangeSetMetadata } from "./ChangeSetMetadata";
import { SkillId } from "./SkillIdentity";

export function DiagnosisView({ workspaceId, skill, onOpenTests, onProjectChanged }: { workspaceId: string; skill: WorkspaceMember; onOpenTests: () => void; onProjectChanged: () => Promise<void> }) {
  const [reports, setReports] = useState<ImportedBugReport[]>([]);
  const [selected, setSelected] = useState<ImportedBugReport | null>(null);
  const [replaySeq, setReplaySeq] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [diagnosisBusy, setDiagnosisBusy] = useState(false);
  const [diagnosis, setDiagnosis] = useState<DiagnosisRecord | null>(null);
  const [repairs, setRepairs] = useState<DiagnosisRepairRecord[]>([]);
  const [runs, setRuns] = useState<ProjectRun[]>([]);
  const [benchmarkRuns, setBenchmarkRuns] = useState<BenchmarkRunRecord[]>([]);
  const [repairProposal, setRepairProposal] = useState<DiagnosisRepairProposal | null>(null);
  const [verificationRunId, setVerificationRunId] = useState("");
  const [benchmarkVerificationRunId, setBenchmarkVerificationRunId] = useState("");
  const [repairBusy, setRepairBusy] = useState(false);
  const [fixtures, setFixtures] = useState<ReportFixture[]>([]);
  const [benchmarkCandidates, setBenchmarkCandidates] = useState<ReportBenchmarkCandidate[]>([]);
  const [benchmarkProposal, setBenchmarkProposal] = useState<{ candidate: ReportBenchmarkCandidate; changeSet: ProjectChangeSet | null } | null>(null);
  const [conversionBusy, setConversionBusy] = useState<"fixture" | "benchmark" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const diagnosisRequest = useRef(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void api.listImportedBugReports(workspaceId)
      .then((items) => {
        setReports(items);
        selectReport(items[0] ?? null);
      })
      .catch((cause) => setError(messageOf(cause)))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  function selectReport(report: ImportedBugReport | null) {
    setSelected(report);
    setReplaySeq(report ? report.report.symptoms[0]?.seq ?? report.report.trace.at(-1)?.seq ?? 0 : 0);
    setDiagnosis(null);
    setRepairs([]);
    setRuns([]);
    setBenchmarkRuns([]);
    setRepairProposal(null);
    setFixtures([]);
    setBenchmarkCandidates([]);
    setBenchmarkProposal(null);
    setVerificationRunId("");
    setBenchmarkVerificationRunId("");
    const requestId = ++diagnosisRequest.current;
    if (report) {
      void Promise.all([
        api.listDiagnoses(workspaceId, report.reportImportId),
        api.listDiagnosisRepairs(workspaceId, report.reportImportId),
        api.listReportFixtures(workspaceId, report.reportImportId),
        api.listReportBenchmarkCandidates(workspaceId, report.reportImportId),
        report.match.matchedProjectId ? api.listRuns(report.match.matchedProjectId) : Promise.resolve([]),
        report.match.matchedProjectId ? api.listBenchmarkRuns(report.match.matchedProjectId) : Promise.resolve([])
      ])
        .then(([diagnoses, repairItems, fixtureItems, candidateItems, runItems, benchmarkRunItems]) => {
          if (requestId !== diagnosisRequest.current) return;
          setDiagnosis(diagnoses[0] ?? null);
          setRepairs(repairItems);
          setFixtures(fixtureItems);
          setBenchmarkCandidates(candidateItems);
          setRuns(runItems);
          setBenchmarkRuns(benchmarkRunItems);
        })
        .catch((cause) => { if (requestId === diagnosisRequest.current) setError(messageOf(cause)); });
    }
  }

  useEffect(() => {
    const projectId = selected?.match.matchedProjectId;
    if (!projectId || !benchmarkRuns.some((run) => ["queued", "preparing", "running"].includes(run.status))) return;
    const timer = window.setInterval(() => {
      void api.listBenchmarkRuns(projectId).then(setBenchmarkRuns).catch((cause) => setError(messageOf(cause)));
    }, 750);
    return () => window.clearInterval(timer);
  }, [selected?.match.matchedProjectId, benchmarkRuns.some((run) => ["queued", "preparing", "running"].includes(run.status))]);

  async function analyze() {
    if (!selected) return;
    const reportImportId = selected.reportImportId;
    const requestId = ++diagnosisRequest.current;
    setDiagnosisBusy(true);
    setError(null);
    try {
      const created = await api.createDiagnosis(workspaceId, reportImportId);
      if (requestId === diagnosisRequest.current) setDiagnosis(created);
    } catch (cause) {
      if (requestId === diagnosisRequest.current) setError(messageOf(cause));
    } finally {
      setDiagnosisBusy(false);
    }
  }

  async function importFiles(input?: FileList | File[]) {
    const files = input ? Array.from(input) : [];
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      if (files.length > 10) throw new Error("一次最多导入 10 份 Bug Report");
      if (files.reduce((total, file) => total + file.size, 0) > 10 * 1024 * 1024) throw new Error("单次导入总量不能超过 10 MiB");
      const imported: ImportedBugReport[] = [];
      const failures: string[] = [];
      for (const file of files) {
        try {
          if (!file.name.toLowerCase().endsWith(".json")) throw new Error("只接受 JSON 报告");
          if (file.size > 2 * 1024 * 1024) throw new Error("超过 2 MiB");
          imported.push(await api.importBugReport(workspaceId, bytesToBase64(new Uint8Array(await file.arrayBuffer()))));
        } catch (cause) {
          failures.push(`${file.name}：${messageOf(cause)}`);
        }
      }
      if (imported.length) {
        const importedUnique = [...new Map(imported.map((item) => [item.reportImportId, item])).values()];
        setReports((items) => {
          const merged = new Map(items.map((item) => [item.reportImportId, item]));
          importedUnique.forEach((item) => merged.set(item.reportImportId, item));
          return [...importedUnique, ...[...merged.values()].filter((item) => !importedUnique.some((created) => created.reportImportId === item.reportImportId))];
        });
        selectReport(importedUnique[0]!);
      }
      if (failures.length) setError(`${imported.length} 份成功，${failures.length} 份失败。${failures.join("；")}`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function deleteReport(report: ImportedBugReport) {
    if (!window.confirm(`删除导入副本 ${report.reportImportId}？关联的诊断、修复记录、夹具和候选用例也会清理；已应用到 Skill 的变更不会回滚。`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteImportedBugReport(workspaceId, report.reportImportId);
      const remaining = reports.filter((item) => item.reportImportId !== report.reportImportId);
      setReports(remaining);
      if (selected?.reportImportId === report.reportImportId) selectReport(remaining[0] ?? null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function proposeRepair(candidateId: string) {
    if (!selected || !diagnosis) return;
    setRepairBusy(true);
    setError(null);
    try {
      const proposal = await api.createDiagnosisRepair(workspaceId, selected.reportImportId, diagnosis.diagnosisId, candidateId);
      setRepairProposal(proposal);
      setRepairs((items) => [proposal.repair, ...items]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRepairBusy(false);
    }
  }

  async function openRepair(repair: DiagnosisRepairRecord) {
    setRepairBusy(true);
    setError(null);
    try {
      setRepairProposal({ repair, changeSet: await api.getChangeSet(repair.changeSetId) });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRepairBusy(false);
    }
  }

  async function confirmRepair() {
    if (!selected || !repairProposal || repairProposal.changeSet.status !== "proposed") return;
    setRepairBusy(true);
    setError(null);
    try {
      const result = await api.confirmDiagnosisRepair(workspaceId, selected.reportImportId, repairProposal.repair.repairId, {
        digest: repairProposal.changeSet.digest,
        baseRevision: repairProposal.changeSet.baseRevision
      });
      setRepairs((items) => items.map((item) => item.repairId === result.repair.repairId ? result.repair : item));
      setRepairProposal(null);
      await onProjectChanged();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRepairBusy(false);
    }
  }

  async function rejectRepair() {
    if (!selected || !repairProposal || repairProposal.changeSet.status !== "proposed") return;
    setRepairBusy(true);
    setError(null);
    try {
      const result = await api.rejectDiagnosisRepair(workspaceId, selected.reportImportId, repairProposal.repair.repairId, {
        digest: repairProposal.changeSet.digest,
        baseRevision: repairProposal.changeSet.baseRevision,
        reason: "用户在诊断修复确认界面拒绝提案"
      });
      setRepairs((items) => items.map((item) => item.repairId === result.repair.repairId ? result.repair : item));
      setRepairProposal({ repair: result.repair, changeSet: result.changeSet });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRepairBusy(false);
    }
  }

  async function verifyRepair(repair: DiagnosisRepairRecord) {
    if (!selected || !verificationRunId) return;
    setRepairBusy(true);
    setError(null);
    try {
      const verified = await api.verifyDiagnosisRepair(workspaceId, selected.reportImportId, repair.repairId, verificationRunId);
      setRepairs((items) => items.map((item) => item.repairId === verified.repairId ? verified : item));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRepairBusy(false);
    }
  }

  async function startPostRepairBenchmark(repair: DiagnosisRepairRecord) {
    if (!selected) return;
    setRepairBusy(true);
    setError(null);
    try {
      const run = await api.startPostRepairBenchmark(workspaceId, selected.reportImportId, repair.repairId);
      setBenchmarkRuns((items) => [run, ...items.filter((item) => item.benchmarkRunId !== run.benchmarkRunId)]);
      setBenchmarkVerificationRunId(run.benchmarkRunId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRepairBusy(false);
    }
  }

  async function verifyPostRepairBenchmark(repair: DiagnosisRepairRecord) {
    if (!selected || !benchmarkVerificationRunId) return;
    setRepairBusy(true);
    setError(null);
    try {
      const verified = await api.verifyPostRepairBenchmark(workspaceId, selected.reportImportId, repair.repairId, benchmarkVerificationRunId);
      setRepairs((items) => items.map((item) => item.repairId === verified.repairId ? verified : item));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRepairBusy(false);
    }
  }

  async function createFixture() {
    if (!selected) return;
    setConversionBusy("fixture");
    setError(null);
    try {
      const result = await api.createReportFixture(workspaceId, selected.reportImportId);
      setFixtures((items) => [result.fixture, ...items]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setConversionBusy(null);
    }
  }

  async function createBenchmarkCandidate() {
    if (!selected) return;
    setConversionBusy("benchmark");
    setError(null);
    try {
      const candidate = await api.createReportBenchmarkCandidate(workspaceId, selected.reportImportId);
      setBenchmarkCandidates((items) => [candidate, ...items]);
      setBenchmarkProposal({ candidate, changeSet: null });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setConversionBusy(null);
    }
  }

  async function openBenchmarkCandidate(candidate: ReportBenchmarkCandidate) {
    setConversionBusy("benchmark");
    setError(null);
    try {
      const changeSet = candidate.changeSetId ? await api.getChangeSet(candidate.changeSetId) : null;
      setBenchmarkProposal({ candidate, changeSet });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setConversionBusy(null);
    }
  }

  function updateBenchmarkCase(patch: Partial<ReportBenchmarkCandidate["case"]>) {
    setBenchmarkProposal((current) => current && !current.changeSet ? {
      ...current,
      candidate: { ...current.candidate, case: { ...current.candidate.case, ...patch } }
    } : current);
  }

  function updateBenchmarkExpected(patch: Partial<ReportBenchmarkCandidate["case"]["expected"]>) {
    setBenchmarkProposal((current) => current && !current.changeSet ? {
      ...current,
      candidate: {
        ...current.candidate,
        case: { ...current.candidate.case, expected: { ...current.candidate.case.expected, ...patch } }
      }
    } : current);
  }

  function setBenchmarkTerminal(status: "" | "completed" | "stopped") {
    setBenchmarkProposal((current) => {
      if (!current || current.changeSet) return current;
      const { terminal, ...expected } = current.candidate.case.expected;
      const nextExpected = status ? { ...expected, terminal: { status, ...(terminal?.nodeId ? { nodeId: terminal.nodeId } : {}) } } : expected;
      return { ...current, candidate: { ...current.candidate, case: { ...current.candidate.case, expected: nextExpected } } };
    });
  }

  async function proposeBenchmarkCandidate() {
    if (!selected || !benchmarkProposal || benchmarkProposal.changeSet) return;
    setConversionBusy("benchmark");
    setError(null);
    try {
      const result = await api.createReportBenchmarkChangeSet(workspaceId, selected.reportImportId, benchmarkProposal.candidate.candidateId, benchmarkProposal.candidate.case);
      setBenchmarkProposal({ candidate: result.candidate, changeSet: result.changeSet });
      setBenchmarkCandidates((items) => items.map((item) => item.candidateId === result.candidate.candidateId ? result.candidate : item));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setConversionBusy(null);
    }
  }

  async function confirmBenchmarkCandidate() {
    if (!selected || !benchmarkProposal?.changeSet || benchmarkProposal.changeSet.status !== "proposed") return;
    setConversionBusy("benchmark");
    setError(null);
    try {
      const result = await api.confirmReportBenchmarkCandidate(workspaceId, selected.reportImportId, benchmarkProposal.candidate.candidateId, {
        digest: benchmarkProposal.changeSet.digest,
        baseRevision: benchmarkProposal.changeSet.baseRevision
      });
      setBenchmarkCandidates((items) => items.map((item) => item.candidateId === result.candidate.candidateId ? result.candidate : item));
      setBenchmarkProposal(null);
      await onProjectChanged();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setConversionBusy(null);
    }
  }

  async function rejectBenchmarkCandidate() {
    if (!selected || !benchmarkProposal?.changeSet || benchmarkProposal.changeSet.status !== "proposed") return;
    setConversionBusy("benchmark");
    setError(null);
    try {
      const result = await api.rejectReportBenchmarkCandidate(workspaceId, selected.reportImportId, benchmarkProposal.candidate.candidateId, {
        digest: benchmarkProposal.changeSet.digest,
        baseRevision: benchmarkProposal.changeSet.baseRevision,
        reason: "用户在报告候选用例确认界面拒绝提案"
      });
      setBenchmarkCandidates((items) => items.map((item) => item.candidateId === result.candidate.candidateId ? result.candidate : item));
      setBenchmarkProposal({ candidate: result.candidate, changeSet: result.changeSet });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setConversionBusy(null);
    }
  }

  const frame = useMemo(() => selected
    ? projectTraceAt(selected.report.graphProjection, selected.report.trace, replaySeq)
    : null, [selected, replaySeq]);
  const visibleEvents = selected?.report.trace.filter((event) => event.seq <= replaySeq) ?? [];
  const latestSeq = selected?.report.trace.at(-1)?.seq ?? 0;
  const latestFixture = fixtures[0];
  const latestBenchmarkCandidate = benchmarkCandidates[0];
  const benchmarkPreview = benchmarkProposal?.changeSet?.preview.find((item): item is BenchmarkCaseChangePreview => item.kind === "benchmark-case") ?? null;

  return <div className={`diagnosis-page ${dragActive ? "drag-active" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }} onDrop={(event) => { event.preventDefault(); setDragActive(false); void importFiles(event.dataTransfer.files); }}>
    <header className="diagnosis-toolbar">
      <div><Bug size={19} /><span>当前 Skill · {skill.displayName}</span><strong>Bug Report 导入与复现</strong><SkillId value={skill.skillId} className="diagnosis-skill-id" /></div>
      <button className="button primary" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? <LoaderCircle size={16} className="spin" /> : <FileUp size={16} />}导入报告</button>
      <input ref={fileInput} hidden multiple type="file" accept="application/json,.json" onChange={(event) => void importFiles(event.target.files ?? undefined)} />
    </header>
    {dragActive && <div className="report-drop-overlay" aria-hidden="true"><FileUp size={24} /><strong>放下 JSON Bug Report</strong></div>}
    {error && <div className="docs-error" role="alert">{error}</div>}
    <div className="diagnosis-layout">
      <aside className="report-import-list-panel">
        <header><span>已导入报告</span><strong>{reports.length}</strong></header>
        <div className="report-import-list">{reports.map((report) => <div key={report.reportImportId} className={`report-import-item ${selected?.reportImportId === report.reportImportId ? "active" : ""}`}>
          <button className="report-import-select" onClick={() => selectReport(report)}>
            <span className={`report-match-dot ${report.match.status}`} />
            <div><strong>{report.report.skill.name}</strong><code>{shortId(sourceRunId(report))}</code><small>{matchLabel(report.match.status)}</small></div>
          </button>
          <button className="report-import-delete" title="删除导入副本" disabled={busy} onClick={() => void deleteReport(report)}><Trash2 size={14} /></button>
        </div>)}
        {!reports.length && !loading && <div className="report-import-empty">暂无导入报告</div>}</div>
      </aside>
      {loading ? <div className="runtime-loading"><LoaderCircle size={19} className="spin" />加载报告</div> : selected && frame ? <main className="report-replay-main">
        <MatchBanner report={selected} />
        <section className="report-replay-facts">
          <div><span>Skill</span><strong>{selected.report.skill.name}</strong><code>{selected.report.skill.skillId}</code></div>
          <div><span>{selected.report.source.kind === "benchmark" ? "来源 Benchmark" : "来源 Run"}</span><code>{sourceRunId(selected)}</code></div>
          <div><span>Revision</span><code>{selected.report.source.revision}</code></div>
          <div><span>症状</span><strong>{selected.report.symptoms.length}</strong></div>
        </section>
        <section className={`report-runtime-fingerprint ${selected.report.runtime.artifactFingerprint ? "recorded" : "legacy"}`}>
          <Fingerprint size={16} />
          <div><span>RuntimeArtifact 指纹</span><code title={selected.report.runtime.artifactFingerprint?.value}>{selected.report.runtime.artifactFingerprint?.value ?? "早期 1.0 报告未记录"}</code></div>
          {selected.report.runtime.artifactFingerprint && <><div><span>项目内容</span><code>{selected.report.runtime.artifactFingerprint.projectContentHash}</code></div><div><span>输入</span><code>{selected.report.runtime.artifactFingerprint.inputHash}</code></div></>}
          {selected.report.runtime.benchmarkFingerprint && <div><span>Benchmark 环境</span><code>{selected.report.runtime.benchmarkFingerprint.providerId} · {selected.report.runtime.benchmarkFingerprint.requestedModel} · {selected.report.runtime.benchmarkFingerprint.runnerImage} · {selected.report.runtime.benchmarkFingerprint.sandboxPolicyHash}</code></div>}
        </section>
        <section className="report-replay-controls" aria-label="报告回放控制">
          <button className="icon-button subtle" title="上一个事件" onClick={() => {
            const previous = [...selected.report.trace].reverse().find((event) => event.seq < replaySeq);
            if (previous) setReplaySeq(previous.seq);
          }}><ChevronLeft size={17} /></button>
          <input aria-label="报告回放时间轴" type="range" min={0} max={latestSeq} step={1} value={replaySeq} onChange={(event) => setReplaySeq(Number(event.target.value))} />
          <code>seq {replaySeq}/{latestSeq}</code>
          <button className="icon-button subtle" title="下一个事件" onClick={() => {
            const next = selected.report.trace.find((event) => event.seq > replaySeq);
            if (next) setReplaySeq(next.seq);
          }}><ChevronRight size={17} /></button>
        </section>
        <TraceGraph graph={selected.report.graphProjection} projection={frame.projection} />
        <section className="report-reuse" data-testid="report-reuse">
          <header><div><FlaskConical size={17} /><span>复用报告</span><strong>夹具与候选用例分离</strong></div></header>
          <div className="report-reuse-grid">
            <article data-testid="fixture-lane">
              <header><div><FlaskConical size={16} /><span>确定性引擎夹具</span></div><small>不计入 Benchmark</small></header>
              <p>按报告自带图重放引擎命令和事件签名，不调用模型、工具或沙箱。</p>
              {latestFixture && <div className="reuse-result"><CheckCircle2 size={14} /><span>已保存并重放一致</span><code>{latestFixture.commands.length} 命令 · {latestFixture.expectedEvents.length} 事件</code></div>}
              <button className="button secondary" disabled={Boolean(conversionBusy)} onClick={() => void createFixture()}>{conversionBusy === "fixture" ? <LoaderCircle size={15} className="spin" /> : <FlaskConical size={15} />}{latestFixture ? "重新生成夹具" : "生成并验证夹具"}</button>
            </article>
            <article data-testid="benchmark-candidate-lane">
              <header><div><FileCheck2 size={16} /><span>候选 Benchmark 用例</span></div><small>需确认 · draft</small></header>
              <p>提取实际经过的节点；业务意图、输入和期望仍由用户补充，确认前不会写入项目。</p>
              {latestBenchmarkCandidate && <div className={`reuse-result ${latestBenchmarkCandidate.status}`}><FileCheck2 size={14} /><span>{benchmarkCandidateStatusLabel(latestBenchmarkCandidate.status)}</span><code>{latestBenchmarkCandidate.case.title}</code></div>}
              {latestBenchmarkCandidate?.status === "applied"
                ? <button className="button secondary" onClick={onOpenTests}><PlayCircle size={15} />前往测试用例</button>
                : latestBenchmarkCandidate?.status === "rejected"
                  ? <button className="button secondary" disabled={Boolean(conversionBusy)} onClick={() => void createBenchmarkCandidate()}><FileCheck2 size={15} />重新生成候选用例</button>
                : latestBenchmarkCandidate
                  ? <button className="button secondary" disabled={Boolean(conversionBusy)} onClick={() => void openBenchmarkCandidate(latestBenchmarkCandidate)}><FileCheck2 size={15} />{latestBenchmarkCandidate.status === "draft" ? "继续编辑候选" : latestBenchmarkCandidate.status === "conflicted" ? "查看冲突变更" : "查看待确认变更"}</button>
                  : <button className="button secondary" disabled={Boolean(conversionBusy)} onClick={() => void createBenchmarkCandidate()}>{conversionBusy === "benchmark" ? <LoaderCircle size={15} className="spin" /> : <FileCheck2 size={15} />}生成候选用例</button>}
            </article>
          </div>
        </section>
        <section className="diagnosis-analysis">
          <header><div><SearchCheck size={17} /><span>原因分析</span><strong>{diagnosis ? `${diagnosis.candidates.length} 个候选` : "尚未分析"}</strong></div><button className="button secondary" disabled={diagnosisBusy} onClick={() => void analyze()}>{diagnosisBusy ? <LoaderCircle size={15} className="spin" /> : <SearchCheck size={15} />}{diagnosis ? "重新分析" : "分析原因"}</button></header>
          {diagnosis ? <>
            <div className="diagnosis-candidate-list">{diagnosis.candidates.map((candidate) => {
              const repair = repairs.find((item) => item.diagnosisId === diagnosis.diagnosisId && item.candidateId === candidate.candidateId);
              const verification = candidate.verification ?? { method: "inspect-trace" as const, steps: ["核对候选引用的现有证据。", "补充缺失事件后重新分析。"], successEvidence: ["新结论引用可定位的 Trace 或报告事实。"] };
              const eligibleRuns = repair?.appliedRevision ? runs.filter((run) => run.revision === repair.appliedRevision) : [];
              const eligibleBenchmarkRuns = repair?.appliedRevision ? benchmarkRuns.filter((run) => run.lineage?.relation === "post-repair" && run.lineage.repairId === repair.repairId && run.lineage.appliedRevision === repair.appliedRevision) : [];
              const selectedBenchmarkRun = eligibleBenchmarkRuns.find((run) => run.benchmarkRunId === benchmarkVerificationRunId);
              return <article key={candidate.candidateId} className={candidate.category === "insufficient-evidence" ? "insufficient" : ""}>
              <header><div><span>{categoryLabel(candidate.category)}</span><h3>{candidate.title}</h3></div><small className={`confidence ${candidate.confidence}`}>{confidenceLabel(candidate.confidence)}</small></header>
              <p>{candidate.statement}</p>
              <section><strong>证据</strong><ul>{candidate.evidence.map((evidence, index) => <li key={`${evidence.source}:${evidence.seq ?? index}:${evidence.field ?? ""}`}><code>{evidence.source}{evidence.seq ? ` · seq ${evidence.seq}` : ""}</code><span>{evidence.fact}</span></li>)}</ul></section>
              <section><strong>建议</strong><ul>{candidate.suggestions.map((suggestion) => <li key={suggestion}><span>{suggestion}</span></li>)}</ul></section>
              <section className="diagnosis-verification"><strong>验证方式 · {verificationMethodLabel(verification.method)}</strong><ul>{verification.steps.map((step) => <li key={step}><span>{step}</span></li>)}</ul><small>成功证据：{verification.successEvidence.join("；")}</small></section>
              {candidate.repair && <div className="diagnosis-repair-action">
                <div><Wrench size={14} /><span>{candidate.repair.title}</span>{repair && <small className={`repair-status ${repair.proposalStatus === "applied" ? repair.status : repair.proposalStatus}`}>{repairStatusLabel(repair)}</small>}</div>
                {!repair || repair.proposalStatus === "rejected" ? <button className="button secondary" disabled={repairBusy} onClick={() => void proposeRepair(candidate.candidateId)}><Wrench size={14} />{repair ? "重新生成修复提案" : "生成修复提案"}</button>
                  : !repair.appliedRevision ? <button className="button secondary" disabled={repairBusy} onClick={() => void openRepair(repair)}><Wrench size={14} />{repair.proposalStatus === "conflicted" ? "查看冲突提案" : "查看待确认提案"}</button>
                    : repair.status === "unverified" ? selected.report.source.kind === "benchmark" ? <div className="repair-verification-controls benchmark-repair-controls">
                      <button className="button secondary" disabled={repairBusy} onClick={() => void startPostRepairBenchmark(repair)}>{repairBusy ? <LoaderCircle size={14} className="spin" /> : <FlaskConical size={14} />}启动修复后 Benchmark</button>
                      <select aria-label="选择修复后 Benchmark" value={benchmarkVerificationRunId} onChange={(event) => setBenchmarkVerificationRunId(event.target.value)}><option value="">选择修复后 Benchmark</option>{eligibleBenchmarkRuns.map((run) => <option key={run.benchmarkRunId} value={run.benchmarkRunId}>{shortId(run.benchmarkRunId)} · {benchmarkRunStatusLabel(run.status)}</option>)}</select>
                      <button className="button secondary" disabled={selectedBenchmarkRun?.status !== "completed" || repairBusy} onClick={() => void verifyPostRepairBenchmark(repair)}><Check size={14} />验证 Benchmark</button>
                      {selectedBenchmarkRun && <small className={`benchmark-repair-run ${selectedBenchmarkRun.status}`}>修复版本 {shortId(selectedBenchmarkRun.lineage?.relation === "post-repair" ? selectedBenchmarkRun.lineage.appliedRevision : "-")} · {benchmarkRunStatusLabel(selectedBenchmarkRun.status)}{selectedBenchmarkRun.failure ? ` · ${selectedBenchmarkRun.failure.message}` : ""}</small>}
                      <button className="button ghost" onClick={onOpenTests}><PlayCircle size={14} />查看真实测试</button>
                    </div> : <div className="repair-verification-controls">
                      <button className="button secondary" onClick={onOpenTests}><PlayCircle size={14} />前往测试运行</button>
                      <select aria-label="选择修复后运行" value={verificationRunId} onChange={(event) => setVerificationRunId(event.target.value)}><option value="">选择修复后运行</option>{eligibleRuns.map((run) => <option key={run.runId} value={run.runId}>{shortId(run.runId)} · {runtimeStatusLabel(run.state.status)}</option>)}</select>
                      <button className="button secondary" disabled={!verificationRunId || repairBusy} onClick={() => void verifyRepair(repair)}><Check size={14} />验证</button>
                    </div> : repair.verification && <div className="repair-verification-evidence">{repair.verification.evidence.map((item) => <span key={item}><CheckCircle2 size={12} />{item}</span>)}</div>}
              </div>}
            </article>})}</div>
            {diagnosis.limitations.length > 0 && <div className="diagnosis-limitations"><Info size={16} /><div><strong>证据边界</strong>{diagnosis.limitations.map((limitation) => <p key={limitation}>{limitation}</p>)}</div></div>}
          </> : <div className="diagnosis-not-run"><SearchCheck size={24} /><span>分析只生成候选原因和证据，不修改 Skill，也不把建议标记为已验证。</span></div>}
        </section>
        <div className="report-replay-columns">
          <section className="report-symptoms">
            <header><span>事实症状</span><strong>{selected.report.symptoms.length}</strong></header>
            {selected.report.symptoms.length ? selected.report.symptoms.map((symptom) => <button key={`${symptom.code}:${symptom.seq}`} className={replaySeq === symptom.seq ? "active" : ""} onClick={() => setReplaySeq(symptom.seq)}>
              <ShieldAlert size={16} /><div><strong>{symptomLabel(symptom.code)}</strong><code>seq {symptom.seq} · {symptom.nodeId}</code>{symptom.requestedNodeId && <small>提交目标 {symptom.requestedNodeId}</small>}</div>
            </button>) : <p>报告没有记录拒绝或停止症状。</p>}
            {selected.report.userNote && <div className="report-user-note"><span>用户说明</span><p>{selected.report.userNote}</p></div>}
          </section>
          <aside className="runtime-events report-events"><header><span>截至当前的事件</span><strong>{visibleEvents.length}</strong></header><ol>{[...visibleEvents].reverse().map((event) => <li key={event.seq} className={event.type === "engine.reject" ? "rejected" : ""}><span>{event.seq}</span><div><strong>{event.type}</strong><code>{event.nodeId}</code><time>{formatTime(event.at)}</time></div></li>)}</ol></aside>
        </div>
      </main> : <div className="report-replay-empty"><FileUp size={34} /><h1>导入一份 Bug Report</h1><p>报告按 skillId 精确匹配；未匹配时仍可使用报告自带图查看。</p></div>}
    </div>
    {repairProposal && (() => {
      const preview = repairProposal.changeSet.preview.find((item): item is GraphChangePreview => item.kind === "graph");
      return preview ? <div className="modal-backdrop" role="presentation"><div className="modal graph-change-modal" role="dialog" aria-modal="true" aria-labelledby="diagnosis-repair-title">
        <div className="modal-header"><div><h2 id="diagnosis-repair-title">确认诊断修复提案</h2><span>{shortId(repairProposal.changeSet.baseRevision)} · 尚未修改 Skill</span></div><button className="icon-button subtle" title="关闭" disabled={repairBusy} onClick={() => setRepairProposal(null)}><X size={18} /></button></div>
        {repairProposal.changeSet.status !== "proposed" && <ProposalStateBanner status={repairProposal.changeSet.status} />}
        <GraphDiffPreview preview={preview} />
        <ChangeSetMetadata changeSet={repairProposal.changeSet} />
        <div className="modal-actions proposal-actions">{repairProposal.changeSet.status === "proposed" ? <><button className="button danger proposal-reject" disabled={repairBusy} onClick={() => void rejectRepair()}><Ban size={16} />拒绝提案</button><button className="button secondary" disabled={repairBusy} onClick={() => setRepairProposal(null)}>暂不应用</button><button className="button primary" disabled={repairBusy} onClick={() => void confirmRepair()}>{repairBusy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}确认并应用</button></> : <button className="button secondary" onClick={() => setRepairProposal(null)}>关闭</button>}</div>
      </div></div> : null;
    })()}
    {benchmarkProposal && <div className="modal-backdrop" role="presentation"><div className="modal benchmark-change-modal report-benchmark-modal" role="dialog" aria-modal="true" aria-labelledby="report-benchmark-title">
      <div className="modal-header"><div><h2 id="report-benchmark-title">{benchmarkPreview ? "确认候选 Benchmark 变更" : "补充候选 Benchmark 用例"}</h2><span>{benchmarkProposal.candidate.case.caseId} · 来源身份不可修改</span></div><button className="icon-button subtle" title="关闭" disabled={conversionBusy === "benchmark"} onClick={() => setBenchmarkProposal(null)}><X size={18} /></button></div>
      {!benchmarkPreview ? <div className="report-benchmark-editor">
        <div className="candidate-source"><Bug size={14} /><span>来源报告</span><code>{benchmarkProposal.candidate.reportId}</code><small>保存后仍为 draft</small></div>
        <label className="field"><span>标题</span><input aria-label="候选用例标题" value={benchmarkProposal.candidate.case.title} onChange={(event) => updateBenchmarkCase({ title: event.target.value })} /></label>
        <label className="field"><span>业务意图</span><textarea aria-label="候选用例业务意图" rows={3} value={benchmarkProposal.candidate.case.intent} onChange={(event) => updateBenchmarkCase({ intent: event.target.value })} /></label>
        <label className="field"><span>期望路径（每行一个节点）</span><textarea aria-label="候选用例期望路径" spellCheck={false} rows={5} value={benchmarkProposal.candidate.case.expected.path.nodeIds.join("\n")} onChange={(event) => updateBenchmarkExpected({ path: { ...benchmarkProposal.candidate.case.expected.path, nodeIds: event.target.value.split(/[,\n]/u).map((item) => item.trim()).filter(Boolean) } })} /></label>
        <div className="report-benchmark-terminal">
          <label className="field"><span>期望终态</span><select aria-label="候选用例期望终态" value={benchmarkProposal.candidate.case.expected.terminal?.status ?? ""} onChange={(event) => setBenchmarkTerminal(event.target.value as "" | "completed" | "stopped")}><option value="">暂不指定</option><option value="completed">completed</option><option value="stopped">stopped</option></select></label>
          <label className="field"><span>终态节点</span><input aria-label="候选用例终态节点" disabled={!benchmarkProposal.candidate.case.expected.terminal} value={benchmarkProposal.candidate.case.expected.terminal?.nodeId ?? ""} onChange={(event) => updateBenchmarkExpected({ terminal: { status: benchmarkProposal.candidate.case.expected.terminal?.status ?? "completed", ...(event.target.value ? { nodeId: event.target.value } : {}) } })} /></label>
        </div>
        <label className="field"><span>人工补充说明</span><textarea aria-label="候选用例补充说明" rows={3} value={benchmarkProposal.candidate.case.notes ?? ""} onChange={(event) => updateBenchmarkCase({ notes: event.target.value })} /></label>
      </div> : <>
        {benchmarkProposal.changeSet!.status !== "proposed" && <ProposalStateBanner status={benchmarkProposal.changeSet!.status} />}
        <div className="change-summary"><span>创建 draft 用例</span><code>{shortId(benchmarkProposal.changeSet!.baseRevision)}</code></div>
        <div className="diff-grid benchmark-diff-grid"><div><div className="diff-heading">应用前</div><pre>{benchmarkPreview.before || "（项目中不存在）"}</pre></div><div><div className="diff-heading">应用后</div><pre>{benchmarkPreview.after}</pre></div></div>
        {benchmarkPreview.lint.length > 0 && <div className="benchmark-preview-warnings">{benchmarkPreview.lint.map((issue, index) => <span key={`${issue.code}-${index}`}><AlertTriangle size={13} />{issue.message}</span>)}</div>}
        <ChangeSetMetadata changeSet={benchmarkProposal.changeSet!} />
      </>}
      <div className="modal-actions proposal-actions">{benchmarkPreview && benchmarkProposal.changeSet!.status !== "proposed" ? <button className="button secondary" onClick={() => setBenchmarkProposal(null)}>关闭</button> : <>{benchmarkPreview && <button className="button danger proposal-reject" disabled={conversionBusy === "benchmark"} onClick={() => void rejectBenchmarkCandidate()}><Ban size={16} />拒绝提案</button>}<button className="button secondary" disabled={conversionBusy === "benchmark"} onClick={() => setBenchmarkProposal(null)}>{benchmarkPreview ? "暂不应用" : "取消"}</button><button className="button primary" data-testid={benchmarkPreview ? "confirm-benchmark-candidate" : "propose-benchmark-candidate"} disabled={conversionBusy === "benchmark" || !benchmarkProposal.candidate.case.title.trim()} onClick={() => void (benchmarkPreview ? confirmBenchmarkCandidate() : proposeBenchmarkCandidate())}>{conversionBusy === "benchmark" ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{benchmarkPreview ? "确认并加入项目" : "生成 ChangeSet"}</button></>}</div>
    </div></div>}
  </div>;
}

function MatchBanner({ report }: { report: ImportedBugReport }) {
  const status = report.match.status;
  const Icon = status === "matched" ? CheckCircle2 : AlertTriangle;
  const text = status === "matched" ? "skillId 与 contentHash 精确匹配当前 Workspace 成员"
    : status === "fingerprint-mismatch" ? "skillId 匹配，但当前内容指纹不同；使用报告自带图复现"
      : status === "target-unavailable" ? "skillId 匹配，但当前 Skill 不可用；使用报告自带图复现"
        : "Workspace 中没有相同 skillId；未按名称自动绑定";
  return <div className={`report-match-banner ${status}`} role="status"><Icon size={16} /><span>{text}</span>{report.match.currentContentHash && <code title={report.match.currentContentHash}>{shortId(report.match.currentContentHash)}</code>}</div>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function matchLabel(status: ImportedBugReport["match"]["status"]): string {
  return { matched: "精确匹配", "fingerprint-mismatch": "指纹不同", "skill-missing": "Skill 缺失", "target-unavailable": "目标不可用" }[status];
}

function symptomLabel(code: ImportedBugReport["report"]["symptoms"][number]["code"]): string {
  return { transition_rejected: "拒绝跳转", run_stopped: "运行停止", assertion_failed: "断言失败", assertion_inconclusive: "断言待定", benchmark_failed: "技术失败" }[code];
}

function categoryLabel(category: DiagnosisRecord["candidates"][number]["category"]): string {
  return { "invalid-transition": "非法跳转", "graph-reference": "图引用", "condition-evaluation": "条件计算", "document-context": "文档上下文", "run-control": "运行控制", "benchmark-assertion": "Benchmark 断言", "benchmark-execution": "Benchmark 执行", "model-output": "模型输出", "tool-execution": "工具执行", environment: "运行环境", "insufficient-evidence": "证据不足" }[category];
}

function verificationMethodLabel(method: DiagnosisRecord["candidates"][number]["verification"]["method"]): string {
  return { "inspect-trace": "补充证据", "rerun-runtime": "新运行验证", "rerun-benchmark": "真实 Benchmark", "check-environment": "环境自检后重跑" }[method];
}

function sourceRunId(report: ImportedBugReport): string {
  return report.report.source.benchmarkRunId ?? report.report.source.runId;
}

function confidenceLabel(confidence: DiagnosisRecord["candidates"][number]["confidence"]): string {
  return { high: "高置信事实", medium: "中等候选", low: "低置信" }[confidence];
}

function repairStatusLabel(repair: DiagnosisRepairRecord): string {
  if (repair.proposalStatus === "rejected") return "提案已拒绝";
  if (repair.proposalStatus === "conflicted") return "提案已冲突";
  if (!repair.appliedRevision) return "待用户确认";
  return { unverified: "未验证", verified: "已验证", failed: "验证失败" }[repair.status];
}

function benchmarkCandidateStatusLabel(status: ReportBenchmarkCandidate["status"]): string {
  return { draft: "等待人工补充", "changeset-created": "ChangeSet 待确认", rejected: "ChangeSet 已拒绝", conflicted: "ChangeSet 已冲突", applied: "已加入项目 · draft" }[status];
}

function ProposalStateBanner({ status }: { status: ProjectChangeSet["status"] }) {
  const text = status === "rejected" ? "该 ChangeSet 已被拒绝，不会修改项目；需要调整时请重新生成提案。"
    : status === "conflicted" ? "项目事实已变化，该 ChangeSet 已冲突且不可应用；请返回并基于当前版本重新生成。"
      : status === "applied" ? "该 ChangeSet 已应用。" : "等待用户确认";
  return <div className={`proposal-state-banner ${status}`} role="status">{status === "rejected" ? <Ban size={15} /> : <AlertTriangle size={15} />}<span>{text}</span></div>;
}

function runtimeStatusLabel(status: ProjectRun["state"]["status"]): string {
  return { running: "运行中", paused: "已暂停", stopped: "已停止", completed: "已完成" }[status];
}

function benchmarkRunStatusLabel(status: BenchmarkRunRecord["status"]): string {
  return { queued: "排队中", preparing: "准备中", running: "运行中", completed: "已完成", failed: "执行失败", blocked: "条件阻断", cancelled: "已取消" }[status];
}

function shortId(value: string): string {
  return value.length > 28 ? `${value.slice(0, 17)}…${value.slice(-7)}` : value;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError && Array.isArray(cause.details)) {
    const first = cause.details[0] as { path?: string; message?: string } | undefined;
    return first ? `${first.path ?? "报告"}：${first.message ?? cause.message}` : cause.message;
  }
  return cause instanceof Error ? cause.message : "报告导入失败";
}
