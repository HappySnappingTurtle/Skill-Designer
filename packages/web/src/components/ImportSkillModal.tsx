import { AlertTriangle, Braces, CheckCircle2, FileArchive, FileSearch, FolderOpen, GitCompareArrows, Info, Link2, RefreshCw, RotateCcw, Save, Sparkles, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  graphEdgeTypeRegistry,
  graphNodeTypeRegistry,
  importReviewGraph,
  type GraphEdgeKind,
  type GraphNodeKind,
  type ImportLLMParseRun,
  type SkillImportCandidate,
  type UpdateSkillImportReviewInput,
  type Workspace
} from "@skill-designer/engine";
import { api, ApiError } from "../api";
import { Modal } from "./Modal";
import { SkillGraphCanvas } from "./SkillGraphCanvas";

interface ImportSkillModalProps {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
  onWorkspaceUpdated: (workspace: Workspace) => Promise<void>;
}

export function ImportSkillModal({ open, workspaceId, onClose, onWorkspaceUpdated }: ImportSkillModalProps) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [folderName, setFolderName] = useState("");
  const [candidate, setCandidate] = useState<SkillImportCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [llmRun, setLLMRun] = useState<ImportLLMParseRun | null>(null);
  const [llmBusy, setLLMBusy] = useState(false);
  const totalSize = useMemo(() => selectedFiles.reduce((sum, file) => sum + file.size, 0), [selectedFiles]);
  const blockingErrors = [
    ...(candidate?.diagnostics.filter((item) => item.severity === "error") ?? []),
    ...(candidate?.parseReview.lint.filter((item) => item.severity === "error") ?? [])
  ];

  useEffect(() => {
    if (!open) return;
    setSelectedFiles([]);
    setFolderName("");
    setCandidate(null);
    setError(null);
    setBusy(false);
    setReviewDirty(false);
    setLLMRun(null);
    setLLMBusy(false);
  }, [open]);

  useEffect(() => {
    if (!candidate || llmBusy) return;
    let disposed = false;
    void api.getLatestImportLLMParse(candidate.importId, workspaceId)
      .then((run) => { if (!disposed) setLLMRun(run); })
      .catch(() => {});
    return () => { disposed = true; };
  }, [candidate?.importId, candidate?.parseReview.reviewRevision, workspaceId, llmBusy]);

  function chooseFiles(files: FileList | null) {
    const next = Array.from(files ?? []).filter((file) => {
      const segments = file.webkitRelativePath.split("/").map((segment) => segment.toLowerCase());
      return !segments.includes(".git") && file.name.toLowerCase() !== ".ds_store";
    });
    const firstPath = next[0]?.webkitRelativePath || next[0]?.name || "";
    setFolderName(firstPath.split("/")[0] || "skill");
    setSelectedFiles(next);
    setCandidate(null);
    setError(null);
  }

  async function preview() {
    if (!selectedFiles.length) return;
    setBusy(true);
    setError(null);
    try {
      const files = await Promise.all(selectedFiles.map(async (file) => ({
        path: relativeBrowserPath(file),
        contentBase64: await fileToBase64(file)
      })));
      const result = await api.createSkillImport(workspaceId, { folderName, files });
      setCandidate(result.candidate);
      setLLMRun(null);
      setReviewDirty(false);
      await onWorkspaceUpdated(result.workspace);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!candidate || blockingErrors.length || candidate.parseReview.reparseConflict || reviewDirty) return;
    setBusy(true);
    setError(null);
    try {
      const workspace = await api.confirmSkillImport(candidate.importId, { workspaceId, digest: candidate.digest });
      await onWorkspaceUpdated(workspace);
      setCandidate({ ...candidate, status: "confirmed" });
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveReview(input: UpdateSkillImportReviewInput) {
    if (!candidate) return;
    setBusy(true);
    setError(null);
    try {
      setCandidate(await api.updateSkillImportReview(candidate.importId, input));
      setReviewDirty(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reparse() {
    if (!candidate || reviewDirty) return;
    setBusy(true);
    setError(null);
    try {
      setCandidate(await api.reparseSkillImport(candidate.importId, { workspaceId, reviewRevision: candidate.parseReview.reviewRevision }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function resolveReparse(choice: "manual" | "reparse") {
    if (!candidate) return;
    setBusy(true);
    setError(null);
    try {
      setCandidate(await api.resolveSkillImportReparse(candidate.importId, {
        workspaceId,
        reviewRevision: candidate.parseReview.reviewRevision,
        choice
      }));
      setReviewDirty(false);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function startLLMParse() {
    if (!candidate || reviewDirty || candidate.parseReview.reparseConflict) return;
    setLLMBusy(true);
    setError(null);
    try {
      const result = await api.startImportLLMParse(candidate.importId, {
        workspaceId,
        reviewRevision: candidate.parseReview.reviewRevision,
        reasoningEffort: "low"
      });
      setLLMRun(result.run);
      if (result.candidate) {
        setCandidate(result.candidate);
        setReviewDirty(false);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLLMBusy(false);
    }
  }

  async function cancelLLMParse() {
    if (!candidate || !llmBusy) return;
    try {
      const run = await api.cancelImportLLMParse(candidate.importId, workspaceId);
      if (run) setLLMRun(run);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  async function closeOrCancel() {
    if (candidate?.status === "proposed") {
      setBusy(true);
      try {
        await onWorkspaceUpdated(await api.cancelSkillImport(candidate.importId, workspaceId));
      } catch (cause) {
        setError(messageOf(cause));
        setBusy(false);
        return;
      }
    }
    onClose();
  }

  return (
    <Modal title="导入 Skill 文件夹" open={open} onClose={() => void closeOrCancel()} className="import-modal">
      <div className="import-modal-body">
        {error && <div className="import-error" role="alert">{error}</div>}
        {!candidate ? (
          <>
            <label className="directory-picker">
              <FolderOpen size={28} />
              <strong>{selectedFiles.length ? folderName : "选择一个 Skill 文件夹"}</strong>
              <span>{selectedFiles.length ? `${selectedFiles.length} 个文件 · ${formatBytes(totalSize)}` : "最多 500 个文件、总计 16 MiB；脚本只保留不执行"}</span>
              <input
                aria-label="选择 Skill 文件夹"
                type="file"
                multiple
                onChange={(event) => chooseFiles(event.target.files)}
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              />
            </label>
            {selectedFiles.length > 0 && (
              <div className="selected-file-preview">
                {selectedFiles.slice(0, 8).map((file) => <code key={file.webkitRelativePath || file.name}>{relativeBrowserPath(file)}</code>)}
                {selectedFiles.length > 8 && <span>另有 {selectedFiles.length - 8} 个文件</span>}
              </div>
            )}
          </>
        ) : (
          <ImportCandidatePreview
            candidate={candidate}
            workspaceId={workspaceId}
            busy={busy}
            llmBusy={llmBusy}
            llmRun={llmRun}
            onDirtyChange={setReviewDirty}
            onSave={saveReview}
            onReparse={reparse}
            onResolveReparse={resolveReparse}
            onStartLLMParse={startLLMParse}
            onCancelLLMParse={cancelLLMParse}
          />
        )}
      </div>
      <footer className="modal-actions">
        <button className="button secondary" onClick={() => void closeOrCancel()} disabled={busy || llmBusy}>{candidate ? "取消导入" : "关闭"}</button>
        {!candidate ? (
          <button className="button primary" onClick={() => void preview()} disabled={busy || !selectedFiles.length}>
            {busy ? <RefreshCw size={15} className="spin" /> : <FileArchive size={15} />}{busy ? "正在扫描" : "扫描并预检"}
          </button>
        ) : (
          <button className="button primary" onClick={() => void confirm()} disabled={busy || llmBusy || blockingErrors.length > 0 || reviewDirty || Boolean(candidate.parseReview.reparseConflict)}>
            {busy ? <RefreshCw size={15} className="spin" /> : <CheckCircle2 size={15} />}
            {candidate.parseReview.reparseConflict ? "先裁决重解析" : reviewDirty ? "先保存审阅" : blockingErrors.length ? "存在阻断问题" : busy ? "正在导入" : "确认导入"}
          </button>
        )}
      </footer>
    </Modal>
  );
}

interface ImportCandidatePreviewProps {
  candidate: SkillImportCandidate;
  workspaceId: string;
  busy: boolean;
  llmBusy: boolean;
  llmRun: ImportLLMParseRun | null;
  onDirtyChange: (dirty: boolean) => void;
  onSave: (input: UpdateSkillImportReviewInput) => Promise<void>;
  onReparse: () => Promise<void>;
  onResolveReparse: (choice: "manual" | "reparse") => Promise<void>;
  onStartLLMParse: () => Promise<void>;
  onCancelLLMParse: () => Promise<void>;
}

const nodeKinds: GraphNodeKind[] = graphNodeTypeRegistry.map((item) => item.kind);
const edgeKinds: GraphEdgeKind[] = graphEdgeTypeRegistry.map((item) => item.kind);

function ImportCandidatePreview({ candidate, workspaceId, busy, llmBusy, llmRun, onDirtyChange, onSave, onReparse, onResolveReparse, onStartLLMParse, onCancelLLMParse }: ImportCandidatePreviewProps) {
  const [draft, setDraft] = useState(candidate.parseReview);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const dirty = useMemo(() => reviewDraftDigest(draft) !== reviewDraftDigest(candidate.parseReview), [candidate.parseReview, draft]);
  const graph = useMemo(() => importReviewGraph(candidate.skillId, draft), [candidate.skillId, draft]);

  useEffect(() => {
    setDraft(candidate.parseReview);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, [candidate.parseReview.reviewRevision]);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  function updateNode(candidateId: string, update: (node: SkillImportCandidate["parseReview"]["nodes"][number]) => SkillImportCandidate["parseReview"]["nodes"][number]) {
    setDraft((current) => ({ ...current, nodes: current.nodes.map((node) => node.candidateId === candidateId ? update(node) : node) }));
  }

  function updateEdge(candidateId: string, update: (edge: SkillImportCandidate["parseReview"]["edges"][number]) => SkillImportCandidate["parseReview"]["edges"][number]) {
    setDraft((current) => ({ ...current, edges: current.edges.map((edge) => edge.candidateId === candidateId ? update(edge) : edge) }));
  }

  async function save() {
    await onSave({
      workspaceId,
      reviewRevision: candidate.parseReview.reviewRevision,
      ...(draft.entry ? { entry: draft.entry } : {}),
      nodes: draft.nodes.map(({ candidateId, decision, value }) => ({ candidateId, decision, value })),
      edges: draft.edges.map(({ candidateId, decision, value }) => ({ candidateId, decision, value }))
    });
  }

  const conflict = candidate.parseReview.reparseConflict;
  return (
    <div className="import-preview">
      <section className="import-identity">
        <div><span>名称</span><strong>{candidate.displayName}</strong></div>
        <div><span>类型</span><strong>{candidate.capability === "workflow" ? "工作流" : "内容型"}</strong></div>
        <div><span>格式</span><strong>{detectedFormatLabel(candidate.detectedFormat)}</strong></div>
        <code title={candidate.skillId}>{candidate.skillId}</code>
      </section>
      <section className="import-review-section">
        <header className="import-review-header">
          <div>
            <strong>解析审阅</strong>
            <span>静态解析器 {candidate.parseReview.parserVersion} · 第 {candidate.parseReview.reviewRevision} 版</span>
          </div>
          <div>
            {llmBusy ? (
              <button className="button danger compact" onClick={() => void onCancelLLMParse()} title="停止当前 LLM 解析"><Square size={13} />停止解析</button>
            ) : (
              <button className="button secondary compact" onClick={() => void onStartLLMParse()} disabled={busy || dirty || Boolean(conflict)} title={dirty ? "请先保存当前修改" : conflict ? "请先裁决当前冲突" : "使用模型按需读取冻结文件并生成新候选"}>
                <Sparkles size={14} />LLM 解析
              </button>
            )}
            <button className="button secondary compact" onClick={() => void onReparse()} disabled={busy || dirty || Boolean(conflict)} title={dirty ? "请先保存当前修改" : "从冻结的原文件重新解析"}>
              <RotateCcw size={14} />重新解析
            </button>
            <button className="button primary compact" onClick={() => void save()} disabled={busy || !dirty || Boolean(conflict)}>
              <Save size={14} />保存审阅
            </button>
          </div>
        </header>
        {(llmBusy || llmRun) && <ImportLLMParseStatus running={llmBusy} run={llmRun} />}
        {conflict && (
          <div className="import-reparse-conflict" role="alert">
            <GitCompareArrows size={19} />
            <div>
              <strong>人工审阅与重新解析结果冲突</strong>
              <span>当前人工版本 {candidate.parseReview.nodes.length} 个节点；新解析结果 {conflict.parsed.nodes.length} 个节点。系统不会自动合并或覆盖。</span>
            </div>
            <button className="button secondary compact" onClick={() => void onResolveReparse("manual")} disabled={busy}>保留人工修改</button>
            <button className="button primary compact" onClick={() => void onResolveReparse("reparse")} disabled={busy}>采用重新解析</button>
          </div>
        )}
        <div className="import-review-graph" aria-label="解析候选图谱">
          <SkillGraphCanvas
            graph={graph}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            query=""
            kindFilter="all"
            edgeKindFilter="all"
            largeGraph={graph.nodes.length > 180}
            embeddedTitle="解析候选 知识图谱"
            onSelectNode={(nodeId) => { setSelectedNodeId(nodeId); setSelectedEdgeId(null); }}
            onSelectEdge={(edgeId) => { setSelectedEdgeId(edgeId); setSelectedNodeId(null); }}
            onClearSelection={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
            fitPadding={54}
          />
        </div>
        <div className="import-review-columns">
          <div className="import-candidate-list">
            <header><strong>候选节点</strong><span>{draft.nodes.filter((item) => item.decision === "accepted").length}/{draft.nodes.length} 接受</span></header>
            {draft.nodes.map((node) => (
              <div className={node.decision === "rejected" ? "rejected" : ""} key={node.candidateId}>
                <label className="import-decision-toggle" title="接受或拒绝该候选节点">
                  <input
                    type="checkbox"
                    checked={node.decision === "accepted"}
                    disabled={Boolean(conflict)}
                    onChange={(event) => updateNode(node.candidateId, (current) => ({ ...current, decision: event.target.checked ? "accepted" : "rejected" }))}
                  />
                  <span>{node.decision === "accepted" ? "接受" : "拒绝"}</span>
                </label>
                <div className="import-candidate-fields">
                  <input aria-label={`${node.value.id} 节点标题`} value={node.value.title} disabled={Boolean(conflict)} maxLength={200} onChange={(event) => updateNode(node.candidateId, (current) => ({ ...current, value: { ...current.value, title: event.target.value } }))} />
                  <select aria-label={`${node.value.id} 节点类型`} value={node.value.kind} disabled={Boolean(conflict)} onChange={(event) => updateNode(node.candidateId, (current) => ({ ...current, value: { ...current.value, kind: event.target.value as GraphNodeKind } }))}>
                    {nodeKinds.map((kind) => <option value={kind} key={kind}>{kind}</option>)}
                  </select>
                </div>
                <CandidateEvidence confidence={node.confidence} evidence={node.evidence} />
              </div>
            ))}
          </div>
          <div className="import-candidate-list">
            <header><strong>候选关系</strong><span>{draft.edges.filter((item) => item.decision === "accepted").length}/{draft.edges.length} 接受</span></header>
            {draft.edges.length ? draft.edges.map((edge) => (
              <div className={edge.decision === "rejected" ? "rejected" : ""} key={edge.candidateId}>
                <label className="import-decision-toggle" title="接受或拒绝该候选关系">
                  <input type="checkbox" checked={edge.decision === "accepted"} disabled={Boolean(conflict)} onChange={(event) => updateEdge(edge.candidateId, (current) => ({ ...current, decision: event.target.checked ? "accepted" : "rejected" }))} />
                  <span>{edge.decision === "accepted" ? "接受" : "拒绝"}</span>
                </label>
                <div className="import-candidate-fields edge-fields">
                  <select aria-label={`${edge.value.id} 起点`} value={edge.value.from} disabled={Boolean(conflict)} onChange={(event) => updateEdge(edge.candidateId, (current) => ({ ...current, value: { ...current.value, from: event.target.value } }))}>
                    {draft.nodes.map((node) => <option value={node.value.id} key={node.value.id}>{node.value.title}</option>)}
                  </select>
                  <span>→</span>
                  <select aria-label={`${edge.value.id} 终点`} value={edge.value.to} disabled={Boolean(conflict)} onChange={(event) => updateEdge(edge.candidateId, (current) => ({ ...current, value: { ...current.value, to: event.target.value } }))}>
                    {draft.nodes.map((node) => <option value={node.value.id} key={node.value.id}>{node.value.title}</option>)}
                  </select>
                  <select aria-label={`${edge.value.id} 关系类型`} value={edge.value.kind} disabled={Boolean(conflict)} onChange={(event) => updateEdge(edge.candidateId, (current) => ({ ...current, value: { ...current.value, kind: event.target.value as GraphEdgeKind } }))}>
                    {edgeKinds.map((kind) => <option value={kind} key={kind}>{kind}</option>)}
                  </select>
                </div>
                <CandidateEvidence confidence={edge.confidence} evidence={edge.evidence} />
              </div>
            )) : <p className="import-empty-relations">当前解析结果没有候选关系</p>}
          </div>
        </div>
        {draft.unresolvedQuestions.length > 0 && (
          <div className="import-review-questions">
            <strong>待确认问题</strong>
            {draft.unresolvedQuestions.map((question) => <p key={question.questionId}><Info size={14} />{question.message}</p>)}
          </div>
        )}
        {draft.lint.length > 0 && (
          <div className="import-review-lint">
            {draft.lint.map((issue, index) => <p className={issue.severity} key={`${issue.code}-${index}`}><AlertTriangle size={14} />{issue.message}</p>)}
          </div>
        )}
      </section>
      <ImportInventoryFacts candidate={candidate} />
      <section className="import-assets">
        <header><strong>资产清单</strong><span>{candidate.files.length} 个原文件 · {candidate.generatedFiles.length} 个生成文件</span></header>
        <div>{candidate.files.map((file) => <code key={file.path}><span>{kindLabel(file.kind)}</span>{file.path}</code>)}</div>
        {candidate.generatedFiles.map((file) => <code className="generated" key={file}><span>生成</span>{file}</code>)}
      </section>
      <section className="import-diagnostics">
        <header><strong>静态诊断</strong><span>{candidate.diagnostics.length} 项</span></header>
        {candidate.diagnostics.length ? candidate.diagnostics.map((item, index) => (
          <div className={item.severity} key={`${item.code}-${index}`}>
            {item.severity === "error" ? <AlertTriangle size={15} /> : <Info size={15} />}
            <span><strong>{item.message}</strong>{item.path && <code>{item.path}</code>}</span>
          </div>
        )) : <div className="diagnostic-clean"><CheckCircle2 size={16} />未发现阻断问题</div>}
      </section>
    </div>
  );
}

function ImportLLMParseStatus({ running, run }: { running: boolean; run: ImportLLMParseRun | null }) {
  const status = running ? "running" : run?.status ?? "running";
  const label = status === "running" ? "模型正在解析" : status === "completed" ? "LLM 解析完成" : status === "cancelled" ? "LLM 解析已取消" : "LLM 解析失败";
  return (
    <div className={`import-llm-status ${status}`} role="status">
      <div className="import-llm-status-heading">
        {status === "running" ? <RefreshCw size={16} className="spin" /> : status === "completed" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
        <div><strong>{label}</strong><span>{run ? `${run.model} · ${run.callCount} 次调用 · ${run.usage.totalTokens} token` : "正在按需读取冻结导入文件"}</span></div>
        {run && <small>{run.reads.filter((read) => read.round > 0).length} 次按需读取 · {run.correctionCount} 次 lint 修正</small>}
      </div>
      {run?.reads.length ? <details><summary>读取记录 {run.reads.length}</summary><div className="import-llm-read-list">{run.reads.map((read, index) => <p className={read.status} key={`${read.round}:${read.path}:${index}`}><code>{read.path}</code><span>{read.message}</span><small>{read.round === 0 ? "基础文件" : `第 ${read.round} 轮`} · {read.resultChars} 字符</small></p>)}</div></details> : null}
      {run?.diagnostics.length ? <div className="import-llm-diagnostics">{run.diagnostics.map((diagnostic, index) => <p className={diagnostic.severity} key={`${diagnostic.code}:${index}`}><strong>{diagnostic.code}</strong><span>{diagnostic.message}</span>{diagnostic.path && <code>{diagnostic.path}</code>}</p>)}</div> : null}
    </div>
  );
}

function ImportInventoryFacts({ candidate }: { candidate: SkillImportCandidate }) {
  const resolvedCount = candidate.references.filter((reference) => reference.status === "resolved").length;
  const issueCount = candidate.references.filter((reference) => reference.status !== "resolved" && reference.status !== "external").length;
  const visibleReferences = candidate.references.slice(0, 200);
  return (
    <section className="import-inventory-facts">
      <header>
        <div><FileSearch size={16} /><div><strong>导入事实</strong><span>元数据、相对引用与判断来源</span></div></div>
        <span>{candidate.formatSignals.length} 个格式信号 · {candidate.provenance.length} 条来源记录</span>
      </header>
      <div className="import-fact-summary">
        <div><Braces size={15} /><span>Frontmatter</span><strong>{candidate.frontmatter ? `${candidate.frontmatter.dialect.toUpperCase()} · ${frontmatterStatusLabel(candidate.frontmatter.status)}` : "未发现"}</strong></div>
        <div><Link2 size={15} /><span>相对引用</span><strong>{resolvedCount} 已解析 · {issueCount} 待检查</strong></div>
        <div><FileSearch size={15} /><span>Provenance</span><strong>{candidate.provenance.length} 条可追溯判断</strong></div>
      </div>
      <div className="import-fact-grid">
        <div className="import-frontmatter-facts">
          <header><strong>Frontmatter 元数据</strong><span>{candidate.frontmatter?.unknownKeys.length ?? 0} 个扩展字段</span></header>
          {candidate.frontmatter ? (
            <>
              <dl>
                {candidate.frontmatter.recognized.name && <><dt>name</dt><dd>{candidate.frontmatter.recognized.name}</dd></>}
                {candidate.frontmatter.recognized.description && <><dt>description</dt><dd>{candidate.frontmatter.recognized.description}</dd></>}
                {candidate.frontmatter.recognized.version && <><dt>version</dt><dd>{candidate.frontmatter.recognized.version}</dd></>}
                {candidate.frontmatter.recognized.license && <><dt>license</dt><dd>{candidate.frontmatter.recognized.license}</dd></>}
                {candidate.frontmatter.recognized.compatibility && <><dt>compatibility</dt><dd>{candidate.frontmatter.recognized.compatibility}</dd></>}
                {candidate.frontmatter.recognized.allowedTools?.length && <><dt>allowed-tools</dt><dd>{candidate.frontmatter.recognized.allowedTools.join("、")}</dd></>}
              </dl>
              {candidate.frontmatter.unknownKeys.length > 0 && <div className="import-extension-keys"><span>原样保留的扩展字段</span>{candidate.frontmatter.unknownKeys.map((key) => <code key={key}>{key}</code>)}</div>}
              {candidate.frontmatter.error && <p className="import-frontmatter-error"><AlertTriangle size={13} />{candidate.frontmatter.error}</p>}
            </>
          ) : <p className="import-fact-empty">SKILL.md 没有结构化 frontmatter</p>}
        </div>
        <div className="import-reference-facts">
          <header><strong>引用清单</strong><span>{candidate.references.length} 项</span></header>
          {visibleReferences.length ? <div className="import-reference-list">{visibleReferences.map((reference) => (
            <div key={reference.referenceId} className={reference.status}>
              <span className="reference-status">{referenceStatusLabel(reference.status)}</span>
              <div><code>{reference.rawTarget}</code><small>{reference.sourcePath}:L{reference.startLine} · {referenceKindLabel(reference.kind)}</small></div>
              <span title={reference.message}>{reference.normalizedTarget ?? reference.message}</span>
            </div>
          ))}{candidate.references.length > visibleReferences.length && <p>另有 {candidate.references.length - visibleReferences.length} 项，请通过导入候选 API 查看完整清单。</p>}</div> : <p className="import-fact-empty">未发现 Markdown 或 frontmatter 相对引用</p>}
        </div>
        <div className="import-provenance-facts">
          <header><strong>判断来源</strong><span>{candidate.provenance.length} 条</span></header>
          <div>{candidate.provenance.map((record) => (
            <div key={record.provenanceId}>
              <span className={`confidence ${record.confidence}`}>{confidenceLabel(record.confidence)}</span>
              <div><strong>{provenanceSubjectLabel(record.subject)}</strong><span>{record.valueSummary}</span></div>
              <code>{record.sourcePath}:L{record.startLine} · {provenanceMethodLabel(record.method)}</code>
            </div>
          ))}</div>
        </div>
        <div className="import-format-facts">
          <header><strong>格式信号</strong><span>{candidate.formatSignals.length} 项</span></header>
          <div>{candidate.formatSignals.map((signal) => <p key={`${signal.code}-${signal.path}`}><span className={`confidence ${signal.confidence}`}>{confidenceLabel(signal.confidence)}</span><strong>{signal.message}</strong><code>{signal.path}</code></p>)}</div>
        </div>
      </div>
    </section>
  );
}

function CandidateEvidence({ confidence, evidence }: Pick<SkillImportCandidate["parseReview"]["nodes"][number], "confidence" | "evidence">) {
  const source = evidence[0];
  return (
    <div className="import-candidate-evidence">
      <span className={`confidence ${confidence}`}>{confidenceLabel(confidence)}</span>
      {source && <span title={source.snippet}><code>{source.path}:L{source.startLine}</code>{source.snippet}</span>}
    </div>
  );
}

function reviewDraftDigest(review: SkillImportCandidate["parseReview"]): string {
  return JSON.stringify({ entry: review.entry, nodes: review.nodes.map(({ candidateId, decision, value }) => ({ candidateId, decision, value })), edges: review.edges.map(({ candidateId, decision, value }) => ({ candidateId, decision, value })) });
}

function confidenceLabel(confidence: SkillImportCandidate["parseReview"]["nodes"][number]["confidence"]): string {
  return { high: "高置信", medium: "中置信", low: "低置信" }[confidence];
}

function detectedFormatLabel(format: SkillImportCandidate["detectedFormat"]): string {
  return { "skill-designer": "Skill Designer", "frontmatter-skill": "Frontmatter Skill", "markdown-skill": "Markdown Skill" }[format];
}

function frontmatterStatusLabel(status: NonNullable<SkillImportCandidate["frontmatter"]>["status"]): string {
  return { valid: "有效", invalid: "解析失败", unterminated: "未闭合" }[status];
}

function referenceStatusLabel(status: SkillImportCandidate["references"][number]["status"]): string {
  return { resolved: "已解析", missing: "缺失", "missing-anchor": "锚点缺失", external: "外部", invalid: "无效", escaped: "越界" }[status];
}

function referenceKindLabel(kind: SkillImportCandidate["references"][number]["kind"]): string {
  return { "markdown-link": "链接", "markdown-image": "图片", "markdown-definition": "定义", "inline-code": "代码路径", frontmatter: "元数据" }[kind];
}

function provenanceSubjectLabel(subject: SkillImportCandidate["provenance"][number]["subject"]): string {
  return { "detected-format": "格式", "display-name": "名称", description: "说明", capability: "能力类型", graph: "图结构" }[subject];
}

function provenanceMethodLabel(method: SkillImportCandidate["provenance"][number]["method"]): string {
  return { "native-manifest": "原生 manifest", "native-graph": "原生图", frontmatter: "frontmatter", "markdown-heading": "Markdown 标题", "markdown-paragraph": "Markdown 段落", "folder-name": "文件夹名称", "static-inference": "静态推断", "conservative-fallback": "保守降级" }[method];
}

function relativeBrowserPath(file: File): string {
  const raw = file.webkitRelativePath || file.name;
  const parts = raw.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join("/") : parts[0] ?? file.name;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function kindLabel(kind: SkillImportCandidate["files"][number]["kind"]): string {
  return { markdown: "文档", json: "数据", config: "配置", text: "文本", script: "脚本", asset: "资产", unknown: "其他" }[kind];
}

function formatBytes(size: number): string {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : "导入失败";
}
