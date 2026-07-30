import { FolderGit2, RefreshCw } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { Workspace } from "@skill-designer/engine";
import { api, ApiError } from "../api";
import { Modal } from "./Modal";

interface OpenInPlaceModalProps {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
  onOpened: (workspace: Workspace) => Promise<void>;
}

export function OpenInPlaceModal({ open, workspaceId, onClose, onOpened }: OpenInPlaceModalProps) {
  const [rootPath, setRootPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRootPath("");
    setBusy(false);
    setError(null);
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!rootPath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onOpened(await api.openInPlaceProject(workspaceId, rootPath.trim()));
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="原地打开 Git Skill" open={open} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="modal-body form-stack">
          <label className="field">
            <span>Skill 根目录绝对路径</span>
            <input aria-label="Skill 根目录绝对路径" value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="/path/to/skill" autoFocus />
          </label>
          <div className="in-place-note"><FolderGit2 size={18} /><span>打开时只读取并建立私有 Snapshot，不修改此目录。此后用户确认的 ChangeSet 会原地写入，因此必须选择你明确授权的 Skill 根目录。</span></div>
          <p className="modal-note">目录必须已有有效的 SKILL.md、skill.json 和 graph/main.json；单个 Workspace 不接受重复 skillId。</p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={busy}>取消</button>
          <button className="button primary" type="submit" disabled={busy || !rootPath.trim()}>{busy ? <RefreshCw size={15} className="spin" /> : <FolderGit2 size={15} />}{busy ? "正在打开" : "确认并打开"}</button>
        </footer>
      </form>
    </Modal>
  );
}

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : "原地打开失败";
}
