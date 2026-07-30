import { AlertTriangle, Ban, BookOpenText, Bot, Check, ChevronRight, FileDiff, History, LoaderCircle, LockKeyhole, MessageSquareText, Plus, RefreshCw, Send, Sparkles, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DesignAssistantSession, DesignAssistantSessionSummary, ModelProviderCapability, ProjectChangeSet, WorkspaceMember } from "@skill-designer/engine";
import { api, ApiError } from "../api";
import { GraphDiffPreview } from "./GraphView";
import { ChangeSetConflictPanel, readConflictedChangeSet } from "./ChangeSetConflictPanel";
import { ChangeSetMetadata } from "./ChangeSetMetadata";

interface Props {
  open: boolean;
  workspaceId: string | null;
  currentSkill: WorkspaceMember | null;
  onClose: () => void;
  onProjectChanged: () => Promise<void>;
}

export function DesignAssistantDrawer({ open, workspaceId, currentSkill, onClose, onProjectChanged }: Props) {
  const [capability, setCapability] = useState<ModelProviderCapability | null>(null);
  const [session, setSession] = useState<DesignAssistantSession | null>(null);
  const [sessionSummaries, setSessionSummaries] = useState<DesignAssistantSessionSummary[]>([]);
  const [proposal, setProposal] = useState<ProjectChangeSet | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setLoading(true);
    setError(null);
    void Promise.all([
      api.getDesignAssistantCapabilities(),
      workspaceId ? api.listDesignAssistantSessions(workspaceId) : Promise.resolve([])
    ])
      .then(async ([nextCapability, summaries]) => {
        if (disposed) return;
        setCapability(nextCapability);
        setSessionSummaries(summaries);
        if (!workspaceId) {
          setSession(null);
          setProposal(null);
          return;
        }
        const keepSession = session?.workspaceId === workspaceId ? session.sessionId : null;
        const selectedId = keepSession && summaries.some((item) => item.sessionId === keepSession)
          ? keepSession
          : summaries.find((item) => item.projectId === currentSkill?.projectId)?.sessionId ?? summaries[0]?.sessionId;
        if (!selectedId) {
          setSession(null);
          setProposal(null);
          return;
        }
        const restored = await api.getDesignAssistantSession(selectedId);
        if (!disposed) setSession(restored);
      })
      .catch((cause) => setError(messageOf(cause)))
      .finally(() => setLoading(false));
    return () => { disposed = true; };
  }, [open, workspaceId]);

  useEffect(() => {
    if (!open || !session) return;
    const changeSetId = [...session.messages].reverse().find((message) => message.changeSetId)?.changeSetId;
    if (changeSetId) void api.getChangeSet(changeSetId).then(setProposal).catch(() => setProposal(null));
  }, [open, session?.sessionId, session?.updatedAt]);

  useEffect(() => {
    if (!open || !session?.messages.length) return;
    const frame = window.requestAnimationFrame(() => {
      const conversation = conversationRef.current;
      if (conversation) conversation.scrollTop = conversation.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, session?.sessionId, session?.messages.length]);

  const targetChanged = Boolean(session && currentSkill && session.projectId !== currentSkill.projectId);
  const providerReady = capability?.status === "ready";
  const latestAssistant = useMemo(() => [...(session?.messages ?? [])].reverse().find((message) => message.role === "assistant"), [session]);

  async function createSession() {
    if (!workspaceId || !currentSkill) return;
    setLoading(true);
    setError(null);
    try {
      const created = await api.createDesignAssistantSession(currentSkill.projectId, workspaceId);
      setSession(created);
      setSessionSummaries((current) => [summaryOf(created), ...current.filter((item) => item.sessionId !== created.sessionId)]);
      setProposal(null);
      setContent("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  async function reproposeConflict() {
    if (!proposal || proposal.status !== "conflicted") return;
    setApplying(true);
    setError(null);
    try {
      setProposal(await api.reproposeChangeSet(proposal.changeSetId, {
        digest: proposal.digest,
        baseRevision: proposal.baseRevision
      }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setApplying(false);
    }
  }

  async function send() {
    if (!session || !content.trim()) return;
    setSending(true);
    setError(null);
    try {
      const result = await api.sendDesignAssistantMessage(session.sessionId, { content: content.trim(), reasoningEffort: "low" });
      setSession(result.session);
      setSessionSummaries((current) => [summaryOf(result.session), ...current.filter((item) => item.sessionId !== result.session.sessionId)]);
      setProposal(result.changeSet ?? null);
      setContent("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSending(false);
    }
  }

  async function cancelRequest() {
    if (!session || !sending || cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      await api.cancelDesignAssistantMessage(session.sessionId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setCancelling(false);
    }
  }

  async function selectSession(sessionId: string) {
    if (!sessionId || sessionId === session?.sessionId) return;
    setLoading(true);
    setError(null);
    try {
      setSession(await api.getDesignAssistantSession(sessionId));
      setProposal(null);
      setContent("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  async function refreshSessions() {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const summaries = await api.listDesignAssistantSessions(workspaceId);
      setSessionSummaries(summaries);
      if (session && summaries.some((item) => item.sessionId === session.sessionId)) {
        setSession(await api.getDesignAssistantSession(session.sessionId));
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }

  async function applyProposal() {
    if (!proposal || proposal.status !== "proposed") return;
    setApplying(true);
    setError(null);
    try {
      const result = await api.confirmAndApplyChangeSet(proposal.changeSetId, { digest: proposal.digest, baseRevision: proposal.baseRevision });
      setProposal(result.changeSet);
      await onProjectChanged();
    } catch (cause) {
      const conflicted = await readConflictedChangeSet(proposal);
      if (conflicted) setProposal(conflicted);
      else setError(messageOf(cause));
    } finally {
      setApplying(false);
    }
  }

  async function rejectProposal() {
    if (!proposal || proposal.status !== "proposed") return;
    setApplying(true);
    setError(null);
    try {
      setProposal(await api.rejectChangeSet(proposal.changeSetId, { digest: proposal.digest, baseRevision: proposal.baseRevision, reason: "用户在设计助手中拒绝提案" }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setApplying(false);
    }
  }

  if (!open) return null;
  return <div className="assistant-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="assistant-drawer" role="dialog" aria-modal="true" aria-label="设计助手">
      <header className="assistant-header">
        <div><span><Sparkles size={16} /></span><div><strong>设计助手</strong><small>只生成 ChangeSet</small></div></div>
        <button className="icon-button subtle" title="关闭" onClick={onClose}><X size={18} /></button>
      </header>

      <div className={`assistant-provider ${providerReady ? "ready" : "unavailable"}`} data-testid="assistant-provider">
        <Bot size={15} /><div><span>{capability?.label ?? "正在读取 Provider"}</span><small>{capability?.reason ?? "请稍候"}</small></div>
        <button className="icon-button subtle" title="重新检测" disabled={loading} onClick={() => void api.getDesignAssistantCapabilities().then(setCapability).catch((cause) => setError(messageOf(cause)))}><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
      </div>

      {workspaceId && sessionSummaries.length > 0 && <div className="assistant-session-switcher">
        <History size={14} />
        <select aria-label="设计助手历史会话" value={session?.sessionId ?? ""} disabled={loading || sending} onChange={(event) => void selectSession(event.target.value)}>
          {sessionSummaries.map((item) => <option key={item.sessionId} value={item.sessionId}>{item.skillName} · {formatSessionTime(item.updatedAt)} · {item.messageCount} 条</option>)}
        </select>
        <button className="icon-button subtle" title="刷新会话" disabled={loading || sending} onClick={() => void refreshSessions()}><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
        <button className="icon-button subtle" title="为当前 Skill 新建会话" disabled={!currentSkill || loading || sending} onClick={() => void createSession()}><Plus size={15} /></button>
      </div>}

      {!workspaceId || !currentSkill ? <div className="assistant-empty"><MessageSquareText size={27} /><strong>先选择一个就绪 Skill</strong></div>
        : !session ? <div className="assistant-empty"><LockKeyhole size={27} /><strong>会话将锁定当前 Skill</strong><span>{currentSkill.displayName}</span><code>{shortId(currentSkill.skillId)}</code><button className="button primary" disabled={loading} onClick={() => void createSession()}>{loading ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}开始设计</button></div>
          : <>
            <section className="assistant-target" data-testid="assistant-target">
              <div><LockKeyhole size={14} /><span>会话目标</span><strong>{session.skillName}</strong></div>
              <code>{shortId(session.skillId)}</code>
              {targetChanged && <div className="assistant-target-warning"><AlertTriangle size={14} /><span>当前页面已切换到 {currentSkill.displayName}，本会话仍锁定 {session.skillName}。</span><button className="button secondary" onClick={() => void createSession()}>为当前 Skill 新建会话</button></div>}
            </section>

            <div ref={conversationRef} className="assistant-conversation" aria-label="设计助手消息">
              {!session.messages.length && <div className="assistant-welcome"><MessageSquareText size={23} /><span>描述需要新增或修改的节点、边、文档或测试用例。目标不明确时助手只会追问。</span></div>}
              {session.messages.map((message) => <article key={message.messageId} className={`assistant-message ${message.role}`}>
                <header><span>{message.role === "user" ? "你" : message.kind === "proposal" ? "修改提案" : message.kind === "cancelled" ? "已取消" : "需要澄清"}</span><time>{formatTime(message.createdAt)}</time></header>
                <p>{message.content}</p>
                {message.toolReads && message.toolReads.length > 0 && <details className="assistant-tool-reads"><summary><BookOpenText size={12} />按需读取 {message.toolReads.length}</summary><ul>{message.toolReads.map((read, index) => <li key={`${read.round}:${read.tool}:${read.ref}:${index}`} className={read.status}><div><code>{read.tool}</code><span>{read.status === "completed" ? "完成" : "拒绝"}</span></div><strong>{read.ref}</strong><small>{read.message} · 第 {read.round} 轮</small></li>)}</ul></details>}
                {message.evidence.length > 0 && <details><summary>依据 {message.evidence.length}</summary><ul>{message.evidence.map((evidence, index) => <li key={`${evidence.ref}:${index}`}><code>{evidence.ref}</code><span>{evidence.fact}</span></li>)}</ul></details>}
                {message.model && <small className="assistant-usage">{message.model.resolvedModel} · {message.model.usage.totalTokens} token{message.model.callCount && message.model.callCount > 1 ? ` · ${message.model.callCount} 次调用` : ""}</small>}
              </article>)}
            </div>

            {proposal && <section className={`assistant-proposal ${proposal.status}`} data-testid="assistant-proposal">
              <header><div><FileDiff size={15} /><strong>ChangeSet</strong><span>{proposal.status === "proposed" ? "等待确认" : proposal.status === "applied" ? "已应用" : proposal.status === "rejected" ? "已拒绝" : "不可应用"}</span></div><code>{shortId(proposal.changeSetId)}</code></header>
              <ChangeSetMetadata changeSet={proposal} />
              {proposal.status === "conflicted" && <ChangeSetConflictPanel changeSet={proposal} />}
              <AssistantChangePreview changeSet={proposal} />
              <div className="assistant-proposal-actions">
                <span>{proposal.operations.length} 个白名单操作</span>
                {proposal.status === "proposed" && <button className="button danger" disabled={applying} onClick={() => void rejectProposal()}><Ban size={15} />拒绝提案</button>}
                {proposal.status === "conflicted"
                  ? <button className="button primary" disabled={applying} onClick={() => void reproposeConflict()}>{applying ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}重新预演</button>
                  : <button className="button primary" disabled={proposal.status !== "proposed" || applying} onClick={() => void applyProposal()}>{applying ? <LoaderCircle size={15} className="spin" /> : proposal.status === "applied" ? <Check size={15} /> : <ChevronRight size={15} />}{proposal.status === "applied" ? "已确认应用" : "确认并应用"}</button>}
              </div>
            </section>}

            <div className="assistant-composer">
              {error && <div className="assistant-error" role="alert">{error}</div>}
              <textarea aria-label="设计需求" value={content} maxLength={4000} rows={3} disabled={sending} placeholder="例如：把核心步骤改名为需求澄清，并补充说明。" onChange={(event) => setContent(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void send(); }} />
              <div><span>{sending ? "模型正在生成，可随时停止" : latestAssistant?.kind === "clarification" ? "请补充上方问题所需信息" : "修改必须再次确认"}</span>{sending
                ? <button className="button danger" disabled={cancelling} onClick={() => void cancelRequest()}>{cancelling ? <LoaderCircle size={15} className="spin" /> : <Square size={14} />}停止生成</button>
                : <button className="button primary" disabled={!providerReady || !content.trim()} onClick={() => void send()}><Send size={15} />发送</button>}</div>
            </div>
          </>}
      {error && !session && <div className="assistant-error standalone" role="alert">{error}</div>}
    </aside>
  </div>;
}

function AssistantChangePreview({ changeSet }: { changeSet: ProjectChangeSet }) {
  return <div className="assistant-change-preview">{changeSet.preview.map((preview) => preview.kind === "graph"
    ? <GraphDiffPreview key={preview.target} preview={preview} />
    : preview.kind === "document"
      ? <div className="assistant-document-diff" key={preview.target}><div><span>修改前</span><pre>{preview.before || "（新文档）"}</pre></div><div><span>修改后</span><pre>{preview.after}</pre></div></div>
      : preview.kind === "benchmark-case"
        ? <div className="assistant-benchmark-diff" key={preview.target}><span>{preview.action === "create" ? "新增" : preview.action === "update" ? "修改" : "删除"}测试用例</span><code>{preview.caseId}</code><pre>{preview.after || preview.before}</pre></div>
        : preview.kind === "skill-manifest"
          ? <div className="assistant-benchmark-diff" key={preview.target}><span>修改 Skill 信息</span><code>{preview.changedFields.join(" · ")}</code><pre>{JSON.stringify(preview.after, null, 2)}</pre></div>
          : preview.kind === "asset"
            ? <div className="assistant-benchmark-diff" key={preview.target}><span>{preview.action === "create" ? "新增" : preview.action === "replace" ? "替换" : "删除"}项目资产</span><code>{preview.target}</code><pre>{`${preview.after?.mimeType ?? preview.before?.mimeType ?? "未知类型"}\n${preview.after?.sha256 ?? preview.before?.sha256 ?? ""}\n引用 ${preview.references.length} 处`}</pre></div>
            : <div className="assistant-benchmark-diff" key={preview.target}><span>恢复项目 Snapshot</span><code>{preview.toRevision}</code><pre>{preview.files.map((file) => `${file.status} ${file.path}`).join("\n")}</pre></div>)}</div>;
}

function shortId(value: string): string { return value.length > 28 ? `${value.slice(0, 17)}…${value.slice(-7)}` : value; }
function formatTime(value: string): string { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatSessionTime(value: string): string { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function summaryOf(session: DesignAssistantSession): DesignAssistantSessionSummary {
  return {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    projectId: session.projectId,
    skillId: session.skillId,
    skillName: session.skillName,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    lastMessagePreview: session.messages.at(-1)?.content.slice(0, 120) ?? null,
    busy: false
  };
}
function messageOf(cause: unknown): string { return cause instanceof ApiError || cause instanceof Error ? cause.message : "设计助手请求失败"; }
