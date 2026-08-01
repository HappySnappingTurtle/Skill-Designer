import TOML from "@iarna/toml";
import type { Root, Content, Link, Image, Definition, InlineCode } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { parseDocument } from "yaml";
import {
  indexDocument,
  type ImportDiagnostic,
  type ImportFormatSignal,
  type ImportFrontmatterDialect,
  type ImportFrontmatterSummary,
  type ImportReference,
  type ImportReferenceKind,
  type ImportStructuredValue
} from "@skill-designer/engine";

export interface ImportInventoryFile {
  path: string;
  content?: string;
}

export interface ImportedIdentityEvidence {
  value: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  method: "frontmatter" | "markdown-heading" | "markdown-paragraph";
}

export interface ImportAssetInventoryAnalysis {
  frontmatter?: ImportFrontmatterSummary;
  references: ImportReference[];
  formatSignals: ImportFormatSignal[];
  diagnostics: ImportDiagnostic[];
  identity: {
    name?: ImportedIdentityEvidence;
    description?: ImportedIdentityEvidence;
  };
}

const recognizedAliases = new Map<string, keyof ImportFrontmatterSummary["recognized"]>([
  ["name", "name"],
  ["title", "name"],
  ["displayname", "name"],
  ["description", "description"],
  ["summary", "description"],
  ["version", "version"],
  ["license", "license"],
  ["compatibility", "compatibility"],
  ["allowedtools", "allowedTools"],
  ["tools", "allowedTools"]
]);

const frontmatterReferenceKeys = new Set(["reference", "references", "doc", "docs", "file", "files", "include", "includes", "resource", "resources"]);
const inlinePathPattern = /^(?:\.{1,2}\/)?(?:[^\s/]+\/)*[^\s/]+\.(?:md|markdown|json|ya?ml|txt|pdf|png|jpe?g|gif|webp|svg|mp3|wav|mp4|webm)(?:#[^\s]+)?$/iu;
const externalTargetPattern = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;
const maxReferences = 2000;

export function analyzeImportAssets(files: ImportInventoryFile[]): ImportAssetInventoryAnalysis {
  const ordered = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const skillDocument = ordered.find((file) => file.path === "SKILL.md");
  const markdown = skillDocument?.content ?? "";
  const frontmatter = markdown ? parseImportFrontmatter(markdown) : undefined;
  const parsedRoot = markdown ? parseMarkdown(maskFrontmatter(markdown, frontmatter)) : undefined;
  const identity = parsedRoot ? extractIdentity(parsedRoot, frontmatter) : {};
  const references = scanReferences(ordered, frontmatter);
  const diagnostics: ImportDiagnostic[] = [];

  if (frontmatter?.status === "invalid") {
    diagnostics.push({ severity: "warning", code: "frontmatter_invalid", message: `SKILL.md 的 ${frontmatter.dialect.toUpperCase()} frontmatter 无法解析：${frontmatter.error ?? "格式无效"}`, path: "SKILL.md" });
  } else if (frontmatter?.status === "unterminated") {
    diagnostics.push({ severity: "warning", code: "frontmatter_unterminated", message: `SKILL.md 的 ${frontmatter.dialect.toUpperCase()} frontmatter 缺少结束分隔符`, path: "SKILL.md" });
  }
  addReferenceDiagnostic(diagnostics, references, "missing", "missing_import_references", "个相对引用找不到目标文件");
  addReferenceDiagnostic(diagnostics, references, "candidate", "inline_code_reference_candidates", "个代码路径候选未在导入资产中解析；仅供审阅，不视为缺失引用", "info");
  addReferenceDiagnostic(diagnostics, references, "missing-anchor", "missing_import_anchors", "个 Markdown 引用找不到目标锚点");
  addReferenceDiagnostic(diagnostics, references, "escaped", "escaped_import_references", "个引用指向导入目录之外；工具不会读取目录外内容");
  addReferenceDiagnostic(diagnostics, references, "invalid", "invalid_import_references", "个引用不是可解析的项目相对路径");
  if (references.length >= maxReferences) {
    diagnostics.push({ severity: "warning", code: "import_references_truncated", message: `引用清单达到 ${maxReferences} 项上限，后续引用未进入预检`, path: "SKILL.md" });
  }

  const formatSignals: ImportFormatSignal[] = skillDocument ? [{
    code: "root-skill-markdown",
    path: "SKILL.md",
    confidence: "high",
    message: "发现根级 SKILL.md"
  }] : [];
  if (frontmatter) formatSignals.push({
    code: `${frontmatter.dialect}-frontmatter`,
    path: "SKILL.md",
    confidence: frontmatter.status === "valid" ? "high" : "low",
    message: `${frontmatter.dialect.toUpperCase()} frontmatter ${frontmatter.status === "valid" ? "解析成功" : "需要检查"}`
  });

  return {
    ...(frontmatter ? { frontmatter } : {}),
    references,
    formatSignals,
    diagnostics,
    identity
  };
}

export function parseImportFrontmatter(markdown: string): ImportFrontmatterSummary | undefined {
  const lines = normalizeMarkdown(markdown).split("\n");
  const first = lines[0]?.trim();
  if (first === "---") return parseDelimitedFrontmatter(lines, "yaml", "---", new Set(["---", "..."]));
  if (first === "+++") return parseDelimitedFrontmatter(lines, "toml", "+++", new Set(["+++"]));
  if (first === "{") return parseJsonFrontmatter(lines);
  return undefined;
}

function parseDelimitedFrontmatter(lines: string[], dialect: ImportFrontmatterDialect, opening: string, endings: Set<string>): ImportFrontmatterSummary {
  const endIndex = lines.findIndex((line, index) => index > 0 && endings.has(line.trim()));
  if (endIndex < 0) return emptyFrontmatter(dialect, "unterminated", lines.length, `缺少 ${opening} 结束分隔符`);
  const body = lines.slice(1, endIndex).join("\n");
  try {
    const parsed = dialect === "yaml" ? parseYaml(body) : TOML.parse(body);
    return frontmatterFromValue(dialect, parsed, endIndex + 1);
  } catch (error) {
    return emptyFrontmatter(dialect, "invalid", endIndex + 1, errorMessage(error));
  }
}

function parseJsonFrontmatter(lines: string[]): ImportFrontmatterSummary {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let endLine = -1;
  const text = lines.join("\n");
  for (let index = 0, line = 1; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\n") line += 1;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        endLine = line;
        break;
      }
    }
  }
  if (endLine < 0) return emptyFrontmatter("json", "unterminated", lines.length, "JSON 对象没有闭合");
  const body = lines.slice(0, endLine).join("\n");
  try {
    return frontmatterFromValue("json", JSON.parse(body), endLine);
  } catch (error) {
    return emptyFrontmatter("json", "invalid", endLine, errorMessage(error));
  }
}

function parseYaml(body: string): unknown {
  const document = parseDocument(body, { schema: "core", strict: true, uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors[0]!.message);
  return document.toJS({ maxAliasCount: 50 });
}

function frontmatterFromValue(dialect: ImportFrontmatterDialect, value: unknown, endLine: number): ImportFrontmatterSummary {
  const normalized = normalizeStructuredValue(value);
  if (!isStructuredRecord(normalized)) return emptyFrontmatter(dialect, "invalid", endLine, "frontmatter 顶层必须是对象");
  const recognized: ImportFrontmatterSummary["recognized"] = {};
  const recognizedKeys = new Set<string>();
  for (const [key, raw] of Object.entries(normalized)) {
    const alias = recognizedAliases.get(normalizeFieldName(key));
    if (!alias) continue;
    recognizedKeys.add(key);
    if (alias === "allowedTools") {
      const tools = stringList(raw);
      if (tools.length) recognized.allowedTools = tools;
    } else if (typeof raw === "string" && raw.trim()) {
      recognized[alias] = raw.trim();
    } else if ((typeof raw === "number" || typeof raw === "boolean") && alias === "version") {
      recognized.version = String(raw);
    }
  }
  return {
    path: "SKILL.md",
    dialect,
    status: "valid",
    startLine: 1,
    endLine,
    data: normalized,
    recognized,
    unknownKeys: Object.keys(normalized).filter((key) => !recognizedKeys.has(key)).sort((left, right) => left.localeCompare(right))
  };
}

function emptyFrontmatter(dialect: ImportFrontmatterDialect, status: "invalid" | "unterminated", endLine: number, error: string): ImportFrontmatterSummary {
  return { path: "SKILL.md", dialect, status, startLine: 1, endLine, data: {}, recognized: {}, unknownKeys: [], error };
}

function normalizeStructuredValue(value: unknown, depth = 0): ImportStructuredValue {
  if (depth > 30) throw new Error("frontmatter 嵌套层级超过 30");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => normalizeStructuredValue(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, ImportStructuredValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) result[key] = normalizeStructuredValue(item, depth + 1);
    }
    return result;
  }
  throw new Error("frontmatter 包含不支持的值类型");
}

function scanReferences(files: ImportInventoryFile[], rootFrontmatter?: ImportFrontmatterSummary): ImportReference[] {
  const filePaths = new Set(files.map((file) => file.path));
  const canonicalPaths = new Map(files.map((file) => [file.path.toLocaleLowerCase("en-US"), file.path]));
  const markdown = new Map(files.filter((file) => file.content !== undefined && /\.md$/iu.test(file.path)).map((file) => [file.path, file.content!]));
  const found: Array<Omit<ImportReference, "referenceId">> = [];

  for (const file of files) {
    if (file.content === undefined || !/\.md$/iu.test(file.path)) continue;
    const ownFrontmatter = file.path === "SKILL.md" ? rootFrontmatter : parseImportFrontmatter(file.content);
    const tree = parseMarkdown(maskFrontmatter(file.content, ownFrontmatter));
    visit(tree, (node) => {
      if (node.type === "link" || node.type === "image" || node.type === "definition") {
        const targetNode = node as Link | Image | Definition;
        const kind: ImportReferenceKind = node.type === "link" ? "markdown-link" : node.type === "image" ? "markdown-image" : "markdown-definition";
        found.push(resolveReference(file.path, node.position?.start.line ?? 1, kind, targetNode.url, filePaths, canonicalPaths, markdown));
      } else if (node.type === "inlineCode") {
        const rawTarget = (node as InlineCode).value.trim();
        if (inlinePathPattern.test(rawTarget)) found.push(resolveReference(file.path, node.position?.start.line ?? 1, "inline-code", rawTarget, filePaths, canonicalPaths, markdown));
      }
    });
    if (ownFrontmatter?.status === "valid") {
      for (const rawTarget of frontmatterReferenceValues(ownFrontmatter.data)) {
        found.push(resolveReference(file.path, ownFrontmatter.startLine, "frontmatter", rawTarget, filePaths, canonicalPaths, markdown));
      }
    }
    if (found.length >= maxReferences) break;
  }

  const deduplicated = new Map<string, Omit<ImportReference, "referenceId">>();
  for (const reference of found.slice(0, maxReferences)) {
    const key = `${reference.sourcePath}\u0000${reference.startLine}\u0000${reference.kind}\u0000${reference.rawTarget}`;
    if (!deduplicated.has(key)) deduplicated.set(key, reference);
  }
  return [...deduplicated.values()].map((reference, index) => ({ referenceId: `reference-${String(index + 1).padStart(4, "0")}`, ...reference }));
}

function resolveReference(
  sourcePath: string,
  startLine: number,
  kind: ImportReferenceKind,
  rawTarget: string,
  filePaths: Set<string>,
  canonicalPaths: Map<string, string>,
  markdown: Map<string, string>
): Omit<ImportReference, "referenceId"> {
  const trimmed = rawTarget.trim();
  if (!trimmed || externalTargetPattern.test(trimmed)) {
    return { sourcePath, startLine, kind, rawTarget, status: "external", message: trimmed ? "外部引用只记录，不发起网络请求" : "空引用不解析" };
  }
  if (trimmed.includes("\\") || trimmed.startsWith("/")) {
    return { sourcePath, startLine, kind, rawTarget, status: "invalid", message: "引用必须使用项目内 POSIX 相对路径" };
  }
  const hashIndex = trimmed.indexOf("#");
  const queryIndex = trimmed.indexOf("?");
  const pathEnd = [hashIndex, queryIndex].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? trimmed.length;
  const pathPart = safeDecode(trimmed.slice(0, pathEnd));
  const fragment = hashIndex >= 0 ? safeDecode(trimmed.slice(hashIndex + 1).split("?")[0] ?? "") : "";
  const normalized = normalizeRelativeTarget(sourcePath, pathPart);
  if (!normalized) return { sourcePath, startLine, kind, rawTarget, status: "escaped", ...(fragment ? { fragment } : {}), message: "引用越过了导入目录边界" };
  const target = canonicalPaths.get(normalized.toLocaleLowerCase("en-US")) ?? normalized;
  const isDirectory = [...filePaths].some((filePath) => filePath.startsWith(`${target.replace(/\/$/u, "")}/`));
  if (!filePaths.has(target) && !isDirectory) {
    if (kind === "inline-code") {
      return { sourcePath, startLine, kind, rawTarget, status: "candidate", normalizedTarget: target, ...(fragment ? { fragment } : {}), message: "代码中的路径样文本未在导入资产中解析；仅记录候选" };
    }
    return { sourcePath, startLine, kind, rawTarget, status: "missing", normalizedTarget: target, ...(fragment ? { fragment } : {}), message: "导入资产中不存在该目标" };
  }
  if (fragment && markdown.has(target)) {
    const anchors = indexDocument(markdown.get(target)!).map((heading) => heading.anchor.toLocaleLowerCase("zh-CN"));
    if (!anchors.includes(fragment.toLocaleLowerCase("zh-CN"))) {
      return { sourcePath, startLine, kind, rawTarget, status: "missing-anchor", normalizedTarget: target, fragment, message: "目标 Markdown 中不存在该锚点" };
    }
  }
  return {
    sourcePath,
    startLine,
    kind,
    rawTarget,
    status: "resolved",
    normalizedTarget: target,
    ...(fragment ? { fragment } : {}),
    message: target === normalized ? "已解析到导入资产" : `已按实际路径大小写解析为 ${target}`
  };
}

function normalizeRelativeTarget(sourcePath: string, rawPath: string): string | null {
  const base = sourcePath.split("/").slice(0, -1);
  const segments = rawPath ? rawPath.split("/") : [sourcePath.split("/").at(-1)!];
  const result = [...base];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!result.length) return null;
      result.pop();
    } else result.push(segment.normalize("NFC"));
  }
  return result.join("/");
}

function frontmatterReferenceValues(data: Record<string, ImportStructuredValue>): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!frontmatterReferenceKeys.has(normalizeFieldName(key))) continue;
    if (typeof value === "string") result.push(value);
    else if (Array.isArray(value)) result.push(...value.filter((item): item is string => typeof item === "string"));
  }
  return result;
}

function extractIdentity(root: Root, frontmatter?: ImportFrontmatterSummary): ImportAssetInventoryAnalysis["identity"] {
  const recognized = frontmatter?.status === "valid" ? frontmatter.recognized : {};
  const firstHeading = root.children.find((node) => node.type === "heading" && node.depth === 1);
  const firstParagraph = root.children.find((node) => node.type === "paragraph");
  const name = recognized.name
    ? { value: recognized.name, sourcePath: "SKILL.md", startLine: frontmatter!.startLine, endLine: frontmatter!.endLine, method: "frontmatter" as const }
    : firstHeading
      ? { value: nodeText(firstHeading), sourcePath: "SKILL.md", startLine: firstHeading.position?.start.line ?? 1, endLine: firstHeading.position?.end.line ?? firstHeading.position?.start.line ?? 1, method: "markdown-heading" as const }
      : undefined;
  const description = recognized.description
    ? { value: recognized.description, sourcePath: "SKILL.md", startLine: frontmatter!.startLine, endLine: frontmatter!.endLine, method: "frontmatter" as const }
    : firstParagraph
      ? { value: nodeText(firstParagraph), sourcePath: "SKILL.md", startLine: firstParagraph.position?.start.line ?? 1, endLine: firstParagraph.position?.end.line ?? firstParagraph.position?.start.line ?? 1, method: "markdown-paragraph" as const }
      : undefined;
  return { ...(name?.value ? { name } : {}), ...(description?.value ? { description } : {}) };
}

function nodeText(node: Content): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children)) return node.children.map((child) => nodeText(child as Content)).join("").trim();
  return "";
}

function parseMarkdown(markdown: string): Root {
  return unified().use(remarkParse).use(remarkFrontmatter, ["yaml", "toml"]).use(remarkGfm).parse(markdown) as Root;
}

function maskFrontmatter(markdown: string, frontmatter?: ImportFrontmatterSummary): string {
  if (!frontmatter) return markdown;
  const lines = normalizeMarkdown(markdown).split("\n");
  for (let index = 0; index < Math.min(frontmatter.endLine, lines.length); index += 1) lines[index] = "";
  return lines.join("\n");
}

function addReferenceDiagnostic(diagnostics: ImportDiagnostic[], references: ImportReference[], status: ImportReference["status"], code: string, suffix: string, severity: ImportDiagnostic["severity"] = "warning"): void {
  const count = references.filter((reference) => reference.status === status).length;
  if (count) diagnostics.push({ severity, code, message: `发现 ${count} ${suffix}` });
}

function isStructuredRecord(value: ImportStructuredValue): value is Record<string, ImportStructuredValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFieldName(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[-_\s]/gu, "");
}

function stringList(value: ImportStructuredValue): string[] {
  if (typeof value === "string") return value.split(/[,\n]/u).map((item) => item.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return [];
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeMarkdown(value: string): string {
  return value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").normalize("NFC");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "格式无效";
}
