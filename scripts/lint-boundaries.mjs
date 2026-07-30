import { readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));
const packages = [
  { name: "engine", sourceRoot: path.join(root, "packages/engine/src") },
  { name: "server", sourceRoot: path.join(root, "packages/server/src") },
  { name: "web", sourceRoot: path.join(root, "packages/web/src") }
];

await validateEngineManifest();
await validateExampleDescriptor();

for (const current of packages) {
  for (const file of await sourceFiles(current.sourceRoot)) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    for (const diagnostic of source.parseDiagnostics) {
      errors.push(`${relative(file)}:${source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1} 无法解析：${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    }
    visitImports(source, (specifier, node) => validateImport(current, file, source, node, specifier));
  }
}

if (errors.length) {
  console.error(`边界 Lint 失败（${errors.length} 项）：`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("边界 Lint 通过：engine/server/web 依赖方向与双 Skill 示例均符合约束。");
}

async function validateEngineManifest() {
  const manifest = JSON.parse(await readFile(path.join(root, "packages/engine/package.json"), "utf8"));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const entries = Object.keys(manifest[field] ?? {});
    if (entries.length) errors.push(`packages/engine/package.json 的 ${field} 必须为空，发现：${entries.join(", ")}`);
  }
}

async function validateExampleDescriptor() {
  const exampleRoot = path.join(root, "examples/multi-skill-workspace");
  const descriptor = JSON.parse(await readFile(path.join(exampleRoot, "example-workspace.json"), "utf8"));
  if (descriptor.schemaVersion !== "1.0" || !Array.isArray(descriptor.members) || descriptor.members.length < 2) {
    errors.push("examples/multi-skill-workspace/example-workspace.json 必须是至少包含两个成员的 1.0 场景");
    return;
  }
  const ids = new Set();
  const capabilities = new Set();
  for (const [index, member] of descriptor.members.entries()) {
    if (typeof member.relativePath !== "string" || member.relativePath.includes("\\") || path.posix.isAbsolute(member.relativePath) || member.relativePath.split("/").includes("..")) {
      errors.push(`示例成员 members[${index}].relativePath 不是可移植相对路径`);
      continue;
    }
    const projectRoot = path.resolve(exampleRoot, member.relativePath);
    if (!projectRoot.startsWith(`${exampleRoot}${path.sep}`)) {
      errors.push(`示例成员 members[${index}] 越出示例根目录`);
      continue;
    }
    try {
      const [manifest, graph] = await Promise.all([
        readJson(path.join(projectRoot, "skill.json")),
        readJson(path.join(projectRoot, "graph/main.json")),
        readFile(path.join(projectRoot, "SKILL.md"), "utf8")
      ]);
      if (manifest.skillId !== member.skillId || graph.skillId !== member.skillId) errors.push(`示例成员 ${member.relativePath} 的 skillId 不一致`);
      if (manifest.capability !== member.capability || graph.capability !== member.capability) errors.push(`示例成员 ${member.relativePath} 的 capability 不一致`);
      if (ids.has(member.skillId)) errors.push(`示例 Workspace 存在重复 skillId：${member.skillId}`);
      ids.add(member.skillId);
      capabilities.add(member.capability);
    } catch (error) {
      errors.push(`示例成员 ${member.relativePath} 缺少或无法解析核心文件：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!capabilities.has("workflow") || !capabilities.has("content-only")) errors.push("示例 Workspace 必须同时覆盖 workflow 和 content-only");
}

function validateImport(current, file, source, node, specifier) {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const location = `${relative(file)}:${line}`;
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(file), specifier);
    if (resolved !== current.sourceRoot && !resolved.startsWith(`${current.sourceRoot}${path.sep}`)) {
      errors.push(`${location} 相对导入越出 ${current.name}/src：${specifier}`);
    }
    return;
  }
  const normalized = specifier.replace(/^node:/u, "").split("/")[0];
  if (current.name === "engine") {
    errors.push(`${location} engine 只允许自身相对导入，发现：${specifier}`);
  } else if (current.name === "web" && (specifier.startsWith("node:") || builtins.has(normalized))) {
    errors.push(`${location} web 不允许依赖 Node 模块：${specifier}`);
  } else if (current.name === "web" && specifier.startsWith("@skill-designer/server")) {
    errors.push(`${location} web 不允许绕过 HTTP 依赖 server：${specifier}`);
  } else if (current.name === "server" && specifier.startsWith("@skill-designer/web")) {
    errors.push(`${location} server 不允许反向依赖 web：${specifier}`);
  }
}

function visitImports(source, callback) {
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      callback(node.moduleSpecifier.text, node);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      callback(node.argument.literal.text, node);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      callback(node.arguments[0].text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(item));
    else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) result.push(item);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}
