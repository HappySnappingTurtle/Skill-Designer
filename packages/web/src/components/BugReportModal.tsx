import { AlertTriangle, Bug, CheckCircle2, Download, FileText, History, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  BugReportRecord,
  BugReportSanitizationMode,
  BenchmarkRunRecord,
  ProjectRunView,
  WorkspaceMember
} from "@skill-designer/engine";
import { api, ApiError } from "../api";
import { Modal } from "./Modal";

type BugReportModalProps = {
  open: boolean;
  workspaceId: string;
  skill: WorkspaceMember;
  onClose: () => void;
  onOpenDiagnosis?: () => void;
} & ({ view: ProjectRunView; benchmarkRun?: never } | { view?: never; benchmarkRun: BenchmarkRunRecord });

export function BugReportModal({ open, workspaceId, skill, view, benchmarkRun, onClose, onOpenDiagnosis }: BugReportModalProps) {
  const [mode, setMode] = useState<BugReportSanitizationMode>("default");
  const [userNote, setUserNote] = useState("");
  const [record, setRecord] = useState<BugReportRecord | null>(null);
  const [history, setHistory] = useState<BugReportRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceId = benchmarkRun?.benchmarkRunId ?? view?.run.runId ?? "";
  const matchesCurrentSource = (item: BugReportRecord) => benchmarkRun
    ? item.report.source.benchmarkRunId === benchmarkRun.benchmarkRunId
    : item.runId === view?.run.runId;
  const rawProjection = useMemo(() => JSON.stringify(benchmarkRun ? {
    benchmarkRun: {
      benchmarkRunId: benchmarkRun.benchmarkRunId,
      caseId: benchmarkRun.caseId,
      status: benchmarkRun.status,
      automaticVerdict: benchmarkRun.automaticVerdict,
      fingerprint: benchmarkRun.fingerprint,
      usage: benchmarkRun.usage
    },
    assertions: benchmarkRun.assertions,
    humanReviews: benchmarkRun.humanReviews,
    trace: benchmarkRun.events
  } : {
    run: {
      runId: view!.run.runId,
      revision: view!.run.revision,
      artifactId: view!.run.artifactId,
      status: view!.run.state.status
    },
    trace: view!.run.events,
    graph: view!.artifact?.graph ?? null
  }, null, 2), [benchmarkRun, view]);

  useEffect(() => {
    if (!open) return;
    setMode("default");
    setUserNote("");
    setRecord(null);
    setHistory([]);
    setError(null);
    setBusy(true);
    void api.listBugReports(skill.projectId, workspaceId).then((items) => {
      setHistory(items);
      setRecord(items.find(matchesCurrentSource) ?? null);
    }).catch((cause) => setError(messageOf(cause))).finally(() => setBusy(false));
  }, [open, sourceId]);

  async function preview() {
    setBusy(true);
    setError(null);
    try {
      const created = await (benchmarkRun
        ? api.createBenchmarkBugReport(skill.projectId, benchmarkRun.benchmarkRunId, {
          workspaceId,
          sanitizationMode: mode,
          userNote
        })
        : api.createBugReport(skill.projectId, view!.run.runId, {
        workspaceId,
        sanitizationMode: mode,
        userNote
        }));
      setRecord(created);
      setHistory((items) => [created, ...items]);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!record) return;
    setBusy(true);
    setError(null);
    try {
      const ready = await api.confirmBugReport(record.reportId, record.digest);
      setRecord(ready);
      setHistory((items) => items.map((item) => item.reportId === ready.reportId ? ready : item));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function download(format: "json" | "markdown") {
    if (!record || record.status !== "ready") return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.downloadBugReport(record.reportId, format);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: BugReportRecord) {
    if (!window.confirm(`删除报告记录 ${item.reportId}？已加入诊断的独立副本不会删除。`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteBugReport(item.reportId, workspaceId);
      setHistory((items) => items.filter((candidate) => candidate.reportId !== item.reportId));
      if (record?.reportId === item.reportId) setRecord(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openDiagnosis() {
    if (!record || record.status !== "ready" || !onOpenDiagnosis) return;
    setBusy(true);
    setError(null);
    try {
      await api.importStoredBugReport(record.reportId, workspaceId);
      onClose();
      onOpenDiagnosis();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return <Modal title="生成 Bug Report" open={open} onClose={onClose} className="bug-report-modal">
    <div className="bug-report-body">
      {error && <div className="import-error" role="alert">{error}</div>}
      <section className="bug-report-settings">
        <label className="field"><span>脱敏模式</span><select aria-label="报告脱敏模式" value={mode} disabled={Boolean(record)} onChange={(event) => setMode(event.target.value as BugReportSanitizationMode)}>
          <option value="default">默认</option><option value="strict">严格</option><option value="off">关闭可选脱敏</option>
        </select></label>
        <label className="field"><span>用户说明</span><textarea aria-label="报告用户说明" rows={3} maxLength={4000} disabled={Boolean(record)} value={userNote} onChange={(event) => setUserNote(event.target.value)} placeholder="描述观察到的现象，不需要判断根因" /></label>
      </section>
      <div className="report-security-note"><ShieldCheck size={16} /><span>任何模式都强制移除密钥、令牌、密码和授权字段。报告只记录已观测事实，不声明根因或修复结果。</span></div>
      <section className="bug-report-history">
        <header><div><History size={15} /><strong>报告记录</strong><span>{history.length}</span></div><button className="icon-button subtle" title="新建当前来源报告" disabled={busy} onClick={() => { setRecord(null); setMode("default"); setUserNote(""); }}><Plus size={15} /></button></header>
        {history.length ? <div>{history.map((item) => <button key={item.reportId} className={record?.reportId === item.reportId ? "selected" : ""} onClick={() => setRecord(item)}>
          <span className={`report-history-status ${item.status}`}>{item.status === "ready" ? "可下载" : "待确认"}</span>
          <code>{item.report.source.kind === "benchmark" ? item.report.source.benchmarkRunId : item.runId}</code>
          <small>{item.sanitizationMode === "strict" ? "严格" : item.sanitizationMode === "default" ? "默认" : "可选关闭"} · {formatTime(item.createdAt)}</small>
          {matchesCurrentSource(item) && <em>当前来源</em>}
          <span role="button" tabIndex={0} title="删除报告记录" onClick={(event) => { event.stopPropagation(); void remove(item); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); void remove(item); } }}><Trash2 size={14} /></span>
        </button>)}</div> : <p>当前 Skill 暂无报告记录</p>}
      </section>
      {record ? <>
        <section className="report-facts">
          <div><span>格式</span><strong>{record.report.reportVersion}</strong></div>
          <div><span>事件</span><strong>{record.report.trace.length}</strong></div>
          <div><span>症状</span><strong>{record.report.symptoms.length}</strong></div>
          <div><span>脱敏字段</span><strong>{record.report.sanitization.redactedFieldCount}</strong></div>
        </section>
        {!record.report.coverage.tools && <div className="report-coverage-warning"><AlertTriangle size={15} />本次运行没有观测到工具事件；报告不会推测外部 Agent 绕过引擎的行为。</div>}
        <div className="bug-report-preview-grid">
          <section><header><Bug size={15} /><strong>本地原始投影</strong><span>不下载</span></header><pre>{matchesCurrentSource(record) ? rawProjection : "该历史报告不属于当前来源。请返回对应运行查看本地原始投影。"}</pre></section>
          <section><header><ShieldCheck size={15} /><strong>导出预览</strong><span>{modeLabel(record.sanitizationMode)}</span></header><pre>{JSON.stringify(record.report, null, 2)}</pre></section>
        </div>
        <div className={`report-ready-state ${record.status}`}>
          {record.status === "ready" ? <CheckCircle2 size={17} /> : <Bug size={17} />}
          <span>{record.status === "ready" ? `${record.fileName} / ${record.markdownFileName} · ${formatBytes((record.fileSize ?? 0) + (record.markdownFileSize ?? 0))}` : "预览已冻结；确认后从同一脱敏内容生成 JSON 与 Markdown"}</span>
        </div>
      </> : <div className="bug-report-empty"><Bug size={28} /><strong>先生成可检查的报告预览</strong><span>报告绑定当前运行和 RuntimeArtifact，不读取后续项目修改。</span></div>}
    </div>
    <footer className="modal-actions">
      <button className="button secondary" onClick={onClose} disabled={busy}>关闭</button>
      {!record ? <button className="button primary" onClick={() => void preview()} disabled={busy}>{busy ? <RefreshCw size={15} className="spin" /> : <Bug size={15} />}生成预览</button>
        : record.status === "proposed" ? <>
          <button className="button secondary" onClick={() => setRecord(null)} disabled={busy}>重新设置</button>
          <button className="button primary" onClick={() => void confirm()} disabled={busy}>{busy ? <RefreshCw size={15} className="spin" /> : <ShieldCheck size={15} />}确认并生成</button>
        </> : <>
          <button className="button secondary" onClick={() => void download("json")} disabled={busy}><Download size={15} />下载 JSON</button>
          <button className="button secondary" onClick={() => void download("markdown")} disabled={busy}><FileText size={15} />下载 Markdown</button>
          {onOpenDiagnosis && <button className="button primary" data-testid="report-open-diagnosis" onClick={() => void openDiagnosis()} disabled={busy}><Bug size={15} />{busy ? "加入诊断" : "加入并打开诊断"}</button>}
        </>}
    </footer>
  </Modal>;
}

function modeLabel(mode: BugReportSanitizationMode): string {
  return { off: "关闭可选脱敏", default: "默认脱敏", strict: "严格脱敏" }[mode];
}

function formatBytes(size: number): string {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KiB`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function messageOf(cause: unknown): string {
  return cause instanceof ApiError || cause instanceof Error ? cause.message : "报告操作失败";
}
