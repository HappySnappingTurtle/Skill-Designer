import {
  AlertTriangle,
  Ban,
  Check,
  FileCheck2,
  FlaskConical,
  LoaderCircle,
  Plus,
  RefreshCw,
  Route,
  Save,
  Search,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  lintBenchmarkCase,
  type BenchmarkCase,
  type BenchmarkCaseChangePreview,
  type BenchmarkCaseEntry,
  type BenchmarkCaseIssue,
  type ProjectBenchmarkCase,
  type ProjectChangeSet,
  type ProjectRun,
  type RuntimeBenchmarkCandidate,
  type SkillGraph,
  type WorkspaceMember
} from "@skill-designer/engine";
import { api, ApiError } from "../api";
import { ChangeSetMetadata } from "./ChangeSetMetadata";
import { ChangeSetConflictPanel, readConflictedChangeSet } from "./ChangeSetConflictPanel";

interface Props {
  workspaceId: string;
  skill: WorkspaceMember;
  onProjectChanged: () => Promise<void>;
}

interface JsonTexts {
  initialVariables: string;
  userReplies: string;
  expectedVariables: string;
  artifacts: string;
  toolResults: string;
}

export function BenchmarkCasesView({ workspaceId, skill, onProjectChanged }: Props) {
  const [entries, setEntries] = useState<BenchmarkCaseEntry[]>([]);
  const [graph, setGraph] = useState<SkillGraph | null>(null);
  const [activeRevision, setActiveRevision] = useState(skill.activeRevision);
  const [loaded, setLoaded] = useState<ProjectBenchmarkCase | null>(null);
  const [draft, setDraft] = useState<BenchmarkCase | null>(null);
  const [texts, setTexts] = useState<JsonTexts | null>(null);
  const [baseline, setBaseline] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changeSet, setChangeSet] = useState<ProjectChangeSet | null>(null);
  const [runtimeCandidateOpen, setRuntimeCandidateOpen] = useState(false);
  const [runtimeCandidateRuns, setRuntimeCandidateRuns] = useState<ProjectRun[]>([]);
  const [runtimeCandidateRunId, setRuntimeCandidateRunId] = useState("");
  const [runtimeCandidate, setRuntimeCandidate] = useState<RuntimeBenchmarkCandidate | null>(null);
  const [runtimeCandidateLoading, setRuntimeCandidateLoading] = useState(false);
  const [query, setQuery] = useState("");
  const locallyAppliedRevision = useRef("");

  useEffect(() => {
    const revisionKey = `${skill.projectId}:${skill.activeRevision}`;
    if (locallyAppliedRevision.current === revisionKey) {
      locallyAppliedRevision.current = "";
      return;
    }
    setEntries([]);
    setGraph(null);
    setLoaded(null);
    setDraft(null);
    setTexts(null);
    setBaseline("");
    setError(null);
    setChangeSet(null);
    setRuntimeCandidate(null);
    setRuntimeCandidateOpen(false);
    setQuery("");
    void loadIndex();
  }, [skill.projectId, skill.activeRevision]);

  async function loadIndex(preferredCaseId?: string) {
    setLoading(true);
    setError(null);
    try {
      const [items, graphView] = await Promise.all([
        api.listBenchmarkCases(skill.projectId),
        api.getProjectGraph(skill.projectId)
      ]);
      setEntries(items);
      setGraph(graphView.graph);
      setActiveRevision(graphView.activeRevision);
      const target = preferredCaseId && items.some((item) => item.caseId === preferredCaseId)
        ? preferredCaseId
        : items[0]?.caseId;
      if (target) await openCase(target, false);
      else {
        setLoaded(null);
        setDraft(null);
        setTexts(null);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  async function openCase(caseId: string, guardDirty = true) {
    if (guardDirty && dirty && !window.confirm("当前测试用例有未确认修改，确定放弃并切换吗？")) return;
    setLoading(true);
    setError(null);
    try {
      const next = await api.readBenchmarkCase(skill.projectId, caseId);
      const nextTexts = textsFromCase(next.case);
      setLoaded(next);
      setDraft(structuredClone(next.case));
      setTexts(nextTexts);
      setActiveRevision(next.activeRevision);
      setBaseline(caseSnapshot(next.case, nextTexts));
      setChangeSet(null);
      setRuntimeCandidate(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  function createDraft() {
    if (dirty && !window.confirm("当前测试用例有未确认修改，确定放弃并新建吗？")) return;
    if (!graph) return;
    const caseId = `case-${crypto.randomUUID()}`;
    const initial = emptyCase(caseId, skill.skillId, graph);
    const initialTexts = textsFromCase(initial);
    setLoaded(null);
    setDraft(initial);
    setTexts(initialTexts);
    setBaseline("");
    setError(null);
    setChangeSet(null);
    setRuntimeCandidate(null);
  }

  const materialized = useMemo(() => draft && texts ? materializeCase(draft, texts) : { value: null, issues: [] as BenchmarkCaseIssue[] }, [draft, texts]);
  const lint = useMemo(() => {
    if (!graph || !materialized.value) return materialized.issues;
    return [...materialized.issues, ...lintBenchmarkCase(materialized.value, graph, skill.skillId)];
  }, [graph, materialized, skill.skillId]);
  const errorCount = lint.filter((issue) => issue.severity === "error").length;
  const warningCount = lint.filter((issue) => issue.severity === "warning").length;
  const dirty = Boolean(draft && texts && caseSnapshot(draft, texts) !== baseline);
  const terminalRuntimeRuns = useMemo(
    () => runtimeCandidateRuns.filter((run) => run.state.status === "completed" || run.state.status === "stopped"),
    [runtimeCandidateRuns]
  );
  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return entries;
    return entries.filter((entry) => [entry.title, entry.caseId, ...entry.tags].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalized)));
  }, [entries, query]);

  async function openRuntimeCandidateDialog() {
    if (dirty && !window.confirm("当前测试用例有未确认修改，确定放弃并从运行生成候选吗？")) return;
    setRuntimeCandidateOpen(true);
    setRuntimeCandidateLoading(true);
    setError(null);
    try {
      const runs = await api.listRuns(skill.projectId);
      setRuntimeCandidateRuns(runs);
      const firstTerminal = runs.find((run) => run.state.status === "completed" || run.state.status === "stopped");
      setRuntimeCandidateRunId(firstTerminal?.runId ?? "");
    } catch (cause) {
      setRuntimeCandidateOpen(false);
      setError(messageOf(cause));
    } finally {
      setRuntimeCandidateLoading(false);
    }
  }

  async function generateRuntimeCandidate() {
    if (!runtimeCandidateRunId) return;
    setRuntimeCandidateLoading(true);
    setError(null);
    try {
      const candidate = await api.createRuntimeBenchmarkCandidate(skill.projectId, runtimeCandidateRunId, workspaceId);
      const candidateTexts = textsFromCase(candidate.case);
      setLoaded(null);
      setDraft(structuredClone(candidate.case));
      setTexts(candidateTexts);
      setBaseline("");
      setChangeSet(null);
      setRuntimeCandidate(candidate);
      setRuntimeCandidateOpen(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setRuntimeCandidateLoading(false);
    }
  }

  async function proposeWrite() {
    if (!materialized.value || !dirty || errorCount) return;
    setBusy(true);
    setError(null);
    try {
      setChangeSet(await api.createChangeSet(skill.projectId, {
        workspaceId,
        baseRevision: activeRevision,
        reason: loaded ? `更新测试用例 ${materialized.value.title}` : `创建测试用例 ${materialized.value.title || materialized.value.caseId}`,
        ...(runtimeCandidate ? {
          source: { kind: "runtime" as const, sourceId: runtimeCandidate.source.runId, label: "运行候选用例" },
          evidence: [{ kind: "runtime" as const, ref: runtimeCandidate.source.runId, summary: `来自冻结运行，RuntimeArtifact ${runtimeCandidate.source.artifactId}` }]
        } : {}),
        operations: [{ op: "benchmark.case.write", target: materialized.value.caseId, value: materialized.value }]
      }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function proposeDelete() {
    if (!loaded || !draft) return;
    setBusy(true);
    setError(null);
    try {
      setChangeSet(await api.createChangeSet(skill.projectId, {
        workspaceId,
        baseRevision: activeRevision,
        reason: `删除测试用例 ${draft.title}`,
        operations: [{ op: "benchmark.case.delete", target: draft.caseId }]
      }));
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
      setChangeSet(null);
      setActiveRevision(applied.activeRevision);
      locallyAppliedRevision.current = `${skill.projectId}:${applied.activeRevision}`;
      await onProjectChanged();
      if (applied.deletedBenchmarkCaseId) await loadIndex();
      else if (applied.benchmarkCase) await loadIndex(applied.benchmarkCase.case.caseId);
      else throw new Error("服务器未返回已应用的测试用例");
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
      await api.rejectChangeSet(changeSet.changeSetId, { digest: changeSet.digest, baseRevision: changeSet.baseRevision, reason: "用户在测试用例确认界面拒绝提案" });
      setChangeSet(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const preview = useMemo<BenchmarkCaseChangePreview | null>(() => {
    const value = changeSet?.preview[0];
    return value?.kind === "benchmark-case" ? value : null;
  }, [changeSet]);

  return <div className="benchmark-page">
    <header className="test-toolbar">
      <div className="test-title"><FileCheck2 size={19} /><div><span>{skill.displayName}</span><strong>测试用例</strong></div></div>
      <div className="test-actions">
        <div className={`lint-summary ${errorCount ? "has-error" : ""}`} title={`${errorCount} 个错误，${warningCount} 个警告`}>
          {errorCount ? <AlertTriangle size={15} /> : <FileCheck2 size={15} />}
          <span>{errorCount ? `${errorCount} 错误` : warningCount ? `${warningCount} 警告` : "校验通过"}</span>
        </div>
        <button className="icon-button" title="从运行生成测试用例" aria-label="从运行生成测试用例" disabled={loading} onClick={() => void openRuntimeCandidateDialog()}><Route size={17} /></button>
        <button className="icon-button" title="新建测试用例" aria-label="新建测试用例" disabled={!graph || loading} onClick={createDraft}><Plus size={17} /></button>
        <button className="button primary" disabled={!dirty || Boolean(errorCount) || busy} onClick={() => void proposeWrite()}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}预览并保存用例
        </button>
      </div>
    </header>

    {error && <div className="docs-error" role="alert">{error}<button title="关闭" onClick={() => setError(null)}><X size={15} /></button></div>}

    <div className="benchmark-layout">
      <aside className="benchmark-case-list-panel">
        <div className="run-list-heading"><span>项目用例</span><strong>{query ? `${filteredEntries.length}/${entries.length}` : entries.length}</strong></div>
        <label className="benchmark-case-search"><Search size={14} /><input aria-label="搜索测试用例" placeholder="搜索标题、ID 或标签" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="benchmark-case-list">
          {filteredEntries.map((entry) => <button key={entry.caseId} className={draft?.caseId === entry.caseId ? "active" : ""} onClick={() => void openCase(entry.caseId)}>
            <span className={`case-status ${entry.status}`}>{entry.status === "ready" ? "就绪" : "草稿"}</span>
            <div><strong>{entry.title}</strong><code>{shortId(entry.caseId)}</code>{entry.tags.length > 0 && <small>{entry.tags.join(" · ")}</small>}</div>
            {!entry.valid && <AlertTriangle size={15} />}
          </button>)}
          {!entries.length && !loading && <div className="run-list-empty">暂无测试用例</div>}
          {entries.length > 0 && filteredEntries.length === 0 && <div className="run-list-empty">没有匹配用例</div>}
        </div>
      </aside>

      {loading && !draft ? <div className="runtime-loading"><LoaderCircle size={20} className="spin" />加载测试用例</div> : draft && texts && graph ? (
        <main className="benchmark-editor">
          {runtimeCandidate && <div className="runtime-case-source"><Route size={16} /><div><strong>从运行观察生成</strong><span>路径、终态和变量是观察结果，不是自动认定的正确答案。请审阅后再提交 ChangeSet。</span></div><code title={runtimeCandidate.source.runId}>{shortId(runtimeCandidate.source.runId)}</code></div>}
          <section className="benchmark-form-section identity">
            <div className="benchmark-section-heading"><div><span>用例</span><h1>{draft.title || "未命名测试用例"}</h1></div><code>{shortId(draft.caseId)}</code></div>
            <div className="benchmark-form-grid two">
              <label className="field"><span>标题</span><input aria-label="测试用例标题" value={draft.title} onChange={(event) => updateDraft(setDraft, { title: event.target.value })} /></label>
              <label className="field"><span>状态</span><select aria-label="测试用例状态" value={draft.status} onChange={(event) => updateDraft(setDraft, { status: event.target.value as BenchmarkCase["status"] })}><option value="draft">草稿</option><option value="ready">就绪</option></select></label>
            </div>
            <label className="field"><span>测试意图</span><textarea aria-label="测试意图" rows={3} value={draft.intent} onChange={(event) => updateDraft(setDraft, { intent: event.target.value })} /></label>
            <label className="field"><span>标签</span><input aria-label="测试用例标签" placeholder="smoke, checkout" value={draft.tags.join(", ")} onChange={(event) => updateDraft(setDraft, { tags: splitComma(event.target.value) })} /></label>
          </section>

          <section className="benchmark-form-section">
            <div className="benchmark-section-heading"><div><span>输入</span><h2>Fixture</h2></div></div>
            <div className="benchmark-form-grid two">
              <label className="field"><span>初始变量（JSON 对象）</span><textarea aria-label="用例初始变量" rows={7} spellCheck={false} value={texts.initialVariables} onChange={(event) => setTexts({ ...texts, initialVariables: event.target.value })} /></label>
              <label className="field"><span>预设用户回答（JSON 数组）</span><textarea aria-label="预设用户回答" rows={7} spellCheck={false} value={texts.userReplies} onChange={(event) => setTexts({ ...texts, userReplies: event.target.value })} /></label>
            </div>
          </section>

          <section className="benchmark-form-section">
            <div className="benchmark-section-heading"><div><span>断言</span><h2>路径与终态</h2></div></div>
            <div className="benchmark-form-grid three">
              <label className="field"><span>路径模式</span><select aria-label="期望路径模式" value={draft.expected.path.mode} onChange={(event) => updateExpected(draft, setDraft, { path: { ...draft.expected.path, mode: event.target.value as BenchmarkCase["expected"]["path"]["mode"] } })}><option value="subsequence">subsequence</option><option value="exact">exact</option></select></label>
              <label className="field"><span>终态</span><select aria-label="期望终态" value={draft.expected.terminal?.status ?? ""} onChange={(event) => updateTerminal(draft, setDraft, event.target.value ? { status: event.target.value as "completed" | "stopped", ...(draft.expected.terminal?.nodeId ? { nodeId: draft.expected.terminal.nodeId } : {}) } : undefined)}><option value="">不校验</option><option value="completed">完成</option><option value="stopped">停止</option></select></label>
              <label className="field"><span>终态节点</span><select aria-label="期望终态节点" value={draft.expected.terminal?.nodeId ?? ""} disabled={!draft.expected.terminal} onChange={(event) => draft.expected.terminal && updateTerminal(draft, setDraft, { status: draft.expected.terminal.status, ...(event.target.value ? { nodeId: event.target.value } : {}) })}><option value="">不校验</option>{graph.nodes.map((node) => <option key={node.id} value={node.id}>{node.title} · {node.id}</option>)}</select></label>
            </div>
            <label className="field"><span>期望路径节点（每行一个 ID）</span><textarea aria-label="期望路径节点" rows={6} spellCheck={false} value={draft.expected.path.nodeIds.join("\n")} onChange={(event) => updateExpected(draft, setDraft, { path: { ...draft.expected.path, nodeIds: splitLines(event.target.value) } })} /></label>
            <div className="benchmark-form-grid two">
              <label className="field"><span>期望变量（JSON 对象）</span><textarea aria-label="期望变量" rows={7} spellCheck={false} value={texts.expectedVariables} onChange={(event) => setTexts({ ...texts, expectedVariables: event.target.value })} /></label>
              <label className="field"><span>禁止副作用（每行一项）</span><textarea aria-label="禁止副作用" rows={7} value={draft.expected.forbiddenEffects.join("\n")} onChange={(event) => updateExpected(draft, setDraft, { forbiddenEffects: splitLines(event.target.value) })} /></label>
              <label className="field"><span>产物断言（JSON 数组）</span><textarea aria-label="产物断言" rows={7} spellCheck={false} value={texts.artifacts} onChange={(event) => setTexts({ ...texts, artifacts: event.target.value })} /></label>
              <label className="field"><span>工具结果断言（JSON 数组）</span><textarea aria-label="工具结果断言" rows={7} spellCheck={false} value={texts.toolResults} onChange={(event) => setTexts({ ...texts, toolResults: event.target.value })} /></label>
            </div>
            <label className="field"><span>备注</span><textarea aria-label="测试用例备注" rows={3} value={draft.notes ?? ""} onChange={(event) => updateDraft(setDraft, { notes: event.target.value })} /></label>
          </section>

          {lint.length > 0 && <section className="benchmark-lint-list"><strong>持续检查</strong>{lint.map((issue, index) => <div key={`${issue.path}-${issue.code}-${index}`} className={issue.severity}><AlertTriangle size={14} /><span><code>{issue.path}</code>{issue.message}</span></div>)}</section>}
          {loaded && <div className="benchmark-delete"><button className="button danger" disabled={busy} onClick={() => void proposeDelete()}><Trash2 size={16} />删除测试用例</button></div>}
        </main>
      ) : (
        <div className="runtime-empty"><FlaskConical size={32} /><h1>创建第一个测试用例</h1><button className="button primary" onClick={createDraft}><Plus size={16} />新建测试用例</button></div>
      )}
    </div>

    {changeSet && preview && <div className="modal-backdrop" role="presentation">
      <div className="modal benchmark-change-modal" role="dialog" aria-modal="true" aria-label="确认测试用例变更">
        <div className="modal-header"><div><h2>{changeSet.status === "conflicted" ? "处理测试用例提案冲突" : "确认测试用例变更"}</h2><span>{preview.target}</span></div><button className="icon-button subtle" title="关闭" disabled={busy} onClick={() => setChangeSet(null)}><X size={18} /></button></div>
        {changeSet.status === "conflicted" && <ChangeSetConflictPanel changeSet={changeSet} />}
        <div className="change-summary"><span>{actionLabel(preview.action)}</span><code>{shortRevision(changeSet.baseRevision)}</code></div>
        <div className="diff-grid benchmark-diff-grid"><div><div className="diff-heading">应用前</div><pre>{preview.before || "（文件不存在）"}</pre></div><div><div className="diff-heading">应用后</div><pre>{preview.after || "（删除文件）"}</pre></div></div>
        {preview.lint.length > 0 && <div className="benchmark-preview-warnings">{preview.lint.map((issue, index) => <span key={`${issue.code}-${index}`}><AlertTriangle size={13} />{issue.message}</span>)}</div>}
        <ChangeSetMetadata changeSet={changeSet} />
        {changeSet.status === "conflicted"
          ? <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setChangeSet(null)}>关闭并保留当前项目</button><button className="button primary" disabled={busy} onClick={() => void reproposeConflict()}>{busy ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}基于当前版本重新预演</button></div>
          : <div className="modal-actions proposal-actions"><button className="button danger proposal-reject" disabled={busy} onClick={() => void rejectProposal()}><Ban size={16} />拒绝提案</button><button className="button secondary" disabled={busy} onClick={() => setChangeSet(null)}>返回编辑</button><button className={`button ${preview.action === "delete" ? "danger" : "primary"}`} disabled={busy} onClick={() => void confirmAndApply()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}确认并应用</button></div>}
      </div>
    </div>}
    {runtimeCandidateOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !runtimeCandidateLoading && setRuntimeCandidateOpen(false)}>
      <div className="modal runtime-candidate-modal" role="dialog" aria-modal="true" aria-label="从运行生成测试用例">
        <div className="modal-header"><div><h2>从运行生成测试用例</h2><span>只读取已完成或已停止的冻结 Trace</span></div><button className="icon-button subtle" title="关闭" disabled={runtimeCandidateLoading} onClick={() => setRuntimeCandidateOpen(false)}><X size={18} /></button></div>
        <div className="runtime-candidate-body">
          {runtimeCandidateLoading && runtimeCandidateRuns.length === 0 ? <div className="runtime-loading"><LoaderCircle size={18} className="spin" />加载运行</div> : terminalRuntimeRuns.length > 0 ? <div className="runtime-candidate-list" role="radiogroup" aria-label="来源运行">{terminalRuntimeRuns.map((run) => <button key={run.runId} role="radio" aria-checked={runtimeCandidateRunId === run.runId} className={runtimeCandidateRunId === run.runId ? "selected" : ""} onClick={() => setRuntimeCandidateRunId(run.runId)}>
            <span className={`run-status-dot ${run.state.status}`} /><div><strong>{runtimeRunStatusLabel(run.state.status)}</strong><code>{shortId(run.runId)}</code><small>{shortRevision(run.revision)} · {run.state.step} 步</small></div><time>{formatRuntimeTime(run.updatedAt)}</time>
          </button>)}</div> : <div className="runtime-candidate-empty"><Route size={28} /><strong>暂无可转换运行</strong><span>先在“手动运行”中完成或停止一次运行。</span></div>}
          <p className="modal-note">生成只会打开可编辑草稿，不写项目。最终保存仍需预览并确认 ChangeSet。</p>
        </div>
        <div className="modal-actions"><button className="button secondary" disabled={runtimeCandidateLoading} onClick={() => setRuntimeCandidateOpen(false)}>取消</button><button className="button primary" disabled={!runtimeCandidateRunId || runtimeCandidateLoading} onClick={() => void generateRuntimeCandidate()}>{runtimeCandidateLoading ? <LoaderCircle size={16} className="spin" /> : <Route size={16} />}生成候选</button></div>
      </div>
    </div>}
  </div>;
}

function emptyCase(caseId: string, skillId: string, graph: SkillGraph): BenchmarkCase {
  const entry = graph.entry;
  const end = graph.nodes.find((node) => node.kind === "end")?.id;
  return {
    schemaVersion: "1.0",
    caseId,
    skillId,
    title: "",
    status: "draft",
    intent: "",
    fixture: { initialVariables: {}, userReplies: [] },
    expected: {
      path: { mode: "subsequence", nodeIds: [entry, end].filter((value): value is string => Boolean(value)) },
      variables: {},
      artifacts: [],
      toolResults: [],
      forbiddenEffects: []
    },
    tags: []
  };
}

function textsFromCase(value: BenchmarkCase): JsonTexts {
  return {
    initialVariables: formatJson(value.fixture.initialVariables),
    userReplies: formatJson(value.fixture.userReplies),
    expectedVariables: formatJson(value.expected.variables),
    artifacts: formatJson(value.expected.artifacts),
    toolResults: formatJson(value.expected.toolResults)
  };
}

function materializeCase(draft: BenchmarkCase, texts: JsonTexts): { value: BenchmarkCase | null; issues: BenchmarkCaseIssue[] } {
  const issues: BenchmarkCaseIssue[] = [];
  const initialVariables = parseJsonObject(texts.initialVariables, "fixture.initialVariables", issues);
  const userReplies = parseJsonArray(texts.userReplies, "fixture.userReplies", issues);
  const expectedVariables = parseJsonObject(texts.expectedVariables, "expected.variables", issues);
  const artifacts = parseJsonArray(texts.artifacts, "expected.artifacts", issues);
  const toolResults = parseJsonArray(texts.toolResults, "expected.toolResults", issues);
  if (issues.length) return { value: null, issues };
  return {
    value: {
      ...draft,
      fixture: { initialVariables: initialVariables!, userReplies: userReplies! as BenchmarkCase["fixture"]["userReplies"] },
      expected: {
        ...draft.expected,
        variables: expectedVariables!,
        artifacts: artifacts! as BenchmarkCase["expected"]["artifacts"],
        toolResults: toolResults! as BenchmarkCase["expected"]["toolResults"]
      }
    },
    issues
  };
}

function parseJsonObject(value: string, path: string, issues: BenchmarkCaseIssue[]): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    issues.push({ severity: "error", path, code: "invalid_json_object", message: "必须是有效 JSON 对象" });
    return null;
  }
}

function parseJsonArray(value: string, path: string, issues: BenchmarkCaseIssue[]): unknown[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    issues.push({ severity: "error", path, code: "invalid_json_array", message: "必须是有效 JSON 数组" });
    return null;
  }
}

function updateDraft(setDraft: React.Dispatch<React.SetStateAction<BenchmarkCase | null>>, patch: Partial<BenchmarkCase>): void {
  setDraft((current) => current ? { ...current, ...patch } : current);
}

function updateExpected(draft: BenchmarkCase, setDraft: React.Dispatch<React.SetStateAction<BenchmarkCase | null>>, patch: Partial<BenchmarkCase["expected"]>): void {
  setDraft({ ...draft, expected: { ...draft.expected, ...patch } });
}

function updateTerminal(
  draft: BenchmarkCase,
  setDraft: React.Dispatch<React.SetStateAction<BenchmarkCase | null>>,
  terminal: BenchmarkCase["expected"]["terminal"] | undefined
): void {
  const { terminal: _current, ...expected } = draft.expected;
  setDraft({ ...draft, expected: { ...expected, ...(terminal ? { terminal } : {}) } });
}

function caseSnapshot(value: BenchmarkCase, texts: JsonTexts): string {
  return JSON.stringify({ value, texts });
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

function splitComma(value: string): string[] {
  return value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function actionLabel(action: BenchmarkCaseChangePreview["action"]): string {
  return { create: "新建用例", update: "修改用例", delete: "删除用例" }[action];
}

function shortId(id: string): string {
  return id.length > 22 ? `${id.slice(0, 11)}…${id.slice(-7)}` : id;
}

function shortRevision(revision: string): string {
  return revision.length > 24 ? `${revision.slice(0, 24)}…` : revision;
}

function runtimeRunStatusLabel(status: ProjectRun["state"]["status"]): string {
  return { running: "运行中", paused: "已暂停", completed: "已完成", stopped: "已停止" }[status];
}

function formatRuntimeTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError || cause instanceof Error) return cause.message;
  return "测试用例操作失败";
}
