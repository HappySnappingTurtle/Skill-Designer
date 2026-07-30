import type {
  CreateManagedSkillInput,
  CreateWorkspaceInput,
  SkillCapability,
  ValidationIssue,
  ValidationResult
} from "./types.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().normalize("NFC") : "";
}

function validateDisplayName(value: unknown, path: string): ValidationResult<string> {
  const name = normalizeText(value);
  const issues: ValidationIssue[] = [];

  if (!name) issues.push({ path, code: "required", message: "名称不能为空" });
  if (name.length > 80) issues.push({ path, code: "too_long", message: "名称不能超过 80 个字符" });
  if (CONTROL_CHARACTERS.test(name)) {
    issues.push({ path, code: "control_character", message: "名称不能包含控制字符" });
  }
  if (name === "." || name === ".." || RESERVED_WINDOWS_NAMES.test(name)) {
    issues.push({ path, code: "reserved_name", message: "名称不能使用系统保留字" });
  }

  return issues.length ? { ok: false, issues } : { ok: true, value: name };
}

export function isSkillCapability(value: unknown): value is SkillCapability {
  return value === "workflow" || value === "content-only";
}

export function validateCreateWorkspaceInput(value: unknown): ValidationResult<CreateWorkspaceInput> {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const name = validateDisplayName(record.name, "name");
  if (!name.ok) return name;
  return { ok: true, value: { name: name.value } };
}

export function validateCreateManagedSkillInput(value: unknown): ValidationResult<CreateManagedSkillInput> {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const name = validateDisplayName(record.name, "name");
  const issues: ValidationIssue[] = name.ok ? [] : [...name.issues];

  if (!isSkillCapability(record.capability)) {
    issues.push({ path: "capability", code: "invalid_enum", message: "Skill 类型无效" });
  }

  const description = normalizeText(record.description);
  if (description.length > 500) {
    issues.push({ path: "description", code: "too_long", message: "说明不能超过 500 个字符" });
  }

  if (issues.length || !name.ok || !isSkillCapability(record.capability)) return { ok: false, issues };

  return {
    ok: true,
    value: {
      name: name.value,
      capability: record.capability,
      ...(description ? { description } : {})
    }
  };
}

export function isStableId(value: string, prefix: "workspace" | "project" | "skill"): boolean {
  return new RegExp(`^${prefix}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "i").test(value);
}
