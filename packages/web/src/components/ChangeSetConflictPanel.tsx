import { AlertTriangle, GitCompareArrows } from "lucide-react";
import type { ProjectChangeSet } from "@skill-designer/engine";
import { api } from "../api";

export function ChangeSetConflictPanel({ changeSet }: { changeSet: ProjectChangeSet }) {
  const conflict = changeSet.conflict;
  return <section className="changeset-conflict-panel" data-testid="changeset-conflict-panel" role="status">
    <AlertTriangle size={19} />
    <div>
      <strong>原提案已与当前项目冲突</strong>
      <span>{conflict?.message ?? changeSet.recoveryReason ?? "项目事实在确认前发生了变化，原提案不能继续应用。"}</span>
      <dl>
        <div><dt>提案基于</dt><dd title={changeSet.baseRevision}>{shortRevision(changeSet.baseRevision)}</dd></div>
        <div><dt>当前版本</dt><dd title={conflict?.currentRevision}>{shortRevision(conflict?.currentRevision ?? "文件事实变化")}</dd></div>
        <div><dt>冲突类型</dt><dd>{conflict?.code ?? "transaction_recovered"}</dd></div>
      </dl>
      <p><GitCompareArrows size={13} />重新预演只会基于当前事实创建新 ChangeSet，不会自动合并或写入项目；请重新检查新 diff 后再确认。</p>
    </div>
  </section>;
}

export async function readConflictedChangeSet(changeSet: ProjectChangeSet): Promise<ProjectChangeSet | null> {
  try {
    const latest = await api.getChangeSet(changeSet.changeSetId);
    return latest.status === "conflicted" ? latest : null;
  } catch {
    return null;
  }
}

function shortRevision(value: string): string {
  return value.length > 22 ? `${value.slice(0, 15)}…${value.slice(-6)}` : value;
}
