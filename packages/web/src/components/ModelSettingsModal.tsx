import { CheckCircle2, KeyRound, LoaderCircle, PlugZap, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { ModelConnectionResult, ModelSettings } from "@skill-designer/engine";
import { api, ApiError } from "../api";
import { Modal } from "./Modal";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function ModelSettingsModal({ open, onClose, onSaved }: Props) {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [model, setModel] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(60_000);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"loading" | "saving" | "testing" | "deleting" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ModelConnectionResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setBusy("loading");
    setError(null);
    setConnection(null);
    void api.getModelSettings()
      .then((next) => {
        setSettings(next);
        setModel(next.model);
        setTimeoutMs(next.timeoutMs);
        setApiKey("");
        setConnection(next.lastConnection ?? null);
      })
      .catch((cause) => setError(messageOf(cause)))
      .finally(() => setBusy(null));
  }, [open]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy("saving");
    setError(null);
    try {
      const next = await api.updateModelSettings({ model: model.trim(), timeoutMs, ...(apiKey ? { apiKey } : {}) });
      setSettings(next);
      setApiKey("");
      setConnection(null);
      onSaved("模型设置已保存");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy("testing");
    setError(null);
    try {
      const result = await api.testModelConnection();
      setConnection(result);
      setSettings((current) => current ? { ...current, connectionStatus: result.status, lastConnection: result } : current);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  async function deleteKey() {
    if (!window.confirm("删除保存在系统凭据库中的 API Key？环境变量不会被修改。")) return;
    setBusy("deleting");
    setError(null);
    try {
      const next = await api.deleteStoredModelKey();
      setSettings(next);
      setApiKey("");
      setConnection(null);
      onSaved("本地 API Key 已删除");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  const loading = busy === "loading" || !settings;
  const envOverride = settings?.keySource === "environment";
  const storeUnavailable = settings?.credentialStore.status !== "ready";

  return (
    <Modal title="模型设置" open={open} onClose={onClose} className="model-settings-modal">
      {loading ? (
        <div className="settings-loading"><LoaderCircle className="spin" size={20} />正在读取设置</div>
      ) : (
        <form onSubmit={save}>
          <div className="modal-body form-stack model-settings-form">
            <div className={`provider-summary ${settings.keyConfigured ? "ready" : "missing"}`}>
              <span className="provider-summary-icon">{settings.keyConfigured ? <CheckCircle2 size={18} /> : <TriangleAlert size={18} />}</span>
              <div><strong>{settings.providerLabel}</strong><small>{settings.keyConfigured ? `密钥来源：${sourceLabel(settings.keySource)}` : "API Key 未配置"}</small></div>
              <span className="provider-status">{settings.keyConfigured ? "已配置" : "未配置"}</span>
            </div>

            <div className="settings-grid">
              <label className="field">
                <span>Provider</span>
                <input value={settings.providerLabel} readOnly />
              </label>
              <label className="field">
                <span>模型 ID</span>
                <input required maxLength={121} value={model} onChange={(event) => setModel(event.target.value)} spellCheck="false" />
              </label>
            </div>

            <label className="field">
              <span>请求超时</span>
              <select value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))}>
                <option value={30_000}>30 秒</option>
                <option value={60_000}>60 秒</option>
                <option value={120_000}>120 秒</option>
                <option value={300_000}>300 秒</option>
              </select>
            </label>

            <label className="field credential-field">
              <span><KeyRound size={14} />API Key</span>
              <input
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={settings.keyConfigured ? "留空以保留现有密钥" : "输入 API Key"}
                disabled={storeUnavailable || envOverride}
              />
              <small>{envOverride ? "OPENAI_API_KEY 正在覆盖本地凭据" : settings.credentialStore.reason}</small>
            </label>

            <div className="credential-facts">
              <ShieldCheck size={17} />
              <div><strong>{settings.credentialStore.label}</strong><small>生成请求自动重试：关闭</small></div>
            </div>

            {connection && (
              <div className={`connection-result ${connection.status}`} role="status">
                {connection.status === "ready" ? <CheckCircle2 size={17} /> : <TriangleAlert size={17} />}
                <div><strong>{connection.message}</strong><small>{connection.model} · {connection.durationMs}ms · {connection.attempts} 次尝试</small></div>
              </div>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <footer className="modal-actions model-settings-actions">
            <button className="button danger" type="button" onClick={() => void deleteKey()} disabled={Boolean(busy) || settings.keySource !== "os-store"} title="删除本地密钥"><Trash2 size={15} />删除密钥</button>
            <button className="button secondary" type="button" onClick={() => void testConnection()} disabled={Boolean(busy) || !settings.keyConfigured}><PlugZap size={15} />{busy === "testing" ? "检查中..." : "测试连接"}</button>
            <button className="button primary" type="submit" disabled={Boolean(busy) || !model.trim()}>{busy === "saving" ? "保存中..." : "保存设置"}</button>
          </footer>
        </form>
      )}
    </Modal>
  );
}

function sourceLabel(source: ModelSettings["keySource"]): string {
  if (source === "environment") return "环境变量";
  if (source === "os-store") return "系统凭据库";
  return "无";
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : "操作失败";
}
