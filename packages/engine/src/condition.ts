import type { ConditionExpression, ConditionOperand, ValidationIssue } from "./types.js";

const referencePattern = /^(skill|runtime)(?:\.[A-Za-z_][A-Za-z0-9_-]*)+$/;
const blockedSegments = new Set(["__proto__", "prototype", "constructor"]);

export function validateCondition(condition: unknown, path = "condition", depth = 0): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (depth > 32) return [{ path, code: "condition_too_deep", message: "条件嵌套不能超过 32 层" }];
  if (!plainObject(condition)) return [{ path, code: "condition_object_required", message: "条件必须是结构化对象" }];

  if (condition.op === "boolean") {
    issues.push(...validateKeys(condition, ["op", "value"], path, "condition_field_unknown"));
    if (typeof condition.value !== "boolean") issues.push({ path: `${path}.value`, code: "boolean_required", message: "布尔条件值无效" });
    return issues;
  }
  if (condition.op === "not") {
    issues.push(...validateKeys(condition, ["op", "condition"], path, "condition_field_unknown"));
    issues.push(...validateCondition(condition.condition, `${path}.condition`, depth + 1));
    return issues;
  }
  if (condition.op === "equals" || condition.op === "notEquals") {
    issues.push(...validateKeys(condition, ["op", "left", "right"], path, "condition_field_unknown"));
    issues.push(...validateOperand(condition.left, `${path}.left`), ...validateOperand(condition.right, `${path}.right`));
    return issues;
  }
  if (condition.op === "contains") {
    issues.push(...validateKeys(condition, ["op", "container", "value"], path, "condition_field_unknown"));
    issues.push(...validateOperand(condition.container, `${path}.container`), ...validateOperand(condition.value, `${path}.value`));
    return issues;
  }
  if (condition.op === "and" || condition.op === "or") {
    issues.push(...validateKeys(condition, ["op", "conditions"], path, "condition_field_unknown"));
    if (!Array.isArray(condition.conditions) || condition.conditions.length === 0 || condition.conditions.length > 100) {
      issues.push({ path: `${path}.conditions`, code: "condition_list_invalid", message: "组合条件必须包含 1 到 100 个子条件" });
      return issues;
    }
    condition.conditions.forEach((child, index) => issues.push(...validateCondition(child, `${path}.conditions[${index}]`, depth + 1)));
    return issues;
  }
  return [{ path: `${path}.op`, code: "condition_op_unknown", message: "条件操作符不受支持" }];
}

export function evaluateCondition(
  condition: ConditionExpression,
  variables: { skill: Record<string, unknown>; runtime: Record<string, unknown> }
): boolean {
  if (condition.op === "boolean") return condition.value;
  if (condition.op === "not") return !evaluateCondition(condition.condition, variables);
  if (condition.op === "equals" || condition.op === "notEquals") {
    const equal = sameValue(resolveOperand(condition.left, variables), resolveOperand(condition.right, variables));
    return condition.op === "equals" ? equal : !equal;
  }
  if (condition.op === "contains") {
    const container = resolveOperand(condition.container, variables);
    const value = resolveOperand(condition.value, variables);
    if (typeof container === "string" && typeof value === "string") return container.includes(value);
    if (Array.isArray(container)) return container.some((item) => sameValue(item, value));
    return false;
  }
  if (condition.op === "and") return condition.conditions.every((child) => evaluateCondition(child, variables));
  if (condition.op === "or") return condition.conditions.some((child) => evaluateCondition(child, variables));
  return false;
}

function validateOperand(value: unknown, path: string): ValidationIssue[] {
  if (!plainObject(value)) return [{ path, code: "operand_object_required", message: "条件操作数必须是对象" }];
  if (value.kind === "literal") {
    const issues = validateKeys(value, ["kind", "value"], path, "operand_field_unknown");
    const values = Array.isArray(value.value) ? value.value : [value.value];
    if (values.length > 100) issues.push({ path: `${path}.value`, code: "literal_list_too_large", message: "字面量数组不能超过 100 项" });
    if (!values.every((item) => item === null || typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))) {
      issues.push({ path: `${path}.value`, code: "literal_invalid", message: "字面值仅支持有限数字、字符串、布尔值、null 或其数组" });
    }
    return issues;
  }
  if (value.kind === "ref" && typeof value.path === "string") {
    const issues = validateKeys(value, ["kind", "path"], path, "operand_field_unknown");
    const segments = value.path.split(".");
    if (!referencePattern.test(value.path) || segments.some((segment) => blockedSegments.has(segment))) {
      issues.push({ path: `${path}.path`, code: "reference_invalid", message: "变量引用必须是安全的 skill.* 或 runtime.* 路径" });
    }
    return issues;
  }
  return [{ path: `${path}.kind`, code: "operand_kind_unknown", message: "条件操作数类型不受支持" }];
}

function validateKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, code: string): ValidationIssue[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .sort()
    .map((key) => ({ path: `${path}.${key}`, code, message: `字段 ${key} 不属于该条件结构` }));
}

function resolveOperand(
  operand: ConditionOperand,
  variables: { skill: Record<string, unknown>; runtime: Record<string, unknown> }
): unknown {
  if (operand.kind === "literal") return operand.value;
  const [namespace, ...segments] = operand.path.split(".");
  let current: unknown = namespace === "skill" ? variables.skill : variables.runtime;
  for (const segment of segments) {
    if (!plainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return JSON.stringify(left) === JSON.stringify(right);
  return false;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
