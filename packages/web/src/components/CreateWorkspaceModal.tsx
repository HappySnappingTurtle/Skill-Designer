import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "./Modal";

interface Props {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}

export function CreateWorkspaceModal({ open, busy, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName("");
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    await onSubmit(name.trim());
  }

  return (
    <Modal title="新建工作区" open={open} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <label className="field">
            <span>工作区名称</span>
            <input
              autoFocus
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：产品研发"
            />
          </label>
        </div>
        <footer className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={busy}>取消</button>
          <button className="button primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? "创建中..." : "创建"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
