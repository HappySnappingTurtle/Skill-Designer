import { FileSearch, Link2 } from "lucide-react";
import type { ChangeSetEvidence, ChangeSetEvidenceKind, ChangeSetSourceKind, ProjectChangeSet } from "@skill-designer/engine";

const sourceLabels: Record<ChangeSetSourceKind, string> = {
  manual: "Studio 手工编辑",
  assistant: "设计助手",
  diagnosis: "诊断建议",
  report: "Bug Report",
  runtime: "运行事实",
  import: "导入解析",
  system: "系统操作",
  legacy: "历史记录"
};

const evidenceLabels: Record<ChangeSetEvidenceKind, string> = {
  "user-request": "用户请求",
  "project-fact": "项目事实",
  document: "文档事实",
  graph: "图谱事实",
  trace: "Trace 事件",
  diagnosis: "诊断结论",
  report: "Bug Report",
  runtime: "运行事实"
};

export function ChangeSetMetadata({ changeSet }: { changeSet: ProjectChangeSet }) {
  const sourceLabel = changeSet.source.label?.trim() || sourceLabels[changeSet.source.kind];
  return <section className="changeset-metadata" aria-label="提案来源与证据" data-testid="changeset-metadata">
    <header>
      <div><FileSearch size={15} /><span>提案来源</span><strong>{sourceLabel}</strong></div>
      {changeSet.source.sourceId && <code title={changeSet.source.sourceId}>{shortRef(changeSet.source.sourceId)}</code>}
    </header>
    <div className="changeset-metadata-reason"><span>修改原因</span><p>{changeSet.reason}</p></div>
    <div className="changeset-evidence-heading"><div><Link2 size={14} /><span>证据</span></div><strong>{changeSet.evidence.length}</strong></div>
    {changeSet.evidence.length > 0
      ? <div className="changeset-evidence-list">{changeSet.evidence.map((evidence, index) => <EvidenceRow key={`${evidence.kind}:${evidence.ref}:${index}`} evidence={evidence} />)}</div>
      : <p className="changeset-evidence-empty">未附加证据</p>}
  </section>;
}

function EvidenceRow({ evidence }: { evidence: ChangeSetEvidence }) {
  return <div className="changeset-evidence-row">
    <span className={`kind ${evidence.kind}`}>{evidenceLabels[evidence.kind]}</span>
    <code title={evidence.ref}>{shortRef(evidence.ref)}</code>
    <p>{evidence.summary}</p>
  </div>;
}

function shortRef(value: string): string {
  return value.length <= 42 ? value : `${value.slice(0, 22)}…${value.slice(-12)}`;
}
