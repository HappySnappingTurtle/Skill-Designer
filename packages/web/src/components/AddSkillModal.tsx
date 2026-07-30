import { useEffect, useState, type FormEvent } from "react";
import type { SkillCapability } from "@skill-designer/engine";
import { Modal } from "./Modal";

interface Props {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; description: string; capability: SkillCapability }) => Promise<void>;
}

export function AddSkillModal({ open, busy, onClose, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [capability, setCapability] = useState<SkillCapability>("workflow");

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setCapability("workflow");
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    await onSubmit({ name: name.trim(), description: description.trim(), capability });
  }

  return (
    <Modal title="添加 Skill" open={open} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body form-stack">
          <label className="field">
            <span>Skill 名称</span>
            <input autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <fieldset className="field">
            <legend>类型</legend>
            <div className="segmented-control">
              <button
                type="button"
                className={capability === "workflow" ? "selected" : ""}
                onClick={() => setCapability("workflow")}
              >
                工作流
              </button>
              <button
                type="button"
                className={capability === "content-only" ? "selected" : ""}
                onClick={() => setCapability("content-only")}
              >
                内容型
              </button>
            </div>
          </fieldset>
          <label className="field">
            <span>说明</span>
            <textarea maxLength={500} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
        </div>
        <footer className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose} disabled={busy}>取消</button>
          <button className="button primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? "添加中..." : "添加"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
