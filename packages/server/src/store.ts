import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, type Dirent } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import { genericEngineCli, genericEngineUsage } from "./generic-export.js";
import {
  applyGraphOperations,
  advanceRuntime,
  type AssetChangeOperation,
  type AssetChangePreview,
  type AssetFileFact,
  type AssetReferenceImpact,
  buildImportParseReview,
  type ApplyChangeSetResult,
  availableTransitions,
  evaluateTransitionConditions,
  type BenchmarkCase,
  type BenchmarkCaseChangeOperation,
  type BenchmarkCaseEntry,
  type BenchmarkRunRecord,
  type BugReportDocument,
  type BugReportDeletionResult,
  type BugReportRecord,
  type BugReportSanitizationMode,
  type ChangeOperation,
  type ConditionExpression,
  type CreateManagedSkillInput,
  type CreateChangeSetInput,
  diffGraph,
  executeProjectFactQueries,
  type DocumentEntry,
  type DocumentChangeOperation,
  type DocumentChangePreview,
  type DocumentFile,
  type DocumentReference,
  type DiagnosisRecord,
  type DiagnosisRepairProposal,
  type DiagnosisRepairRecord,
  type ExecutionTracePage,
  type ProjectDocumentSlice,
  type ProjectFileMutationStep,
  type ProjectAssetEntry,
  type ProjectAssetFile,
  type CreateSkillImportInput,
  type GenericExportRecord,
  type GenericExportDeletionResult,
  type GitDiffResult,
  type GraphChangeOperation,
  GraphOperationError,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphLintIssue,
  type GraphNode,
  type GraphNodeKind,
  type ImportedBugReport,
  type ImportedBugReportDeletionResult,
  type ImportParserVersion,
  type ImportProvenanceRecord,
  importReviewGraph,
  isSkillDocumentPath,
  createBenchmarkCaseFromReport,
  createBenchmarkCaseFromRuntime,
  createReportFixture as buildReportFixture,
  createRuntimeState,
  createBenchmarkBugReportDocument,
  createBugReportDocument,
  bugReportMarkdown,
  diagnoseBugReport,
  lintGraph,
  lintBenchmarkCase,
  sliceDocument,
  type SkillManifest,
  type SkillManifestUpdateOperation,
  type SkillGraph,
  type ProjectChangeSet,
  type ProjectBaseline,
  type ProjectBenchmarkCase,
  type ProjectRevision,
  type ProjectRestoreChangePreview,
  type ProjectRestoreOperation,
  type ProjectRevisionStatus,
  type ReproposeChangeSetInput,
  type ResolveImportReparseInput,
  type ProjectSnapshotManifest,
  type ProjectTransactionJournal,
  type SkillImportCandidate,
  type SkillImportParseReview,
  type SkillImportPreview,
  type SkillImportReviewSnapshot,
  type UpdateSkillImportReviewInput,
  type ProjectRun,
  type ProjectRunView,
  type ProjectFactQueryResult,
  type ProjectFactQuery,
  type PreparedBenchmarkExecution,
  type RuntimeArtifact,
  type RuntimeArtifactCleanupResult,
  type RuntimeArtifactStorageStatus,
  type RuntimeBenchmarkCandidate,
  type RuntimeEngineEvent,
  type RuntimeTraceEvent,
  type ReportBenchmarkCandidate,
  type ReportFixture,
  type ReportFixtureReplay,
  pauseRuntime,
  replayReportFixture,
  reduceTrace,
  resumeRuntime,
  stopRuntime,
  type Workspace,
  type WorkspaceDeletionResult,
  type WorkspaceMember,
  type WorkspaceSummary,
  validateCreateManagedSkillInput,
  validateCreateWorkspaceInput,
  validateBugReportDocument,
  withImportReviewLint
} from "@skill-designer/engine";
import { analyzeImportAssets, type ImportAssetInventoryAnalysis } from "./ingest-inventory.js";
import { AppError } from "./errors.js";
import { GitDiffService } from "./git.js";
import { ExecutionTraceStore } from "./trace-store.js";

export interface StoreOptions {
  dataDir: string;
  now?: () => Date;
  idFactory?: () => string;
  afterFileMutation?: (event: { journal: ProjectTransactionJournal; step: ProjectFileMutationStep }) => void | Promise<void>;
}

export interface ApplyLLMImportReviewInput {
  workspaceId: string;
  reviewRevision: number;
  sourceDigest: string;
  parserVersion: Extract<ImportParserVersion, "llm-v1">;
  snapshot: SkillImportReviewSnapshot;
}

export interface RuntimeDebugContext {
  view: ProjectRunView;
  currentNode: GraphNode;
  document: {
    path: string;
    anchor: string | null;
    status: "found" | "whole-document" | "missing" | "ambiguous";
    content: string;
  } | null;
  conditionEvaluations: Array<{ edgeId: string; to: string; conditionOp: string; result: boolean }>;
  facts: ProjectFactQueryResult[];
}

export interface RuntimeTraceDraft {
  type: "condition.evaluated" | "document.context" | "context.queried" | "conversation.user" | "conversation.assistant" | "llm.request" | "llm.response" | "llm.error";
  actor: "user" | "model" | "system";
  data: Record<string, unknown>;
}

function isGraphOperation(operation: ChangeOperation): operation is GraphChangeOperation {
  return operation.op.startsWith("graph.");
}

function isBenchmarkCaseOperation(operation: ChangeOperation): operation is BenchmarkCaseChangeOperation {
  return operation.op === "benchmark.case.write" || operation.op === "benchmark.case.delete";
}

function isDocumentOperation(operation: ChangeOperation): operation is DocumentChangeOperation {
  return operation.op === "docs.write" || operation.op === "docs.rename" || operation.op === "docs.delete";
}

function isProjectRestoreOperation(operation: ChangeOperation): operation is ProjectRestoreOperation {
  return operation.op === "project.restore";
}

function isSkillManifestOperation(operation: ChangeOperation): operation is SkillManifestUpdateOperation {
  return operation.op === "skill.update";
}

function isAssetOperation(operation: ChangeOperation): operation is AssetChangeOperation {
  return operation.op === "asset.copy" || operation.op === "asset.delete";
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError(400, "invalid_object", "操作值必须是对象");
  }
  return value as Record<string, unknown>;
}

const GRAPH_NODE_KNOWN_FIELDS = new Set(["id", "kind", "title", "description", "doc", "docAnchor", "lookup", "position", "extensions"]);
const GRAPH_EDGE_KNOWN_FIELDS = new Set(["id", "from", "to", "kind", "label", "condition", "extensions"]);
const GRAPH_EXTENSION_BYTES = 64 * 1024;
const RUNTIME_ARTIFACT_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

interface RuntimeArtifactStorageScan {
  status: RuntimeArtifactStorageStatus;
  eligible: Array<{ artifactId: string; file: string; size: number; createdAt: string }>;
  protectedArtifactIds: Set<string>;
}

function preservedGraphFields(item: Record<string, unknown>, knownFields: Set<string>, label: string): Record<string, unknown> {
  const unknownEntries = Object.entries(item).filter(([field]) => !knownFields.has(field));
  const payload = Object.fromEntries([
    ...unknownEntries,
    ...(item.extensions === undefined ? [] : [["extensions", item.extensions] as [string, unknown]])
  ]);
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
    if (stableJson(payload) !== stableJson(JSON.parse(serialized))) throw new Error("lossy JSON value");
  } catch {
    throw new AppError(400, "graph_extension_invalid", `${label} 的扩展字段必须是普通 JSON 数据`);
  }
  if (Buffer.byteLength(serialized, "utf8") > GRAPH_EXTENSION_BYTES) {
    throw new AppError(413, "graph_extension_too_large", `${label} 的扩展字段不能超过 64 KiB`);
  }
  const clone = JSON.parse(serialized) as Record<string, unknown>;
  delete clone.extensions;
  return clone;
}

function stableJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AppError(400, "runtime_input_invalid", "运行初始变量只能包含有限 JSON 数值");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") throw new AppError(400, "runtime_input_invalid", "运行初始变量必须是 JSON 可序列化值");
  if (seen.has(value)) throw new AppError(400, "runtime_input_invalid", "运行初始变量不能包含循环引用");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, seen)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new AppError(400, "runtime_input_invalid", "运行初始变量只能包含普通 JSON 对象");
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

const textFileExtensions = new Set([".md", ".json", ".txt", ".yaml", ".yml", ".js", ".mjs", ".cjs", ".ts", ".sh", ".ps1"]);

interface ProjectSource {
  projectId: string;
  skillId: string;
  mode: "managed-copy" | "in-place";
  root: string;
}

interface ProjectState {
  projectId: string;
  skillId: string;
  activeRevision: string;
  currentSnapshotId?: string;
  createdAt: string;
  updatedAt?: string;
}

interface ParsedImportFile {
  path: string;
  content: Buffer;
}

interface InspectedImport {
  manifest?: SkillManifest;
  graph?: SkillGraph;
  markdown: string;
  identity: ImportAssetInventoryAnalysis["identity"];
  displayName: string;
  description: string;
  capability: SkillManifest["capability"];
  generatedFiles: string[];
  diagnostics: SkillImportCandidate["diagnostics"];
  frontmatter?: SkillImportCandidate["frontmatter"];
  references: SkillImportCandidate["references"];
  formatSignals: SkillImportCandidate["formatSignals"];
}

export class WorkspaceStore {
  readonly dataDir: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly afterFileMutation?: StoreOptions["afterFileMutation"];
  private readonly git = new GitDiffService();
  private readonly traceEmitter = new EventEmitter().setMaxListeners(0);
  private readonly traceStore: ExecutionTraceStore;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private initializationPromise?: Promise<void>;

  constructor(options: StoreOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.afterFileMutation = options.afterFileMutation;
    this.traceStore = new ExecutionTraceStore(path.join(this.dataDir, "traces"));
  }

  async initialize(): Promise<void> {
    this.initializationPromise ??= this.initializeOnce();
    return this.initializationPromise;
  }

  private async initializeOnce(): Promise<void> {
    await Promise.all([
      mkdir(this.workspaceRoot(), { recursive: true }),
      mkdir(this.projectStateRoot(), { recursive: true }),
      mkdir(this.managedProjectRoot(), { recursive: true }),
      this.traceStore.initialize()
    ]);
    await this.recoverInterruptedTransactions();
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    await this.initialize();
    const entries = await readdir(this.workspaceRoot(), { withFileTypes: true });
    const workspaces = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("workspace-"))
        .map(async (entry) => this.readWorkspace(entry.name))
    );

    return workspaces
      .map((workspace) => this.toSummary(workspace))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createWorkspace(input: unknown): Promise<Workspace> {
    const validated = validateCreateWorkspaceInput(input);
    if (!validated.ok) throw new AppError(400, "validation_failed", "Workspace 信息无效", validated.issues);

    return this.mutate(async () => {
      await this.initialize();
      const timestamp = this.now().toISOString();
      const workspace: Workspace = {
        workspaceId: this.prefixedId("workspace"),
        name: validated.value.name,
        selectedProjectId: null,
        members: [],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      await mkdir(this.workspaceDir(workspace.workspaceId), { recursive: true });
      await this.writeWorkspace(workspace);
      return workspace;
    });
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    this.assertId(workspaceId, "workspace");
    return this.readWorkspace(workspaceId);
  }

  async renameWorkspace(workspaceId: string, input: unknown): Promise<Workspace> {
    this.assertId(workspaceId, "workspace");
    const validated = validateCreateWorkspaceInput(input);
    if (!validated.ok) throw new AppError(400, "validation_failed", "Workspace 信息无效", validated.issues);

    return this.mutate(async () => {
      const workspace = await this.readWorkspace(workspaceId);
      workspace.name = validated.value.name;
      workspace.updatedAt = this.now().toISOString();
      await this.writeWorkspace(workspace);
      return workspace;
    });
  }

  async deleteWorkspace(workspaceId: string): Promise<WorkspaceDeletionResult> {
    this.assertId(workspaceId, "workspace");
    return this.mutate(async () => {
      const workspace = await this.readWorkspace(workspaceId);
      const preservedProjects = await Promise.all(workspace.members.map(async (member) => {
        try {
          const source = await this.readProjectSource(member.projectId);
          return { projectId: member.projectId, skillId: member.skillId, mode: member.mode, sourcePath: source.root };
        } catch {
          return {
            projectId: member.projectId,
            skillId: member.skillId,
            mode: member.mode,
            ...(member.sourcePath ? { sourcePath: member.sourcePath } : {})
          };
        }
      }));
      const deletedAt = this.now().toISOString();
      await rm(this.workspaceDir(workspaceId), { recursive: true, force: false });
      return { workspaceId, deletedAt, preservedProjects };
    });
  }

  async getProjectGraph(projectId: string): Promise<{
    graph: SkillGraph;
    lint: ReturnType<typeof lintGraph>;
    activeRevision: string;
  }> {
    this.assertId(projectId, "project");
    const source = await this.readProjectSource(projectId);
    const state = await this.readProjectState(projectId);
    const graph = await this.readGraph(source);
    return { graph, lint: [...lintGraph(graph), ...await this.lintDocumentBindings(source, graph)], activeRevision: state.activeRevision };
  }

  async getSkillManifest(projectId: string): Promise<{ manifest: SkillManifest; activeRevision: string }> {
    this.assertId(projectId, "project");
    const [source, state] = await Promise.all([this.readProjectSource(projectId), this.readProjectState(projectId)]);
    await this.assertProjectReadPath(source, path.join(source.root, "skill.json"));
    return { manifest: await this.readSkillManifest(source), activeRevision: state.activeRevision };
  }

  async listAssets(projectId: string): Promise<ProjectAssetEntry[]> {
    this.assertId(projectId, "project");
    const source = await this.readProjectSource(projectId);
    const assetsRoot = path.join(source.root, "assets");
    await this.assertProjectReadPath(source, assetsRoot);
    let files: string[];
    try {
      files = await this.walkProjectFiles(source, assetsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const references = await this.allAssetReferences(source);
    const referenceCounts = new Map<string, number>();
    for (const reference of references) {
      referenceCounts.set(reference.target, (referenceCounts.get(reference.target) ?? 0) + 1);
    }
    return Promise.all(files.map(async (file) => {
      const relative = path.relative(source.root, file).split(path.sep).join("/").normalize("NFC");
      const [content, info] = await Promise.all([readFile(file), stat(file)]);
      return {
        ...this.assetFact(relative, content),
        updatedAt: info.mtime.toISOString(),
        referenceCount: referenceCounts.get(relative) ?? 0
      };
    })).then((entries) => entries.sort((left, right) => left.path.localeCompare(right.path)));
  }

  async readAsset(projectId: string, relativePath: string): Promise<ProjectAssetFile> {
    this.assertId(projectId, "project");
    const source = await this.readProjectSource(projectId);
    const normalizedPath = this.normalizeAssetPath(relativePath);
    const target = this.resolveAssetPath(source, normalizedPath);
    try {
      await this.assertProjectReadPath(source, target);
      const [content, info, references] = await Promise.all([
        readFile(target),
        stat(target),
        this.assetReferences(source, normalizedPath)
      ]);
      if (!info.isFile()) throw new AppError(404, "asset_not_found", "资产不存在");
      return {
        ...this.assetFact(normalizedPath, content),
        updatedAt: info.mtime.toISOString(),
        referenceCount: references.length,
        contentBase64: content.toString("base64")
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "asset_not_found", "资产不存在");
      throw error;
    }
  }

  async listDocuments(projectId: string): Promise<DocumentEntry[]> {
    this.assertId(projectId, "project");
    const source = await this.readProjectSource(projectId);
    const graph = await this.readGraph(source);
    const references = new Map<string, number>();
    for (const node of graph.nodes) {
      if (node.doc) references.set(node.doc, (references.get(node.doc) ?? 0) + 1);
    }
    const entries: DocumentEntry[] = [];
    for (const relative of await this.walkMarkdown(source.root, "")) {
      const target = this.resolveDocumentPath(source, relative);
      try {
        await this.assertProjectReadPath(source, target);
        const info = await stat(target);
        if (info.isFile()) {
          entries.push({
            path: relative,
            name: path.posix.basename(relative),
            size: info.size,
            updatedAt: info.mtime.toISOString(),
            referenceCount: references.get(relative) ?? 0
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return entries.sort((left, right) => (left.path === "SKILL.md" ? -1 : right.path === "SKILL.md" ? 1 : left.path.localeCompare(right.path)));
  }

  async readDocument(projectId: string, relativePath: string): Promise<DocumentFile> {
    this.assertId(projectId, "project");
    const source = await this.readProjectSource(projectId);
    const target = this.resolveDocumentPath(source, relativePath);
    try {
      await this.assertProjectReadPath(source, target);
      const [content, state] = await Promise.all([readFile(target, "utf8"), this.readProjectState(projectId)]);
      return { path: relativePath, content, activeRevision: state.activeRevision };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "document_not_found", "文档不存在");
      throw error;
    }
  }

  async getProjectDocumentSlice(projectId: string, relativePath: string, query = ""): Promise<ProjectDocumentSlice> {
    this.assertId(projectId, "project");
    const source = await this.readProjectSource(projectId);
    const target = this.resolveDocumentPath(source, relativePath);
    try {
      await this.assertProjectReadPath(source, target);
      const [content, state] = await Promise.all([readFile(target, "utf8"), this.readProjectState(projectId)]);
      return { documentPath: relativePath, activeRevision: state.activeRevision, ...sliceDocument(content, query, false) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "document_not_found", "文档不存在");
      throw error;
    }
  }

  async listDocumentReferences(projectId: string, relativePath?: string): Promise<DocumentReference[]> {
    this.assertId(projectId, "project");
    const source = await this.readProjectSource(projectId);
    if (relativePath !== undefined) this.resolveDocumentPath(source, relativePath);
    const graph = await this.readGraph(source);
    return graph.nodes.flatMap((node) => node.doc && (!relativePath || node.doc === relativePath) ? [{
      nodeId: node.id,
      nodeTitle: node.title,
      documentPath: node.doc,
      ...(node.docAnchor ? { anchor: node.docAnchor } : {})
    }] : []);
  }

  async listBenchmarkCases(projectId: string): Promise<BenchmarkCaseEntry[]> {
    this.assertId(projectId, "project");
    const source = await this.readProjectSource(projectId);
    const graph = await this.readGraph(source);
    let entries: Dirent[];
    try {
      entries = await readdir(this.benchmarkCaseDir(source), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const cases = await Promise.all(entries
      .filter((entry) => entry.isFile() && /^case-[0-9a-f-]{36}\.json$/i.test(entry.name))
      .map(async (entry): Promise<BenchmarkCaseEntry> => {
        const caseId = entry.name.slice(0, -5);
        const target = path.join(this.benchmarkCaseDir(source), entry.name);
        await this.assertProjectReadPath(source, target);
        const info = await stat(target);
        try {
          const value = JSON.parse(await readFile(target, "utf8")) as BenchmarkCase;
          const issues = lintBenchmarkCase(value, graph, source.skillId);
          if (value.caseId !== caseId) {
            issues.push({ severity: "error", path: "caseId", code: "case_file_identity_mismatch", message: "文件名与 caseId 不一致" });
          }
          return {
            caseId,
            title: typeof value.title === "string" && value.title.trim() ? value.title : caseId,
            status: value.status === "ready" ? "ready" : "draft",
            path: this.benchmarkCaseRelativePath(caseId),
            tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [],
            updatedAt: info.mtime.toISOString(),
            valid: !issues.some((issue) => issue.severity === "error"),
            issues
          };
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          return {
            caseId,
            title: caseId,
            status: "draft",
            path: this.benchmarkCaseRelativePath(caseId),
            tags: [],
            updatedAt: info.mtime.toISOString(),
            valid: false,
            issues: [{ severity: "error", path: "case", code: "invalid_json", message: "测试用例不是有效 JSON" }]
          };
        }
      }));
    return cases.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readBenchmarkCase(projectId: string, caseId: string): Promise<ProjectBenchmarkCase> {
    this.assertId(projectId, "project");
    this.assertBenchmarkCaseId(caseId);
    const [source, state] = await Promise.all([this.readProjectSource(projectId), this.readProjectState(projectId)]);
    try {
      const target = this.benchmarkCaseFile(source, caseId);
      await this.assertProjectReadPath(source, target);
      const value = JSON.parse(await readFile(target, "utf8")) as BenchmarkCase;
      const graph = await this.readGraph(source);
      const issues = lintBenchmarkCase(value, graph, source.skillId);
      if (value.caseId !== caseId) issues.push({ severity: "error", path: "caseId", code: "case_file_identity_mismatch", message: "文件名与 caseId 不一致" });
      return { case: value, path: this.benchmarkCaseRelativePath(caseId), activeRevision: state.activeRevision, issues };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "benchmark_case_not_found", "测试用例不存在");
      if (error instanceof SyntaxError) throw new AppError(422, "benchmark_case_invalid_json", "测试用例不是有效 JSON");
      throw error;
    }
  }

  async listRevisions(projectId: string): Promise<ProjectRevision[]> {
    this.assertId(projectId, "project");
    const [source, state] = await Promise.all([this.readProjectSource(projectId), this.readProjectState(projectId)]);
    await this.ensureProjectHistory(source, state);
    const entries = await readdir(this.revisionDir(projectId), { withFileTypes: true });
    const revisions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => readFile(path.join(this.revisionDir(projectId), entry.name), "utf8").then((value) => JSON.parse(value) as ProjectRevision))
    );
    return revisions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listProjectTransactions(projectId: string): Promise<ProjectTransactionJournal[]> {
    this.assertId(projectId, "project");
    let entries;
    try {
      entries = await readdir(this.transactionDir(projectId), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const journals = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => this.readTransactionJournal(path.join(this.transactionDir(projectId), entry.name))));
    return journals.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getRevisionStatus(projectId: string): Promise<ProjectRevisionStatus> {
    this.assertId(projectId, "project");
    const [source, state] = await Promise.all([this.readProjectSource(projectId), this.readProjectState(projectId)]);
    const current = await this.ensureProjectHistory(source, state);
    const baseline = await this.readBaseline(projectId);
    const [currentSnapshot, baselineSnapshot] = await Promise.all([
      this.readSnapshot(projectId, current.snapshotId),
      this.readSnapshot(projectId, baseline.snapshotId)
    ]);
    return {
      activeRevision: current,
      currentSnapshot,
      baseline,
      changedFiles: this.diffSnapshots(baselineSnapshot, currentSnapshot)
    };
  }

  async acknowledgeBaseline(projectId: string, input: unknown): Promise<ProjectRevisionStatus> {
    this.assertId(projectId, "project");
    const record = plainRecord(input);
    if (typeof record.workspaceId !== "string" || typeof record.revisionId !== "string" || typeof record.snapshotId !== "string") {
      throw new AppError(400, "invalid_baseline_confirmation", "基线确认信息不完整");
    }
    this.assertId(record.workspaceId, "workspace");

    return this.mutate(async () => {
      const [source, state, workspace] = await Promise.all([
        this.readProjectSource(projectId),
        this.readProjectState(projectId),
        this.readWorkspace(record.workspaceId as string)
      ]);
      if (!workspace.members.some((member) => member.projectId === projectId && member.skillId === source.skillId)) {
        throw new AppError(403, "project_not_in_workspace", "该 Skill 不属于指定 Workspace");
      }
      const current = await this.ensureProjectHistory(source, state);
      if (record.revisionId !== current.revisionId || record.snapshotId !== current.snapshotId) {
        throw new AppError(409, "baseline_target_changed", "当前版本或快照已变化，请重新查看后再确认");
      }
      const baseline: ProjectBaseline = {
        projectId,
        skillId: source.skillId,
        revisionId: current.revisionId,
        snapshotId: current.snapshotId,
        acknowledgedAt: this.now().toISOString()
      };
      await this.atomicWrite(this.baselineFile(projectId), JSON.stringify(baseline, null, 2) + "\n");
      return this.getRevisionStatus(projectId);
    });
  }

  async createSkillImport(workspaceId: string, input: unknown): Promise<SkillImportPreview> {
    this.assertId(workspaceId, "workspace");
    const parsed = this.parseSkillImportInput(input);
    return this.mutate(async () => {
      const workspace = await this.readWorkspace(workspaceId);
      const timestamp = this.now().toISOString();
      const importId = this.prefixedId("import");
      const projectId = this.prefixedId("project");
      const inspected = this.inspectImportFiles(parsed.folderName, parsed.files);
      const skillId = inspected.manifest?.skillId ?? this.prefixedId("skill");
      const diagnostics = [...inspected.diagnostics];
      if (workspace.members.some((member) => member.skillId === skillId)) {
        diagnostics.push({ severity: "error", code: "duplicate_skill_id", message: "Workspace 中已存在相同 skillId" });
      }
      const files = parsed.files.map((file) => ({
        path: file.path,
        size: file.content.length,
        sha256: `sha256:${createHash("sha256").update(file.content).digest("hex")}`,
        kind: this.importFileKind(file.path)
      }));
      const sourceDigest = createHash("sha256").update(JSON.stringify(files.map((file) => [file.path, file.sha256]))).digest("hex");
      const parseReview = buildImportParseReview({
        skillId,
        sourceDigest,
        markdown: inspected.markdown,
        ...(inspected.graph ? { nativeGraph: inspected.graph } : {}),
        ...(inspected.manifest ? { declaredCapability: inspected.manifest.capability } : {})
      });
      if (!inspected.manifest) {
        diagnostics.push(parseReview.capability === "workflow"
          ? { severity: "info", code: "workflow_inferred", message: "从明确的流程章节提取了候选节点与有向边，请在确认前审阅顺序和关系" }
          : { severity: "info", code: "content_only_default", message: "未发现至少两个明确流程步骤，按内容型 Skill 生成知识图候选" });
      }
      const provenance = this.buildImportProvenance(parsed.folderName, inspected, parseReview);
      const candidatePayload = {
        workspaceId,
        projectId,
        skillId,
        displayName: inspected.displayName,
        description: inspected.description,
        capability: parseReview.capability,
        detectedFormat: inspected.manifest ? "skill-designer" as const : inspected.frontmatter ? "frontmatter-skill" as const : "markdown-skill" as const,
        files,
        generatedFiles: inspected.generatedFiles,
        diagnostics,
        ...(inspected.frontmatter ? { frontmatter: inspected.frontmatter } : {}),
        references: inspected.references,
        formatSignals: inspected.formatSignals,
        provenance,
        parseReview
      };
      const candidate: SkillImportCandidate = {
        importId,
        ...candidatePayload,
        digest: "",
        status: "proposed",
        createdAt: timestamp
      };
      candidate.digest = this.skillImportDigest(candidate);

      await mkdir(this.importFilesDir(importId), { recursive: true });
      for (const file of parsed.files) {
        const target = path.join(this.importFilesDir(importId), ...file.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await this.atomicWriteBuffer(target, file.content);
      }
      await this.writeImportCandidate(candidate);

      workspace.members.push({
        projectId,
        skillId,
        displayName: candidate.displayName,
        capability: candidate.capability,
        mode: "managed-copy",
        status: "pending-import",
        order: workspace.members.length,
        activeRevision: "pending",
        git: { available: false, changedFiles: 0 },
        lint: {
          errors: diagnostics.filter((item) => item.severity === "error").length + parseReview.lint.filter((item) => item.severity === "error").length,
          warnings: diagnostics.filter((item) => item.severity === "warning").length + parseReview.lint.filter((item) => item.severity === "warning").length
        },
        lastRunAt: null,
        createdAt: timestamp
      });
      workspace.updatedAt = timestamp;
      try {
        await this.writeWorkspace(workspace);
      } catch (error) {
        await rm(this.importDir(importId), { recursive: true, force: true });
        throw error;
      }
      return { candidate, workspace };
    });
  }

  async getSkillImport(importId: string): Promise<SkillImportCandidate> {
    this.assertImportId(importId);
    return this.readImportCandidate(importId);
  }

  async readSkillImportTextFile(
    importId: string,
    input: { workspaceId: string; reviewRevision: number; path: string }
  ): Promise<{ path: string; content: string; sha256: string }> {
    this.assertImportId(importId);
    const candidate = await this.readImportCandidate(importId);
    this.assertMutableImportReview(candidate, input.workspaceId, input.reviewRevision);
    const file = candidate.files.find((item) => item.path === input.path);
    if (!file || !["markdown", "json", "config", "text"].includes(file.kind)) {
      throw new AppError(404, "import_parse_file_unavailable", "该文件不在可读取的导入文本索引中");
    }
    const bytes = await readFile(path.join(this.importFilesDir(importId), ...file.path.split("/")));
    const actualSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actualSha256 !== file.sha256) {
      throw new AppError(409, "import_source_changed", "冻结导入文件校验失败，请重新扫描源目录");
    }
    return { path: file.path, content: bytes.toString("utf8"), sha256: actualSha256 };
  }

  async applyLLMImportReview(importId: string, input: ApplyLLMImportReviewInput): Promise<SkillImportCandidate> {
    this.assertImportId(importId);
    return this.mutate(async () => {
      const candidate = await this.readImportCandidate(importId);
      this.assertMutableImportReview(candidate, input.workspaceId, input.reviewRevision);
      if (candidate.parseReview.reparseConflict) throw new AppError(409, "import_reparse_conflict", "已有重新解析冲突等待裁决");
      if (candidate.parseReview.sourceDigest !== input.sourceDigest) throw new AppError(409, "import_source_changed", "冻结导入源摘要已变化");
      if (input.snapshot.capability !== "workflow" && input.snapshot.capability !== "content-only") {
        throw new AppError(422, "import_llm_capability_invalid", "LLM 解析能力类型无效");
      }
      if (input.snapshot.nodes.length > 200 || input.snapshot.edges.length > 400 || input.snapshot.unresolvedQuestions.length > 50) {
        throw new AppError(422, "import_llm_result_limit", "LLM 解析候选数量超过上限");
      }
      const nodes = input.snapshot.nodes.map((raw, index) => {
        const record = plainRecord(raw.value);
        if (typeof record.id !== "string" || !record.id) throw new AppError(422, "import_llm_node_invalid", `nodes[${index}] 缺少稳定 id`);
        return { ...structuredClone(raw), candidateId: `node:${record.id}`, value: this.parseGraphNode(raw.value, record.id, index), decision: "accepted" as const, manuallyEdited: false };
      });
      const edges = input.snapshot.edges.map((raw, index) => {
        const record = plainRecord(raw.value);
        if (typeof record.id !== "string" || !record.id) throw new AppError(422, "import_llm_edge_invalid", `edges[${index}] 缺少稳定 id`);
        return { ...structuredClone(raw), candidateId: `edge:${record.id}`, value: this.parseGraphEdge(raw.value, record.id, index), decision: "accepted" as const, manuallyEdited: false };
      });
      const snapshot = withImportReviewLint(candidate.skillId, {
        capability: input.snapshot.capability,
        ...(input.snapshot.entry ? { entry: input.snapshot.entry } : {}),
        nodes,
        edges,
        unresolvedQuestions: structuredClone(input.snapshot.unresolvedQuestions),
        lint: []
      });
      const errors = snapshot.lint.filter((issue) => issue.severity === "error");
      if (errors.length) throw new AppError(422, "import_llm_lint_failed", "LLM 解析结果未通过图 Lint", errors);
      if (candidate.parseReview.manuallyEdited) {
        return this.persistImportReview(candidate, {
          ...candidate.parseReview,
          reviewRevision: candidate.parseReview.reviewRevision + 1,
          reparseConflict: {
            kind: "manual-vs-reparse",
            detectedAt: this.now().toISOString(),
            parserVersion: input.parserVersion,
            parsed: this.importReviewSnapshot(snapshot)
          }
        });
      }
      return this.persistImportReview(candidate, {
        parserVersion: input.parserVersion,
        sourceDigest: candidate.parseReview.sourceDigest,
        reviewRevision: candidate.parseReview.reviewRevision + 1,
        manuallyEdited: false,
        ...snapshot
      });
    });
  }

  async updateSkillImportReview(importId: string, input: unknown): Promise<SkillImportCandidate> {
    this.assertImportId(importId);
    const parsed = this.parseImportReviewInput(input);
    return this.mutate(async () => {
      const candidate = await this.readImportCandidate(importId);
      this.assertMutableImportReview(candidate, parsed.workspaceId, parsed.reviewRevision);
      if (candidate.parseReview.reparseConflict) {
        throw new AppError(409, "import_reparse_conflict", "请先裁决重新解析冲突，再继续编辑");
      }
      if (parsed.nodes.length !== candidate.parseReview.nodes.length || parsed.edges.length !== candidate.parseReview.edges.length) {
        throw new AppError(400, "import_review_identity_changed", "审阅只能接受、修改或拒绝已有候选，不能增删候选身份");
      }

      const nodeInputs = new Map(parsed.nodes.map((item) => [item.candidateId, item]));
      const edgeInputs = new Map(parsed.edges.map((item) => [item.candidateId, item]));
      const nodes = candidate.parseReview.nodes.map((current, index) => {
        const next = nodeInputs.get(current.candidateId);
        if (!next) throw new AppError(400, "import_review_identity_changed", `缺少节点候选：${current.candidateId}`);
        const value = this.parseGraphNode(next.value, current.value.id, index);
        const changed = next.decision !== current.decision || JSON.stringify(value) !== JSON.stringify(current.value);
        return { ...current, value, decision: next.decision, manuallyEdited: current.manuallyEdited || changed };
      });
      const edges = candidate.parseReview.edges.map((current, index) => {
        const next = edgeInputs.get(current.candidateId);
        if (!next) throw new AppError(400, "import_review_identity_changed", `缺少边候选：${current.candidateId}`);
        const value = this.parseGraphEdge(next.value, current.value.id, index);
        const changed = next.decision !== current.decision || JSON.stringify(value) !== JSON.stringify(current.value);
        return { ...current, value, decision: next.decision, manuallyEdited: current.manuallyEdited || changed };
      });
      const snapshot = withImportReviewLint(candidate.skillId, {
        capability: candidate.parseReview.capability,
        ...(parsed.entry ? { entry: parsed.entry } : {}),
        nodes,
        edges,
        unresolvedQuestions: candidate.parseReview.unresolvedQuestions,
        lint: []
      });
      const review: SkillImportParseReview = {
        parserVersion: candidate.parseReview.parserVersion,
        sourceDigest: candidate.parseReview.sourceDigest,
        reviewRevision: candidate.parseReview.reviewRevision + 1,
        manuallyEdited: candidate.parseReview.manuallyEdited || this.importReviewChanged(candidate.parseReview, snapshot),
        ...snapshot
      };
      return this.persistImportReview(candidate, review);
    });
  }

  async reparseSkillImport(importId: string, input: unknown): Promise<SkillImportCandidate> {
    this.assertImportId(importId);
    const record = plainRecord(input);
    if (typeof record.workspaceId !== "string" || typeof record.reviewRevision !== "number") {
      throw new AppError(400, "invalid_import_reparse", "重新解析信息不完整");
    }
    this.assertId(record.workspaceId, "workspace");
    return this.mutate(async () => {
      const candidate = await this.readImportCandidate(importId);
      this.assertMutableImportReview(candidate, record.workspaceId as string, record.reviewRevision as number);
      if (candidate.parseReview.reparseConflict) throw new AppError(409, "import_reparse_conflict", "已有重新解析冲突等待裁决");
      const files = await Promise.all(candidate.files.map(async (file): Promise<ParsedImportFile> => ({
        path: file.path,
        content: await readFile(path.join(this.importFilesDir(importId), ...file.path.split("/")))
      })));
      const inspected = this.inspectImportFiles(candidate.displayName, files);
      const parsedReview = buildImportParseReview({
        skillId: candidate.skillId,
        sourceDigest: candidate.parseReview.sourceDigest,
        markdown: inspected.markdown,
        ...(inspected.graph ? { nativeGraph: inspected.graph } : {}),
        ...(inspected.manifest ? { declaredCapability: inspected.manifest.capability } : {})
      });
      if (candidate.parseReview.manuallyEdited) {
        const review: SkillImportParseReview = {
          ...candidate.parseReview,
          reviewRevision: candidate.parseReview.reviewRevision + 1,
          reparseConflict: {
            kind: "manual-vs-reparse",
            detectedAt: this.now().toISOString(),
            parserVersion: parsedReview.parserVersion,
            parsed: this.importReviewSnapshot(parsedReview)
          }
        };
        return this.persistImportReview(candidate, review);
      }
      return this.persistImportReview(candidate, {
        ...parsedReview,
        reviewRevision: candidate.parseReview.reviewRevision + 1
      });
    });
  }

  async resolveSkillImportReparse(importId: string, input: unknown): Promise<SkillImportCandidate> {
    this.assertImportId(importId);
    const parsed = this.parseImportReparseResolution(input);
    return this.mutate(async () => {
      const candidate = await this.readImportCandidate(importId);
      this.assertMutableImportReview(candidate, parsed.workspaceId, parsed.reviewRevision);
      const conflict = candidate.parseReview.reparseConflict;
      if (!conflict) throw new AppError(409, "import_reparse_conflict_missing", "当前没有待裁决的重新解析结果");
      const { reparseConflict: _conflict, ...manualReview } = candidate.parseReview;
      const review: SkillImportParseReview = parsed.choice === "manual"
        ? { ...manualReview, reviewRevision: candidate.parseReview.reviewRevision + 1 }
        : {
            parserVersion: conflict.parserVersion ?? candidate.parseReview.parserVersion,
            sourceDigest: candidate.parseReview.sourceDigest,
            reviewRevision: candidate.parseReview.reviewRevision + 1,
            manuallyEdited: false,
            ...conflict.parsed
          };
      return this.persistImportReview(candidate, review);
    });
  }

  async confirmSkillImport(importId: string, input: unknown): Promise<Workspace> {
    this.assertImportId(importId);
    const record = plainRecord(input);
    if (typeof record.workspaceId !== "string" || typeof record.digest !== "string") {
      throw new AppError(400, "invalid_import_confirmation", "导入确认信息不完整");
    }
    this.assertId(record.workspaceId, "workspace");

    return this.mutate(async () => {
      const [candidate, workspace] = await Promise.all([
        this.readImportCandidate(importId),
        this.readWorkspace(record.workspaceId as string)
      ]);
      if (candidate.workspaceId !== record.workspaceId || candidate.digest !== record.digest) {
        throw new AppError(409, "import_confirmation_mismatch", "导入确认内容与预检不一致");
      }
      if (candidate.status !== "proposed") throw new AppError(409, "import_not_proposed", "导入候选已处理");
      if (candidate.parseReview.reparseConflict) throw new AppError(409, "import_reparse_conflict", "重新解析结果尚未裁决");
      const errors = candidate.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length) throw new AppError(422, "import_diagnostics_failed", "导入预检存在阻断问题", errors);
      const reviewErrors = candidate.parseReview.lint.filter((issue) => issue.severity === "error");
      if (reviewErrors.length) throw new AppError(422, "import_review_invalid", "解析审阅结果存在阻断问题", reviewErrors);
      const member = workspace.members.find((item) => item.projectId === candidate.projectId && item.skillId === candidate.skillId);
      if (!member || member.status !== "pending-import") throw new AppError(409, "pending_member_missing", "Workspace 中的待确认成员不存在");
      if (workspace.members.some((item) => item.projectId !== candidate.projectId && item.skillId === candidate.skillId)) {
        throw new AppError(409, "duplicate_skill_id", "Workspace 中已存在相同 skillId");
      }

      const source: ProjectSource = {
        projectId: candidate.projectId,
        skillId: candidate.skillId,
        mode: "managed-copy",
        root: path.join(this.managedProjectRoot(), candidate.projectId)
      };
      const timestamp = this.now().toISOString();
      const revisionId = `rev-${timestamp.replace(/[-:.TZ]/g, "")}`;
      const projectStateDir = path.join(this.projectStateRoot(), candidate.projectId);
      const workspaceBefore = structuredClone(workspace);
      try {
        await mkdir(source.root, { recursive: false });
        for (const file of candidate.files) {
          const from = path.join(this.importFilesDir(importId), ...file.path.split("/"));
          const target = path.join(source.root, ...file.path.split("/"));
          this.assertProjectPath(source, target);
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(from, target);
        }
        await mkdir(projectStateDir, { recursive: true });
        await this.writeImportGeneratedFiles(source, candidate);
        await this.atomicWrite(path.join(projectStateDir, "source.json"), JSON.stringify(source, null, 2) + "\n");
        const revision = await this.captureProjectRevision(source, revisionId, null, "initial", timestamp);
        const state: ProjectState = {
          projectId: candidate.projectId,
          skillId: candidate.skillId,
          activeRevision: revisionId,
          currentSnapshotId: revision.snapshotId,
          createdAt: timestamp
        };
        const baseline: ProjectBaseline = {
          projectId: candidate.projectId,
          skillId: candidate.skillId,
          revisionId,
          snapshotId: revision.snapshotId,
          acknowledgedAt: timestamp
        };
        await Promise.all([
          this.atomicWrite(this.projectStateFile(candidate.projectId), JSON.stringify(state, null, 2) + "\n"),
          this.atomicWrite(this.baselineFile(candidate.projectId), JSON.stringify(baseline, null, 2) + "\n")
        ]);

        member.status = "ready";
        member.sourcePath = source.root;
        member.activeRevision = revisionId;
        member.lint = { errors: 0, warnings: candidate.diagnostics.filter((item) => item.severity === "warning").length };
        workspace.selectedProjectId = candidate.projectId;
        workspace.updatedAt = timestamp;
        const confirmed: SkillImportCandidate = { ...candidate, status: "confirmed", confirmedAt: timestamp };
        await Promise.all([this.writeWorkspace(workspace), this.writeImportCandidate(confirmed)]);
        return workspace;
      } catch (error) {
        const rollbackFailures: string[] = [];
        await Promise.all([
          rm(source.root, { recursive: true, force: true }).catch(() => rollbackFailures.push("managed-project")),
          rm(projectStateDir, { recursive: true, force: true }).catch(() => rollbackFailures.push("project-state")),
          this.writeWorkspace(workspaceBefore).catch(() => rollbackFailures.push("workspace")),
          this.writeImportCandidate(candidate).catch(() => rollbackFailures.push("import-candidate"))
        ]);
        if (rollbackFailures.length) {
          throw new AppError(500, "import_rollback_failed", "导入失败且回滚不完整", { rollbackFailures });
        }
        throw error;
      }
    });
  }

  async cancelSkillImport(importId: string, input: unknown): Promise<Workspace> {
    this.assertImportId(importId);
    const record = plainRecord(input);
    if (typeof record.workspaceId !== "string") throw new AppError(400, "workspace_required", "取消导入需要 workspaceId");
    this.assertId(record.workspaceId, "workspace");
    return this.mutate(async () => {
      const [candidate, workspace] = await Promise.all([this.readImportCandidate(importId), this.readWorkspace(record.workspaceId as string)]);
      if (candidate.workspaceId !== record.workspaceId) throw new AppError(409, "import_workspace_mismatch", "导入候选不属于该 Workspace");
      if (candidate.status !== "proposed") throw new AppError(409, "import_not_proposed", "导入候选已处理");
      workspace.members = workspace.members.filter((member) => member.projectId !== candidate.projectId).map((member, index) => ({ ...member, order: index }));
      workspace.updatedAt = this.now().toISOString();
      await Promise.all([
        this.writeWorkspace(workspace),
        this.writeImportCandidate({ ...candidate, status: "cancelled" })
      ]);
      return workspace;
    });
  }

  async createGenericExport(projectId: string, input: unknown): Promise<GenericExportRecord> {
    this.assertId(projectId, "project");
    const record = plainRecord(input);
    if (typeof record.workspaceId !== "string" || typeof record.revisionId !== "string") {
      throw new AppError(400, "invalid_export_request", "导出请求缺少 workspaceId 或 revisionId");
    }
    if (record.profile !== undefined && record.profile !== "generic/1") {
      throw new AppError(400, "export_profile_unsupported", "1.0 只支持 generic/1 导出");
    }
    this.assertId(record.workspaceId, "workspace");
    return this.mutate(async () => {
      const [source, state, workspace] = await Promise.all([
        this.readProjectSource(projectId),
        this.readProjectState(projectId),
        this.readWorkspace(record.workspaceId as string)
      ]);
      if (!workspace.members.some((member) => member.projectId === projectId && member.skillId === source.skillId && member.status === "ready")) {
        throw new AppError(403, "project_not_exportable", "该 Skill 不是 Workspace 中可导出的就绪成员");
      }
      const activeRevision = await this.ensureProjectHistory(source, state);
      if (record.revisionId !== activeRevision.revisionId) {
        throw new AppError(409, "export_revision_changed", "当前 revision 已变化，请重新预览导出内容");
      }
      const snapshot = await this.readSnapshot(projectId, activeRevision.snapshotId);
      await this.readSnapshotGraph(projectId, snapshot.snapshotId, source.skillId);
      const engine = Buffer.from(genericEngineCli(), "utf8");
      const engineUsage = Buffer.from(genericEngineUsage(), "utf8");
      const manifestPayload = {
        schemaVersion: "1.0",
        profile: "generic/1",
        skillId: source.skillId,
        revisionId: activeRevision.revisionId,
        contentHash: activeRevision.contentHash,
        files: [
          ...snapshot.files,
          { path: "engine/skill-engine.mjs", size: engine.length, sha256: `sha256:${createHash("sha256").update(engine).digest("hex")}` },
          { path: "engine/README.md", size: engineUsage.length, sha256: `sha256:${createHash("sha256").update(engineUsage).digest("hex")}` }
        ]
      };
      const exportManifest = Buffer.from(JSON.stringify(manifestPayload, null, 2) + "\n", "utf8");
      const files: GenericExportRecord["files"] = [
        ...snapshot.files.map((file) => ({ ...file, source: "snapshot" as const })),
        {
          path: "engine/skill-engine.mjs",
          size: engine.length,
          sha256: `sha256:${createHash("sha256").update(engine).digest("hex")}`,
          source: "generated" as const
        },
        {
          path: "engine/README.md",
          size: engineUsage.length,
          sha256: `sha256:${createHash("sha256").update(engineUsage).digest("hex")}`,
          source: "generated" as const
        },
        {
          path: "export-manifest.json",
          size: exportManifest.length,
          sha256: `sha256:${createHash("sha256").update(exportManifest).digest("hex")}`,
          source: "generated" as const
        }
      ].sort((left, right) => left.path.localeCompare(right.path));
      const warnings: string[] = [];
      const scriptCount = files.filter((file) => file.source === "snapshot" && this.importFileKind(file.path) === "script").length;
      if (scriptCount) warnings.push(`包内包含 ${scriptCount} 个脚本文件；通用引擎不会自动执行它们`);
      const exportId = this.prefixedId("export");
      const createdAt = this.now().toISOString();
      const digestPayload = {
        workspaceId: record.workspaceId,
        projectId,
        skillId: source.skillId,
        revisionId: activeRevision.revisionId,
        snapshotId: snapshot.snapshotId,
        contentHash: snapshot.contentHash,
        profile: "generic/1",
        files
      };
      const exportRecord: GenericExportRecord = {
        exportId,
        workspaceId: record.workspaceId as string,
        projectId,
        skillId: source.skillId,
        revisionId: activeRevision.revisionId,
        snapshotId: snapshot.snapshotId,
        contentHash: snapshot.contentHash,
        profile: "generic/1",
        files,
        warnings,
        digest: createHash("sha256").update(JSON.stringify(digestPayload)).digest("hex"),
        status: "proposed",
        createdAt
      };
      await this.writeExportRecord(exportRecord);
      await mkdir(path.dirname(this.exportGeneratedFile(exportId, "engine/skill-engine.mjs")), { recursive: true });
      await Promise.all([
        this.atomicWrite(this.exportGeneratedFile(exportId, "engine/skill-engine.mjs"), engine.toString("utf8")),
        this.atomicWrite(this.exportGeneratedFile(exportId, "engine/README.md"), engineUsage.toString("utf8")),
        this.atomicWrite(this.exportGeneratedFile(exportId, "export-manifest.json"), exportManifest.toString("utf8"))
      ]);
      return exportRecord;
    });
  }

  async listGenericExports(projectId: string, workspaceId: string): Promise<GenericExportRecord[]> {
    this.assertId(projectId, "project");
    this.assertId(workspaceId, "workspace");
    const [source, workspace] = await Promise.all([this.readProjectSource(projectId), this.readWorkspace(workspaceId)]);
    if (!workspace.members.some((member) => member.projectId === projectId && member.skillId === source.skillId && member.status === "ready")) {
      throw new AppError(403, "project_not_exportable", "该 Skill 不是 Workspace 中可导出的就绪成员");
    }
    let entries;
    try {
      entries = await readdir(path.join(this.dataDir, "exports"), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^export-[0-9a-f-]{36}$/iu.test(entry.name))
      .map((entry) => this.readExportRecord(entry.name)));
    return records
      .filter((record) => record.projectId === projectId && record.workspaceId === workspaceId && record.skillId === source.skillId)
      .sort((left, right) => (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt));
  }

  async deleteGenericExport(exportId: string, workspaceId: string): Promise<GenericExportDeletionResult> {
    this.assertExportId(exportId);
    this.assertId(workspaceId, "workspace");
    return this.mutate(async () => {
      const record = await this.readExportRecord(exportId);
      const [workspace, source] = await Promise.all([this.readWorkspace(workspaceId), this.readProjectSource(record.projectId)]);
      if (record.workspaceId !== workspaceId || !workspace.members.some((member) => member.projectId === record.projectId && member.skillId === record.skillId && source.skillId === record.skillId)) {
        throw new AppError(403, "export_workspace_mismatch", "导出记录不属于指定 Workspace");
      }
      await rm(this.exportDir(exportId), { recursive: true, force: true });
      return { exportId, projectId: record.projectId, deleted: true };
    });
  }

  async getGenericExport(exportId: string): Promise<GenericExportRecord> {
    this.assertExportId(exportId);
    return this.readExportRecord(exportId);
  }

  async confirmGenericExport(exportId: string, input: unknown): Promise<GenericExportRecord> {
    this.assertExportId(exportId);
    const confirmation = plainRecord(input);
    if (typeof confirmation.digest !== "string" || typeof confirmation.revisionId !== "string") {
      throw new AppError(400, "invalid_export_confirmation", "导出确认信息不完整");
    }
    return this.mutate(async () => {
      const exportRecord = await this.readExportRecord(exportId);
      if (exportRecord.status !== "proposed") throw new AppError(409, "export_not_proposed", "导出记录已处理");
      if (confirmation.digest !== exportRecord.digest || confirmation.revisionId !== exportRecord.revisionId) {
        throw new AppError(409, "export_confirmation_mismatch", "导出确认内容与预览不一致");
      }
      const state = await this.readProjectState(exportRecord.projectId);
      if (state.activeRevision !== exportRecord.revisionId || state.currentSnapshotId !== exportRecord.snapshotId) {
        const conflicted: GenericExportRecord = { ...exportRecord, status: "conflicted" };
        await this.writeExportRecord(conflicted);
        throw new AppError(409, "export_revision_changed", "当前 revision 已变化，导出记录已标记冲突");
      }
      const snapshot = await this.readSnapshot(exportRecord.projectId, exportRecord.snapshotId);
      if (snapshot.contentHash !== exportRecord.contentHash) throw new AppError(409, "export_snapshot_mismatch", "导出 Snapshot 内容标识不一致");
      const archiveName = `skill-${exportRecord.skillId}-${this.shortFilesystemId(exportRecord.revisionId)}.zip`;
      const archivePath = this.exportArchiveFile(exportId);
      await this.buildGenericArchive(exportRecord, snapshot, archivePath);
      const archiveInfo = await stat(archivePath);
      const ready: GenericExportRecord = {
        ...exportRecord,
        status: "ready",
        archiveName,
        archiveSize: archiveInfo.size,
        completedAt: this.now().toISOString()
      };
      await this.writeExportRecord(ready);
      return ready;
    });
  }

  async getGenericExportArchive(exportId: string): Promise<{ record: GenericExportRecord; path: string }> {
    this.assertExportId(exportId);
    const record = await this.readExportRecord(exportId);
    if (record.status !== "ready" || !record.archiveName) throw new AppError(409, "export_not_ready", "导出包尚未生成");
    const archivePath = this.exportArchiveFile(exportId);
    try {
      await stat(archivePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "export_archive_missing", "导出归档不存在");
      throw error;
    }
    return { record, path: archivePath };
  }

  async createRun(projectId: string, input: unknown): Promise<ProjectRunView> {
    this.assertId(projectId, "project");
    const record = plainRecord(input);
    if (typeof record.workspaceId !== "string") throw new AppError(400, "workspace_required", "启动运行需要 workspaceId");
    this.assertId(record.workspaceId, "workspace");
    const initialVariables = record.initialVariables === undefined ? {} : plainRecord(record.initialVariables);

    return this.mutate(async () => {
      const [source, state, workspace] = await Promise.all([
        this.readProjectSource(projectId),
        this.readProjectState(projectId),
        this.readWorkspace(record.workspaceId as string)
      ]);
      if (!workspace.members.some((member) => member.projectId === projectId && member.skillId === source.skillId)) {
        throw new AppError(403, "project_not_in_workspace", "该 Skill 不属于指定 Workspace");
      }
      const revision = await this.ensureProjectHistory(source, state);
      const graph = await this.readSnapshotGraph(projectId, revision.snapshotId, source.skillId);
      let initialized: ReturnType<typeof createRuntimeState>;
      try {
        initialized = createRuntimeState(graph, initialVariables);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "run_start_failed";
        throw new AppError(422, code, error instanceof Error ? error.message : "运行启动失败");
      }

      const timestamp = this.now().toISOString();
      const artifactId = this.prefixedId("artifact");
      const runId = this.prefixedId("run");
      const artifact: RuntimeArtifact = {
        schemaVersion: "1.0",
        artifactId,
        workspaceId: record.workspaceId as string,
        projectId,
        skillId: source.skillId,
        revision: revision.revisionId,
        contentHash: revision.contentHash,
        initialVariables: structuredClone(initialVariables),
        fingerprint: this.createRuntimeArtifactFingerprint(revision.contentHash, initialVariables),
        graph: structuredClone(graph),
        createdAt: timestamp
      };
      const run: ProjectRun = {
        schemaVersion: "1.0",
        runId,
        workspaceId: artifact.workspaceId,
        projectId,
        skillId: source.skillId,
        artifactId,
        revision: revision.revisionId,
        state: initialized.state,
        events: this.traceEvents(initialized.events, { runId, artifact, at: timestamp }),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      await Promise.all([
        mkdir(this.runtimeArtifactDir(projectId), { recursive: true }),
        mkdir(this.runDir(projectId), { recursive: true })
      ]);
      await Promise.all([
        this.atomicWrite(this.runtimeArtifactFile(projectId, artifactId), JSON.stringify(artifact, null, 2) + "\n"),
        this.atomicWrite(this.runFile(projectId, runId), JSON.stringify(run, null, 2) + "\n")
      ]);
      await this.traceStore.sync(run);
      this.traceEmitter.emit(`${projectId}:${runId}`);
      const member = workspace.members.find((item) => item.projectId === projectId);
      if (member) member.lastRunAt = timestamp;
      workspace.updatedAt = timestamp;
      await this.writeWorkspace(workspace);
      return {
        run,
        artifact,
        allowedTransitions: availableTransitions(graph, run.state),
        contextFacts: await this.runtimeContextFacts(projectId, run, artifact)
      };
    });
  }

  async prepareBenchmarkExecution(projectId: string, workspaceId: string, caseId: string): Promise<PreparedBenchmarkExecution> {
    this.assertId(projectId, "project");
    this.assertId(workspaceId, "workspace");
    this.assertBenchmarkCaseId(caseId);
    return this.mutate(async () => {
      const [source, state, workspace] = await Promise.all([
        this.readProjectSource(projectId),
        this.readProjectState(projectId),
        this.readWorkspace(workspaceId)
      ]);
      if (!workspace.members.some((member) => member.projectId === projectId && member.skillId === source.skillId && member.status === "ready")) {
        throw new AppError(403, "project_not_in_workspace", "该 Skill 不是 Workspace 中可运行 Benchmark 的就绪成员");
      }
      const revision = await this.ensureProjectHistory(source, state);
      const snapshotRoot = this.snapshotFilesDir(projectId, revision.snapshotId);
      const graph = await this.readSnapshotGraph(projectId, revision.snapshotId, source.skillId);
      let benchmarkCase: BenchmarkCase;
      try {
        benchmarkCase = JSON.parse(await readFile(path.join(snapshotRoot, ...this.benchmarkCaseRelativePath(caseId).split("/")), "utf8")) as BenchmarkCase;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "benchmark_case_not_found", "冻结 Revision 中不存在该测试用例");
        if (error instanceof SyntaxError) throw new AppError(422, "benchmark_case_invalid_json", "冻结测试用例 JSON 无效");
        throw error;
      }
      const issues = lintBenchmarkCase(benchmarkCase, graph, source.skillId);
      if (benchmarkCase.status !== "ready" || issues.some((issue) => issue.severity === "error")) {
        throw new AppError(422, "benchmark_case_not_ready", "只有校验通过的 ready 用例才能运行真实 Benchmark", issues);
      }
      const timestamp = this.now().toISOString();
      const runtimeArtifact: RuntimeArtifact = {
        schemaVersion: "1.0",
        artifactId: this.prefixedId("artifact"),
        workspaceId,
        projectId,
        skillId: source.skillId,
        revision: revision.revisionId,
        contentHash: revision.contentHash,
        initialVariables: structuredClone(benchmarkCase.fixture.initialVariables),
        fingerprint: this.createRuntimeArtifactFingerprint(revision.contentHash, benchmarkCase.fixture.initialVariables),
        graph: structuredClone(graph),
        createdAt: timestamp
      };
      const documents: Record<string, string> = {};
      for (const documentPath of this.graphDocumentPaths(graph)) {
        try {
          documents[documentPath] = await readFile(path.join(snapshotRoot, ...documentPath.split("/")), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await mkdir(this.runtimeArtifactDir(projectId), { recursive: true });
      await this.atomicWrite(this.runtimeArtifactFile(projectId, runtimeArtifact.artifactId), JSON.stringify(runtimeArtifact, null, 2) + "\n");
      return { benchmarkCase, runtimeArtifact, snapshotRoot, documents };
    });
  }

  async getRun(projectId: string, runId: string): Promise<ProjectRunView> {
    this.assertId(projectId, "project");
    this.assertRunId(runId);
    const [run, artifact] = await Promise.all([this.readRun(projectId, runId), this.readArtifactForRun(projectId, runId)]);
    const contextFacts = await this.runtimeContextFacts(projectId, run, artifact);
    return {
      run,
      artifact,
      allowedTransitions: run.state.status === "running" ? availableTransitions(artifact.graph, run.state) : [],
      contextFacts
    };
  }

  async createRuntimeBenchmarkCandidate(projectId: string, runId: string, input: unknown): Promise<RuntimeBenchmarkCandidate> {
    this.assertId(projectId, "project");
    this.assertRunId(runId);
    const record = plainRecord(input);
    if (typeof record.workspaceId !== "string") throw new AppError(400, "workspace_required", "从运行生成用例需要 workspaceId");
    this.assertId(record.workspaceId, "workspace");
    const [workspace, source, view, graphView] = await Promise.all([
      this.readWorkspace(record.workspaceId),
      this.readProjectSource(projectId),
      this.getRun(projectId, runId),
      this.getProjectGraph(projectId)
    ]);
    const member = workspace.members.find((item) => item.projectId === projectId && item.skillId === source.skillId);
    if (!member) throw new AppError(403, "project_not_in_workspace", "该 Skill 不属于指定 Workspace");
    if (view.run.workspaceId !== workspace.workspaceId || view.run.projectId !== projectId || view.run.skillId !== source.skillId) {
      throw new AppError(409, "runtime_candidate_identity_mismatch", "来源运行身份与当前 Skill 不一致");
    }
    if (view.run.state.status !== "completed" && view.run.state.status !== "stopped") {
      throw new AppError(409, "runtime_candidate_not_terminal", "只有已完成或已停止的运行可以生成测试候选");
    }
    if (!view.artifact) throw new AppError(409, "runtime_artifact_missing", "来源运行缺少 RuntimeArtifact");
    const timestamp = this.now().toISOString();
    const benchmarkCase = createBenchmarkCaseFromRuntime({
      caseId: `case-${this.idFactory()}`,
      skillId: source.skillId,
      skillName: member.displayName,
      initialVariables: view.artifact.initialVariables,
      finalVariables: view.run.state.skillVariables,
      status: view.run.state.status,
      currentNodeId: view.run.state.currentNodeId,
      trace: view.run.events
    });
    return {
      schemaVersion: "1.0",
      candidateId: `runtime-candidate-${this.idFactory()}`,
      workspaceId: workspace.workspaceId,
      projectId,
      skillId: source.skillId,
      source: {
        runId,
        artifactId: view.artifact.artifactId,
        revision: view.artifact.revision,
        status: view.run.state.status
      },
      case: benchmarkCase,
      issues: lintBenchmarkCase(benchmarkCase, graphView.graph, source.skillId),
      createdAt: timestamp
    };
  }

  async getRuntimeDebugContext(projectId: string, runId: string): Promise<RuntimeDebugContext> {
    this.assertId(projectId, "project");
    this.assertRunId(runId);
    const [run, artifact] = await Promise.all([this.readRun(projectId, runId), this.readArtifactForRun(projectId, runId)]);
    const currentNode = artifact.graph.nodes.find((node) => node.id === run.state.currentNodeId);
    if (!currentNode) throw new AppError(409, "runtime_current_node_missing", "RuntimeArtifact 中不存在当前节点");
    let document: RuntimeDebugContext["document"] = null;
    if (currentNode.doc) {
      if (!isSkillDocumentPath(currentNode.doc)) throw new AppError(409, "runtime_document_path_invalid", "冻结节点引用了无效文档路径");
      const revision = await this.readRevision(projectId, run.revision);
      try {
        const content = await readFile(path.join(this.snapshotFilesDir(projectId, revision.snapshotId), ...currentNode.doc.split("/")), "utf8");
        const sliced = sliceDocument(content, currentNode.docAnchor ?? "", false);
        document = {
          path: currentNode.doc,
          anchor: currentNode.docAnchor ?? null,
          status: sliced.status,
          content: sliced.slice?.content ?? sliced.content ?? ""
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        document = { path: currentNode.doc, anchor: currentNode.docAnchor ?? null, status: "missing", content: "" };
      }
    }
    const facts = await this.runtimeContextFacts(projectId, run, artifact);
    return {
      view: {
        run,
        artifact,
        allowedTransitions: run.state.status === "running" ? availableTransitions(artifact.graph, run.state) : [],
        contextFacts: facts
      },
      currentNode: structuredClone(currentNode),
      document,
      conditionEvaluations: evaluateTransitionConditions(artifact.graph, run.state),
      facts
    };
  }

  async appendRuntimeTrace(
    projectId: string,
    runId: string,
    input: { expectedArtifactId: string; expectedCurrentNodeId?: string; expectedEventSeq?: number; events: RuntimeTraceDraft[] }
  ): Promise<ProjectRunView> {
    this.assertId(projectId, "project");
    this.assertRunId(runId);
    if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 6) {
      throw new AppError(400, "runtime_trace_events_invalid", "一次只能追加 1 到 6 条运行对话事件");
    }
    return this.mutate(async () => {
      const run = await this.readRun(projectId, runId);
      const artifact = await this.readArtifact(projectId, run.artifactId);
      if (artifact.artifactId !== input.expectedArtifactId) throw new AppError(409, "runtime_context_changed", "运行 Artifact 已变化");
      if (input.expectedCurrentNodeId !== undefined && run.state.currentNodeId !== input.expectedCurrentNodeId) throw new AppError(409, "runtime_context_changed", "模型生成期间当前节点已变化");
      if (input.expectedEventSeq !== undefined && run.state.eventSeq !== input.expectedEventSeq) throw new AppError(409, "runtime_context_changed", "模型生成期间运行事件已变化");
      const allowedTypes = new Set<RuntimeTraceDraft["type"]>(["condition.evaluated", "document.context", "context.queried", "conversation.user", "conversation.assistant", "llm.request", "llm.response", "llm.error"]);
      const allowedActors = new Set<RuntimeTraceDraft["actor"]>(["user", "model", "system"]);
      const timestamp = this.now().toISOString();
      const events = input.events.map((draft, index): RuntimeTraceEvent => {
        if (!allowedTypes.has(draft.type) || !allowedActors.has(draft.actor) || JSON.stringify(draft.data).length > 16_000) {
          throw new AppError(400, "runtime_trace_event_invalid", "运行对话事件结构无效或超过大小上限");
        }
        return {
          schemaVersion: "1.0",
          seq: run.state.eventSeq + index + 1,
          type: draft.type,
          nodeId: run.state.currentNodeId,
          data: structuredClone(draft.data),
          runId,
          workspaceId: run.workspaceId,
          projectId,
          skillId: run.skillId,
          artifactId: run.artifactId,
          at: timestamp,
          actor: draft.actor
        };
      });
      run.state.eventSeq += events.length;
      run.events.push(...events);
      run.updatedAt = timestamp;
      await this.atomicWrite(this.runFile(projectId, runId), JSON.stringify(run, null, 2) + "\n");
      await this.traceStore.sync(run);
      this.traceEmitter.emit(`${projectId}:${runId}`);
      return {
        run,
        artifact,
        allowedTransitions: run.state.status === "running" ? availableTransitions(artifact.graph, run.state) : [],
        contextFacts: await this.runtimeContextFacts(projectId, run, artifact)
      };
    });
  }

  async getTraceEvents(projectId: string, runId: string, afterSeq = 0): Promise<ExecutionTracePage> {
    this.assertId(projectId, "project");
    this.assertRunId(runId);
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new AppError(400, "invalid_after_seq", "afterSeq 必须是非负整数");
    const [run, artifact] = await Promise.all([this.readRun(projectId, runId), this.readArtifactForRun(projectId, runId)]);
    const events = await this.traceStore.sync(run);
    return {
      schemaVersion: "1.0",
      traceId: run.runId,
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      skillId: run.skillId,
      artifactId: run.artifactId,
      afterSeq,
      latestSeq: events.at(-1)?.seq ?? 0,
      events: events.filter((event) => event.seq > afterSeq),
      projection: reduceTrace(artifact.graph, events)
    };
  }

  async createBugReport(projectId: string, runId: string, input: unknown): Promise<BugReportRecord> {
    this.assertId(projectId, "project");
    this.assertRunId(runId);
    const record = plainRecord(input);
    if (typeof record.workspaceId !== "string") throw new AppError(400, "workspace_required", "生成报告需要 workspaceId");
    this.assertId(record.workspaceId, "workspace");
    const sanitizationMode = (record.sanitizationMode ?? "default") as BugReportSanitizationMode;
    if (!(["off", "default", "strict"] as const).includes(sanitizationMode)) {
      throw new AppError(400, "invalid_sanitization_mode", "报告脱敏模式无效");
    }
    const userNote = record.userNote ?? "";
    if (typeof userNote !== "string" || userNote.length > 4_000) {
      throw new AppError(400, "invalid_report_note", "报告说明必须是不超过 4000 字符的文本");
    }
    return this.mutate(async () => {
      const [run, artifact, workspace, source] = await Promise.all([
        this.readRun(projectId, runId),
        this.readArtifactForRun(projectId, runId),
        this.readWorkspace(record.workspaceId as string),
        this.readProjectSource(projectId)
      ]);
      if (run.workspaceId !== record.workspaceId || !workspace.members.some((member) => member.projectId === projectId && member.skillId === run.skillId)) {
        throw new AppError(403, "run_not_in_workspace", "该运行不属于指定 Workspace");
      }
      if (run.state.status !== "completed" && run.state.status !== "stopped") {
        throw new AppError(409, "run_not_terminal", "运行结束或停止后才能生成报告");
      }
      const manifest = await this.readSnapshotSkillManifest(projectId, run.revision, run.skillId);
      const reportId = this.prefixedId("report");
      const createdAt = this.now().toISOString();
      const report = createBugReportDocument({
        reportId,
        skillName: manifest.name,
        run,
        artifact,
        generatedAt: createdAt,
        sanitizationMode,
        userNote
      });
      const bugReport: BugReportRecord = {
        reportId,
        projectId: source.projectId,
        runId,
        sanitizationMode,
        report,
        digest: createHash("sha256").update(JSON.stringify(report)).digest("hex"),
        status: "proposed",
        createdAt
      };
      await this.writeBugReportRecord(bugReport);
      return bugReport;
    });
  }

  async createBenchmarkBugReport(projectId: string, benchmarkRun: BenchmarkRunRecord, input: unknown): Promise<BugReportRecord> {
    this.assertId(projectId, "project");
    if (benchmarkRun.projectId !== projectId || !/^benchmark-run-[0-9a-f-]{36}$/iu.test(benchmarkRun.benchmarkRunId)) throw new AppError(409, "benchmark_identity_mismatch", "Benchmark 运行身份不一致");
    const record = plainRecord(input);
    if (typeof record.workspaceId !== "string") throw new AppError(400, "workspace_required", "生成报告需要 workspaceId");
    this.assertId(record.workspaceId, "workspace");
    const sanitizationMode = (record.sanitizationMode ?? "default") as BugReportSanitizationMode;
    if (!( ["off", "default", "strict"] as const).includes(sanitizationMode)) throw new AppError(400, "invalid_sanitization_mode", "报告脱敏模式无效");
    const userNote = record.userNote ?? "";
    if (typeof userNote !== "string" || userNote.length > 4_000) throw new AppError(400, "invalid_report_note", "报告说明必须是不超过 4000 字符的文本");
    if (!benchmarkRun.fingerprint.runtimeArtifactId || !benchmarkRun.fingerprint.revision) throw new AppError(409, "benchmark_report_artifact_missing", "该 Benchmark 在 Artifact 冻结前结束，不能生成 Skill 问题报告");
    if (benchmarkRun.status !== "completed" && benchmarkRun.status !== "failed" && benchmarkRun.status !== "cancelled") throw new AppError(409, "benchmark_not_terminal", "Benchmark 结束后才能生成报告");
    return this.mutate(async () => {
      const [artifact, workspace, source] = await Promise.all([
        this.readArtifact(projectId, benchmarkRun.fingerprint.runtimeArtifactId!),
        this.readWorkspace(record.workspaceId as string),
        this.readProjectSource(projectId)
      ]);
      if (benchmarkRun.workspaceId !== record.workspaceId || !workspace.members.some((member) => member.projectId === projectId && member.skillId === benchmarkRun.skillId)) {
        throw new AppError(403, "benchmark_not_in_workspace", "该 Benchmark 不属于指定 Workspace");
      }
      const manifest = await this.readSnapshotSkillManifest(projectId, benchmarkRun.fingerprint.revision!, benchmarkRun.skillId);
      const reportId = this.prefixedId("report");
      const createdAt = this.now().toISOString();
      const report = createBenchmarkBugReportDocument({ reportId, skillName: manifest.name, run: benchmarkRun, artifact, generatedAt: createdAt, sanitizationMode, userNote });
      const bugReport: BugReportRecord = {
        reportId,
        projectId: source.projectId,
        runId: report.source.runId,
        sanitizationMode,
        report,
        digest: createHash("sha256").update(JSON.stringify(report)).digest("hex"),
        status: "proposed",
        createdAt
      };
      await this.writeBugReportRecord(bugReport);
      return bugReport;
    });
  }

  async getBugReport(reportId: string): Promise<BugReportRecord> {
    this.assertBugReportId(reportId);
    return this.readBugReportRecord(reportId);
  }

  async listBugReports(projectId: string, workspaceId: string): Promise<BugReportRecord[]> {
    this.assertId(projectId, "project");
    this.assertId(workspaceId, "workspace");
    const [workspace, source] = await Promise.all([this.readWorkspace(workspaceId), this.readProjectSource(projectId)]);
    if (!workspace.members.some((member) => member.projectId === projectId && member.skillId === source.skillId && member.status === "ready")) {
      throw new AppError(403, "project_not_in_workspace", "该 Skill 不是 Workspace 中的就绪成员");
    }
    try {
      const entries = await readdir(this.reportRoot(), { withFileTypes: true });
      const records = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && /^report-[0-9a-f-]{36}$/iu.test(entry.name))
        .map((entry) => this.readBugReportRecord(entry.name)));
      return records
        .filter((record) => record.projectId === projectId && record.report.source.workspaceId === workspaceId && record.report.skill.skillId === source.skillId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async deleteBugReport(reportId: string, workspaceId: string): Promise<BugReportDeletionResult> {
    this.assertBugReportId(reportId);
    this.assertId(workspaceId, "workspace");
    return this.mutate(async () => {
      const record = await this.readBugReportRecord(reportId);
      const workspace = await this.readWorkspace(workspaceId);
      if (record.report.source.workspaceId !== workspaceId || !workspace.members.some((member) => member.projectId === record.projectId && member.skillId === record.report.skill.skillId)) {
        throw new AppError(403, "report_workspace_mismatch", "报告不属于指定 Workspace");
      }
      await rm(this.reportDir(reportId), { recursive: true, force: true });
      return { reportId, projectId: record.projectId, deleted: true };
    });
  }

  async confirmBugReport(reportId: string, input: unknown): Promise<BugReportRecord> {
    this.assertBugReportId(reportId);
    const confirmation = plainRecord(input);
    if (typeof confirmation.digest !== "string") throw new AppError(400, "invalid_report_confirmation", "报告确认信息不完整");
    return this.mutate(async () => {
      const record = await this.readBugReportRecord(reportId);
      if (record.status !== "proposed") throw new AppError(409, "report_not_proposed", "报告已经确认");
      if (confirmation.digest !== record.digest) throw new AppError(409, "report_confirmation_mismatch", "报告确认内容与预览不一致");
      const content = JSON.stringify(record.report, null, 2) + "\n";
      const markdown = bugReportMarkdown(record.report);
      const fileStem = `${this.reportSlug(record.report.skill.name)}-${this.localTimestamp(new Date(record.createdAt))}.report`;
      const fileName = `${fileStem}.json`;
      const markdownFileName = `${fileStem}.md`;
      await mkdir(this.reportDir(reportId), { recursive: true });
      await Promise.all([
        this.atomicWrite(this.reportDownloadFile(reportId, "json"), content),
        this.atomicWrite(this.reportDownloadFile(reportId, "markdown"), markdown)
      ]);
      const ready: BugReportRecord = {
        ...record,
        status: "ready",
        fileName,
        fileSize: Buffer.byteLength(content),
        markdownFileName,
        markdownFileSize: Buffer.byteLength(markdown),
        completedAt: this.now().toISOString()
      };
      await this.writeBugReportRecord(ready);
      return ready;
    });
  }

  async getBugReportDownload(reportId: string, format: "json" | "markdown" = "json"): Promise<{ record: BugReportRecord; path: string; fileName: string; size?: number; contentType: string }> {
    this.assertBugReportId(reportId);
    const record = await this.readBugReportRecord(reportId);
    if (record.status !== "ready" || !record.fileName) throw new AppError(409, "report_not_ready", "报告尚未确认");
    const fileName = format === "markdown" ? record.markdownFileName : record.fileName;
    const size = format === "markdown" ? record.markdownFileSize : record.fileSize;
    if (!fileName) throw new AppError(409, "report_format_not_ready", "该报告没有所选下载格式");
    const filePath = this.reportDownloadFile(reportId, format);
    try {
      await stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "report_file_missing", "报告文件不存在");
      throw error;
    }
    return { record, path: filePath, fileName, ...(size !== undefined ? { size } : {}), contentType: format === "markdown" ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8" };
  }

  async importStoredBugReport(workspaceId: string, reportId: string): Promise<ImportedBugReport> {
    this.assertId(workspaceId, "workspace");
    this.assertBugReportId(reportId);
    return this.mutate(async () => {
      const [workspace, record] = await Promise.all([this.readWorkspace(workspaceId), this.readBugReportRecord(reportId)]);
      if (record.status !== "ready") throw new AppError(409, "report_not_ready", "报告确认后才能加入诊断");
      const issues = validateBugReportDocument(record.report);
      if (issues.length) throw new AppError(422, "report_validation_failed", "报告格式校验失败", issues);
      try {
        const entries = await readdir(this.reportImportDir(workspaceId), { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !/^report-import-[0-9a-f-]{36}\.json$/iu.test(entry.name)) continue;
          const existing = await this.readImportedBugReport(workspaceId, entry.name.replace(/\.json$/u, ""));
          if (existing.report.reportId === reportId) return { ...existing, match: await this.resolveImportedReportMatch(workspace, existing.report) };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const imported: ImportedBugReport = {
        reportImportId: `report-import-${this.idFactory()}`,
        workspaceId,
        report: record.report,
        match: await this.resolveImportedReportMatch(workspace, record.report),
        importedAt: this.now().toISOString()
      };
      await this.writeImportedBugReport(imported);
      return imported;
    });
  }

  async importBugReport(workspaceId: string, input: unknown): Promise<ImportedBugReport> {
    this.assertId(workspaceId, "workspace");
    const record = plainRecord(input);
    if (typeof record.contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(record.contentBase64)) {
      throw new AppError(400, "invalid_report_encoding", "报告内容编码无效");
    }
    const content = Buffer.from(record.contentBase64, "base64");
    if (content.length > 2 * 1024 * 1024 || content.toString("base64").replace(/=+$/u, "") !== record.contentBase64.replace(/=+$/u, "")) {
      throw new AppError(400, "invalid_report_encoding", "报告内容编码无效或超过 2 MiB");
    }
    let report: BugReportDocument;
    try {
      report = JSON.parse(content.toString("utf8")) as BugReportDocument;
    } catch {
      throw new AppError(400, "invalid_report_json", "报告 JSON 无效");
    }
    const issues = validateBugReportDocument(report);
    if (issues.length) throw new AppError(422, "report_validation_failed", "报告格式校验失败", issues);
    return this.mutate(async () => {
      const workspace = await this.readWorkspace(workspaceId);
      try {
        const entries = await readdir(this.reportImportDir(workspaceId), { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !/^report-import-[0-9a-f-]{36}\.json$/iu.test(entry.name)) continue;
          const existing = await this.readImportedBugReport(workspaceId, entry.name.replace(/\.json$/u, ""));
          if (existing.report.reportId !== report.reportId) continue;
          if (JSON.stringify(existing.report) !== JSON.stringify(report)) throw new AppError(409, "report_id_conflict", "相同 reportId 已对应不同报告内容");
          return { ...existing, match: await this.resolveImportedReportMatch(workspace, existing.report) };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const match = await this.resolveImportedReportMatch(workspace, report);
      const imported: ImportedBugReport = {
        reportImportId: `report-import-${this.idFactory()}`,
        workspaceId,
        report,
        match,
        importedAt: this.now().toISOString()
      };
      await this.writeImportedBugReport(imported);
      return imported;
    });
  }

  async listImportedBugReports(workspaceId: string): Promise<ImportedBugReport[]> {
    this.assertId(workspaceId, "workspace");
    const workspace = await this.readWorkspace(workspaceId);
    try {
      const entries = await readdir(this.reportImportDir(workspaceId), { withFileTypes: true });
      const reports = await Promise.all(entries
        .filter((entry) => entry.isFile() && /^report-import-[0-9a-f-]{36}\.json$/iu.test(entry.name))
        .map((entry) => this.readImportedBugReport(workspaceId, entry.name.replace(/\.json$/u, ""))));
      const refreshed = await Promise.all(reports.map(async (report) => ({
        ...report,
        match: await this.resolveImportedReportMatch(workspace, report.report)
      })));
      return refreshed.sort((left, right) => right.importedAt.localeCompare(left.importedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async deleteImportedBugReport(workspaceId: string, reportImportId: string): Promise<ImportedBugReportDeletionResult> {
    this.assertId(workspaceId, "workspace");
    this.assertReportImportId(reportImportId);
    return this.mutate(async () => {
      await Promise.all([this.readWorkspace(workspaceId), this.readImportedBugReport(workspaceId, reportImportId)]);
      await Promise.all([
        rm(this.diagnosisDir(workspaceId, reportImportId), { recursive: true, force: true }),
        rm(this.reportFixtureDir(workspaceId, reportImportId), { recursive: true, force: true }),
        rm(this.reportBenchmarkCandidateDir(workspaceId, reportImportId), { recursive: true, force: true })
      ]);
      await rm(this.reportImportFile(workspaceId, reportImportId), { force: true });
      return { reportImportId, workspaceId, deleted: true, derivedRecordsDeleted: true };
    });
  }

  private async resolveImportedReportMatch(workspace: Workspace, report: BugReportDocument): Promise<ImportedBugReport["match"]> {
    const member = workspace.members.find((item) => item.skillId === report.skill.skillId);
    if (!member) return { status: "skill-missing" };
    if (member.status !== "ready") return { status: "target-unavailable", matchedProjectId: member.projectId };
    const state = await this.readProjectState(member.projectId);
    const revision = await this.readRevision(member.projectId, state.activeRevision);
    return revision.contentHash === report.skill.contentHash
      ? { status: "matched", matchedProjectId: member.projectId, currentContentHash: revision.contentHash }
      : { status: "fingerprint-mismatch", matchedProjectId: member.projectId, currentContentHash: revision.contentHash };
  }

  async createDiagnosis(workspaceId: string, reportImportId: string): Promise<DiagnosisRecord> {
    this.assertId(workspaceId, "workspace");
    this.assertReportImportId(reportImportId);
    return this.mutate(async () => {
      await this.readWorkspace(workspaceId);
      const imported = await this.readImportedBugReport(workspaceId, reportImportId);
      const diagnosis = diagnoseBugReport({
        diagnosisId: `diagnosis-${this.idFactory()}`,
        workspaceId,
        reportImportId,
        report: imported.report,
        generatedAt: this.now().toISOString()
      });
      await this.enrichDocumentDiagnosisRepairs(imported, diagnosis);
      await this.writeDiagnosis(diagnosis);
      return diagnosis;
    });
  }

  async listDiagnoses(workspaceId: string, reportImportId: string): Promise<DiagnosisRecord[]> {
    this.assertId(workspaceId, "workspace");
    this.assertReportImportId(reportImportId);
    await Promise.all([this.readWorkspace(workspaceId), this.readImportedBugReport(workspaceId, reportImportId)]);
    try {
      const entries = await readdir(this.diagnosisDir(workspaceId, reportImportId), { withFileTypes: true });
      const records = await Promise.all(entries
        .filter((entry) => entry.isFile() && /^diagnosis-[0-9a-f-]{36}\.json$/iu.test(entry.name))
        .map(async (entry) => JSON.parse(await readFile(path.join(this.diagnosisDir(workspaceId, reportImportId), entry.name), "utf8")) as DiagnosisRecord));
      return records.sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof SyntaxError) throw new AppError(500, "diagnosis_corrupt", "诊断记录数据损坏");
      throw error;
    }
  }

  async createDiagnosisRepair(
    workspaceId: string,
    reportImportId: string,
    diagnosisId: string,
    candidateId: string
  ): Promise<DiagnosisRepairProposal> {
    this.assertId(workspaceId, "workspace");
    this.assertReportImportId(reportImportId);
    this.assertDiagnosisId(diagnosisId);
    const [imported, diagnosis] = await Promise.all([
      this.readImportedBugReport(workspaceId, reportImportId),
      this.readDiagnosis(workspaceId, reportImportId, diagnosisId)
    ]);
    if (imported.match.status !== "matched" || !imported.match.matchedProjectId) {
      throw new AppError(409, "repair_target_not_exact", "只有与当前 Skill 指纹精确匹配的报告才能生成修复提案");
    }
    const candidate = diagnosis.candidates.find((item) => item.candidateId === candidateId);
    if (!candidate) throw new AppError(404, "diagnosis_candidate_not_found", "诊断候选不存在");
    if (!candidate.repair) throw new AppError(422, "repair_not_deterministic", "当前候选缺少足够证据，不能自动生成修复提案");
    const revision = await this.getRevisionStatus(imported.match.matchedProjectId);
    if (revision.activeRevision.contentHash !== imported.report.skill.contentHash) {
      throw new AppError(409, "repair_source_changed", "当前 Skill 已与报告内容不同，请重新复现和诊断");
    }
    if (candidate.repair.kind === "graph.remove-document-binding") {
      await this.assertDocumentDiagnosisRepairCurrent(imported.match.matchedProjectId, imported, candidate);
    }
    const changeSet = await this.createChangeSet(imported.match.matchedProjectId, {
      workspaceId,
      baseRevision: revision.activeRevision.revisionId,
      reason: `诊断 ${diagnosisId}：${candidate.title}`,
      source: { kind: "diagnosis", sourceId: diagnosisId, label: "诊断修复建议" },
      evidence: [
        { kind: "diagnosis", ref: candidate.candidateId, summary: candidate.statement.slice(0, 500) },
        ...candidate.evidence.slice(0, 19).map((evidence) => ({
          kind: evidence.source,
          ref: evidence.source === "trace" && evidence.seq !== undefined
            ? `${diagnosis.reportId}#seq-${evidence.seq}`
            : evidence.source === "graph" && evidence.nodeId
              ? evidence.nodeId
              : diagnosis.reportId,
          summary: evidence.fact.slice(0, 500)
        }))
      ],
      operations: [candidate.repair.operation]
    });
    const timestamp = this.now().toISOString();
    const sourceRunId = imported.report.source.benchmarkRunId ?? imported.report.source.runId;
    const parentRepair = await this.findParentDiagnosisRepair(workspaceId, imported.match.matchedProjectId, diagnosis.skillId, sourceRunId);
    const repair: DiagnosisRepairRecord = {
      schemaVersion: "1.0",
      repairId: `repair-${this.idFactory()}`,
      workspaceId,
      reportImportId,
      diagnosisId,
      candidateId,
      skillId: diagnosis.skillId,
      projectId: imported.match.matchedProjectId,
      sourceRunId,
      sourceRevision: imported.report.source.revision,
      changeSetId: changeSet.changeSetId,
      proposalStatus: "proposed",
      status: "unverified",
      round: (parentRepair?.round ?? 0) + 1,
      ...(parentRepair ? {
        lineage: {
          relation: "follow-up",
          parentRepairId: parentRepair.repairId,
          parentReportImportId: parentRepair.reportImportId,
          sourceVerificationRunId: sourceRunId
        }
      } : {}),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeDiagnosisRepair(repair);
    return { repair, changeSet };
  }

  async listDiagnosisRepairs(workspaceId: string, reportImportId: string): Promise<DiagnosisRepairRecord[]> {
    this.assertId(workspaceId, "workspace");
    this.assertReportImportId(reportImportId);
    await Promise.all([this.readWorkspace(workspaceId), this.readImportedBugReport(workspaceId, reportImportId)]);
    try {
      const entries = await readdir(this.diagnosisRepairDir(workspaceId, reportImportId), { withFileTypes: true });
      const repairs = await Promise.all(entries
        .filter((entry) => entry.isFile() && /^repair-[0-9a-f-]{36}\.json$/iu.test(entry.name))
        .map((entry) => this.readDiagnosisRepair(workspaceId, reportImportId, entry.name.replace(/\.json$/u, ""))));
      const synchronized = await Promise.all(repairs.map((repair) => this.synchronizeDiagnosisRepair(repair)));
      return synchronized.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async confirmDiagnosisRepair(
    workspaceId: string,
    reportImportId: string,
    repairId: string,
    confirmation: unknown
  ): Promise<{ repair: DiagnosisRepairRecord; applied: ApplyChangeSetResult }> {
    const repair = await this.readDiagnosisRepair(workspaceId, reportImportId, repairId);
    if (repair.appliedRevision) throw new AppError(409, "repair_already_applied", "修复提案已应用");
    const applied = await this.confirmAndApplyChangeSet(repair.changeSetId, confirmation);
    const updated: DiagnosisRepairRecord = {
      ...repair,
      proposalStatus: "applied",
      appliedRevision: applied.activeRevision,
      updatedAt: this.now().toISOString()
    };
    await this.writeDiagnosisRepair(updated);
    return { repair: updated, applied };
  }

  async rejectDiagnosisRepair(
    workspaceId: string,
    reportImportId: string,
    repairId: string,
    input: unknown
  ): Promise<{ repair: DiagnosisRepairRecord; changeSet: ProjectChangeSet }> {
    const repair = await this.readDiagnosisRepair(workspaceId, reportImportId, repairId);
    if (repair.appliedRevision || repair.proposalStatus === "applied") throw new AppError(409, "repair_already_applied", "修复提案已应用，不能拒绝");
    const changeSet = await this.rejectChangeSet(repair.changeSetId, input);
    const updated: DiagnosisRepairRecord = {
      ...repair,
      proposalStatus: "rejected",
      updatedAt: this.now().toISOString()
    };
    await this.writeDiagnosisRepair(updated);
    return { repair: updated, changeSet };
  }

  async verifyDiagnosisRepair(
    workspaceId: string,
    reportImportId: string,
    repairId: string,
    input: unknown
  ): Promise<DiagnosisRepairRecord> {
    const record = plainRecord(input);
    if (record.level !== "runtime" || typeof record.runId !== "string") {
      throw new AppError(400, "invalid_repair_verification", "当前只接受带 runId 的 runtime 验证");
    }
    const repair = await this.readDiagnosisRepair(workspaceId, reportImportId, repairId);
    if (!repair.appliedRevision) throw new AppError(409, "repair_not_applied", "修复提案尚未应用，不能验证");
    const [runView, changeSet, diagnosis] = await Promise.all([
      this.getRun(repair.projectId, record.runId),
      this.getChangeSet(repair.changeSetId),
      this.readDiagnosis(workspaceId, reportImportId, repair.diagnosisId)
    ]);
    if (runView.run.skillId !== repair.skillId || runView.run.workspaceId !== workspaceId || runView.run.revision !== repair.appliedRevision) {
      throw new AppError(409, "verification_run_mismatch", "验证运行必须属于该 Skill 并使用修复后的 revision");
    }
    const candidate = diagnosis.candidates.find((item) => item.candidateId === repair.candidateId);
    const repairKind = candidate?.repair?.kind;
    const operation = repairKind === "graph.remove-document-binding"
      ? changeSet.operations.find((item) => item.op === "graph.node.update")
      : changeSet.operations.find((item) => item.op === "graph.edge.create" || item.op === "graph.edge.update");
    if (!operation) throw new AppError(500, "repair_operation_missing", "修复记录缺少可验证的图操作");

    if (operation.op === "graph.node.update") {
      if (!runView.artifact) throw new AppError(409, "verification_artifact_mismatch", "验证运行缺少可读取的 RuntimeArtifact");
      const artifactNode = runView.artifact.graph.nodes.find((node) => node.id === operation.target);
      if (!artifactNode || artifactNode.doc || artifactNode.docAnchor) {
        throw new AppError(409, "verification_artifact_mismatch", "验证运行的 Artifact 未包含移除文档绑定的节点修改");
      }
      const traversal = runView.run.events.find((event) => event.type === "engine.enter" && event.nodeId === operation.target);
      const repeated = traversal ? runView.run.events.find((event) => event.seq >= traversal.seq
        && event.type === "document.context"
        && event.nodeId === operation.target
        && (event.data.status === "missing" || event.data.status === "ambiguous")) : undefined;
      let status: DiagnosisRepairRecord["status"];
      let evidence: string[];
      if (repeated) {
        status = "failed";
        evidence = [`新运行在 seq ${repeated.seq} 再次记录节点 ${operation.target} 的文档上下文不可用`];
      } else if (runView.run.state.status === "completed" && traversal) {
        status = "verified";
        evidence = [
          `新运行使用 revision ${runView.run.revision}`,
          `RuntimeArtifact 中节点 ${operation.target} 已无文档绑定`,
          `Trace 在 seq ${traversal.seq} 实际进入节点 ${operation.target}`,
          "运行到达 completed 终态且未重复出现该节点的文档上下文失败"
        ];
      } else {
        throw new AppError(422, "verification_inconclusive", "该运行没有进入修复节点并完成，不能判定文档绑定修复结果");
      }
      const checkedAt = this.now().toISOString();
      const updated: DiagnosisRepairRecord = {
        ...repair,
        status,
        updatedAt: checkedAt,
        verification: { level: "runtime", runId: record.runId, checkedAt, evidence }
      };
      await this.writeDiagnosisRepair(updated);
      return updated;
    }
    if (operation.op !== "graph.edge.create" && operation.op !== "graph.edge.update") {
      throw new AppError(500, "repair_operation_missing", "修复记录缺少可验证的图边操作");
    }
    const traversal = runView.run.events.find((event) => event.type === "engine.enter" && event.data.viaEdgeId === operation.target);
    const repeated = runView.run.events.find((event) => event.type === "engine.reject" && event.nodeId === operation.value.from && event.data.requestedNodeId === operation.value.to);
    const downstreamRejection = traversal ? runView.run.events.find((event) => event.seq > traversal.seq && event.type === "engine.reject") : undefined;
    const operationLabel = operation.op === "graph.edge.create" ? "新增边" : "更新边";
    let status: DiagnosisRepairRecord["status"];
    let evidence: string[];
    if (repeated) {
      status = "failed";
      evidence = [`新运行在 seq ${repeated.seq} 再次拒绝 ${operation.value.from} -> ${operation.value.to}`];
    } else if (downstreamRejection) {
      status = "failed";
      evidence = [
        `Trace 在 seq ${traversal!.seq} 实际经过${operationLabel} ${operation.target}`,
        `随后在 seq ${downstreamRejection.seq} 发生拒绝跳转，验证运行未完成`
      ];
    } else if (runView.run.state.status === "completed" && traversal) {
      status = "verified";
      evidence = [`新运行使用 revision ${runView.run.revision}`, `Trace 实际经过${operationLabel} ${operation.target}`, "运行到达 completed 终态"];
    } else {
      throw new AppError(422, "verification_inconclusive", "该运行没有完整经过修复边并完成，不能判定修复结果");
    }
    const checkedAt = this.now().toISOString();
    const updated: DiagnosisRepairRecord = {
      ...repair,
      status,
      updatedAt: checkedAt,
      verification: { level: "runtime", runId: record.runId, checkedAt, evidence }
    };
    await this.writeDiagnosisRepair(updated);
    return updated;
  }

  async preparePostRepairBenchmark(
    workspaceId: string,
    reportImportId: string,
    repairId: string,
    requireCurrentRevision = true
  ): Promise<{ projectId: string; skillId: string; caseId: string; parentBenchmarkRunId: string; sourceRevision: string; sourceArtifactId: string; repairId: string; changeSetId: string; appliedRevision: string }> {
    this.assertId(workspaceId, "workspace");
    this.assertReportImportId(reportImportId);
    this.assertRepairId(repairId);
    const [repair, imported] = await Promise.all([
      this.readDiagnosisRepair(workspaceId, reportImportId, repairId),
      this.readImportedBugReport(workspaceId, reportImportId)
    ]);
    if (!repair.appliedRevision) throw new AppError(409, "repair_not_applied", "修复提案尚未应用，不能启动修复后 Benchmark");
    if (imported.report.source.kind !== "benchmark" || !imported.report.source.benchmarkRunId || !imported.report.source.caseId) {
      throw new AppError(409, "repair_not_from_benchmark", "只有来自真实 Benchmark 的问题才能启动 Benchmark 级修复验证");
    }
    if (imported.report.source.projectId !== repair.projectId || imported.report.source.revision !== repair.sourceRevision) {
      throw new AppError(409, "repair_source_identity_mismatch", "修复记录与来源 Benchmark 身份不一致");
    }
    if (requireCurrentRevision) {
      const revision = await this.getRevisionStatus(repair.projectId);
      if (revision.activeRevision.revisionId !== repair.appliedRevision) {
        throw new AppError(409, "post_repair_revision_drift", "当前 Skill 已离开修复应用时的 revision，请重新确认验证基线");
      }
    }
    const projectCase = await this.readBenchmarkCase(repair.projectId, imported.report.source.caseId);
    if (projectCase.case.status !== "ready" || projectCase.issues.some((issue) => issue.severity === "error")) {
      throw new AppError(422, "benchmark_case_not_ready", "来源 Benchmark 用例当前不是可运行的 ready 用例", projectCase.issues);
    }
    return {
      projectId: repair.projectId,
      skillId: repair.skillId,
      caseId: imported.report.source.caseId,
      parentBenchmarkRunId: imported.report.source.benchmarkRunId,
      sourceRevision: imported.report.source.revision,
      sourceArtifactId: imported.report.source.artifactId,
      repairId,
      changeSetId: repair.changeSetId,
      appliedRevision: repair.appliedRevision
    };
  }

  async verifyDiagnosisRepairWithBenchmark(
    workspaceId: string,
    reportImportId: string,
    repairId: string,
    run: BenchmarkRunRecord,
    parent: BenchmarkRunRecord
  ): Promise<DiagnosisRepairRecord> {
    this.assertId(workspaceId, "workspace");
    this.assertReportImportId(reportImportId);
    this.assertRepairId(repairId);
    const [repair, imported] = await Promise.all([
      this.readDiagnosisRepair(workspaceId, reportImportId, repairId),
      this.readImportedBugReport(workspaceId, reportImportId)
    ]);
    if (!repair.appliedRevision) throw new AppError(409, "repair_not_applied", "修复提案尚未应用，不能验证");
    const lineage = run.lineage;
    if (!lineage || lineage.relation !== "post-repair" || lineage.repairId !== repairId || lineage.changeSetId !== repair.changeSetId || lineage.appliedRevision !== repair.appliedRevision) {
      throw new AppError(409, "post_repair_lineage_mismatch", "验证运行没有绑定该修复记录的完整 lineage");
    }
    if (imported.report.source.kind !== "benchmark" || imported.report.source.benchmarkRunId !== parent.benchmarkRunId || lineage.parentBenchmarkRunId !== parent.benchmarkRunId) {
      throw new AppError(409, "post_repair_parent_mismatch", "验证运行的父记录不是报告来源 Benchmark");
    }
    if (parent.workspaceId !== workspaceId || parent.projectId !== repair.projectId || parent.skillId !== repair.skillId || parent.caseId !== imported.report.source.caseId
      || parent.fingerprint.revision !== imported.report.source.revision || parent.fingerprint.runtimeArtifactId !== imported.report.source.artifactId) {
      throw new AppError(409, "post_repair_parent_mismatch", "报告来源 Benchmark 的身份或冻结版本与报告不一致");
    }
    if (run.workspaceId !== workspaceId || run.projectId !== repair.projectId || run.skillId !== repair.skillId || run.caseId !== imported.report.source.caseId) {
      throw new AppError(409, "verification_run_mismatch", "验证运行必须属于该修复的 Workspace、Skill 和来源用例");
    }
    if (run.status !== "completed") throw new AppError(422, "benchmark_verification_not_completed", "只有技术执行完成的 Benchmark 才能验证修复");
    if (run.fingerprint.revision !== repair.appliedRevision || !run.fingerprint.runtimeArtifactId || !parent.fingerprint.runtimeArtifactId || run.fingerprint.runtimeArtifactId === parent.fingerprint.runtimeArtifactId) {
      throw new AppError(409, "verification_artifact_mismatch", "验证运行必须使用修复 revision 的新 RuntimeArtifact");
    }
    const [parentArtifact, runArtifact] = await Promise.all([
      this.readArtifact(parent.projectId, parent.fingerprint.runtimeArtifactId),
      this.readArtifact(run.projectId, run.fingerprint.runtimeArtifactId)
    ]);
    if (parentArtifact.workspaceId !== workspaceId || parentArtifact.skillId !== repair.skillId || parentArtifact.revision !== imported.report.source.revision
      || parentArtifact.contentHash !== parent.fingerprint.contentHash || runArtifact.workspaceId !== workspaceId || runArtifact.skillId !== repair.skillId
      || runArtifact.revision !== repair.appliedRevision || runArtifact.contentHash !== run.fingerprint.contentHash) {
      throw new AppError(409, "verification_artifact_mismatch", "父子 Benchmark 指纹与持久化 RuntimeArtifact 不一致");
    }
    const humanVerdict = run.humanReviews.at(-1)?.verdict;
    if (run.automaticVerdict === "inconclusive" || humanVerdict === undefined || humanVerdict === "inconclusive") {
      throw new AppError(422, "benchmark_verification_inconclusive", "自动断言和最新人工判定都形成明确结论后才能验证修复");
    }
    const status: DiagnosisRepairRecord["status"] = run.automaticVerdict === "passed" && humanVerdict === "passed" ? "verified" : "failed";
    const checkedAt = this.now().toISOString();
    const evidence = [
      `新 Benchmark ${run.benchmarkRunId} 显式绑定修复 ${repairId}`,
      `使用修复 revision ${repair.appliedRevision}`,
      `RuntimeArtifact ${parent.fingerprint.runtimeArtifactId} -> ${run.fingerprint.runtimeArtifactId}`,
      `自动断言 ${run.automaticVerdict}；人工判定 ${humanVerdict}`
    ];
    const updated: DiagnosisRepairRecord = {
      ...repair,
      status,
      updatedAt: checkedAt,
      verification: { level: "benchmark", runId: run.benchmarkRunId, checkedAt, evidence }
    };
    await this.writeDiagnosisRepair(updated);
    return updated;
  }

  async createReportFixture(
    workspaceId: string,
    reportImportId: string
  ): Promise<{ fixture: ReportFixture; replay: ReportFixtureReplay }> {
    this.assertId(workspaceId, "workspace");
    this.assertReportImportId(reportImportId);
    const [, imported] = await Promise.all([
      this.readWorkspace(workspaceId),
      this.readImportedBugReport(workspaceId, reportImportId)
    ]);
    const fixture = buildReportFixture({
      fixtureId: `fixture-${this.idFactory()}`,
      workspaceId,
      reportImportId,
      report: imported.report,
      createdAt: this.now().toISOString()
    });
    const replay = replayReportFixture(fixture);
    if (!replay.matches) {
      throw new AppError(422, "fixture_not_replayable", "报告无法转换为确定性引擎夹具", { mismatches: replay.mismatches });
    }
    await this.writeReportFixture(fixture);
    return { fixture, replay };
  }

  async listReportFixtures(workspaceId: string, reportImportId: string): Promise<ReportFixture[]> {
    this.assertId(workspaceId, "workspace");
    this.assertReportImportId(reportImportId);
    await Promise.all([this.readWorkspace(workspaceId), this.readImportedBugReport(workspaceId, reportImportId)]);
    try {
      const entries = await readdir(this.reportFixtureDir(workspaceId, reportImportId), { withFileTypes: true });
      const fixtures = await Promise.all(entries
        .filter((entry) => entry.isFile() && /^fixture-[0-9a-f-]{36}\.json$/iu.test(entry.name))
        .map((entry) => this.readReportFixture(workspaceId, reportImportId, entry.name.replace(/\.json$/u, ""))));
      return fixtures.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async createReportBenchmarkCandidate(workspaceId: string, reportImportId: string): Promise<ReportBenchmarkCandidate> {
    this.assertId(workspaceId, "workspace");
    this.assertReportImportId(reportImportId);
    const [workspace, imported] = await Promise.all([
      this.readWorkspace(workspaceId),
      this.readImportedBugReport(workspaceId, reportImportId)
    ]);
    const member = workspace.members.find((item) => item.skillId === imported.report.skill.skillId);
    if (!member || member.status !== "ready") {
      throw new AppError(409, "benchmark_target_unavailable", "报告对应的 Skill 当前不可编辑");
    }
    const { graph } = await this.getProjectGraph(member.projectId);
    const benchmarkCase = createBenchmarkCaseFromReport({
      caseId: `case-${this.idFactory()}`,
      reportImportId,
      report: imported.report
    });
    const timestamp = this.now().toISOString();
    const candidate: ReportBenchmarkCandidate = {
      schemaVersion: "1.0",
      candidateId: `benchmark-candidate-${this.idFactory()}`,
      workspaceId,
      reportImportId,
      reportId: imported.report.reportId,
      projectId: member.projectId,
      skillId: member.skillId,
      status: "draft",
      case: benchmarkCase,
      issues: lintBenchmarkCase(benchmarkCase, graph, member.skillId),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.writeReportBenchmarkCandidate(candidate);
    return candidate;
  }

  async listReportBenchmarkCandidates(workspaceId: string, reportImportId: string): Promise<ReportBenchmarkCandidate[]> {
    this.assertId(workspaceId, "workspace");
    this.assertReportImportId(reportImportId);
    await Promise.all([this.readWorkspace(workspaceId), this.readImportedBugReport(workspaceId, reportImportId)]);
    try {
      const entries = await readdir(this.reportBenchmarkCandidateDir(workspaceId, reportImportId), { withFileTypes: true });
      const candidates = await Promise.all(entries
        .filter((entry) => entry.isFile() && /^benchmark-candidate-[0-9a-f-]{36}\.json$/iu.test(entry.name))
        .map((entry) => this.readReportBenchmarkCandidate(workspaceId, reportImportId, entry.name.replace(/\.json$/u, ""))));
      const synchronized = await Promise.all(candidates.map((candidate) => this.synchronizeReportBenchmarkCandidate(candidate)));
      return synchronized.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async createReportBenchmarkChangeSet(
    workspaceId: string,
    reportImportId: string,
    candidateId: string,
    input: unknown
  ): Promise<{ candidate: ReportBenchmarkCandidate; changeSet: ProjectChangeSet }> {
    const candidate = await this.readReportBenchmarkCandidate(workspaceId, reportImportId, candidateId);
    if (candidate.status !== "draft") throw new AppError(409, "benchmark_candidate_not_draft", "候选用例已经生成过 ChangeSet");
    const record = plainRecord(input);
    const benchmarkCase = plainRecord(record.case) as unknown as BenchmarkCase;
    if (benchmarkCase.caseId !== candidate.case.caseId || benchmarkCase.skillId !== candidate.skillId || JSON.stringify(benchmarkCase.source) !== JSON.stringify(candidate.case.source)) {
      throw new AppError(409, "benchmark_candidate_identity_changed", "候选用例的来源身份不可修改");
    }
    const { graph, activeRevision } = await this.getProjectGraph(candidate.projectId);
    const issues = lintBenchmarkCase(benchmarkCase, graph, candidate.skillId);
    if (issues.some((issue) => issue.severity === "error")) {
      throw new AppError(422, "benchmark_candidate_invalid", "候选用例仍有阻断问题", { issues });
    }
    const changeSet = await this.createChangeSet(candidate.projectId, {
      workspaceId,
      baseRevision: activeRevision,
      reason: `从 Bug Report ${candidate.reportId} 创建 Benchmark 候选`,
      source: { kind: "report", sourceId: reportImportId, label: "Bug Report 候选用例" },
      evidence: [
        { kind: "report", ref: candidate.reportId, summary: "从已导入 Bug Report 生成 Benchmark 候选用例" },
        ...(candidate.case.source?.sourceRunId
          ? [{ kind: "runtime" as const, ref: candidate.case.source.sourceRunId, summary: "候选用例关联的原始运行" }]
          : [])
      ],
      operations: [{ op: "benchmark.case.write", target: benchmarkCase.caseId, value: benchmarkCase }]
    });
    const updated: ReportBenchmarkCandidate = {
      ...candidate,
      status: "changeset-created",
      case: benchmarkCase,
      issues,
      changeSetId: changeSet.changeSetId,
      updatedAt: this.now().toISOString()
    };
    await this.writeReportBenchmarkCandidate(updated);
    return { candidate: updated, changeSet };
  }

  async confirmReportBenchmarkCandidate(
    workspaceId: string,
    reportImportId: string,
    candidateId: string,
    confirmation: unknown
  ): Promise<{ candidate: ReportBenchmarkCandidate; applied: ApplyChangeSetResult }> {
    const candidate = await this.readReportBenchmarkCandidate(workspaceId, reportImportId, candidateId);
    if (candidate.status !== "changeset-created" || !candidate.changeSetId) {
      throw new AppError(409, "benchmark_candidate_not_confirmable", "候选用例尚未生成可确认的 ChangeSet");
    }
    const applied = await this.confirmAndApplyChangeSet(candidate.changeSetId, confirmation);
    const updated: ReportBenchmarkCandidate = {
      ...candidate,
      status: "applied",
      appliedRevision: applied.activeRevision,
      updatedAt: this.now().toISOString()
    };
    await this.writeReportBenchmarkCandidate(updated);
    return { candidate: updated, applied };
  }

  async rejectReportBenchmarkCandidate(
    workspaceId: string,
    reportImportId: string,
    candidateId: string,
    input: unknown
  ): Promise<{ candidate: ReportBenchmarkCandidate; changeSet: ProjectChangeSet }> {
    const candidate = await this.readReportBenchmarkCandidate(workspaceId, reportImportId, candidateId);
    if (candidate.status !== "changeset-created" || !candidate.changeSetId) {
      throw new AppError(409, "benchmark_candidate_not_rejectable", "候选用例没有可拒绝的 ChangeSet");
    }
    const changeSet = await this.rejectChangeSet(candidate.changeSetId, input);
    const updated: ReportBenchmarkCandidate = {
      ...candidate,
      status: "rejected",
      updatedAt: this.now().toISOString()
    };
    await this.writeReportBenchmarkCandidate(updated);
    return { candidate: updated, changeSet };
  }

  subscribeTrace(projectId: string, runId: string, listener: () => void): () => void {
    this.assertId(projectId, "project");
    this.assertRunId(runId);
    const key = `${projectId}:${runId}`;
    this.traceEmitter.on(key, listener);
    return () => this.traceEmitter.off(key, listener);
  }

  async listRuns(projectId: string): Promise<ProjectRun[]> {
    this.assertId(projectId, "project");
    try {
      const entries = await readdir(this.runDir(projectId), { withFileTypes: true });
      const runs = await Promise.all(entries
        .filter((entry) => entry.isFile() && /^run-[0-9a-f-]{36}\.json$/i.test(entry.name))
        .map(async (entry) => this.normalizeRun(JSON.parse(await readFile(path.join(this.runDir(projectId), entry.name), "utf8")))));
      return runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async getRuntimeArtifactStorage(
    projectId: string,
    workspaceId: string,
    benchmarkArtifactIds: string[],
    benchmarkRunCount: number
  ): Promise<RuntimeArtifactStorageStatus> {
    this.assertId(projectId, "project");
    this.assertId(workspaceId, "workspace");
    return (await this.scanRuntimeArtifactStorage(projectId, workspaceId, benchmarkArtifactIds, benchmarkRunCount)).status;
  }

  async cleanupRuntimeArtifacts(
    projectId: string,
    workspaceId: string,
    benchmarkArtifactIds: string[],
    benchmarkRunCount: number
  ): Promise<RuntimeArtifactCleanupResult> {
    this.assertId(projectId, "project");
    this.assertId(workspaceId, "workspace");
    return this.mutate(async () => {
      const before = await this.scanRuntimeArtifactStorage(projectId, workspaceId, benchmarkArtifactIds, benchmarkRunCount);
      const deletedArtifactIds: string[] = [];
      let deletedBytes = 0;
      for (const candidate of before.eligible) {
        if (before.protectedArtifactIds.has(candidate.artifactId)) continue;
        let parsed: Partial<RuntimeArtifact>;
        let info;
        try {
          info = await lstat(candidate.file);
          if (!info.isFile() || info.isSymbolicLink()) continue;
          parsed = JSON.parse(await readFile(candidate.file, "utf8")) as Partial<RuntimeArtifact>;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (
          parsed.schemaVersion !== "1.0" || parsed.artifactId !== candidate.artifactId ||
          parsed.workspaceId !== workspaceId || parsed.projectId !== projectId || parsed.skillId !== before.status.skillId ||
          typeof parsed.createdAt !== "string" || parsed.createdAt !== candidate.createdAt ||
          Date.parse(parsed.createdAt) > Date.parse(before.status.cutoffAt)
        ) continue;
        await unlink(candidate.file);
        deletedArtifactIds.push(candidate.artifactId);
        deletedBytes += info.size;
      }
      const after = await this.scanRuntimeArtifactStorage(projectId, workspaceId, benchmarkArtifactIds, benchmarkRunCount);
      return {
        schemaVersion: "1.0",
        before: before.status,
        after: after.status,
        deletedArtifactIds,
        deletedBytes
      };
    });
  }

  async commandRun(
    projectId: string,
    runId: string,
    command: "next" | "pause" | "resume" | "stop",
    input: unknown = {}
  ): Promise<ProjectRunView> {
    this.assertId(projectId, "project");
    this.assertRunId(runId);
    return this.mutate(async () => {
      const run = await this.readRun(projectId, runId);
      const artifact = await this.readArtifact(projectId, run.artifactId);
      if (artifact.projectId !== projectId || artifact.skillId !== run.skillId) {
        throw new AppError(409, "artifact_identity_mismatch", "RuntimeArtifact 与运行身份不一致");
      }
      const record = plainRecord(input);
      if (typeof record.expectedEventSeq === "number" && record.expectedEventSeq !== run.state.eventSeq) {
        throw new AppError(409, "runtime_context_changed", "模型生成期间运行事件已变化");
      }
      if (typeof record.expectedCurrentNodeId === "string" && record.expectedCurrentNodeId !== run.state.currentNodeId) {
        throw new AppError(409, "runtime_context_changed", "模型生成期间当前节点已变化");
      }
      let result;
      if (command === "next") {
        if (typeof record.nextNodeId !== "string" || !record.nextNodeId.trim()) {
          throw new AppError(400, "next_node_required", "缺少下一节点 ID");
        }
        result = advanceRuntime(artifact.graph, run.state, record.nextNodeId.trim());
      } else if (command === "pause") result = pauseRuntime(artifact.graph, run.state);
      else if (command === "resume") result = resumeRuntime(artifact.graph, run.state);
      else result = stopRuntime(artifact.graph, run.state);

      const timestamp = this.now().toISOString();
      run.state = result.state;
      run.events.push(...this.traceEvents(result.events, { runId, artifact, at: timestamp }));
      run.updatedAt = timestamp;
      await this.atomicWrite(this.runFile(projectId, runId), JSON.stringify(run, null, 2) + "\n");
      await this.traceStore.sync(run);
      this.traceEmitter.emit(`${projectId}:${runId}`);
      return {
        run,
        allowedTransitions: result.state.status === "running" ? result.allowedTransitions : [],
        contextFacts: await this.runtimeContextFacts(projectId, run, artifact),
        commandResult: {
          accepted: result.accepted,
          eventSeqs: result.events.map((event) => event.seq),
          ...(result.rejection ? { rejection: result.rejection } : {})
        }
      };
    });
  }

  private graphDocumentPaths(graph: SkillGraph): Set<string> {
    const paths = new Set(graph.nodes.map((node) => node.doc).filter((value): value is string => Boolean(value)));
    for (const node of graph.nodes) {
      for (const query of node.lookup ?? []) if (query.kind === "document.slice") paths.add(query.path);
    }
    return paths;
  }

  private async runtimeContextFacts(projectId: string, run: ProjectRun, artifact: RuntimeArtifact): Promise<ProjectFactQueryResult[]> {
    const currentNode = artifact.graph.nodes.find((node) => node.id === run.state.currentNodeId);
    if (!currentNode?.lookup?.length) return [];
    const revision = await this.readRevision(projectId, run.revision);
    const documents: Record<string, string> = {};
    for (const query of currentNode.lookup) {
      if (query.kind !== "document.slice") continue;
      if (!this.isRuntimeDocumentPath(query.path)) {
        throw new AppError(409, "runtime_document_path_invalid", "冻结节点查询引用了无效文档路径");
      }
      try {
        documents[query.path] = await readFile(path.join(this.snapshotFilesDir(projectId, revision.snapshotId), ...query.path.split("/")), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return executeProjectFactQueries(artifact.graph, documents, currentNode.lookup);
  }

  private isRuntimeDocumentPath(documentPath: string): boolean {
    return isSkillDocumentPath(documentPath);
  }

  async createChangeSet(projectId: string, input: unknown): Promise<ProjectChangeSet> {
    this.assertId(projectId, "project");
    const parsed = this.parseChangeSetInput(input);

    return this.mutate(async () => {
      const [source, state, workspace] = await Promise.all([
        this.readProjectSource(projectId),
        this.readProjectState(projectId),
        this.readWorkspace(parsed.workspaceId)
      ]);
      if (!workspace.members.some((member) => member.projectId === projectId && member.skillId === source.skillId)) {
        throw new AppError(403, "project_not_in_workspace", "该 Skill 不属于指定 Workspace");
      }
      if (parsed.baseRevision !== state.activeRevision) {
        throw new AppError(409, "revision_conflict", "项目版本已变化，请重新加载文档");
      }
      const documentOperations = parsed.operations.filter(isDocumentOperation);
      const graphOperations = parsed.operations.filter(isGraphOperation);
      const benchmarkCaseOperations = parsed.operations.filter(isBenchmarkCaseOperation);
      const skillManifestOperations = parsed.operations.filter(isSkillManifestOperation);
      const assetOperations = parsed.operations.filter(isAssetOperation);
      const operationDomains = [documentOperations.length, graphOperations.length, benchmarkCaseOperations.length, skillManifestOperations.length, assetOperations.length].filter(Boolean).length;
      if (operationDomains > 1) {
        throw new AppError(400, "mixed_operation_domains", "当前版本不能在同一 ChangeSet 中混合不同操作域");
      }

      let preview: ProjectChangeSet["preview"];
      if (documentOperations.length) {
        if (documentOperations.length !== 1 || parsed.operations.length !== 1) {
          throw new AppError(400, "operation_count_unsupported", "当前版本每次只允许确认一个文档变更");
        }
        const operation = documentOperations[0]!;
        const target = this.resolveDocumentPath(source, operation.target);
        await this.assertProjectReadPath(source, target);
        let before = "";
        let existed = true;
        try {
          before = await readFile(target, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          existed = false;
        }
        if (operation.op === "docs.write") {
          if (before === operation.value) throw new AppError(409, "no_changes", "文档内容没有变化");
          const graph = await this.readGraph(source);
          const bindingIssues = await this.lintDocumentBindings(source, graph, new Map([[operation.target, operation.value]]), operation.target);
          const bindingErrors = bindingIssues.filter((issue) => issue.severity === "error");
          if (bindingErrors.length) {
            throw new AppError(422, "document_binding_broken", "文档变更会破坏节点绑定", bindingErrors);
          }
          preview = [this.previewDocument(operation.target, existed, before, operation.value, existed ? "update" : "create")];
        } else {
          if (!existed) throw new AppError(404, "document_not_found", "文档不存在");
          if (operation.target === "SKILL.md") throw new AppError(400, "skill_document_protected", "SKILL.md 不能重命名或删除");
          const graphBefore = await this.readGraph(source);
          const referenceNodeIds = graphBefore.nodes.filter((node) => node.doc === operation.target).map((node) => node.id);
          let graphAfter: SkillGraph;
          if (operation.op === "docs.rename") {
            if (operation.value === operation.target) throw new AppError(409, "no_changes", "文档路径没有变化");
            const destination = this.resolveDocumentPath(source, operation.value);
            try {
              await stat(destination);
              throw new AppError(409, "document_destination_exists", "目标文档已经存在");
            } catch (error) {
              if (error instanceof AppError) throw error;
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            graphAfter = this.rewriteDocumentReferences(graphBefore, operation.target, operation.value);
            const lint = [...lintGraph(graphAfter), ...await this.lintDocumentBindings(source, graphAfter, new Map([[operation.value, before]]))];
            const errors = lint.filter((issue) => issue.severity === "error");
            if (errors.length) throw new AppError(422, "document_rename_invalid", "重命名会破坏项目引用", errors);
            preview = [
              this.previewDocument(operation.target, true, before, before, "rename", operation.value, referenceNodeIds),
              { kind: "graph" as const, target: "graph/main.json" as const, before: graphBefore, after: graphAfter, lint, ...diffGraph(graphBefore, graphAfter) }
            ];
          } else {
            graphAfter = this.rewriteDocumentReferences(graphBefore, operation.target, null);
            const lint = [...lintGraph(graphAfter), ...await this.lintDocumentBindings(source, graphAfter)];
            const errors = lint.filter((issue) => issue.severity === "error");
            if (errors.length) throw new AppError(422, "document_delete_invalid", "删除会破坏项目结构", errors);
            preview = [
              this.previewDocument(operation.target, true, before, "", "delete", undefined, referenceNodeIds),
              { kind: "graph" as const, target: "graph/main.json" as const, before: graphBefore, after: graphAfter, lint, ...diffGraph(graphBefore, graphAfter) }
            ];
          }
        }
      } else if (graphOperations.length) {
        const before = await this.readGraph(source);
        let after: SkillGraph;
        try {
          after = applyGraphOperations(before, graphOperations);
        } catch (error) {
          if (error instanceof GraphOperationError) {
            throw new AppError(400, error.code, error.message, { target: error.target });
          }
          throw error;
        }
        const lint = [...lintGraph(after), ...await this.lintDocumentBindings(source, after)];
        const errors = lint.filter((issue) => issue.severity === "error");
        if (errors.length) throw new AppError(422, "graph_lint_failed", "图存在错误，不能进入确认", errors);
        const diff = diffGraph(before, after);
        if (Object.values(diff).every((ids) => ids.length === 0)) {
          throw new AppError(409, "no_changes", "图内容没有变化");
        }
        preview = [{ kind: "graph", target: "graph/main.json", before, after, lint, ...diff }];
      } else if (skillManifestOperations.length) {
        if (skillManifestOperations.length !== 1 || parsed.operations.length !== 1) {
          throw new AppError(400, "operation_count_unsupported", "当前版本每次只允许确认一个 Skill 信息变更");
        }
        const before = await this.readSkillManifest(source);
        const operation = skillManifestOperations[0]!;
        const after: SkillManifest = { ...before, ...operation.value };
        const changedFields = (["name", "version", "description"] as const).filter((field) => before[field] !== after[field]);
        if (!changedFields.length) throw new AppError(409, "no_changes", "Skill 信息没有变化");
        preview = [{ kind: "skill-manifest", target: "skill.json", before, after, changedFields }];
      } else if (assetOperations.length) {
        if (assetOperations.length !== 1 || parsed.operations.length !== 1) {
          throw new AppError(400, "operation_count_unsupported", "当前版本每次只允许确认一个资产变更");
        }
        const operation = assetOperations[0]!;
        const target = this.resolveAssetPath(source, operation.target);
        await this.assertProjectReadPath(source, target);
        let beforeContent: Buffer | undefined;
        try {
          beforeContent = await readFile(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const existed = beforeContent !== undefined;
        const before = beforeContent ? this.assetFact(operation.target, beforeContent) : undefined;
        const references = await this.assetReferences(source, operation.target);
        if (operation.op === "asset.copy") {
          const content = this.decodeAssetContent(operation.value.contentBase64);
          const after = this.assetFact(operation.target, content);
          if (before?.sha256 === after.sha256) throw new AppError(409, "no_changes", "资产内容没有变化");
          preview = [{
            kind: "asset",
            target: operation.target,
            action: existed ? "replace" : "create",
            existed,
            ...(before ? { before } : {}),
            after,
            references
          }];
        } else {
          if (!before) throw new AppError(404, "asset_not_found", "资产不存在");
          preview = [{ kind: "asset", target: operation.target, action: "delete", existed: true, before, references }];
        }
      } else {
        if (benchmarkCaseOperations.length !== 1 || parsed.operations.length !== 1) {
          throw new AppError(400, "operation_count_unsupported", "当前版本每次只允许确认一个测试用例变更");
        }
        const operation = benchmarkCaseOperations[0]!;
        this.assertBenchmarkCaseId(operation.target);
        const target = this.benchmarkCaseFile(source, operation.target);
        await this.assertProjectReadPath(source, target);
        let before = "";
        let existed = true;
        try {
          before = await readFile(target, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          existed = false;
        }
        if (operation.op === "benchmark.case.delete" && !existed) {
          throw new AppError(404, "benchmark_case_not_found", "测试用例不存在");
        }
        const graph = await this.readGraph(source);
        const lint = operation.op === "benchmark.case.write" ? lintBenchmarkCase(operation.value, graph, source.skillId) : [];
        const errors = lint.filter((issue) => issue.severity === "error");
        if (errors.length) throw new AppError(422, "benchmark_case_lint_failed", "测试用例存在错误，不能进入确认", errors);
        const after = operation.op === "benchmark.case.write" ? JSON.stringify(operation.value, null, 2) + "\n" : "";
        if (before === after) throw new AppError(409, "no_changes", "测试用例内容没有变化");
        preview = [{
          kind: "benchmark-case",
          target: this.benchmarkCaseRelativePath(operation.target),
          caseId: operation.target,
          action: operation.op === "benchmark.case.delete" ? "delete" : existed ? "update" : "create",
          existed,
          before,
          after,
          lint
        }];
      }

      const timestamp = this.now().toISOString();
      const changeSetId = this.prefixedId("change");
      const digestPayload = {
        workspaceId: parsed.workspaceId,
        projectId,
        skillId: source.skillId,
        baseRevision: parsed.baseRevision,
        operations: parsed.operations,
        reason: parsed.reason,
        source: parsed.source,
        evidence: parsed.evidence
      };
      const changeSet: ProjectChangeSet = {
        changeSetId,
        workspaceId: parsed.workspaceId,
        projectId,
        skillId: source.skillId,
        baseRevision: parsed.baseRevision,
        operations: parsed.operations,
        reason: parsed.reason,
        source: parsed.source!,
        evidence: parsed.evidence!,
        status: "proposed",
        preview,
        digest: createHash("sha256").update(JSON.stringify(digestPayload)).digest("hex"),
        createdAt: timestamp
      };
      await mkdir(this.changeSetDir(projectId), { recursive: true });
      await this.writeChangeSet(changeSet);
      return changeSet;
    });
  }

  async createUndoChangeSet(projectId: string, input: unknown): Promise<ProjectChangeSet> {
    this.assertId(projectId, "project");
    const record = plainRecord(input);
    if (typeof record.workspaceId !== "string" || typeof record.baseRevision !== "string") {
      throw new AppError(400, "invalid_undo_changeset", "撤销信息不完整");
    }
    this.assertId(record.workspaceId, "workspace");

    return this.mutate(async () => {
      const [source, state, workspace] = await Promise.all([
        this.readProjectSource(projectId),
        this.readProjectState(projectId),
        this.readWorkspace(record.workspaceId as string)
      ]);
      if (!workspace.members.some((member) => member.projectId === projectId && member.skillId === source.skillId)) {
        throw new AppError(403, "project_not_in_workspace", "该 Skill 不属于指定 Workspace");
      }
      if (record.baseRevision !== state.activeRevision) {
        throw new AppError(409, "revision_conflict", "项目版本已变化，请重新打开版本历史");
      }
      const currentRevision = await this.ensureProjectHistory(source, state);
      if (!currentRevision.parentRevision) throw new AppError(409, "undo_not_available", "初始版本没有可撤销的提交");
      const targetRevision = await this.readRevision(projectId, currentRevision.parentRevision);
      const [currentSnapshot, targetSnapshot] = await Promise.all([
        this.readSnapshot(projectId, currentRevision.snapshotId),
        this.readSnapshot(projectId, targetRevision.snapshotId)
      ]);
      await Promise.all([
        this.verifySnapshotForRestore(source, currentRevision, currentSnapshot),
        this.verifySnapshotForRestore(source, targetRevision, targetSnapshot)
      ]);
      const liveContentHash = await this.computeProjectContentHash(source);
      if (liveContentHash !== currentSnapshot.contentHash) {
        throw new AppError(409, "project_content_changed", "项目文件已在当前 revision 之外变化，不能直接撤销");
      }
      const files = this.diffSnapshots(currentSnapshot, targetSnapshot);
      if (!files.length) throw new AppError(409, "undo_has_no_changes", "最近提交与其父版本内容一致，无需撤销");
      const operation: ProjectRestoreOperation = {
        op: "project.restore",
        target: targetRevision.revisionId,
        value: { snapshotId: targetSnapshot.snapshotId, contentHash: targetSnapshot.contentHash }
      };
      const preview: ProjectRestoreChangePreview = {
        kind: "project-restore",
        target: "project",
        fromRevision: currentRevision.revisionId,
        toRevision: targetRevision.revisionId,
        toSnapshotId: targetSnapshot.snapshotId,
        files
      };
      const changeSetId = this.prefixedId("change");
      const changeSetSource = { kind: "system" as const, sourceId: currentRevision.revisionId, label: "版本历史撤销" };
      const changeSetEvidence = [{ kind: "project-fact" as const, ref: targetRevision.revisionId, summary: `目标 Snapshot ${targetRevision.snapshotId}` }];
      const digestPayload = {
        workspaceId: record.workspaceId,
        projectId,
        skillId: source.skillId,
        baseRevision: currentRevision.revisionId,
        operations: [operation],
        reason: `撤销最近提交，恢复到 ${targetRevision.revisionId}`,
        source: changeSetSource,
        evidence: changeSetEvidence
      };
      const changeSet: ProjectChangeSet = {
        changeSetId,
        workspaceId: record.workspaceId as string,
        projectId,
        skillId: source.skillId,
        baseRevision: currentRevision.revisionId,
        operations: [operation],
        reason: `撤销最近提交，恢复到 ${targetRevision.revisionId}`,
        source: changeSetSource,
        evidence: changeSetEvidence,
        status: "proposed",
        preview: [preview],
        digest: createHash("sha256").update(JSON.stringify(digestPayload)).digest("hex"),
        createdAt: this.now().toISOString()
      };
      await this.writeChangeSet(changeSet);
      return changeSet;
    });
  }

  async getChangeSet(changeSetId: string): Promise<ProjectChangeSet> {
    this.assertChangeSetId(changeSetId);
    const projectDirs = await readdir(this.projectStateRoot(), { withFileTypes: true });
    for (const project of projectDirs) {
      if (!project.isDirectory()) continue;
      try {
        const changeSet = JSON.parse(await readFile(path.join(this.changeSetDir(project.name), `${changeSetId}.json`), "utf8")) as ProjectChangeSet;
        changeSet.source ??= { kind: "legacy", label: "历史 ChangeSet" };
        changeSet.evidence ??= [];
        return changeSet;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new AppError(404, "changeset_not_found", "ChangeSet 不存在");
  }

  async rejectChangeSet(changeSetId: string, input: unknown): Promise<ProjectChangeSet> {
    this.assertChangeSetId(changeSetId);
    const record = plainRecord(input);
    if (typeof record.digest !== "string" || typeof record.baseRevision !== "string") {
      throw new AppError(400, "invalid_rejection", "拒绝信息不完整");
    }
    if (record.reason !== undefined && typeof record.reason !== "string") {
      throw new AppError(400, "invalid_rejection_reason", "拒绝原因必须是文本");
    }
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    if (reason.length > 500) throw new AppError(400, "rejection_reason_too_long", "拒绝原因不能超过 500 个字符");

    return this.mutate(async () => {
      const changeSet = await this.getChangeSet(changeSetId);
      if (changeSet.status !== "proposed") throw new AppError(409, "changeset_not_proposed", "ChangeSet 已处理");
      if (record.digest !== changeSet.digest || record.baseRevision !== changeSet.baseRevision) {
        throw new AppError(409, "rejection_mismatch", "拒绝内容与当前预览不一致");
      }
      const rejected: ProjectChangeSet = {
        ...changeSet,
        status: "rejected",
        rejectedAt: this.now().toISOString(),
        ...(reason ? { rejectionReason: reason } : {})
      };
      await this.writeChangeSet(rejected);
      return rejected;
    });
  }

  async reproposeChangeSet(changeSetId: string, input: unknown): Promise<ProjectChangeSet> {
    this.assertChangeSetId(changeSetId);
    const record = plainRecord(input);
    if (typeof record.digest !== "string" || typeof record.baseRevision !== "string") {
      throw new AppError(400, "invalid_reproposal", "重新预演信息不完整");
    }
    const confirmation: ReproposeChangeSetInput = { digest: record.digest, baseRevision: record.baseRevision };
    const changeSet = await this.getChangeSet(changeSetId);
    if (changeSet.status !== "conflicted") {
      throw new AppError(409, "changeset_not_conflicted", "只有已冲突的 ChangeSet 可以重新预演");
    }
    if (confirmation.digest !== changeSet.digest || confirmation.baseRevision !== changeSet.baseRevision) {
      throw new AppError(409, "confirmation_mismatch", "重新预演内容与原预览不一致");
    }
    const state = await this.readProjectState(changeSet.projectId);
    if (changeSet.preview.some((preview) => preview.kind === "project-restore")) {
      return this.createUndoChangeSet(changeSet.projectId, {
        workspaceId: changeSet.workspaceId,
        baseRevision: state.activeRevision
      });
    }
    return this.createChangeSet(changeSet.projectId, {
      workspaceId: changeSet.workspaceId,
      baseRevision: state.activeRevision,
      reason: changeSet.reason,
      source: changeSet.source,
      evidence: changeSet.evidence,
      operations: changeSet.operations
    });
  }

  async confirmAndApplyChangeSet(
    changeSetId: string,
    confirmation: unknown
  ): Promise<ApplyChangeSetResult> {
    const record = typeof confirmation === "object" && confirmation !== null ? confirmation as Record<string, unknown> : {};
    if (typeof record.digest !== "string" || typeof record.baseRevision !== "string") {
      throw new AppError(400, "invalid_confirmation", "确认信息不完整");
    }

    return this.mutate(async () => {
      const changeSet = await this.getChangeSet(changeSetId);
      if (changeSet.status !== "proposed") throw new AppError(409, "changeset_not_proposed", "ChangeSet 已处理");
      if (record.digest !== changeSet.digest || record.baseRevision !== changeSet.baseRevision) {
        throw new AppError(409, "confirmation_mismatch", "确认内容与预览不一致");
      }

      const [source, state] = await Promise.all([
        this.readProjectSource(changeSet.projectId),
        this.readProjectState(changeSet.projectId)
      ]);
      if (source.skillId !== changeSet.skillId) throw new AppError(409, "skill_identity_mismatch", "Skill 身份已变化");
      if (state.activeRevision !== changeSet.baseRevision) {
        await this.markConflicted(changeSet, "revision_conflict", "项目版本已变化，原提案不能继续应用", state.activeRevision);
        throw new AppError(409, "revision_conflict", "项目版本已变化，ChangeSet 已标记冲突");
      }

      const restorePreview = changeSet.preview.find((item): item is ProjectRestoreChangePreview => item.kind === "project-restore");
      if (restorePreview) {
        return await this.applyProjectRestoreChangeSet(changeSet, source, state, restorePreview);
      }

      const documentPreview = changeSet.preview.find((item) => item.kind === "document");
      if (documentPreview) {
        return await this.applyDocumentChangeSet(changeSet, source, state, documentPreview);
      }

      const assetPreview = changeSet.preview.find((item): item is AssetChangePreview => item.kind === "asset");
      if (assetPreview) {
        return await this.applyAssetChangeSet(changeSet, source, state, assetPreview);
      }

      const preview = changeSet.preview[0];
      if (!preview) throw new AppError(500, "changeset_preview_invalid", "ChangeSet 预览数据损坏");

      let target: string;
      let beforeContent: string;
      let afterContent: string;
      let graph: SkillGraph | undefined;
      let skillManifest: SkillManifest | undefined;
      let benchmarkCase: ProjectBenchmarkCase | undefined;
      let deletedBenchmarkCaseId: string | undefined;

      if (preview.kind === "skill-manifest") {
        const operation = changeSet.operations[0];
        if (!operation || !isSkillManifestOperation(operation) || changeSet.operations.length !== 1) {
          throw new AppError(500, "changeset_preview_invalid", "Skill 信息 ChangeSet 操作数据损坏");
        }
        const current = await this.readSkillManifest(source);
        if (JSON.stringify(current) !== JSON.stringify(preview.before)) {
          await this.markConflicted(changeSet, "skill_manifest_conflict", "Skill 信息已在预览后发生变化", state.activeRevision);
          throw new AppError(409, "skill_manifest_conflict", "Skill 信息已在预览后发生变化，ChangeSet 已标记冲突");
        }
        const recalculated = { ...current, ...operation.value };
        if (JSON.stringify(recalculated) !== JSON.stringify(preview.after)) {
          await this.markConflicted(changeSet, "skill_manifest_preview_mismatch", "Skill 信息重算结果与原预览不一致", state.activeRevision);
          throw new AppError(409, "skill_manifest_preview_mismatch", "Skill 信息与预览不一致，ChangeSet 已标记冲突");
        }
        target = path.join(source.root, "skill.json");
        beforeContent = JSON.stringify(current, null, 2) + "\n";
        afterContent = JSON.stringify(recalculated, null, 2) + "\n";
        skillManifest = recalculated;
      } else if (preview.kind === "graph") {
        const operations = changeSet.operations.filter(isGraphOperation);
        if (!operations.length || operations.length !== changeSet.operations.length) {
          throw new AppError(500, "changeset_preview_invalid", "图 ChangeSet 操作数据损坏");
        }
        target = this.graphFile(source);
        const currentGraph = await this.readGraph(source);
        if (JSON.stringify(currentGraph) !== JSON.stringify(preview.before)) {
          await this.markConflicted(changeSet, "graph_conflict", "图已在预览后发生变化", state.activeRevision);
          throw new AppError(409, "graph_conflict", "图已在预览后发生变化，ChangeSet 已标记冲突");
        }
        const recalculated = applyGraphOperations(currentGraph, operations);
        const lintErrors = [
          ...lintGraph(recalculated),
          ...await this.lintDocumentBindings(source, recalculated)
        ].filter((issue) => issue.severity === "error");
        if (lintErrors.length || JSON.stringify(recalculated) !== JSON.stringify(preview.after)) {
          await this.markConflicted(changeSet, "graph_preview_mismatch", "图操作重算结果与原预览不一致", state.activeRevision, lintErrors);
          throw new AppError(409, "graph_preview_mismatch", "图操作重算结果与预览不一致", lintErrors);
        }
        beforeContent = JSON.stringify(currentGraph, null, 2) + "\n";
        afterContent = JSON.stringify(recalculated, null, 2) + "\n";
        graph = recalculated;
      } else if (preview.kind === "benchmark-case") {
        const operation = changeSet.operations[0];
        if (!operation || !isBenchmarkCaseOperation(operation) || preview.caseId !== operation.target) {
          throw new AppError(500, "changeset_preview_invalid", "测试用例 ChangeSet 预览数据损坏");
        }
        target = this.benchmarkCaseFile(source, operation.target);
        await this.assertProjectReadPath(source, target);
        let current = "";
        let currentlyExists = true;
        try {
          current = await readFile(target, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          currentlyExists = false;
        }
        if (currentlyExists !== preview.existed || current !== preview.before) {
          await this.markConflicted(changeSet, "benchmark_case_conflict", "测试用例已在预览后发生变化", state.activeRevision);
          throw new AppError(409, "benchmark_case_conflict", "测试用例已在预览后发生变化，ChangeSet 已标记冲突");
        }
        if (operation.op === "benchmark.case.write") {
          const currentGraph = await this.readGraph(source);
          const lint = lintBenchmarkCase(operation.value, currentGraph, source.skillId);
          const errors = lint.filter((issue) => issue.severity === "error");
          const recalculated = JSON.stringify(operation.value, null, 2) + "\n";
          if (errors.length || recalculated !== preview.after) {
            await this.markConflicted(changeSet, "benchmark_case_preview_mismatch", "测试用例或图已在确认期间变化", state.activeRevision, errors);
            throw new AppError(409, "benchmark_case_preview_mismatch", "测试用例或图已在确认期间变化，ChangeSet 已标记冲突", errors);
          }
          afterContent = recalculated;
        } else {
          if (!currentlyExists || preview.after !== "") {
            await this.markConflicted(changeSet, "benchmark_case_preview_mismatch", "测试用例删除预览与当前事实不一致", state.activeRevision);
            throw new AppError(409, "benchmark_case_preview_mismatch", "测试用例删除预览不一致");
          }
          afterContent = "";
          deletedBenchmarkCaseId = operation.target;
        }
        beforeContent = current;
      } else {
        throw new AppError(500, "changeset_preview_invalid", "文档 ChangeSet 预览路由失败");
      }

      const appliedAt = this.now().toISOString();
      const nextRevision = this.nextRevisionId(appliedAt);
      const appliedChangeSet: ProjectChangeSet = {
        ...changeSet,
        status: "applied",
        appliedRevision: nextRevision
      };

      let transaction = await this.beginProjectTransaction(changeSet, source, state, nextRevision, "changeset", appliedAt);
      let capturedRevision: ProjectRevision | undefined;
      try {
        await mkdir(path.dirname(target), { recursive: true });
        if (preview.kind === "benchmark-case" && preview.action === "delete") await unlink(target);
        else await this.atomicWrite(target, afterContent);
        transaction = await this.advanceProjectTransaction(transaction, "files-written");
        capturedRevision = await this.captureProjectRevision(
          source,
          nextRevision,
          state.activeRevision,
          "changeset",
          appliedAt,
          changeSet.changeSetId
        );
        transaction = await this.advanceProjectTransaction(transaction, "revision-captured", {
          capturedSnapshotId: capturedRevision.snapshotId
        });
        const nextState: ProjectState = {
          ...state,
          activeRevision: nextRevision,
          currentSnapshotId: capturedRevision.snapshotId,
          updatedAt: appliedAt
        };
        await this.atomicWrite(this.projectStateFile(changeSet.projectId), JSON.stringify(nextState, null, 2) + "\n");
        transaction = await this.advanceProjectTransaction(transaction, "state-committed");
        await this.writeChangeSet(appliedChangeSet);
        transaction = await this.advanceProjectTransaction(transaction, "completed");
      } catch (error) {
        const rollbackFailures: string[] = [];
        try {
          await this.atomicWrite(this.projectStateFile(changeSet.projectId), JSON.stringify(state, null, 2) + "\n");
        } catch {
          rollbackFailures.push("project-state");
        }
        try {
          if (preview.kind === "benchmark-case") {
            await this.restoreDocument(target, preview.existed, beforeContent);
          } else await this.atomicWrite(target, beforeContent);
        } catch {
          rollbackFailures.push("document");
        }
        if (capturedRevision) {
          try {
            await this.removeCapturedRevision(capturedRevision);
          } catch {
            rollbackFailures.push("revision-history");
          }
        }
        if (!rollbackFailures.length) {
          try {
            await this.markTransactionRolledBack(transaction, changeSet, "提交期间发生错误，已恢复确认前状态；请重新检查 ChangeSet");
          } catch {
            rollbackFailures.push("transaction-journal");
          }
        }
        if (rollbackFailures.length) {
          throw new AppError(500, "transaction_rollback_failed", "提交失败且回滚不完整", { rollbackFailures });
        }
        throw error;
      }

      if (preview.kind === "benchmark-case" && preview.action !== "delete") {
        const operation = changeSet.operations[0] as BenchmarkCaseChangeOperation;
        benchmarkCase = {
          case: (operation as Extract<BenchmarkCaseChangeOperation, { op: "benchmark.case.write" }>).value,
          path: preview.target,
          activeRevision: nextRevision,
          issues: preview.lint
        };
      }

      return {
        changeSet: appliedChangeSet,
        activeRevision: nextRevision,
        ...(graph ? { graph } : {}),
        ...(benchmarkCase ? { benchmarkCase } : {}),
        ...(deletedBenchmarkCaseId ? { deletedBenchmarkCaseId } : {}),
        ...(skillManifest ? { skillManifest } : {})
      };
    });
  }

  private async applyProjectRestoreChangeSet(
    changeSet: ProjectChangeSet,
    source: ProjectSource,
    state: ProjectState,
    preview: ProjectRestoreChangePreview
  ): Promise<ApplyChangeSetResult> {
    const operation = changeSet.operations[0];
    if (!operation || !isProjectRestoreOperation(operation) || changeSet.operations.length !== 1) {
      throw new AppError(500, "changeset_preview_invalid", "撤销 ChangeSet 操作数据损坏");
    }
    const currentRevision = await this.readRevision(source.projectId, state.activeRevision);
    if (
      currentRevision.revisionId !== preview.fromRevision ||
      currentRevision.parentRevision !== preview.toRevision ||
      operation.target !== preview.toRevision ||
      operation.value.snapshotId !== preview.toSnapshotId
    ) {
      await this.markConflicted(changeSet, "undo_target_changed", "撤销目标已变化", state.activeRevision);
      throw new AppError(409, "undo_target_changed", "撤销目标已变化，ChangeSet 已标记冲突");
    }
    const targetRevision = await this.readRevision(source.projectId, preview.toRevision);
    const [currentSnapshot, targetSnapshot] = await Promise.all([
      this.readSnapshot(source.projectId, currentRevision.snapshotId),
      this.readSnapshot(source.projectId, targetRevision.snapshotId)
    ]);
    if (
      targetSnapshot.snapshotId !== operation.value.snapshotId ||
      targetSnapshot.contentHash !== operation.value.contentHash
    ) {
      await this.markConflicted(changeSet, "undo_snapshot_changed", "撤销 Snapshot 身份已变化", state.activeRevision);
      throw new AppError(409, "undo_snapshot_changed", "撤销 Snapshot 身份已变化，ChangeSet 已标记冲突");
    }
    await Promise.all([
      this.verifySnapshotForRestore(source, currentRevision, currentSnapshot),
      this.verifySnapshotForRestore(source, targetRevision, targetSnapshot)
    ]);
    const liveContentHash = await this.computeProjectContentHash(source);
    if (liveContentHash !== currentSnapshot.contentHash) {
      await this.markConflicted(changeSet, "project_content_changed", "项目文件已在撤销预览后变化", state.activeRevision);
      throw new AppError(409, "project_content_changed", "项目文件已在撤销预览后变化，ChangeSet 已标记冲突");
    }
    if (JSON.stringify(this.diffSnapshots(currentSnapshot, targetSnapshot)) !== JSON.stringify(preview.files)) {
      await this.markConflicted(changeSet, "undo_preview_mismatch", "撤销文件差异与原预览不一致", state.activeRevision);
      throw new AppError(409, "undo_preview_mismatch", "撤销文件差异与预览不一致，ChangeSet 已标记冲突");
    }

    const appliedAt = this.now().toISOString();
    const nextRevision = this.nextRevisionId(appliedAt);
    const appliedChangeSet: ProjectChangeSet = { ...changeSet, status: "applied", appliedRevision: nextRevision };
    let transaction = await this.beginProjectTransaction(changeSet, source, state, nextRevision, "undo", appliedAt);
    let capturedRevision: ProjectRevision | undefined;
    try {
      await this.replaceProjectWithSnapshot(source, targetSnapshot);
      if (await this.computeProjectContentHash(source) !== targetSnapshot.contentHash) {
        throw new AppError(500, "undo_restore_mismatch", "恢复后的项目内容与目标 Snapshot 不一致");
      }
      transaction = await this.advanceProjectTransaction(transaction, "files-written");
      capturedRevision = await this.captureProjectRevision(
        source,
        nextRevision,
        state.activeRevision,
        "undo",
        appliedAt,
        changeSet.changeSetId
      );
      transaction = await this.advanceProjectTransaction(transaction, "revision-captured", {
        capturedSnapshotId: capturedRevision.snapshotId
      });
      if (capturedRevision.contentHash !== targetSnapshot.contentHash) {
        throw new AppError(500, "undo_revision_mismatch", "撤销 revision 与目标 Snapshot 内容不一致");
      }
      const nextState: ProjectState = {
        ...state,
        activeRevision: nextRevision,
        currentSnapshotId: capturedRevision.snapshotId,
        updatedAt: appliedAt
      };
      await this.atomicWrite(this.projectStateFile(source.projectId), JSON.stringify(nextState, null, 2) + "\n");
      transaction = await this.advanceProjectTransaction(transaction, "state-committed");
      await this.writeChangeSet(appliedChangeSet);
      transaction = await this.advanceProjectTransaction(transaction, "completed");
    } catch (error) {
      const rollbackFailures: string[] = [];
      try {
        await this.replaceProjectWithSnapshot(source, currentSnapshot);
      } catch {
        rollbackFailures.push("project-files");
      }
      try {
        await this.atomicWrite(this.projectStateFile(source.projectId), JSON.stringify(state, null, 2) + "\n");
      } catch {
        rollbackFailures.push("project-state");
      }
      if (capturedRevision) {
        try {
          await this.removeCapturedRevision(capturedRevision);
        } catch {
          rollbackFailures.push("revision-history");
        }
      }
      if (!rollbackFailures.length) {
        try {
          await this.markTransactionRolledBack(transaction, changeSet, "撤销提交期间发生错误，已恢复撤销前状态；请重新检查 ChangeSet");
        } catch {
          rollbackFailures.push("transaction-journal");
        }
      }
      if (rollbackFailures.length) {
        throw new AppError(500, "transaction_rollback_failed", "撤销失败且回滚不完整", { rollbackFailures });
      }
      throw error;
    }
    return {
      changeSet: appliedChangeSet,
      activeRevision: nextRevision,
      restoredRevision: targetRevision.revisionId,
      restoredSnapshotId: targetSnapshot.snapshotId
    };
  }

  private async applyAssetChangeSet(
    changeSet: ProjectChangeSet,
    source: ProjectSource,
    state: ProjectState,
    preview: AssetChangePreview
  ): Promise<ApplyChangeSetResult> {
    const operation = changeSet.operations[0];
    if (!operation || !isAssetOperation(operation) || changeSet.operations.length !== 1 || preview.target !== operation.target) {
      throw new AppError(500, "changeset_preview_invalid", "资产 ChangeSet 预览数据损坏");
    }
    const target = this.resolveAssetPath(source, operation.target);
    await this.assertProjectReadPath(source, target);
    let beforeContent: Buffer | undefined;
    try {
      beforeContent = await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const existed = beforeContent !== undefined;
    const before = beforeContent ? this.assetFact(operation.target, beforeContent) : undefined;
    if (existed !== preview.existed || JSON.stringify(before) !== JSON.stringify(preview.before)) {
      await this.markConflicted(changeSet, "asset_conflict", "资产已在预览后发生变化", state.activeRevision);
      throw new AppError(409, "asset_conflict", "资产已在预览后发生变化，ChangeSet 已标记冲突");
    }
    const references = await this.assetReferences(source, operation.target);
    if (JSON.stringify(references) !== JSON.stringify(preview.references)) {
      await this.markConflicted(changeSet, "asset_references_changed", "资产引用已在预览后发生变化", state.activeRevision);
      throw new AppError(409, "asset_references_changed", "资产引用已在预览后发生变化，ChangeSet 已标记冲突");
    }

    let afterContent: Buffer | undefined;
    if (operation.op === "asset.copy") {
      afterContent = this.decodeAssetContent(operation.value.contentBase64);
      const after = this.assetFact(operation.target, afterContent);
      const action = existed ? "replace" : "create";
      if (preview.action !== action || JSON.stringify(preview.after) !== JSON.stringify(after)) {
        await this.markConflicted(changeSet, "asset_preview_mismatch", "资产内容重算结果与原预览不一致", state.activeRevision);
        throw new AppError(409, "asset_preview_mismatch", "资产内容与预览不一致，ChangeSet 已标记冲突");
      }
    } else if (!existed || preview.action !== "delete" || preview.after !== undefined) {
      await this.markConflicted(changeSet, "asset_preview_mismatch", "资产删除预览与当前事实不一致", state.activeRevision);
      throw new AppError(409, "asset_preview_mismatch", "资产删除预览不一致，ChangeSet 已标记冲突");
    }

    const appliedAt = this.now().toISOString();
    const nextRevision = this.nextRevisionId(appliedAt);
    const appliedChangeSet: ProjectChangeSet = { ...changeSet, status: "applied", appliedRevision: nextRevision };
    let transaction = await this.beginProjectTransaction(changeSet, source, state, nextRevision, "changeset", appliedAt);
    let capturedRevision: ProjectRevision | undefined;
    try {
      if (operation.op === "asset.copy") {
        await mkdir(path.dirname(target), { recursive: true });
        await this.atomicWriteBuffer(target, afterContent!);
      } else {
        await unlink(target);
      }
      transaction = await this.advanceProjectTransaction(transaction, "files-written");
      capturedRevision = await this.captureProjectRevision(source, nextRevision, state.activeRevision, "changeset", appliedAt, changeSet.changeSetId);
      transaction = await this.advanceProjectTransaction(transaction, "revision-captured", {
        capturedSnapshotId: capturedRevision.snapshotId
      });
      const nextState: ProjectState = {
        ...state,
        activeRevision: nextRevision,
        currentSnapshotId: capturedRevision.snapshotId,
        updatedAt: appliedAt
      };
      await this.atomicWrite(this.projectStateFile(changeSet.projectId), JSON.stringify(nextState, null, 2) + "\n");
      transaction = await this.advanceProjectTransaction(transaction, "state-committed");
      await this.writeChangeSet(appliedChangeSet);
      transaction = await this.advanceProjectTransaction(transaction, "completed");
    } catch (error) {
      const rollbackFailures: string[] = [];
      try {
        await this.atomicWrite(this.projectStateFile(changeSet.projectId), JSON.stringify(state, null, 2) + "\n");
      } catch {
        rollbackFailures.push("project-state");
      }
      try {
        if (beforeContent) {
          await mkdir(path.dirname(target), { recursive: true });
          await this.atomicWriteBuffer(target, beforeContent);
        } else {
          await rm(target, { force: true });
        }
      } catch {
        rollbackFailures.push(operation.target);
      }
      if (capturedRevision) {
        try {
          await this.removeCapturedRevision(capturedRevision);
        } catch {
          rollbackFailures.push("revision-history");
        }
      }
      if (!rollbackFailures.length) {
        try {
          await this.markTransactionRolledBack(transaction, changeSet, "资产提交期间发生错误，已恢复确认前状态；请重新检查 ChangeSet");
        } catch {
          rollbackFailures.push("transaction-journal");
        }
      }
      if (rollbackFailures.length) {
        throw new AppError(500, "transaction_rollback_failed", "资产提交失败且回滚不完整", { rollbackFailures });
      }
      throw error;
    }

    if (operation.op === "asset.delete") {
      return { changeSet: appliedChangeSet, activeRevision: nextRevision, deletedAssetPath: operation.target };
    }
    const info = await stat(target);
    return {
      changeSet: appliedChangeSet,
      activeRevision: nextRevision,
      asset: {
        ...this.assetFact(operation.target, afterContent!),
        updatedAt: info.mtime.toISOString(),
        referenceCount: references.length
      }
    };
  }

  private async applyDocumentChangeSet(
    changeSet: ProjectChangeSet,
    source: ProjectSource,
    state: ProjectState,
    preview: DocumentChangePreview
  ): Promise<ApplyChangeSetResult> {
    const operation = changeSet.operations[0];
    if (!operation || !isDocumentOperation(operation) || changeSet.operations.length !== 1 || preview.target !== operation.target) {
      throw new AppError(500, "changeset_preview_invalid", "文档 ChangeSet 预览数据损坏");
    }
    const sourceTarget = this.resolveDocumentPath(source, operation.target);
    let current = "";
    let currentlyExists = true;
    try {
      current = await readFile(sourceTarget, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      currentlyExists = false;
    }
    if (currentlyExists !== preview.existed || current !== preview.before) {
      await this.markConflicted(changeSet, "document_conflict", "文档已在预览后发生变化", state.activeRevision);
      throw new AppError(409, "document_conflict", "文档已在预览后发生变化，ChangeSet 已标记冲突");
    }

    type Backup = { target: string; existed: boolean; content: string };
    const backups: Backup[] = [{ target: sourceTarget, existed: currentlyExists, content: current }];
    let document: DocumentFile | undefined;
    let deletedDocumentPath: string | undefined;
    let graph: SkillGraph | undefined;
    let destinationTarget: string | undefined;

    if (operation.op === "docs.write") {
      const action = currentlyExists ? "update" : "create";
      if (preview.action !== action || preview.after !== operation.value) {
        await this.markConflicted(changeSet, "document_preview_mismatch", "文档内容与原预览不一致", state.activeRevision);
        throw new AppError(409, "document_preview_mismatch", "文档内容与预览不一致");
      }
      const currentGraph = await this.readGraph(source);
      const bindingErrors = (await this.lintDocumentBindings(
        source,
        currentGraph,
        new Map([[operation.target, operation.value]]),
        operation.target
      )).filter((issue) => issue.severity === "error");
      if (bindingErrors.length) {
        await this.markConflicted(changeSet, "document_binding_changed", "节点引用已在确认期间变化", state.activeRevision, bindingErrors);
        throw new AppError(409, "document_binding_changed", "节点引用已在确认期间变化，ChangeSet 已标记冲突", bindingErrors);
      }
    } else {
      if (operation.target === "SKILL.md" || !currentlyExists) {
        await this.markConflicted(changeSet, "document_preview_mismatch", "文档生命周期操作目标已变化", state.activeRevision);
        throw new AppError(409, "document_preview_mismatch", "文档生命周期操作目标已变化");
      }
      const graphPreview = changeSet.preview.find((item) => item.kind === "graph");
      if (!graphPreview) throw new AppError(500, "changeset_preview_invalid", "文档生命周期 ChangeSet 缺少图引用预览");
      const currentGraph = await this.readGraph(source);
      if (JSON.stringify(currentGraph) !== JSON.stringify(graphPreview.before)) {
        await this.markConflicted(changeSet, "document_references_changed", "节点引用已在预览后变化", state.activeRevision);
        throw new AppError(409, "document_references_changed", "节点引用已在预览后变化，ChangeSet 已标记冲突");
      }
      const destination = operation.op === "docs.rename" ? operation.value : null;
      const recalculated = this.rewriteDocumentReferences(currentGraph, operation.target, destination);
      const overrides = destination ? new Map([[destination, current]]) : new Map<string, string>();
      const lintErrors = [
        ...lintGraph(recalculated),
        ...await this.lintDocumentBindings(source, recalculated, overrides)
      ].filter((issue) => issue.severity === "error");
      if (lintErrors.length || JSON.stringify(recalculated) !== JSON.stringify(graphPreview.after)) {
        await this.markConflicted(changeSet, "document_reference_preview_mismatch", "文档引用同步结果与原预览不一致", state.activeRevision, lintErrors);
        throw new AppError(409, "document_reference_preview_mismatch", "文档引用同步结果与预览不一致", lintErrors);
      }
      graph = recalculated;
      const graphTarget = this.graphFile(source);
      backups.push({ target: graphTarget, existed: true, content: JSON.stringify(currentGraph, null, 2) + "\n" });
      if (operation.op === "docs.rename") {
        if (preview.action !== "rename" || preview.destination !== operation.value || preview.after !== current) {
          await this.markConflicted(changeSet, "document_preview_mismatch", "文档重命名预览与当前事实不一致", state.activeRevision);
          throw new AppError(409, "document_preview_mismatch", "文档重命名预览不一致");
        }
        destinationTarget = this.resolveDocumentPath(source, operation.value);
        let destinationContent = "";
        let destinationExists = true;
        try {
          destinationContent = await readFile(destinationTarget, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          destinationExists = false;
        }
        if (destinationExists) {
          await this.markConflicted(changeSet, "document_destination_exists", "目标文档已在确认期间出现", state.activeRevision);
          throw new AppError(409, "document_destination_exists", "目标文档已在确认期间出现，ChangeSet 已标记冲突");
        }
        backups.push({ target: destinationTarget, existed: false, content: destinationContent });
      } else {
        if (preview.action !== "delete" || preview.after !== "") {
          await this.markConflicted(changeSet, "document_preview_mismatch", "文档删除预览与当前事实不一致", state.activeRevision);
          throw new AppError(409, "document_preview_mismatch", "文档删除预览不一致");
        }
        deletedDocumentPath = operation.target;
      }
    }

    const appliedAt = this.now().toISOString();
    const nextRevision = this.nextRevisionId(appliedAt);
    const appliedChangeSet: ProjectChangeSet = { ...changeSet, status: "applied", appliedRevision: nextRevision };
    let transaction = await this.beginProjectTransaction(changeSet, source, state, nextRevision, "changeset", appliedAt);
    let capturedRevision: ProjectRevision | undefined;
    try {
      if (operation.op === "docs.write") {
        await mkdir(path.dirname(sourceTarget), { recursive: true });
        await this.atomicWrite(sourceTarget, operation.value);
        document = { path: operation.target, content: operation.value, activeRevision: nextRevision };
      } else if (operation.op === "docs.rename") {
        await mkdir(path.dirname(destinationTarget!), { recursive: true });
        transaction = await this.beginFileMutation(transaction, "document-rename-destination");
        await this.atomicWrite(destinationTarget!, current);
        await this.notifyFileMutation(transaction);
        transaction = await this.beginFileMutation(transaction, "document-rename-source");
        await unlink(sourceTarget);
        await this.notifyFileMutation(transaction);
        transaction = await this.beginFileMutation(transaction, "document-rename-graph");
        await this.atomicWrite(this.graphFile(source), JSON.stringify(graph, null, 2) + "\n");
        await this.notifyFileMutation(transaction);
        document = { path: operation.value, content: current, activeRevision: nextRevision };
      } else {
        await unlink(sourceTarget);
        await this.atomicWrite(this.graphFile(source), JSON.stringify(graph, null, 2) + "\n");
      }
      transaction = await this.advanceProjectTransaction(transaction, "files-written");
      capturedRevision = await this.captureProjectRevision(source, nextRevision, state.activeRevision, "changeset", appliedAt, changeSet.changeSetId);
      transaction = await this.advanceProjectTransaction(transaction, "revision-captured", {
        capturedSnapshotId: capturedRevision.snapshotId
      });
      const nextState: ProjectState = {
        ...state,
        activeRevision: nextRevision,
        currentSnapshotId: capturedRevision.snapshotId,
        updatedAt: appliedAt
      };
      await this.atomicWrite(this.projectStateFile(changeSet.projectId), JSON.stringify(nextState, null, 2) + "\n");
      transaction = await this.advanceProjectTransaction(transaction, "state-committed");
      await this.writeChangeSet(appliedChangeSet);
      transaction = await this.advanceProjectTransaction(transaction, "completed");
    } catch (error) {
      const rollbackFailures: string[] = [];
      try {
        await this.atomicWrite(this.projectStateFile(changeSet.projectId), JSON.stringify(state, null, 2) + "\n");
      } catch {
        rollbackFailures.push("project-state");
      }
      for (const backup of [...backups].reverse()) {
        try {
          await this.restoreDocument(backup.target, backup.existed, backup.content);
        } catch {
          rollbackFailures.push(path.relative(source.root, backup.target));
        }
      }
      if (capturedRevision) {
        try {
          await this.removeCapturedRevision(capturedRevision);
        } catch {
          rollbackFailures.push("revision-history");
        }
      }
      if (!rollbackFailures.length) {
        try {
          await this.markTransactionRolledBack(transaction, changeSet, "文档提交期间发生错误，已恢复确认前状态；请重新检查 ChangeSet");
        } catch {
          rollbackFailures.push("transaction-journal");
        }
      }
      if (rollbackFailures.length) {
        throw new AppError(500, "transaction_rollback_failed", "提交失败且回滚不完整", { rollbackFailures });
      }
      throw error;
    }
    return {
      changeSet: appliedChangeSet,
      activeRevision: nextRevision,
      ...(document ? { document } : {}),
      ...(deletedDocumentPath ? { deletedDocumentPath } : {}),
      ...(graph ? { graph } : {})
    };
  }

  async createManagedSkill(workspaceId: string, input: unknown): Promise<Workspace> {
    this.assertId(workspaceId, "workspace");
    const validated = validateCreateManagedSkillInput(input);
    if (!validated.ok) throw new AppError(400, "validation_failed", "Skill 信息无效", validated.issues);

    return this.mutate(async () => {
      const workspace = await this.readWorkspace(workspaceId);
      const created = await this.writeManagedSkill(validated.value);

      if (workspace.members.some((member) => member.skillId === created.member.skillId)) {
        throw new AppError(409, "duplicate_skill_id", "Workspace 中已存在相同 skillId");
      }

      workspace.members.push(created.member);
      workspace.selectedProjectId = created.member.projectId;
      workspace.updatedAt = this.now().toISOString();
      await this.writeWorkspace(workspace);
      return workspace;
    });
  }

  async openInPlaceProject(workspaceId: string, input: unknown): Promise<Workspace> {
    this.assertId(workspaceId, "workspace");
    const record = plainRecord(input);
    if (typeof record.rootPath !== "string" || !record.rootPath.trim()) {
      throw new AppError(400, "root_path_required", "原地打开需要项目根路径");
    }
    const requestedRoot = path.resolve(record.rootPath.trim());
    let root: string;
    try {
      root = await realpath(requestedRoot);
      const info = await stat(root);
      if (!info.isDirectory()) throw new AppError(400, "project_root_not_directory", "项目根路径不是目录");
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "project_root_not_found", "项目根路径不存在");
      throw error;
    }
    if (root === path.parse(root).root) throw new AppError(403, "project_root_too_broad", "不能把文件系统根目录作为 Skill Project");

    return this.mutate(async () => {
      const workspace = await this.readWorkspace(workspaceId);
      let manifest: SkillManifest;
      let graph: SkillGraph;
      try {
        const [manifestFile, graphFile, skillDocument] = await Promise.all([
          lstat(path.join(root, "skill.json")),
          lstat(path.join(root, "graph", "main.json")),
          lstat(path.join(root, "SKILL.md"))
        ]);
        if (manifestFile.isSymbolicLink() || graphFile.isSymbolicLink() || skillDocument.isSymbolicLink()) {
          throw new AppError(403, "project_symlink_unsupported", "原地项目核心文件不接受符号链接");
        }
        const [manifestText, graphText] = await Promise.all([
          readFile(path.join(root, "skill.json"), "utf8"),
          readFile(path.join(root, "graph", "main.json"), "utf8")
        ]);
        if (!skillDocument.isFile()) throw new Error("SKILL.md is not a file");
        manifest = JSON.parse(manifestText) as SkillManifest;
        graph = JSON.parse(graphText) as SkillGraph;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(422, "in_place_format_invalid", "原地项目必须包含有效 SKILL.md、skill.json 和 graph/main.json");
      }
      if (
        !/^skill-[0-9a-f-]{36}$/i.test(manifest.skillId) || !manifest.name?.trim() || manifest.name.length > 120 ||
        (manifest.capability !== "workflow" && manifest.capability !== "content-only") ||
        graph.skillId !== manifest.skillId || graph.capability !== manifest.capability
      ) {
        throw new AppError(422, "in_place_identity_invalid", "原地项目的 Skill 身份或能力声明无效");
      }
      const lintErrors = lintGraph(graph).filter((issue) => issue.severity === "error");
      if (lintErrors.length) throw new AppError(422, "in_place_graph_invalid", "原地项目图校验失败", lintErrors);
      if (workspace.members.some((member) => member.skillId === manifest.skillId)) {
        throw new AppError(409, "duplicate_skill_id", "Workspace 中已存在相同 skillId");
      }

      const projectId = this.prefixedId("project");
      const source: ProjectSource = { projectId, skillId: manifest.skillId, mode: "in-place", root };
      const projectFiles = await this.walkProjectFiles(source, root);
      if (projectFiles.length > 2000) throw new AppError(413, "project_file_count_exceeded", "原地项目文件数不能超过 2000");
      let projectSize = 0;
      for (const file of projectFiles) {
        const info = await stat(file);
        if (info.size > 32 * 1024 * 1024) throw new AppError(413, "project_file_too_large", `原地项目单文件不能超过 32 MiB：${path.relative(root, file)}`);
        projectSize += info.size;
      }
      if (projectSize > 128 * 1024 * 1024) throw new AppError(413, "project_too_large", "原地项目总大小不能超过 128 MiB");

      const timestamp = this.now().toISOString();
      const revisionId = `rev-${timestamp.replace(/[-:.TZ]/g, "")}`;
      const projectStateDir = path.join(this.projectStateRoot(), projectId);
      try {
        await mkdir(projectStateDir, { recursive: true });
        await this.atomicWrite(path.join(projectStateDir, "source.json"), JSON.stringify(source, null, 2) + "\n");
        const revision = await this.captureProjectRevision(source, revisionId, null, "initial", timestamp);
        const state: ProjectState = {
          projectId,
          skillId: manifest.skillId,
          activeRevision: revisionId,
          currentSnapshotId: revision.snapshotId,
          createdAt: timestamp
        };
        const baseline: ProjectBaseline = {
          projectId,
          skillId: manifest.skillId,
          revisionId,
          snapshotId: revision.snapshotId,
          acknowledgedAt: timestamp
        };
        const gitStatus = await this.git.status(root, "in-place");
        await Promise.all([
          this.atomicWrite(this.projectStateFile(projectId), JSON.stringify(state, null, 2) + "\n"),
          this.atomicWrite(this.baselineFile(projectId), JSON.stringify(baseline, null, 2) + "\n")
        ]);
        workspace.members.push({
          projectId,
          skillId: manifest.skillId,
          displayName: manifest.name,
          capability: manifest.capability,
          mode: "in-place",
          sourcePath: root,
          status: "ready",
          order: workspace.members.length,
          activeRevision: revisionId,
          git: { available: gitStatus.capability.available, changedFiles: gitStatus.files.length },
          lint: {
            errors: 0,
            warnings: lintGraph(graph).filter((issue) => issue.severity === "warning").length
          },
          lastRunAt: null,
          createdAt: timestamp
        });
        workspace.selectedProjectId = projectId;
        workspace.updatedAt = timestamp;
        await this.writeWorkspace(workspace);
        return workspace;
      } catch (error) {
        await rm(projectStateDir, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async getProjectGitReferences(projectId: string) {
    this.assertId(projectId, "project");
    const source = await this.readProjectSource(projectId);
    return this.git.listReferences(source.root, source.mode);
  }

  async getProjectGitDiff(projectId: string, base = "HEAD"): Promise<GitDiffResult> {
    this.assertId(projectId, "project");
    const source = await this.readProjectSource(projectId);
    return this.git.compare(source.root, source.mode, base);
  }

  async selectProject(workspaceId: string, projectId: unknown): Promise<Workspace> {
    this.assertId(workspaceId, "workspace");
    if (typeof projectId !== "string") throw new AppError(400, "validation_failed", "projectId 无效");
    this.assertId(projectId, "project");

    return this.mutate(async () => {
      const workspace = await this.readWorkspace(workspaceId);
      const member = workspace.members.find((item) => item.projectId === projectId);
      if (!member) throw new AppError(404, "member_not_found", "Workspace 中不存在该 Skill");
      if (member.status !== "ready") throw new AppError(409, "member_not_ready", "该 Skill 当前不可选择");

      workspace.selectedProjectId = projectId;
      workspace.updatedAt = this.now().toISOString();
      await this.writeWorkspace(workspace);
      return workspace;
    });
  }

  async removeMember(workspaceId: string, projectId: string): Promise<Workspace> {
    this.assertId(workspaceId, "workspace");
    this.assertId(projectId, "project");

    return this.mutate(async () => {
      const workspace = await this.readWorkspace(workspaceId);
      const nextMembers = workspace.members.filter((member) => member.projectId !== projectId);
      if (nextMembers.length === workspace.members.length) {
        throw new AppError(404, "member_not_found", "Workspace 中不存在该 Skill");
      }
      workspace.members = nextMembers.map((member, index) => ({ ...member, order: index }));
      if (workspace.selectedProjectId === projectId) {
        workspace.selectedProjectId = workspace.members.find((member) => member.status === "ready")?.projectId ?? null;
      }
      workspace.updatedAt = this.now().toISOString();
      await this.writeWorkspace(workspace);
      return workspace;
    });
  }

  async reorderMembers(workspaceId: string, input: unknown): Promise<Workspace> {
    this.assertId(workspaceId, "workspace");
    const record = plainRecord(input);
    if (!Array.isArray(record.projectIds) || record.projectIds.some((value) => typeof value !== "string")) {
      throw new AppError(400, "member_order_invalid", "成员顺序必须是 projectId 数组");
    }
    const projectIds = record.projectIds as string[];
    for (const projectId of projectIds) this.assertId(projectId, "project");
    if (new Set(projectIds).size !== projectIds.length) {
      throw new AppError(400, "member_order_duplicate", "成员顺序不能包含重复 projectId");
    }

    return this.mutate(async () => {
      const workspace = await this.readWorkspace(workspaceId);
      const currentIds = new Set(workspace.members.map((member) => member.projectId));
      if (projectIds.length !== currentIds.size || projectIds.some((projectId) => !currentIds.has(projectId))) {
        throw new AppError(409, "member_order_mismatch", "成员顺序必须完整包含 Workspace 的当前成员");
      }
      const byId = new Map(workspace.members.map((member) => [member.projectId, member]));
      workspace.members = projectIds.map((projectId, order) => ({ ...byId.get(projectId)!, order }));
      workspace.updatedAt = this.now().toISOString();
      await this.writeWorkspace(workspace);
      return workspace;
    });
  }

  async repairMemberPath(workspaceId: string, projectId: string, input: unknown): Promise<Workspace> {
    this.assertId(workspaceId, "workspace");
    this.assertId(projectId, "project");
    const record = plainRecord(input);
    if (typeof record.rootPath !== "string" || !record.rootPath.trim()) {
      throw new AppError(400, "root_path_required", "修复路径需要项目根路径");
    }
    const requestedRoot = path.resolve(record.rootPath.trim());
    let root: string;
    try {
      root = await realpath(requestedRoot);
      if (!(await stat(root)).isDirectory()) throw new AppError(400, "project_root_not_directory", "项目根路径不是目录");
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "project_root_not_found", "项目根路径不存在");
      throw error;
    }
    if (root === path.parse(root).root) throw new AppError(403, "project_root_too_broad", "不能把文件系统根目录作为 Skill Project");

    return this.mutate(async () => {
      const workspace = await this.readWorkspace(workspaceId);
      const member = workspace.members.find((item) => item.projectId === projectId);
      if (!member) throw new AppError(404, "member_not_found", "Workspace 中不存在该 Skill");
      if (member.mode !== "in-place") throw new AppError(409, "member_repair_not_in_place", "只有原地打开的 Skill 可以修复路径");
      if (member.status !== "missing" && member.status !== "error") {
        throw new AppError(409, "member_repair_not_needed", "该 Skill 当前不需要修复路径");
      }

      let manifest: SkillManifest;
      let graph: SkillGraph;
      try {
        const [manifestText, graphText, skillDocument] = await Promise.all([
          readFile(path.join(root, "skill.json"), "utf8"),
          readFile(path.join(root, "graph", "main.json"), "utf8"),
          stat(path.join(root, "SKILL.md"))
        ]);
        if (!skillDocument.isFile()) throw new Error("SKILL.md is not a file");
        manifest = JSON.parse(manifestText) as SkillManifest;
        graph = JSON.parse(graphText) as SkillGraph;
      } catch {
        throw new AppError(422, "repair_format_invalid", "修复目录必须包含有效 SKILL.md、skill.json 和 graph/main.json");
      }
      if (manifest.skillId !== member.skillId || graph.skillId !== member.skillId || graph.capability !== manifest.capability) {
        throw new AppError(409, "repair_skill_identity_mismatch", "修复目录与 Workspace 中的 Skill 身份不一致");
      }
      const lintErrors = lintGraph(graph).filter((issue) => issue.severity === "error");
      if (lintErrors.length) throw new AppError(422, "repair_graph_invalid", "修复目录的图校验失败", lintErrors);

      const source: ProjectSource = { projectId, skillId: member.skillId, mode: "in-place", root };
      const projectFiles = await this.walkProjectFiles(source, root);
      if (projectFiles.length > 2000) throw new AppError(413, "project_file_count_exceeded", "原地项目文件数不能超过 2000");
      let projectSize = 0;
      for (const file of projectFiles) {
        const info = await stat(file);
        if (info.size > 32 * 1024 * 1024) throw new AppError(413, "project_file_too_large", `原地项目单文件不能超过 32 MiB：${path.relative(root, file)}`);
        projectSize += info.size;
      }
      if (projectSize > 128 * 1024 * 1024) throw new AppError(413, "project_too_large", "原地项目总大小不能超过 128 MiB");

      const state = await this.readProjectState(projectId);
      const revision = await this.readRevision(projectId, state.activeRevision);
      if (await this.computeProjectContentHash(source) !== revision.contentHash) {
        throw new AppError(409, "repair_content_mismatch", "修复目录内容与当前 Revision 不一致，请选择原项目目录或先恢复对应版本");
      }

      const sourceFile = path.join(this.projectStateRoot(), projectId, "source.json");
      const previousSource = await readFile(sourceFile, "utf8");
      await this.atomicWrite(sourceFile, JSON.stringify(source, null, 2) + "\n");
      try {
        member.sourcePath = root;
        member.status = "ready";
        delete member.statusDetail;
        workspace.updatedAt = this.now().toISOString();
        await this.writeWorkspace(workspace);
      } catch (error) {
        await this.atomicWrite(sourceFile, previousSource);
        throw error;
      }
      return workspace;
    });
  }

  private async writeManagedSkill(input: CreateManagedSkillInput): Promise<{ member: WorkspaceMember }> {
    const skillId = this.prefixedId("skill");
    const projectId = this.prefixedId("project");
    const root = path.join(this.managedProjectRoot(), projectId);
    const projectStateDir = path.join(this.projectStateRoot(), projectId);
    const timestamp = this.now().toISOString();
    const revision = `rev-${timestamp.replace(/[-:.TZ]/g, "")}`;
    const manifest: SkillManifest = {
      skillId,
      name: input.name,
      version: "0.1.0",
      description: input.description ?? "",
      capability: input.capability,
      ...(input.capability === "workflow" ? { entry: "flow.start" } : {})
    };
    const source: ProjectSource = { projectId, skillId, mode: "managed-copy", root };
    const graph = this.initialGraph(manifest);

    await Promise.all([
      mkdir(path.join(root, "graph"), { recursive: true }),
      mkdir(path.join(root, "docs"), { recursive: true }),
      mkdir(path.join(root, "benchmarks"), { recursive: true }),
      mkdir(projectStateDir, { recursive: true })
    ]);
    await Promise.all([
      this.atomicWrite(path.join(root, "skill.json"), JSON.stringify(manifest, null, 2) + "\n"),
      this.atomicWrite(path.join(root, "SKILL.md"), this.initialSkillDocument(manifest)),
      this.atomicWrite(path.join(root, "graph", "main.json"), JSON.stringify(graph, null, 2) + "\n"),
      this.atomicWrite(path.join(projectStateDir, "source.json"), JSON.stringify(source, null, 2) + "\n")
    ]);
    const projectRevision = await this.captureProjectRevision(source, revision, null, "initial", timestamp);
    const initialState: ProjectState = {
      projectId,
      skillId,
      activeRevision: revision,
      currentSnapshotId: projectRevision.snapshotId,
      createdAt: timestamp
    };
    const baseline: ProjectBaseline = {
      projectId,
      skillId,
      revisionId: revision,
      snapshotId: projectRevision.snapshotId,
      acknowledgedAt: timestamp
    };
    await Promise.all([
      this.atomicWrite(path.join(projectStateDir, "state.json"), JSON.stringify(initialState, null, 2) + "\n"),
      this.atomicWrite(this.baselineFile(projectId), JSON.stringify(baseline, null, 2) + "\n")
    ]);

    return {
      member: {
        projectId,
        skillId,
        displayName: input.name,
        capability: input.capability,
        mode: "managed-copy",
        sourcePath: root,
        status: "ready",
        order: 0,
        activeRevision: revision,
        git: { available: false, changedFiles: 0 },
        lint: { errors: 0, warnings: 0 },
        lastRunAt: null,
        createdAt: timestamp
      }
    };
  }

  private initialSkillDocument(manifest: SkillManifest): string {
    const description = manifest.description || "待补充 Skill 说明。";
    return `---\nname: ${manifest.name}\nversion: ${manifest.version}\n---\n\n# ${manifest.name}\n\n${description}\n`;
  }

  private initialGraph(manifest: SkillManifest): SkillGraph {
    if (manifest.capability === "content-only") {
      return {
        schemaVersion: "1.0",
        skillId: manifest.skillId,
        capability: "content-only",
        nodes: [
          {
            id: "knowledge.skill",
            kind: "knowledge",
            title: "SKILL.md",
            description: manifest.description || "Skill 主文档",
            doc: "SKILL.md",
            position: { x: 260, y: 180 }
          }
        ],
        edges: []
      };
    }
    return {
      schemaVersion: "1.0",
      skillId: manifest.skillId,
      capability: "workflow",
      entry: "flow.start",
      nodes: [
        { id: "flow.start", kind: "start", title: "开始", position: { x: 80, y: 180 } },
        {
          id: "flow.core-step",
          kind: "step",
          title: "核心步骤",
          description: manifest.description || "待补充节点内容",
          position: { x: 360, y: 180 }
        },
        { id: "flow.end", kind: "end", title: "完成", position: { x: 640, y: 180 } }
      ],
      edges: [
        { id: "edge.start-core", from: "flow.start", to: "flow.core-step", kind: "flow" },
        { id: "edge.core-end", from: "flow.core-step", to: "flow.end", kind: "flow" }
      ]
    };
  }

  private async readProjectSource(projectId: string): Promise<ProjectSource> {
    try {
      return JSON.parse(await readFile(path.join(this.projectStateRoot(), projectId, "source.json"), "utf8")) as ProjectSource;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AppError(404, "project_not_found", "Skill Project 不存在");
      }
      if (error instanceof SyntaxError) throw new AppError(500, "project_source_corrupt", "项目来源数据损坏");
      throw error;
    }
  }

  private async readProjectState(projectId: string): Promise<ProjectState> {
    try {
      return JSON.parse(await readFile(this.projectStateFile(projectId), "utf8")) as ProjectState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AppError(404, "project_state_not_found", "Skill Project 状态不存在");
      }
      if (error instanceof SyntaxError) throw new AppError(500, "project_state_corrupt", "项目状态数据损坏");
      throw error;
    }
  }

  private async readGraph(source: ProjectSource): Promise<SkillGraph> {
    const target = this.graphFile(source);
    try {
      await this.assertProjectReadPath(source, target);
      const graph = JSON.parse(await readFile(target, "utf8")) as SkillGraph;
      if (graph.skillId !== source.skillId) {
        throw new AppError(409, "skill_identity_mismatch", "图的 skillId 与项目身份不一致");
      }
      return graph;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AppError(404, "graph_not_found", "Skill 图文件不存在");
      }
      if (error instanceof SyntaxError) throw new AppError(500, "graph_corrupt", "Skill 图 JSON 损坏");
      throw error;
    }
  }

  private async readSkillManifest(source: ProjectSource): Promise<SkillManifest> {
    const target = path.join(source.root, "skill.json");
    try {
      await this.assertProjectReadPath(source, target);
      const manifest = JSON.parse(await readFile(target, "utf8")) as SkillManifest;
      if (manifest.skillId !== source.skillId) throw new AppError(409, "skill_identity_mismatch", "skill.json 的 skillId 与项目身份不一致");
      if (!manifest.name?.trim() || !manifest.version?.trim() || (manifest.capability !== "workflow" && manifest.capability !== "content-only")) {
        throw new AppError(422, "skill_manifest_invalid", "skill.json 的基础信息无效");
      }
      return manifest;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "skill_manifest_not_found", "skill.json 不存在");
      if (error instanceof SyntaxError) throw new AppError(500, "skill_manifest_corrupt", "skill.json 已损坏");
      throw error;
    }
  }

  private async lintDocumentBindings(
    source: ProjectSource,
    graph: SkillGraph,
    overrides = new Map<string, string>(),
    onlyDocumentPath?: string
  ): Promise<GraphLintIssue[]> {
    const issues: GraphLintIssue[] = [];
    for (const [index, node] of graph.nodes.entries()) {
      const documentPath = node.doc?.trim();
      const anchor = node.docAnchor?.trim();
      if (onlyDocumentPath !== undefined && documentPath !== onlyDocumentPath) continue;
      if (anchor && !documentPath) {
        issues.push({
          severity: "error",
          code: "document_anchor_without_document",
          message: `节点 ${node.id} 设置了标题路径，但没有关联文档`,
          path: `nodes[${index}].docAnchor`
        });
        continue;
      }
      if (!documentPath) continue;

      let target: string;
      try {
        target = this.resolveDocumentPath(source, documentPath);
      } catch (error) {
        issues.push({
          severity: "error",
          code: "referenced_document_path_invalid",
          message: `节点 ${node.id} 的文档路径无效`,
          path: `nodes[${index}].doc`
        });
        continue;
      }

      let content: string;
      if (overrides.has(documentPath)) {
        content = overrides.get(documentPath)!;
      } else {
        try {
          await this.assertProjectReadPath(source, target);
          content = await readFile(target, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          issues.push({
            severity: "error",
            code: "referenced_document_missing",
            message: `节点 ${node.id} 引用的文档 ${documentPath} 不存在`,
            path: `nodes[${index}].doc`
          });
          continue;
        }
      }

      if (!anchor) continue;
      const result = sliceDocument(content, anchor, false);
      if (result.status === "missing") {
        issues.push({
          severity: "error",
          code: "document_anchor_missing",
          message: `节点 ${node.id} 在 ${documentPath} 中找不到标题路径或锚点 ${anchor}`,
          path: `nodes[${index}].docAnchor`
        });
      } else if (result.status === "ambiguous") {
        issues.push({
          severity: "error",
          code: "document_anchor_ambiguous",
          message: `节点 ${node.id} 的文档锚点 ${anchor} 不唯一：${result.candidates.map((candidate) => candidate.path).join("、")}`,
          path: `nodes[${index}].docAnchor`
        });
      }
    }
    return issues;
  }

  private async enrichDocumentDiagnosisRepairs(imported: ImportedBugReport, diagnosis: DiagnosisRecord): Promise<void> {
    const projectId = imported.match.matchedProjectId;
    if (imported.match.status !== "matched" || !projectId) return;
    const [revision, source] = await Promise.all([
      this.getRevisionStatus(projectId),
      this.readProjectSource(projectId)
    ]);
    if (revision.activeRevision.contentHash !== imported.report.skill.contentHash) return;
    const graph = await this.readGraph(source);
    const issues = await this.lintDocumentBindings(source, graph);

    for (const candidate of diagnosis.candidates) {
      if (candidate.category !== "document-context") continue;
      const seq = candidate.evidence.find((item) => item.source === "trace" && item.seq !== undefined)?.seq;
      const event = imported.report.trace.find((item) => item.seq === seq && item.type === "document.context");
      if (!event?.nodeId || typeof event.data.path !== "string") continue;
      const nodeIndex = graph.nodes.findIndex((node) => node.id === event.nodeId);
      if (nodeIndex < 0) continue;
      const node = graph.nodes[nodeIndex]!;
      const eventAnchor = typeof event.data.anchor === "string" ? event.data.anchor.trim() : "";
      if (node.doc?.trim() !== event.data.path.trim() || (node.docAnchor?.trim() ?? "") !== eventAnchor) continue;
      const relevantIssues = issues.filter((issue) => issue.path === `nodes[${nodeIndex}].doc` || issue.path === `nodes[${nodeIndex}].docAnchor`);
      if (!relevantIssues.length) continue;
      const { doc: _document, docAnchor: _anchor, ...withoutBinding } = structuredClone(node);
      candidate.repair = {
        kind: "graph.remove-document-binding",
        title: `移除节点 ${node.id} 的不可用文档绑定`,
        operation: { op: "graph.node.update", target: node.id, value: withoutBinding }
      };
      candidate.evidence.push({
        source: "graph",
        nodeId: node.id,
        field: relevantIssues[0]!.path,
        fact: `当前项目复核仍失败：${relevantIssues.map((issue) => issue.message).join("；")}`
      });
    }
  }

  private async assertDocumentDiagnosisRepairCurrent(
    projectId: string,
    imported: ImportedBugReport,
    candidate: DiagnosisRecord["candidates"][number]
  ): Promise<void> {
    if (candidate.repair?.kind !== "graph.remove-document-binding") return;
    const seq = candidate.evidence.find((item) => item.source === "trace" && item.seq !== undefined)?.seq;
    const event = imported.report.trace.find((item) => item.seq === seq && item.type === "document.context");
    const source = await this.readProjectSource(projectId);
    const graph = await this.readGraph(source);
    const nodeIndex = graph.nodes.findIndex((node) => node.id === candidate.repair!.operation.target);
    const node = nodeIndex >= 0 ? graph.nodes[nodeIndex] : undefined;
    const eventAnchor = typeof event?.data.anchor === "string" ? event.data.anchor.trim() : "";
    if (!event?.nodeId || event.nodeId !== node?.id || typeof event.data.path !== "string"
      || node.doc?.trim() !== event.data.path.trim() || (node.docAnchor?.trim() ?? "") !== eventAnchor) {
      throw new AppError(409, "repair_document_binding_changed", "当前节点文档绑定已与诊断证据不同，请重新运行并分析");
    }
    const issues = await this.lintDocumentBindings(source, graph);
    const remainsInvalid = issues.some((issue) => issue.path === `nodes[${nodeIndex}].doc` || issue.path === `nodes[${nodeIndex}].docAnchor`);
    const { doc: _document, docAnchor: _anchor, ...withoutBinding } = structuredClone(node);
    if (!remainsInvalid || JSON.stringify(withoutBinding) !== JSON.stringify(candidate.repair.operation.value)) {
      throw new AppError(409, "repair_document_binding_changed", "当前节点文档绑定已恢复或发生变化，请重新运行并分析");
    }
  }

  private rewriteDocumentReferences(graph: SkillGraph, from: string, to: string | null): SkillGraph {
    return {
      ...structuredClone(graph),
      nodes: graph.nodes.map((node) => {
        if (node.doc !== from) return structuredClone(node);
        if (to) return { ...structuredClone(node), doc: to };
        const { doc: _document, docAnchor: _anchor, ...withoutBinding } = structuredClone(node);
        return withoutBinding;
      })
    };
  }

  private graphFile(source: ProjectSource): string {
    const target = path.resolve(source.root, "graph", "main.json");
    this.assertProjectPath(source, target);
    return target;
  }

  private resolveDocumentPath(source: ProjectSource, relativePath: string): string {
    if (typeof relativePath !== "string" || !isSkillDocumentPath(relativePath)) {
      throw new AppError(400, "invalid_document_path", "文档路径无效");
    }
    const target = path.resolve(source.root, ...relativePath.split("/"));
    this.assertProjectPath(source, target);
    return target;
  }

  private normalizeAssetPath(relativePath: string): string {
    const normalized = typeof relativePath === "string" ? relativePath.normalize("NFC") : "";
    const segments = normalized.split("/");
    const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
    if (
      !normalized || normalized.length > 240 || normalized.includes("\\") || normalized.startsWith("/") ||
      segments.length < 2 || segments[0] !== "assets" ||
      segments.some((segment) => !segment || segment === "." || segment === ".." || segment.length > 120 ||
        /[\u0000-\u001f<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment) || reserved.test(segment)) ||
      path.posix.normalize(normalized) !== normalized
    ) {
      throw new AppError(400, "asset_path_invalid", "资产路径必须位于 assets/，并使用 Windows、macOS、Linux 均可用的相对路径");
    }
    return normalized;
  }

  private resolveAssetPath(source: ProjectSource, relativePath: string): string {
    const normalized = this.normalizeAssetPath(relativePath);
    const target = path.resolve(source.root, ...normalized.split("/"));
    this.assertProjectPath(source, target);
    return target;
  }

  private decodeAssetContent(contentBase64: string): Buffer {
    const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
    if (!contentBase64 || !canonicalBase64.test(contentBase64)) {
      throw new AppError(400, "asset_content_invalid", "资产内容不是规范 Base64");
    }
    const content = Buffer.from(contentBase64, "base64");
    if (content.toString("base64") !== contentBase64) {
      throw new AppError(400, "asset_content_invalid", "资产内容不是规范 Base64");
    }
    if (content.length > 2 * 1024 * 1024) {
      throw new AppError(413, "asset_too_large", "单个资产不能超过 2 MiB");
    }
    return content;
  }

  private assetFact(relativePath: string, content: Buffer): AssetFileFact {
    const extension = path.posix.extname(relativePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".txt": "text/plain"
    };
    return {
      path: relativePath,
      size: content.length,
      sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      mimeType: mimeTypes[extension] ?? "application/octet-stream"
    };
  }

  private async allAssetReferences(source: ProjectSource): Promise<Array<AssetReferenceImpact & { target: string }>> {
    const files = await this.walkProjectFiles(source, source.root);
    const inventory = await Promise.all(files.map(async (file) => {
      const relative = path.relative(source.root, file).split(path.sep).join("/").normalize("NFC");
      return /\.md$/iu.test(relative)
        ? { path: relative, content: await readFile(file, "utf8") }
        : { path: relative };
    }));
    return analyzeImportAssets(inventory).references.flatMap((reference) => {
      if (!reference.normalizedTarget?.startsWith("assets/")) return [];
      return [{
        target: reference.normalizedTarget,
        sourcePath: reference.sourcePath,
        startLine: reference.startLine,
        kind: reference.kind,
        rawTarget: reference.rawTarget
      }];
    }).sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.startLine - right.startLine);
  }

  private async assetReferences(source: ProjectSource, relativePath: string): Promise<AssetReferenceImpact[]> {
    return (await this.allAssetReferences(source))
      .filter((reference) => reference.target === relativePath)
      .map(({ target: _target, ...reference }) => reference);
  }

  private benchmarkCaseDir(source: ProjectSource): string {
    const target = path.resolve(source.root, "benchmarks", "cases");
    this.assertProjectPath(source, target);
    return target;
  }

  private benchmarkCaseFile(source: ProjectSource, caseId: string): string {
    this.assertBenchmarkCaseId(caseId);
    const target = path.resolve(this.benchmarkCaseDir(source), `${caseId}.json`);
    this.assertProjectPath(source, target);
    return target;
  }

  private benchmarkCaseRelativePath(caseId: string): string {
    this.assertBenchmarkCaseId(caseId);
    return `benchmarks/cases/${caseId}.json`;
  }

  private parseSkillImportInput(value: unknown): { folderName: string; files: ParsedImportFile[] } {
    const record = plainRecord(value) as Partial<CreateSkillImportInput>;
    if (typeof record.folderName !== "string" || !Array.isArray(record.files)) {
      throw new AppError(400, "invalid_import_payload", "导入目录信息不完整");
    }
    const folderName = record.folderName.trim().normalize("NFC").slice(0, 120);
    if (!folderName) throw new AppError(400, "invalid_import_folder", "导入目录名称无效");
    if (!record.files.length || record.files.length > 500) {
      throw new AppError(413, "import_file_count_invalid", "导入文件数量必须在 1 到 500 之间");
    }
    const seen = new Set<string>();
    const files: ParsedImportFile[] = [];
    let totalSize = 0;
    for (const raw of record.files as unknown[]) {
      if (typeof raw !== "object" || raw === null) throw new AppError(400, "invalid_import_file", "导入文件结构无效");
      const item = raw as Record<string, unknown>;
      if (typeof item.path !== "string" || typeof item.contentBase64 !== "string") {
        throw new AppError(400, "invalid_import_file", "导入文件缺少路径或内容");
      }
      const filePath = this.normalizeImportPath(item.path);
      const lowerSegments = filePath.split("/").map((segment) => segment.toLowerCase());
      if (lowerSegments.includes(".git") || path.posix.basename(filePath).toLowerCase() === ".ds_store") continue;
      const collisionKey = filePath.toLowerCase();
      if (seen.has(collisionKey)) throw new AppError(400, "duplicate_import_path", `导入目录包含跨系统冲突路径：${filePath}`);
      seen.add(collisionKey);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(item.contentBase64)) throw new AppError(400, "invalid_base64", `文件内容编码无效：${filePath}`);
      const content = Buffer.from(item.contentBase64, "base64");
      if (content.toString("base64").replace(/=+$/u, "") !== item.contentBase64.replace(/=+$/u, "")) {
        throw new AppError(400, "invalid_base64", `文件内容编码无效：${filePath}`);
      }
      if (content.length > 2 * 1024 * 1024) throw new AppError(413, "import_file_too_large", `单个文件不能超过 2 MiB：${filePath}`);
      totalSize += content.length;
      if (totalSize > 16 * 1024 * 1024) throw new AppError(413, "import_too_large", "导入目录总大小不能超过 16 MiB");
      files.push({ path: filePath, content });
    }
    if (!files.length) throw new AppError(400, "import_files_required", "导入目录没有可用文件");
    return { folderName, files: files.sort((left, right) => left.path.localeCompare(right.path)) };
  }

  private normalizeImportPath(value: string): string {
    const normalized = value.replace(/\\/g, "/").normalize("NFC");
    if (normalized.startsWith("/") || normalized.length > 500) throw new AppError(400, "invalid_import_path", "导入文件路径无效");
    const segments = normalized.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment))) {
      throw new AppError(400, "invalid_import_path", `导入文件路径无效：${value}`);
    }
    const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
    if (segments.some((segment) => reserved.test(segment))) throw new AppError(400, "windows_reserved_path", `路径在 Windows 上不可用：${value}`);
    return segments.join("/");
  }

  private parseImportReviewInput(value: unknown): UpdateSkillImportReviewInput {
    const record = plainRecord(value);
    if (
      typeof record.workspaceId !== "string" ||
      typeof record.reviewRevision !== "number" ||
      !Number.isInteger(record.reviewRevision) ||
      !Array.isArray(record.nodes) ||
      !Array.isArray(record.edges) ||
      (record.entry !== undefined && typeof record.entry !== "string")
    ) {
      throw new AppError(400, "invalid_import_review", "解析审阅信息不完整");
    }
    this.assertId(record.workspaceId, "workspace");
    const parseCandidate = (raw: unknown, label: string) => {
      const item = plainRecord(raw);
      if (
        typeof item.candidateId !== "string" ||
        (item.decision !== "accepted" && item.decision !== "rejected") ||
        typeof item.value !== "object" || item.value === null
      ) {
        throw new AppError(400, "invalid_import_review", `${label}候选结构无效`);
      }
      return item;
    };
    const nodes = record.nodes.map((item, index) => parseCandidate(item, `nodes[${index}]`)) as unknown as UpdateSkillImportReviewInput["nodes"];
    const edges = record.edges.map((item, index) => parseCandidate(item, `edges[${index}]`)) as unknown as UpdateSkillImportReviewInput["edges"];
    return {
      workspaceId: record.workspaceId,
      reviewRevision: record.reviewRevision,
      ...(record.entry ? { entry: record.entry } : {}),
      nodes,
      edges
    };
  }

  private parseImportReparseResolution(value: unknown): ResolveImportReparseInput {
    const record = plainRecord(value);
    if (
      typeof record.workspaceId !== "string" ||
      typeof record.reviewRevision !== "number" ||
      !Number.isInteger(record.reviewRevision) ||
      (record.choice !== "manual" && record.choice !== "reparse")
    ) {
      throw new AppError(400, "invalid_import_reparse_resolution", "重新解析裁决信息不完整");
    }
    this.assertId(record.workspaceId, "workspace");
    return record as unknown as ResolveImportReparseInput;
  }

  private assertMutableImportReview(candidate: SkillImportCandidate, workspaceId: string, reviewRevision: number): void {
    if (candidate.workspaceId !== workspaceId) throw new AppError(403, "import_workspace_mismatch", "导入候选不属于指定 Workspace");
    if (candidate.status !== "proposed") throw new AppError(409, "import_not_proposed", "导入候选已处理");
    if (candidate.parseReview.reviewRevision !== reviewRevision) {
      throw new AppError(409, "import_review_changed", "解析审阅已变化，请刷新后重试");
    }
  }

  private importReviewSnapshot(review: SkillImportReviewSnapshot): SkillImportReviewSnapshot {
    return {
      capability: review.capability,
      ...(review.entry ? { entry: review.entry } : {}),
      nodes: structuredClone(review.nodes),
      edges: structuredClone(review.edges),
      unresolvedQuestions: structuredClone(review.unresolvedQuestions),
      lint: structuredClone(review.lint)
    };
  }

  private importReviewChanged(before: SkillImportReviewSnapshot, after: SkillImportReviewSnapshot): boolean {
    return JSON.stringify(this.importReviewSnapshot(before)) !== JSON.stringify(this.importReviewSnapshot(after));
  }

  private skillImportDigest(candidate: SkillImportCandidate): string {
    const { digest: _digest, status: _status, confirmedAt: _confirmedAt, ...reviewedCandidate } = candidate;
    return createHash("sha256").update(JSON.stringify(reviewedCandidate)).digest("hex");
  }

  private async persistImportReview(candidate: SkillImportCandidate, review: SkillImportParseReview): Promise<SkillImportCandidate> {
    const workspace = await this.readWorkspace(candidate.workspaceId);
    const member = workspace.members.find((item) => item.projectId === candidate.projectId && item.status === "pending-import");
    if (!member) throw new AppError(409, "pending_member_missing", "Workspace 中的待确认成员不存在");
    const next: SkillImportCandidate = { ...candidate, capability: review.capability, parseReview: review, digest: "" };
    next.digest = this.skillImportDigest(next);
    member.capability = next.capability;
    member.lint = {
      errors: next.diagnostics.filter((item) => item.severity === "error").length + review.lint.filter((item) => item.severity === "error").length,
      warnings: next.diagnostics.filter((item) => item.severity === "warning").length + review.lint.filter((item) => item.severity === "warning").length
    };
    workspace.updatedAt = this.now().toISOString();
    await Promise.all([this.writeImportCandidate(next), this.writeWorkspace(workspace)]);
    return next;
  }

  private buildImportProvenance(folderName: string, inspected: InspectedImport, review: SkillImportParseReview): ImportProvenanceRecord[] {
    const records: Array<Omit<ImportProvenanceRecord, "provenanceId">> = [];
    const add = (record: Omit<ImportProvenanceRecord, "provenanceId">) => records.push(record);
    if (inspected.manifest) {
      add({ subject: "detected-format", valueSummary: "Skill Designer", sourcePath: "skill.json", startLine: 1, endLine: 1, method: "native-manifest", confidence: "high" });
      add({ subject: "display-name", valueSummary: inspected.displayName, sourcePath: "skill.json", startLine: 1, endLine: 1, method: "native-manifest", confidence: "high" });
      add({ subject: "description", valueSummary: inspected.description || "（空说明）", sourcePath: "skill.json", startLine: 1, endLine: 1, method: "native-manifest", confidence: "high" });
    } else {
      const formatSource = inspected.frontmatter ?? { startLine: 1, endLine: 1 };
      add({
        subject: "detected-format",
        valueSummary: inspected.frontmatter ? `${inspected.frontmatter.dialect.toUpperCase()} frontmatter Skill` : "Markdown Skill",
        sourcePath: "SKILL.md",
        startLine: formatSource.startLine,
        endLine: formatSource.endLine,
        method: inspected.frontmatter ? "frontmatter" : "markdown-heading",
        confidence: inspected.frontmatter?.status === "valid" ? "high" : "medium"
      });
      if (inspected.identity.name) {
        const evidence = inspected.identity.name;
        add({ subject: "display-name", valueSummary: inspected.displayName, sourcePath: evidence.sourcePath, startLine: evidence.startLine, endLine: evidence.endLine, method: evidence.method, confidence: evidence.method === "frontmatter" ? "high" : "medium" });
      } else {
        add({ subject: "display-name", valueSummary: inspected.displayName || folderName, sourcePath: ".", startLine: 1, endLine: 1, method: "folder-name", confidence: "low" });
      }
      if (inspected.identity.description) {
        const evidence = inspected.identity.description;
        add({ subject: "description", valueSummary: inspected.description, sourcePath: evidence.sourcePath, startLine: evidence.startLine, endLine: evidence.endLine, method: evidence.method, confidence: evidence.method === "frontmatter" ? "high" : "medium" });
      } else {
        add({ subject: "description", valueSummary: "（未提取到说明）", sourcePath: "SKILL.md", startLine: 1, endLine: 1, method: "conservative-fallback", confidence: "low" });
      }
    }

    if (inspected.graph) {
      add({ subject: "capability", valueSummary: inspected.graph.capability, sourcePath: "graph/main.json", startLine: 1, endLine: 1, method: "native-graph", confidence: "high" });
      add({ subject: "graph", valueSummary: `${inspected.graph.nodes.length} 个节点 · ${inspected.graph.edges.length} 条关系`, sourcePath: "graph/main.json", startLine: 1, endLine: 1, method: "native-graph", confidence: "high" });
    } else if (inspected.manifest) {
      add({ subject: "capability", valueSummary: inspected.manifest.capability, sourcePath: "skill.json", startLine: 1, endLine: 1, method: "native-manifest", confidence: "high" });
    } else {
      const evidence = review.nodes.find((node) => node.value.kind !== "start" && node.value.kind !== "end")?.evidence[0] ?? review.nodes[0]?.evidence[0];
      add({
        subject: "capability",
        valueSummary: review.capability,
        sourcePath: evidence?.path ?? "SKILL.md",
        startLine: evidence?.startLine ?? 1,
        endLine: evidence?.endLine ?? 1,
        method: review.capability === "workflow" ? "static-inference" : "conservative-fallback",
        confidence: review.capability === "workflow" ? "medium" : "low"
      });
      add({
        subject: "graph",
        valueSummary: `${review.nodes.length} 个候选节点 · ${review.edges.length} 条候选关系`,
        sourcePath: evidence?.path ?? "SKILL.md",
        startLine: evidence?.startLine ?? 1,
        endLine: evidence?.endLine ?? 1,
        method: review.capability === "workflow" ? "static-inference" : "conservative-fallback",
        confidence: review.capability === "workflow" ? "medium" : "low"
      });
    }
    return records.map((record, index) => ({ provenanceId: `provenance-${String(index + 1).padStart(3, "0")}`, ...record }));
  }

  private inspectImportFiles(folderName: string, files: ParsedImportFile[]): InspectedImport {
    const byPath = new Map(files.map((file) => [file.path, file]));
    const assetAnalysis = analyzeImportAssets(files.map((file) => ({
      path: file.path,
      ...(this.importFileKind(file.path) === "markdown" ? { content: file.content.toString("utf8") } : {})
    })));
    const diagnostics: SkillImportCandidate["diagnostics"] = [...assetAnalysis.diagnostics];
    const formatSignals = [...assetAnalysis.formatSignals];
    let manifest: SkillManifest | undefined;
    let graph: SkillGraph | undefined;
    const manifestFile = byPath.get("skill.json");
    if (manifestFile) {
      try {
        const value = JSON.parse(manifestFile.content.toString("utf8")) as Partial<SkillManifest>;
        if (
          typeof value.skillId !== "string" || !/^skill-[0-9a-f-]{36}$/i.test(value.skillId) ||
          typeof value.name !== "string" || !value.name.trim() || value.name.length > 120 ||
          typeof value.version !== "string" || typeof value.description !== "string" ||
          (value.capability !== "workflow" && value.capability !== "content-only")
        ) {
          diagnostics.push({ severity: "error", code: "invalid_skill_manifest", message: "skill.json 缺少有效的稳定身份或能力声明", path: "skill.json" });
        } else {
          manifest = value as SkillManifest;
          formatSignals.unshift({ code: "native-manifest", path: "skill.json", confidence: "high", message: "发现有效的 Skill Designer manifest" });
        }
      } catch {
        diagnostics.push({ severity: "error", code: "invalid_skill_manifest_json", message: "skill.json 不是有效 JSON", path: "skill.json" });
      }
    }

    const graphFile = byPath.get("graph/main.json");
    if (graphFile) {
      try {
        graph = JSON.parse(graphFile.content.toString("utf8")) as SkillGraph;
        if (!manifest) {
          diagnostics.push({ severity: "error", code: "graph_without_manifest", message: "已有 graph/main.json 但缺少有效 skill.json，不能安全重写身份", path: "graph/main.json" });
        } else {
          if (graph.skillId !== manifest.skillId || graph.capability !== manifest.capability) {
            diagnostics.push({ severity: "error", code: "graph_identity_mismatch", message: "图的 skillId 或 capability 与 skill.json 不一致", path: "graph/main.json" });
          }
          diagnostics.push(...lintGraph(graph).map((issue) => ({
            severity: issue.severity,
            code: issue.code,
            message: issue.message,
            ...(issue.path ? { path: issue.path } : {})
          })));
          formatSignals.push({ code: "native-graph", path: "graph/main.json", confidence: "high", message: "发现可校验的原生 SkillGraph" });
        }
      } catch {
        graph = undefined;
        diagnostics.push({ severity: "error", code: "invalid_graph_json", message: "graph/main.json 不是有效 JSON", path: "graph/main.json" });
      }
    } else if (manifest?.capability === "workflow") {
      diagnostics.push({ severity: "error", code: "workflow_graph_missing", message: "工作流 Skill 缺少 graph/main.json", path: "graph/main.json" });
    }

    const skillDocument = byPath.get("SKILL.md");
    if (!skillDocument) diagnostics.push({ severity: "error", code: "skill_document_missing", message: "导入目录必须包含根级 SKILL.md", path: "SKILL.md" });
    const markdown = skillDocument?.content.toString("utf8") ?? "";
    const displayName = manifest?.name.trim() || assetAnalysis.identity.name?.value || folderName;
    const description = manifest?.description ?? assetAnalysis.identity.description?.value ?? "";
    const capability = manifest?.capability ?? "content-only";
    const generatedFiles = [!manifestFile ? "skill.json" : null, !graphFile ? "graph/main.json" : null].filter((value): value is string => Boolean(value));
    const scriptCount = files.filter((file) => this.importFileKind(file.path) === "script").length;
    if (scriptCount) diagnostics.push({ severity: "warning", code: "scripts_not_executed", message: `保留 ${scriptCount} 个脚本文件；导入过程不会执行它们` });
    return {
      ...(manifest ? { manifest } : {}),
      ...(graph && manifest ? { graph } : {}),
      ...(assetAnalysis.frontmatter ? { frontmatter: assetAnalysis.frontmatter } : {}),
      markdown,
      identity: assetAnalysis.identity,
      displayName: displayName.slice(0, 120),
      description: description.slice(0, 1000),
      capability,
      generatedFiles,
      diagnostics,
      references: assetAnalysis.references,
      formatSignals
    };
  }

  private importFileKind(filePath: string): SkillImportCandidate["files"][number]["kind"] {
    const extension = path.posix.extname(filePath).toLowerCase();
    if (extension === ".md") return "markdown";
    if (extension === ".json") return "json";
    if ([".yaml", ".yml", ".toml"].includes(extension)) return "config";
    if ([".txt", ".csv", ".log"].includes(extension)) return "text";
    if ([".js", ".mjs", ".cjs", ".ts", ".sh", ".ps1", ".py", ".rb"].includes(extension)) return "script";
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp3", ".wav", ".mp4", ".webm", ".pdf", ".docx", ".xlsx", ".pptx", ".zip"].includes(extension)) return "asset";
    return "unknown";
  }

  private async writeImportGeneratedFiles(source: ProjectSource, candidate: SkillImportCandidate): Promise<void> {
    const graph = importReviewGraph(candidate.skillId, candidate.parseReview);
    const manifest: SkillManifest = {
      skillId: candidate.skillId,
      name: candidate.displayName,
      version: "0.1.0",
      description: candidate.description,
      capability: candidate.capability,
      ...(candidate.capability === "workflow" && graph.entry ? { entry: graph.entry } : {})
    };
    if (candidate.generatedFiles.includes("skill.json")) {
      await this.atomicWrite(path.join(source.root, "skill.json"), JSON.stringify(manifest, null, 2) + "\n");
    }
    if (candidate.generatedFiles.includes("graph/main.json") || candidate.parseReview.manuallyEdited) {
      await mkdir(path.join(source.root, "graph"), { recursive: true });
      await this.atomicWrite(path.join(source.root, "graph", "main.json"), JSON.stringify(graph, null, 2) + "\n");
    }
  }

  private parseChangeSetInput(value: unknown): CreateChangeSetInput {
    const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    if (
      typeof record.workspaceId !== "string" ||
      typeof record.baseRevision !== "string" ||
      typeof record.reason !== "string" ||
      !Array.isArray(record.operations)
    ) {
      throw new AppError(400, "invalid_changeset", "ChangeSet 信息不完整");
    }
    this.assertId(record.workspaceId, "workspace");
    if (record.operations.length > 1000) throw new AppError(413, "too_many_operations", "单个 ChangeSet 操作数不能超过 1000");
    const operations: ChangeOperation[] = record.operations.map((operation, index) => {
      const item = typeof operation === "object" && operation !== null ? operation as Record<string, unknown> : {};
      if (typeof item.op !== "string" || typeof item.target !== "string") {
        throw new AppError(400, "invalid_operation", `operations[${index}] 缺少 op 或 target`);
      }
      if (item.op === "docs.write") {
        if (typeof item.value !== "string") throw new AppError(400, "invalid_operation", `operations[${index}] 文档内容无效`);
        if (Buffer.byteLength(item.value, "utf8") > 1024 * 1024) {
          throw new AppError(413, "document_too_large", "单个文档不能超过 1 MiB");
        }
        return { op: "docs.write", target: item.target, value: item.value };
      }
      if (item.op === "docs.rename") {
        if (typeof item.value !== "string") throw new AppError(400, "invalid_operation", `operations[${index}] 目标文档路径无效`);
        return { op: "docs.rename", target: item.target, value: item.value };
      }
      if (item.op === "docs.delete") {
        if (item.value !== undefined) throw new AppError(400, "invalid_operation", `operations[${index}] 删除文档不能携带 value`);
        return { op: "docs.delete", target: item.target };
      }
      if (item.op === "asset.copy") {
        const target = this.normalizeAssetPath(item.target);
        const value = plainRecord(item.value);
        if (Object.keys(value).some((key) => key !== "contentBase64") || typeof value.contentBase64 !== "string") {
          throw new AppError(400, "asset_content_invalid", `operations[${index}] 的资产内容无效`);
        }
        this.decodeAssetContent(value.contentBase64);
        return { op: "asset.copy", target, value: { contentBase64: value.contentBase64 } };
      }
      if (item.op === "asset.delete") {
        const target = this.normalizeAssetPath(item.target);
        if (item.value !== undefined) throw new AppError(400, "invalid_operation", `operations[${index}] 删除资产不能携带 value`);
        return { op: "asset.delete", target };
      }
      if (item.op === "benchmark.case.delete") {
        this.assertBenchmarkCaseId(item.target);
        return { op: item.op, target: item.target };
      }
      if (item.op === "benchmark.case.write") {
        this.assertBenchmarkCaseId(item.target);
        const benchmarkCase = plainRecord(item.value) as unknown as BenchmarkCase;
        if (benchmarkCase.caseId !== item.target) {
          throw new AppError(400, "benchmark_case_target_mismatch", `operations[${index}] 的 caseId 与 target 不一致`);
        }
        if (Buffer.byteLength(JSON.stringify(benchmarkCase), "utf8") > 512 * 1024) {
          throw new AppError(413, "benchmark_case_too_large", "单个测试用例不能超过 512 KiB");
        }
        return { op: item.op, target: item.target, value: benchmarkCase };
      }
      if (item.op === "skill.update") {
        if (item.target !== "skill.json") throw new AppError(400, "skill_manifest_target_invalid", `operations[${index}] 必须指向 skill.json`);
        const update = plainRecord(item.value);
        const name = typeof update.name === "string" ? update.name.trim() : "";
        const version = typeof update.version === "string" ? update.version.trim() : "";
        const description = typeof update.description === "string" ? update.description.trim() : "";
        if (!name || name.length > 120 || !version || version.length > 50 || /[\r\n\u0000-\u001f]/u.test(version) || description.length > 4000) {
          throw new AppError(400, "skill_manifest_update_invalid", `operations[${index}] 的 Skill 信息无效`);
        }
        if (Object.keys(update).some((key) => !["name", "version", "description"].includes(key))) {
          throw new AppError(400, "skill_manifest_field_protected", `operations[${index}] 不能修改 Skill 身份、能力或入口`);
        }
        return { op: "skill.update", target: "skill.json", value: { name, version, description } };
      }
      if (item.op === "graph.node.delete" || item.op === "graph.edge.delete") {
        return { op: item.op, target: item.target };
      }
      if (item.op === "graph.node.create" || item.op === "graph.node.update") {
        return { op: item.op, target: item.target, value: this.parseGraphNode(item.value, item.target, index) };
      }
      if (item.op === "graph.edge.create" || item.op === "graph.edge.update") {
        return { op: item.op, target: item.target, value: this.parseGraphEdge(item.value, item.target, index) };
      }
      throw new AppError(400, "operation_not_allowed", `operations[${index}] 的操作类型不在白名单中`);
    });
    if (!operations.length) throw new AppError(400, "operations_required", "ChangeSet 至少需要一个操作");
    return {
      workspaceId: record.workspaceId,
      baseRevision: record.baseRevision,
      reason: record.reason.trim().slice(0, 500) || "编辑 Skill",
      source: this.parseChangeSetSource(record.source),
      evidence: this.parseChangeSetEvidence(record.evidence),
      operations
    };
  }

  private parseChangeSetSource(value: unknown): NonNullable<CreateChangeSetInput["source"]> {
    if (value === undefined) return { kind: "manual", label: "Studio 手工编辑" };
    const record = plainRecord(value);
    const kinds = new Set(["manual", "assistant", "diagnosis", "report", "runtime", "import", "system", "legacy"]);
    if (typeof record.kind !== "string" || !kinds.has(record.kind)) throw new AppError(400, "changeset_source_invalid", "ChangeSet 来源类型无效");
    if (record.sourceId !== undefined && (typeof record.sourceId !== "string" || !record.sourceId.trim() || record.sourceId.length > 200)) {
      throw new AppError(400, "changeset_source_invalid", "ChangeSet 来源 ID 无效");
    }
    if (record.label !== undefined && (typeof record.label !== "string" || !record.label.trim() || record.label.length > 120)) {
      throw new AppError(400, "changeset_source_invalid", "ChangeSet 来源说明无效");
    }
    return {
      kind: record.kind as NonNullable<CreateChangeSetInput["source"]>["kind"],
      ...(typeof record.sourceId === "string" ? { sourceId: record.sourceId.trim() } : {}),
      ...(typeof record.label === "string" ? { label: record.label.trim() } : {})
    };
  }

  private parseChangeSetEvidence(value: unknown): NonNullable<CreateChangeSetInput["evidence"]> {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20) throw new AppError(400, "changeset_evidence_invalid", "ChangeSet 证据必须是不超过 20 项的数组");
    const kinds = new Set(["user-request", "project-fact", "document", "graph", "trace", "diagnosis", "report", "runtime"]);
    return value.map((item, index) => {
      const record = plainRecord(item);
      if (typeof record.kind !== "string" || !kinds.has(record.kind) || typeof record.ref !== "string" || !record.ref.trim() || record.ref.length > 300 || typeof record.summary !== "string" || !record.summary.trim() || record.summary.length > 500) {
        throw new AppError(400, "changeset_evidence_invalid", `ChangeSet evidence[${index}] 结构无效`);
      }
      return { kind: record.kind as NonNullable<CreateChangeSetInput["evidence"]>[number]["kind"], ref: record.ref.trim(), summary: record.summary.trim() };
    });
  }

  private parseGraphNode(value: unknown, target: string, index: number): GraphNode {
    const item = plainRecord(value);
    if (item.id !== target || typeof item.kind !== "string" || typeof item.title !== "string") {
      throw new AppError(400, "invalid_graph_node", `operations[${index}] 的节点结构无效`);
    }
    if (item.title.length > 200) throw new AppError(400, "graph_title_too_long", "节点标题不能超过 200 个字符");
    if (item.description !== undefined && typeof item.description !== "string") {
      throw new AppError(400, "invalid_graph_node", `operations[${index}] 的节点说明无效`);
    }
    if (item.doc !== undefined && typeof item.doc !== "string") {
      throw new AppError(400, "invalid_graph_node", `operations[${index}] 的文档引用无效`);
    }
    if (item.docAnchor !== undefined && typeof item.docAnchor !== "string") {
      throw new AppError(400, "invalid_graph_node", `operations[${index}] 的文档锚点无效`);
    }
    if (item.lookup !== undefined && (!Array.isArray(item.lookup) || item.lookup.length > 20 || Buffer.byteLength(JSON.stringify(item.lookup), "utf8") > 64 * 1024)) {
      throw new AppError(400, "invalid_graph_node", `operations[${index}] 的声明式查询无效或超过大小上限`);
    }
    const position = item.position === undefined ? undefined : plainRecord(item.position);
    if (position && (typeof position.x !== "number" || !Number.isFinite(position.x) || typeof position.y !== "number" || !Number.isFinite(position.y))) {
      throw new AppError(400, "invalid_graph_position", `operations[${index}] 的节点坐标无效`);
    }
    const extensions = item.extensions === undefined ? undefined : plainRecord(item.extensions);
    const preserved = preservedGraphFields(item, GRAPH_NODE_KNOWN_FIELDS, `operations[${index}] 节点`);
    return {
      ...preserved,
      id: target,
      kind: item.kind as GraphNodeKind,
      title: item.title,
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(item.doc !== undefined ? { doc: item.doc } : {}),
      ...(item.docAnchor !== undefined ? { docAnchor: item.docAnchor } : {}),
      ...(item.lookup !== undefined ? { lookup: structuredClone(item.lookup) as ProjectFactQuery[] } : {}),
      ...(position ? { position: { x: position.x as number, y: position.y as number } } : {}),
      ...(extensions ? { extensions } : {})
    };
  }

  private parseGraphEdge(value: unknown, target: string, index: number): GraphEdge {
    const item = plainRecord(value);
    if (
      item.id !== target ||
      typeof item.from !== "string" ||
      typeof item.to !== "string" ||
      typeof item.kind !== "string"
    ) {
      throw new AppError(400, "invalid_graph_edge", `operations[${index}] 的边结构无效`);
    }
    if (item.label !== undefined && typeof item.label !== "string") {
      throw new AppError(400, "invalid_graph_edge", `operations[${index}] 的边标签无效`);
    }
    const condition = item.condition === undefined ? undefined : plainRecord(item.condition) as unknown as ConditionExpression;
    const extensions = item.extensions === undefined ? undefined : plainRecord(item.extensions);
    const preserved = preservedGraphFields(item, GRAPH_EDGE_KNOWN_FIELDS, `operations[${index}] 边`);
    return {
      ...preserved,
      id: target,
      from: item.from,
      to: item.to,
      kind: item.kind as GraphEdgeKind,
      ...(item.label !== undefined ? { label: item.label } : {}),
      ...(condition ? { condition } : {}),
      ...(extensions ? { extensions } : {})
    };
  }

  private previewDocument(
    target: string,
    existed: boolean,
    before: string,
    after: string,
    action: "create" | "update" | "rename" | "delete",
    destination?: string,
    referenceNodeIds: string[] = []
  ) {
    const oldLines = before ? before.split("\n").length : 0;
    const newLines = after ? after.split("\n").length : 0;
    let prefix = 0;
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < beforeLines.length - prefix &&
      suffix < afterLines.length - prefix &&
      beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
    ) suffix++;
    return {
      kind: "document" as const,
      target,
      action,
      ...(destination ? { destination } : {}),
      referenceNodeIds,
      existed,
      before,
      after,
      oldLines,
      newLines,
      addedLines: Math.max(0, afterLines.length - prefix - suffix),
      removedLines: Math.max(0, beforeLines.length - prefix - suffix)
    };
  }

  private async restoreDocument(target: string, existed: boolean, before: string): Promise<void> {
    if (existed) {
      await this.atomicWrite(target, before);
      return;
    }
    try {
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async walkMarkdown(directory: string, prefix: string): Promise<string[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const results: string[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          if (entry.name.toLowerCase().endsWith(".md")) throw new AppError(403, "project_symlink_unsupported", "Markdown 文档不接受符号链接");
          continue;
        }
        if (entry.isDirectory()) results.push(...await this.walkMarkdown(path.join(directory, entry.name), childPrefix));
        else if (entry.isFile() && isSkillDocumentPath(childPrefix)) results.push(childPrefix);
      }
      return results;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeChangeSet(changeSet: ProjectChangeSet): Promise<void> {
    await mkdir(this.changeSetDir(changeSet.projectId), { recursive: true });
    await this.atomicWrite(
      path.join(this.changeSetDir(changeSet.projectId), `${changeSet.changeSetId}.json`),
      JSON.stringify(changeSet, null, 2) + "\n"
    );
  }

  private async readImportCandidate(importId: string): Promise<SkillImportCandidate> {
    try {
      const candidate = JSON.parse(await readFile(this.importCandidateFile(importId), "utf8")) as SkillImportCandidate;
      if (candidate.importId !== importId) throw new AppError(409, "import_identity_mismatch", "导入候选身份数据不一致");
      candidate.references ??= [];
      candidate.formatSignals ??= [];
      candidate.provenance ??= [];
      return candidate;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "import_not_found", "导入候选不存在");
      if (error instanceof SyntaxError) throw new AppError(500, "import_corrupt", "导入候选数据损坏");
      throw error;
    }
  }

  private async writeImportCandidate(candidate: SkillImportCandidate): Promise<void> {
    await mkdir(this.importDir(candidate.importId), { recursive: true });
    await this.atomicWrite(this.importCandidateFile(candidate.importId), JSON.stringify(candidate, null, 2) + "\n");
  }

  private async readExportRecord(exportId: string): Promise<GenericExportRecord> {
    try {
      const record = JSON.parse(await readFile(this.exportRecordFile(exportId), "utf8")) as GenericExportRecord;
      if (record.exportId !== exportId) throw new AppError(409, "export_identity_mismatch", "导出记录身份数据不一致");
      return record;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "export_not_found", "导出记录不存在");
      if (error instanceof SyntaxError) throw new AppError(500, "export_corrupt", "导出记录数据损坏");
      throw error;
    }
  }

  private async writeExportRecord(record: GenericExportRecord): Promise<void> {
    await mkdir(this.exportDir(record.exportId), { recursive: true });
    await this.atomicWrite(this.exportRecordFile(record.exportId), JSON.stringify(record, null, 2) + "\n");
  }

  private async readBugReportRecord(reportId: string): Promise<BugReportRecord> {
    try {
      const record = JSON.parse(await readFile(this.reportRecordFile(reportId), "utf8")) as BugReportRecord;
      if (record.reportId !== reportId || record.report.reportId !== reportId) {
        throw new AppError(409, "report_identity_mismatch", "报告身份数据不一致");
      }
      return record;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "report_not_found", "报告不存在");
      if (error instanceof SyntaxError) throw new AppError(500, "report_corrupt", "报告数据损坏");
      throw error;
    }
  }

  private async writeBugReportRecord(record: BugReportRecord): Promise<void> {
    await mkdir(this.reportDir(record.reportId), { recursive: true });
    await this.atomicWrite(this.reportRecordFile(record.reportId), JSON.stringify(record, null, 2) + "\n");
  }

  private async readImportedBugReport(workspaceId: string, reportImportId: string): Promise<ImportedBugReport> {
    this.assertReportImportId(reportImportId);
    try {
      const report = JSON.parse(await readFile(this.reportImportFile(workspaceId, reportImportId), "utf8")) as ImportedBugReport;
      if (report.workspaceId !== workspaceId || report.reportImportId !== reportImportId) {
        throw new AppError(409, "report_import_identity_mismatch", "导入报告身份数据不一致");
      }
      return report;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "report_import_not_found", "导入报告不存在");
      if (error instanceof SyntaxError) throw new AppError(500, "report_import_corrupt", "导入报告数据损坏");
      throw error;
    }
  }

  private async writeImportedBugReport(report: ImportedBugReport): Promise<void> {
    await mkdir(this.reportImportDir(report.workspaceId), { recursive: true });
    await this.atomicWrite(this.reportImportFile(report.workspaceId, report.reportImportId), JSON.stringify(report, null, 2) + "\n");
  }

  private async writeDiagnosis(diagnosis: DiagnosisRecord): Promise<void> {
    const directory = this.diagnosisDir(diagnosis.workspaceId, diagnosis.reportImportId);
    await mkdir(directory, { recursive: true });
    await this.atomicWrite(path.join(directory, `${diagnosis.diagnosisId}.json`), JSON.stringify(diagnosis, null, 2) + "\n");
  }

  private async readDiagnosis(workspaceId: string, reportImportId: string, diagnosisId: string): Promise<DiagnosisRecord> {
    this.assertDiagnosisId(diagnosisId);
    try {
      const diagnosis = JSON.parse(await readFile(path.join(this.diagnosisDir(workspaceId, reportImportId), `${diagnosisId}.json`), "utf8")) as DiagnosisRecord;
      if (diagnosis.diagnosisId !== diagnosisId || diagnosis.workspaceId !== workspaceId || diagnosis.reportImportId !== reportImportId) {
        throw new AppError(409, "diagnosis_identity_mismatch", "诊断记录身份数据不一致");
      }
      return diagnosis;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "diagnosis_not_found", "诊断记录不存在");
      if (error instanceof SyntaxError) throw new AppError(500, "diagnosis_corrupt", "诊断记录数据损坏");
      throw error;
    }
  }

  private async readDiagnosisRepair(workspaceId: string, reportImportId: string, repairId: string): Promise<DiagnosisRepairRecord> {
    this.assertRepairId(repairId);
    try {
      const parsed = JSON.parse(await readFile(path.join(this.diagnosisRepairDir(workspaceId, reportImportId), `${repairId}.json`), "utf8")) as DiagnosisRepairRecord;
      const repair = { ...parsed, round: Number.isSafeInteger(parsed.round) && parsed.round > 0 ? parsed.round : 1 };
      if (repair.repairId !== repairId || repair.workspaceId !== workspaceId || repair.reportImportId !== reportImportId) {
        throw new AppError(409, "repair_identity_mismatch", "修复记录身份数据不一致");
      }
      return repair;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "repair_not_found", "修复记录不存在");
      if (error instanceof SyntaxError) throw new AppError(500, "repair_corrupt", "修复记录数据损坏");
      throw error;
    }
  }

  private async writeDiagnosisRepair(repair: DiagnosisRepairRecord): Promise<void> {
    await mkdir(this.diagnosisRepairDir(repair.workspaceId, repair.reportImportId), { recursive: true });
    await this.atomicWrite(path.join(this.diagnosisRepairDir(repair.workspaceId, repair.reportImportId), `${repair.repairId}.json`), JSON.stringify(repair, null, 2) + "\n");
  }

  private async findParentDiagnosisRepair(
    workspaceId: string,
    projectId: string,
    skillId: string,
    sourceRunId: string
  ): Promise<DiagnosisRepairRecord | null> {
    const reports = await this.listImportedBugReports(workspaceId);
    const repairs = (await Promise.all(reports.map((report) =>
      this.listDiagnosisRepairs(workspaceId, report.reportImportId)
    ))).flat();
    return repairs
      .filter((repair) =>
        repair.projectId === projectId && repair.skillId === skillId &&
        repair.verification?.runId === sourceRunId
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  }

  private async synchronizeDiagnosisRepair(repair: DiagnosisRepairRecord): Promise<DiagnosisRepairRecord> {
    const changeSet = await this.getChangeSet(repair.changeSetId);
    return {
      ...repair,
      proposalStatus: changeSet.status,
      ...(changeSet.appliedRevision ? { appliedRevision: changeSet.appliedRevision } : {})
    };
  }

  private async readReportFixture(workspaceId: string, reportImportId: string, fixtureId: string): Promise<ReportFixture> {
    this.assertFixtureId(fixtureId);
    try {
      const fixture = JSON.parse(await readFile(path.join(this.reportFixtureDir(workspaceId, reportImportId), `${fixtureId}.json`), "utf8")) as ReportFixture;
      if (fixture.fixtureId !== fixtureId || fixture.workspaceId !== workspaceId || fixture.reportImportId !== reportImportId || fixture.benchmarkEligible !== false) {
        throw new AppError(409, "fixture_identity_mismatch", "报告夹具身份数据不一致");
      }
      return fixture;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "fixture_not_found", "报告夹具不存在");
      if (error instanceof SyntaxError) throw new AppError(500, "fixture_corrupt", "报告夹具数据损坏");
      throw error;
    }
  }

  private async writeReportFixture(fixture: ReportFixture): Promise<void> {
    await mkdir(this.reportFixtureDir(fixture.workspaceId, fixture.reportImportId), { recursive: true });
    await this.atomicWrite(path.join(this.reportFixtureDir(fixture.workspaceId, fixture.reportImportId), `${fixture.fixtureId}.json`), JSON.stringify(fixture, null, 2) + "\n");
  }

  private async readReportBenchmarkCandidate(workspaceId: string, reportImportId: string, candidateId: string): Promise<ReportBenchmarkCandidate> {
    this.assertBenchmarkCandidateId(candidateId);
    try {
      const candidate = JSON.parse(await readFile(path.join(this.reportBenchmarkCandidateDir(workspaceId, reportImportId), `${candidateId}.json`), "utf8")) as ReportBenchmarkCandidate;
      if (candidate.candidateId !== candidateId || candidate.workspaceId !== workspaceId || candidate.reportImportId !== reportImportId) {
        throw new AppError(409, "benchmark_candidate_identity_mismatch", "候选用例身份数据不一致");
      }
      return candidate;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "benchmark_candidate_not_found", "候选用例不存在");
      if (error instanceof SyntaxError) throw new AppError(500, "benchmark_candidate_corrupt", "候选用例数据损坏");
      throw error;
    }
  }

  private async writeReportBenchmarkCandidate(candidate: ReportBenchmarkCandidate): Promise<void> {
    await mkdir(this.reportBenchmarkCandidateDir(candidate.workspaceId, candidate.reportImportId), { recursive: true });
    await this.atomicWrite(path.join(this.reportBenchmarkCandidateDir(candidate.workspaceId, candidate.reportImportId), `${candidate.candidateId}.json`), JSON.stringify(candidate, null, 2) + "\n");
  }

  private async synchronizeReportBenchmarkCandidate(candidate: ReportBenchmarkCandidate): Promise<ReportBenchmarkCandidate> {
    if (!candidate.changeSetId) return candidate;
    const changeSet = await this.getChangeSet(candidate.changeSetId);
    const status: ReportBenchmarkCandidate["status"] = changeSet.status === "proposed" ? "changeset-created" : changeSet.status;
    return {
      ...candidate,
      status,
      ...(changeSet.appliedRevision ? { appliedRevision: changeSet.appliedRevision } : {})
    };
  }

  private async buildGenericArchive(
    record: GenericExportRecord,
    snapshot: ProjectSnapshotManifest,
    archivePath: string
  ): Promise<void> {
    await rm(archivePath, { force: true });
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(archivePath, { mode: 0o600 });
      const archive = archiver("zip", { zlib: { level: 9 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("warning", reject);
      archive.on("error", reject);
      archive.pipe(output);
      for (const file of snapshot.files) {
        const source = path.resolve(this.snapshotFilesDir(record.projectId, snapshot.snapshotId), ...file.path.split("/"));
        const root = path.resolve(this.snapshotFilesDir(record.projectId, snapshot.snapshotId));
        if (!source.startsWith(root + path.sep)) {
          reject(new AppError(500, "snapshot_path_invalid", "Snapshot 文件路径无效"));
          return;
        }
        archive.file(source, { name: file.path, mode: 0o600 });
      }
      archive.file(this.exportGeneratedFile(record.exportId, "engine/skill-engine.mjs"), { name: "engine/skill-engine.mjs", mode: 0o700 });
      archive.file(this.exportGeneratedFile(record.exportId, "engine/README.md"), { name: "engine/README.md", mode: 0o600 });
      archive.file(this.exportGeneratedFile(record.exportId, "export-manifest.json"), { name: "export-manifest.json", mode: 0o600 });
      void archive.finalize().catch(reject);
    });
  }

  private shortFilesystemId(value: string): string {
    return value.replace(/[^0-9A-Za-z-]/g, "").slice(-20);
  }

  private reportSlug(value: string): string {
    const slug = value.normalize("NFKC").toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/gu, "");
    return slug.slice(0, 60) || "skill-report";
  }

  private localTimestamp(value: Date): string {
    const part = (number: number) => String(number).padStart(2, "0");
    return `${value.getFullYear()}${part(value.getMonth() + 1)}${part(value.getDate())}-${part(value.getHours())}${part(value.getMinutes())}${part(value.getSeconds())}`;
  }

  private async readRun(projectId: string, runId: string): Promise<ProjectRun> {
    try {
      const run = this.normalizeRun(JSON.parse(await readFile(this.runFile(projectId, runId), "utf8")));
      if (run.projectId !== projectId || run.runId !== runId) throw new AppError(409, "run_identity_mismatch", "运行身份数据不一致");
      return run;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "run_not_found", "运行不存在");
      if (error instanceof SyntaxError) throw new AppError(500, "run_corrupt", "运行数据损坏");
      throw error;
    }
  }

  private async readArtifactForRun(projectId: string, runId: string): Promise<RuntimeArtifact> {
    const run = await this.readRun(projectId, runId);
    return this.readArtifact(projectId, run.artifactId);
  }

  private async scanRuntimeArtifactStorage(
    projectId: string,
    workspaceId: string,
    benchmarkArtifactIds: string[],
    benchmarkRunCount: number
  ): Promise<RuntimeArtifactStorageScan> {
    if (!Number.isSafeInteger(benchmarkRunCount) || benchmarkRunCount < 0) {
      throw new AppError(500, "artifact_reference_count_invalid", "Benchmark Artifact 引用计数无效");
    }
    const [source, workspace, runs] = await Promise.all([
      this.readProjectSource(projectId),
      this.readWorkspace(workspaceId),
      this.listRuns(projectId)
    ]);
    if (!workspace.members.some((member) => member.projectId === projectId && member.skillId === source.skillId)) {
      throw new AppError(403, "project_not_in_workspace", "该 Skill 不属于指定 Workspace");
    }
    const protectedArtifactIds = new Set<string>();
    for (const run of runs) {
      if (
        run.projectId !== projectId || run.skillId !== source.skillId ||
        !/^artifact-[0-9a-f-]{36}$/iu.test(run.artifactId)
      ) {
        throw new AppError(500, "runtime_artifact_reference_invalid", "普通运行包含无效的 RuntimeArtifact 引用");
      }
      protectedArtifactIds.add(run.artifactId);
    }
    for (const artifactId of benchmarkArtifactIds) {
      if (!/^artifact-[0-9a-f-]{36}$/iu.test(artifactId)) {
        throw new AppError(500, "benchmark_artifact_reference_invalid", "Benchmark 包含无效的 RuntimeArtifact 引用");
      }
      protectedArtifactIds.add(artifactId);
    }

    let entries: Dirent[];
    try {
      entries = await readdir(this.runtimeArtifactDir(projectId), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
      else throw error;
    }
    const scannedAt = this.now().toISOString();
    const cutoffAt = new Date(Date.parse(scannedAt) - RUNTIME_ARTIFACT_ORPHAN_GRACE_MS).toISOString();
    const cutoff = Date.parse(cutoffAt);
    const validArtifactIds = new Set<string>();
    const eligible: RuntimeArtifactStorageScan["eligible"] = [];
    let totalBytes = 0;
    let protectedCount = 0;
    let orphanedCount = 0;
    let eligibleBytes = 0;
    let invalidCount = 0;

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const match = entry.name.match(/^(artifact-[0-9a-f-]{36})\.json$/iu);
      if (!entry.isFile() || !match?.[1]) {
        invalidCount += 1;
        continue;
      }
      const artifactId = match[1];
      const file = path.join(this.runtimeArtifactDir(projectId), entry.name);
      try {
        const [info, parsed] = await Promise.all([
          lstat(file),
          readFile(file, "utf8").then((content) => JSON.parse(content) as Partial<RuntimeArtifact>)
        ]);
        const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
        const createdTime = Date.parse(createdAt);
        if (
          !info.isFile() || info.isSymbolicLink() || parsed.schemaVersion !== "1.0" ||
          parsed.artifactId !== artifactId || parsed.workspaceId !== workspaceId ||
          parsed.projectId !== projectId || parsed.skillId !== source.skillId ||
          !Number.isFinite(createdTime)
        ) {
          invalidCount += 1;
          continue;
        }
        validArtifactIds.add(artifactId);
        totalBytes += info.size;
        if (protectedArtifactIds.has(artifactId)) protectedCount += 1;
        else {
          orphanedCount += 1;
          if (createdTime <= cutoff) {
            eligible.push({ artifactId, file, size: info.size, createdAt });
            eligibleBytes += info.size;
          }
        }
      } catch {
        invalidCount += 1;
      }
    }

    const missingReferencedCount = [...protectedArtifactIds].filter((artifactId) => !validArtifactIds.has(artifactId)).length;
    return {
      status: {
        schemaVersion: "1.0",
        workspaceId,
        projectId,
        skillId: source.skillId,
        scannedAt,
        cutoffAt,
        policy: {
          schemaVersion: "1.0",
          cleanupMode: "explicit",
          orphanGracePeriodMs: RUNTIME_ARTIFACT_ORPHAN_GRACE_MS
        },
        totalCount: validArtifactIds.size,
        totalBytes,
        protectedCount,
        orphanedCount,
        eligibleCount: eligible.length,
        eligibleBytes,
        invalidCount,
        missingReferencedCount,
        runtimeRunCount: runs.length,
        benchmarkRunCount
      },
      eligible,
      protectedArtifactIds
    };
  }

  private async readArtifact(projectId: string, artifactId: string): Promise<RuntimeArtifact> {
    this.assertArtifactId(artifactId);
    try {
      const parsed = JSON.parse(await readFile(this.runtimeArtifactFile(projectId, artifactId), "utf8")) as Partial<RuntimeArtifact>;
      const initialVariables = parsed.initialVariables && typeof parsed.initialVariables === "object" && !Array.isArray(parsed.initialVariables) ? parsed.initialVariables : {};
      if (typeof parsed.contentHash !== "string") throw new AppError(500, "artifact_corrupt", "RuntimeArtifact 缺少内容指纹");
      const artifact = {
        ...parsed,
        schemaVersion: "1.0" as const,
        initialVariables: structuredClone(initialVariables),
        fingerprint: parsed.fingerprint ?? this.createRuntimeArtifactFingerprint(parsed.contentHash, initialVariables)
      } as RuntimeArtifact;
      if (artifact.projectId !== projectId || artifact.artifactId !== artifactId) {
        throw new AppError(409, "artifact_identity_mismatch", "RuntimeArtifact 身份数据不一致");
      }
      return artifact;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "artifact_not_found", "RuntimeArtifact 不存在");
      if (error instanceof SyntaxError) throw new AppError(500, "artifact_corrupt", "RuntimeArtifact 数据损坏");
      throw error;
    }
  }

  private traceEvents(
    events: RuntimeEngineEvent[],
    identity: { runId: string; artifact: RuntimeArtifact; at: string }
  ): RuntimeTraceEvent[] {
    return events.map((event) => ({
      ...event,
      schemaVersion: "1.0",
      runId: identity.runId,
      workspaceId: identity.artifact.workspaceId,
      projectId: identity.artifact.projectId,
      skillId: identity.artifact.skillId,
      artifactId: identity.artifact.artifactId,
      at: identity.at,
      actor: "engine"
    }));
  }

  private createRuntimeArtifactFingerprint(projectContentHash: string, initialVariables: Record<string, unknown>): RuntimeArtifact["fingerprint"] {
    const canonicalInput = stableJson(initialVariables);
    if (Buffer.byteLength(canonicalInput, "utf8") > 64 * 1024) throw new AppError(400, "runtime_input_too_large", "运行初始变量不能超过 64 KiB");
    const inputHash = `sha256:${createHash("sha256").update(canonicalInput, "utf8").digest("hex")}`;
    return {
      schemaVersion: "1.0",
      algorithm: "sha256",
      projectContentHash,
      inputHash,
      value: `sha256:${createHash("sha256").update(`runtime-artifact/1\0${projectContentHash}\0${inputHash}`, "utf8").digest("hex")}`
    };
  }

  private normalizeRun(value: unknown): ProjectRun {
    const run = value as ProjectRun;
    return {
      ...run,
      schemaVersion: "1.0",
      events: Array.isArray(run.events) ? run.events.map((event) => ({ ...event, schemaVersion: "1.0" as const })) : []
    };
  }

  private async ensureProjectHistory(source: ProjectSource, state: ProjectState): Promise<ProjectRevision> {
    if (state.currentSnapshotId) {
      try {
        const revision = await this.readRevision(source.projectId, state.activeRevision);
        try {
          await this.readBaseline(source.projectId);
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "baseline_not_found") throw error;
          const baseline: ProjectBaseline = {
            projectId: source.projectId,
            skillId: source.skillId,
            revisionId: revision.revisionId,
            snapshotId: revision.snapshotId,
            acknowledgedAt: this.now().toISOString()
          };
          await this.atomicWrite(this.baselineFile(source.projectId), JSON.stringify(baseline, null, 2) + "\n");
        }
        return revision;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "revision_not_found") throw error;
      }
    }

    const timestamp = this.now().toISOString();
    const revision = await this.captureProjectRevision(source, state.activeRevision, null, "recovered", timestamp);
    const nextState = { ...state, currentSnapshotId: revision.snapshotId, updatedAt: state.updatedAt ?? timestamp };
    const baseline: ProjectBaseline = {
      projectId: source.projectId,
      skillId: source.skillId,
      revisionId: revision.revisionId,
      snapshotId: revision.snapshotId,
      acknowledgedAt: timestamp
    };
    await Promise.all([
      this.atomicWrite(this.projectStateFile(source.projectId), JSON.stringify(nextState, null, 2) + "\n"),
      this.atomicWrite(this.baselineFile(source.projectId), JSON.stringify(baseline, null, 2) + "\n")
    ]);
    return revision;
  }

  private async captureProjectRevision(
    source: ProjectSource,
    revisionId: string,
    parentRevision: string | null,
    revisionSource: ProjectRevision["source"],
    createdAt: string,
    changeSetId?: string
  ): Promise<ProjectRevision> {
    const snapshotId = this.prefixedId("snapshot");
    const files = await this.walkProjectFiles(source, source.root);
    const snapshotFilesRoot = path.join(this.snapshotDir(source.projectId, snapshotId), "files");
    const manifestFiles: ProjectSnapshotManifest["files"] = [];
    await mkdir(snapshotFilesRoot, { recursive: true });
    for (const file of files.sort((left, right) => left.localeCompare(right))) {
      const relative = path.relative(source.root, file).split(path.sep).join("/").normalize("NFC");
      const buffer = await readFile(file);
      const target = path.join(snapshotFilesRoot, ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(file, target);
      manifestFiles.push({
        path: relative,
        size: buffer.length,
        sha256: `sha256:${createHash("sha256").update(this.normalizeProjectFile(file, buffer)).digest("hex")}`
      });
    }
    const contentHash = await this.computeProjectContentHash(source);
    const manifest: ProjectSnapshotManifest = {
      snapshotId,
      projectId: source.projectId,
      skillId: source.skillId,
      revisionId,
      contentHash,
      files: manifestFiles,
      createdAt
    };
    const revision: ProjectRevision = {
      revisionId,
      projectId: source.projectId,
      skillId: source.skillId,
      parentRevision,
      contentHash,
      snapshotId,
      source: revisionSource,
      ...(changeSetId ? { changeSetId } : {}),
      createdAt
    };
    await mkdir(this.revisionDir(source.projectId), { recursive: true });
    await Promise.all([
      this.atomicWrite(this.snapshotManifestFile(source.projectId, snapshotId), JSON.stringify(manifest, null, 2) + "\n"),
      this.atomicWrite(this.revisionFile(source.projectId, revisionId), JSON.stringify(revision, null, 2) + "\n")
    ]);
    return revision;
  }

  private async removeCapturedRevision(revision: ProjectRevision): Promise<void> {
    await Promise.all([
      rm(this.snapshotDir(revision.projectId, revision.snapshotId), { recursive: true, force: true }),
      rm(this.revisionFile(revision.projectId, revision.revisionId), { force: true })
    ]);
  }

  private async beginProjectTransaction(
    changeSet: ProjectChangeSet,
    source: ProjectSource,
    state: ProjectState,
    nextRevision: string,
    kind: ProjectTransactionJournal["kind"],
    createdAt: string
  ): Promise<ProjectTransactionJournal> {
    const baseRevision = await this.ensureProjectHistory(source, state);
    if (baseRevision.revisionId !== state.activeRevision) {
      throw new AppError(409, "transaction_base_revision_mismatch", "事务基线版本与项目当前版本不一致");
    }
    const journal: ProjectTransactionJournal = {
      schemaVersion: "1.0",
      transactionId: this.prefixedId("transaction"),
      projectId: source.projectId,
      skillId: source.skillId,
      changeSetId: changeSet.changeSetId,
      kind,
      baseRevision: baseRevision.revisionId,
      baseSnapshotId: baseRevision.snapshotId,
      nextRevision,
      stage: "prepared",
      createdAt,
      updatedAt: createdAt
    };
    await this.writeTransactionJournal(journal);
    return journal;
  }

  private async advanceProjectTransaction(
    journal: ProjectTransactionJournal,
    stage: ProjectTransactionJournal["stage"],
    extra: Partial<ProjectTransactionJournal> = {}
  ): Promise<ProjectTransactionJournal> {
    const updatedAt = this.now().toISOString();
    const next: ProjectTransactionJournal = {
      ...journal,
      ...extra,
      stage,
      updatedAt,
      ...(stage === "completed" ? { completedAt: updatedAt } : {})
    };
    if (stage !== "prepared") delete next.fileMutation;
    await this.writeTransactionJournal(next);
    return next;
  }

  private async beginFileMutation(
    journal: ProjectTransactionJournal,
    step: ProjectFileMutationStep
  ): Promise<ProjectTransactionJournal> {
    return this.advanceProjectTransaction(journal, journal.stage, { fileMutation: step });
  }

  private async notifyFileMutation(journal: ProjectTransactionJournal): Promise<void> {
    if (journal.fileMutation && this.afterFileMutation) {
      await this.afterFileMutation({ journal: structuredClone(journal), step: journal.fileMutation });
    }
  }

  private async markTransactionRolledBack(
    journal: ProjectTransactionJournal,
    changeSet: ProjectChangeSet,
    reason: string
  ): Promise<ProjectTransactionJournal> {
    const recoveredAt = this.now().toISOString();
    const recoveredChangeSet: ProjectChangeSet = {
      ...changeSet,
      status: "conflicted",
      recoveredAt,
      recoveryReason: reason
    };
    await this.writeChangeSet(recoveredChangeSet);
    return this.advanceProjectTransaction(journal, "recovered", {
      recoveredAt,
      recoveredFromStage: journal.stage as Exclude<ProjectTransactionJournal["stage"], "completed" | "recovered">,
      ...(journal.fileMutation ? { recoveredFromFileMutation: journal.fileMutation } : {}),
      recoveryAction: "rolled-back",
      recoveryReason: reason
    });
  }

  private async writeTransactionJournal(journal: ProjectTransactionJournal): Promise<void> {
    await mkdir(this.transactionDir(journal.projectId), { recursive: true });
    await this.atomicWrite(this.transactionFile(journal.projectId, journal.transactionId), JSON.stringify(journal, null, 2) + "\n");
  }

  private async readTransactionJournal(target: string): Promise<ProjectTransactionJournal> {
    let journal: ProjectTransactionJournal;
    try {
      journal = JSON.parse(await readFile(target, "utf8")) as ProjectTransactionJournal;
    } catch (error) {
      if (error instanceof SyntaxError) throw new AppError(500, "transaction_journal_corrupt", "事务日志 JSON 已损坏", { target });
      throw error;
    }
    const stages = new Set<ProjectTransactionJournal["stage"]>([
      "prepared", "files-written", "revision-captured", "state-committed", "completed", "recovered"
    ]);
    const fileMutations = new Set<ProjectFileMutationStep>([
      "document-rename-destination", "document-rename-source", "document-rename-graph"
    ]);
    if (
      journal.schemaVersion !== "1.0" || !/^transaction-[0-9a-f-]{36}$/i.test(journal.transactionId) ||
      !/^project-[0-9a-f-]{36}$/i.test(journal.projectId) || !/^skill-[0-9a-f-]{36}$/i.test(journal.skillId) ||
      !/^change-[0-9a-f-]{36}$/i.test(journal.changeSetId) || !stages.has(journal.stage) ||
      !/^rev-[0-9A-Za-z-]+$/.test(journal.baseRevision) || !/^rev-[0-9A-Za-z-]+$/.test(journal.nextRevision) ||
      !/^snapshot-[0-9a-f-]{36}$/i.test(journal.baseSnapshotId) ||
      (journal.fileMutation !== undefined && !fileMutations.has(journal.fileMutation)) ||
      (journal.recoveredFromFileMutation !== undefined && !fileMutations.has(journal.recoveredFromFileMutation))
    ) {
      throw new AppError(500, "transaction_journal_corrupt", "事务日志字段无效", { target });
    }
    return journal;
  }

  private async recoverInterruptedTransactions(): Promise<void> {
    const projects = await readdir(this.projectStateRoot(), { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory() || !/^project-[0-9a-f-]{36}$/i.test(project.name)) continue;
      let entries;
      try {
        entries = await readdir(this.transactionDir(project.name), { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
        const journal = await this.readTransactionJournal(path.join(this.transactionDir(project.name), entry.name));
        if (journal.projectId !== project.name) {
          throw new AppError(500, "transaction_journal_identity_mismatch", "事务日志与项目目录身份不一致");
        }
        if (journal.stage === "completed" || journal.stage === "recovered") continue;
        if (await this.transactionCommitIsComplete(journal)) {
          await this.advanceProjectTransaction(journal, "completed", {
            recoveryAction: "commit-completed",
            recoveryReason: "启动检查确认文件、revision、项目状态和 ChangeSet 均已完整提交"
          });
          continue;
        }
        await this.rollbackInterruptedTransaction(journal);
      }
    }
  }

  private async transactionCommitIsComplete(journal: ProjectTransactionJournal): Promise<boolean> {
    try {
      const [source, state, revision, changeSet] = await Promise.all([
        this.readProjectSource(journal.projectId),
        this.readProjectState(journal.projectId),
        this.readRevision(journal.projectId, journal.nextRevision),
        this.getChangeSet(journal.changeSetId)
      ]);
      if (
        source.skillId !== journal.skillId || state.activeRevision !== journal.nextRevision ||
        state.currentSnapshotId !== revision.snapshotId || revision.changeSetId !== journal.changeSetId ||
        revision.parentRevision !== journal.baseRevision || changeSet.status !== "applied" ||
        changeSet.appliedRevision !== journal.nextRevision
      ) return false;
      const snapshot = await this.readSnapshot(journal.projectId, revision.snapshotId);
      await this.verifySnapshotForRestore(source, revision, snapshot);
      return await this.computeProjectContentHash(source) === revision.contentHash;
    } catch {
      return false;
    }
  }

  private async rollbackInterruptedTransaction(journal: ProjectTransactionJournal): Promise<void> {
    const [source, state, baseRevision, baseSnapshot, changeSet] = await Promise.all([
      this.readProjectSource(journal.projectId),
      this.readProjectState(journal.projectId),
      this.readRevision(journal.projectId, journal.baseRevision),
      this.readSnapshot(journal.projectId, journal.baseSnapshotId),
      this.getChangeSet(journal.changeSetId)
    ]);
    if (source.skillId !== journal.skillId || baseRevision.snapshotId !== journal.baseSnapshotId) {
      throw new AppError(500, "transaction_recovery_identity_mismatch", "事务恢复基线身份不一致");
    }
    await this.verifySnapshotForRestore(source, baseRevision, baseSnapshot);
    await this.replaceProjectWithSnapshot(source, baseSnapshot);
    let interruptedRevision: ProjectRevision | undefined;
    try {
      interruptedRevision = await this.readRevision(journal.projectId, journal.nextRevision);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "revision_not_found") throw error;
    }
    if (interruptedRevision) await this.removeCapturedRevision(interruptedRevision);
    const recoveredAt = this.now().toISOString();
    const baseState: ProjectState = {
      ...state,
      activeRevision: baseRevision.revisionId,
      currentSnapshotId: baseSnapshot.snapshotId,
      updatedAt: recoveredAt
    };
    await this.atomicWrite(this.projectStateFile(journal.projectId), JSON.stringify(baseState, null, 2) + "\n");
    const stageLabel = {
      prepared: "准备写入",
      "files-written": "文件已写入",
      "revision-captured": "版本快照已生成",
      "state-committed": "项目状态已提交",
      completed: "已完成",
      recovered: "已恢复"
    }[journal.stage];
    const fileMutationLabel = journal.fileMutation ? {
      "document-rename-destination": "写入重命名目标文档",
      "document-rename-source": "移除重命名源文档",
      "document-rename-graph": "更新文档图引用"
    }[journal.fileMutation] : null;
    const reason = `启动恢复检测到未完成事务（停留在“${stageLabel}”${fileMutationLabel ? `，文件步骤“${fileMutationLabel}”` : ""}），已恢复确认前 Snapshot；请重新检查并提交 ChangeSet`;
    await this.markTransactionRolledBack(journal, changeSet, reason);
  }

  private async readRevision(projectId: string, revisionId: string): Promise<ProjectRevision> {
    if (!/^rev-[0-9A-Za-z-]+$/.test(revisionId)) throw new AppError(400, "invalid_revision_id", "Revision ID 无效");
    try {
      const revision = JSON.parse(await readFile(this.revisionFile(projectId, revisionId), "utf8")) as ProjectRevision;
      if (revision.projectId !== projectId || revision.revisionId !== revisionId) {
        throw new AppError(409, "revision_identity_mismatch", "Revision 身份数据不一致");
      }
      return revision;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "revision_not_found", "Revision 不存在");
      throw error;
    }
  }

  private async readSnapshot(projectId: string, snapshotId: string): Promise<ProjectSnapshotManifest> {
    if (!/^snapshot-[0-9a-f-]{36}$/i.test(snapshotId)) throw new AppError(400, "invalid_snapshot_id", "Snapshot ID 无效");
    try {
      const snapshot = JSON.parse(await readFile(this.snapshotManifestFile(projectId, snapshotId), "utf8")) as ProjectSnapshotManifest;
      if (snapshot.projectId !== projectId || snapshot.snapshotId !== snapshotId) {
        throw new AppError(409, "snapshot_identity_mismatch", "Snapshot 身份数据不一致");
      }
      return snapshot;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "snapshot_not_found", "Snapshot 不存在");
      throw error;
    }
  }

  private async verifySnapshotForRestore(
    source: ProjectSource,
    revision: ProjectRevision,
    snapshot: ProjectSnapshotManifest
  ): Promise<void> {
    if (
      revision.projectId !== source.projectId || revision.skillId !== source.skillId ||
      snapshot.projectId !== source.projectId || snapshot.skillId !== source.skillId ||
      revision.snapshotId !== snapshot.snapshotId || snapshot.revisionId !== revision.revisionId ||
      revision.contentHash !== snapshot.contentHash
    ) {
      throw new AppError(409, "undo_snapshot_identity_mismatch", "撤销 Snapshot 与 revision 身份不一致");
    }
    if (snapshot.files.length > 2000) throw new AppError(413, "undo_snapshot_file_count_exceeded", "撤销 Snapshot 文件数超过上限");
    const snapshotRoot = path.resolve(this.snapshotFilesDir(source.projectId, snapshot.snapshotId));
    const seen = new Set<string>();
    const contentHash = createHash("sha256");
    for (const file of [...snapshot.files].sort((left, right) => left.path.localeCompare(right.path))) {
      const relative = file.path.normalize("NFC");
      const parts = relative.split("/");
      if (
        !relative || relative !== file.path || path.posix.isAbsolute(relative) || relative.includes("\\") ||
        parts.some((part) => !part || part === "." || part === "..") ||
        parts[0]?.toLowerCase() === ".git" || relative.toLowerCase() === ".ds_store" || seen.has(relative)
      ) {
        throw new AppError(409, "undo_snapshot_path_invalid", `撤销 Snapshot 包含无效路径：${file.path}`);
      }
      seen.add(relative);
      const snapshotFile = path.resolve(snapshotRoot, ...parts);
      if (snapshotFile !== snapshotRoot && !snapshotFile.startsWith(`${snapshotRoot}${path.sep}`)) {
        throw new AppError(409, "undo_snapshot_path_invalid", `撤销 Snapshot 路径越界：${file.path}`);
      }
      const info = await lstat(snapshotFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new AppError(409, "undo_snapshot_file_missing", `撤销 Snapshot 缺少文件：${file.path}`);
        throw error;
      });
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new AppError(409, "undo_snapshot_file_invalid", `撤销 Snapshot 包含非普通文件：${file.path}`);
      }
      const buffer = await readFile(snapshotFile);
      const normalized = this.normalizeProjectFile(relative, buffer);
      const sha256 = `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
      if (buffer.length !== file.size || sha256 !== file.sha256) {
        throw new AppError(409, "undo_snapshot_hash_mismatch", `撤销 Snapshot 文件校验失败：${file.path}`);
      }
      contentHash.update(relative);
      contentHash.update("\0");
      contentHash.update(String(normalized.length));
      contentHash.update("\0");
      contentHash.update(normalized);
      contentHash.update("\0");
    }
    if (`sha256:${contentHash.digest("hex")}` !== snapshot.contentHash) {
      throw new AppError(409, "undo_snapshot_content_mismatch", "撤销 Snapshot 总内容标识校验失败");
    }
    if (!seen.has("SKILL.md") || !seen.has("skill.json") || !seen.has("graph/main.json")) {
      throw new AppError(409, "undo_snapshot_required_file_missing", "撤销 Snapshot 缺少 Skill 核心文件");
    }
    await Promise.all([
      this.readSnapshotGraph(source.projectId, snapshot.snapshotId, source.skillId),
      this.readSnapshotSkillManifest(source.projectId, revision.revisionId, source.skillId)
    ]);
  }

  private async replaceProjectWithSnapshot(source: ProjectSource, snapshot: ProjectSnapshotManifest): Promise<void> {
    const desired = new Set(snapshot.files.map((file) => file.path));
    const currentFiles = await this.walkProjectFiles(source, source.root);
    for (const current of currentFiles) {
      const relative = path.relative(source.root, current).split(path.sep).join("/").normalize("NFC");
      if (!desired.has(relative)) await unlink(current);
    }
    const snapshotRoot = path.resolve(this.snapshotFilesDir(source.projectId, snapshot.snapshotId));
    for (const file of [...snapshot.files].sort((left, right) => left.path.localeCompare(right.path))) {
      const sourceFile = path.resolve(snapshotRoot, ...file.path.split("/"));
      const target = path.resolve(source.root, ...file.path.split("/"));
      this.assertProjectPath(source, target);
      await mkdir(path.dirname(target), { recursive: true });
      await this.atomicCopyFile(sourceFile, target);
    }
  }

  private async atomicCopyFile(source: string, target: string): Promise<void> {
    const temp = `${target}.${this.idFactory()}.tmp`;
    try {
      await copyFile(source, temp);
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readSnapshotGraph(projectId: string, snapshotId: string, skillId: string): Promise<SkillGraph> {
    try {
      const graph = JSON.parse(
        await readFile(path.join(this.snapshotFilesDir(projectId, snapshotId), "graph", "main.json"), "utf8")
      ) as SkillGraph;
      if (graph.skillId !== skillId) throw new AppError(409, "snapshot_graph_identity_mismatch", "Snapshot 图的 Skill 身份不一致");
      const errors = lintGraph(graph).filter((issue) => issue.severity === "error");
      if (errors.length) throw new AppError(422, "snapshot_graph_invalid", "Snapshot 图校验失败", errors);
      return graph;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "snapshot_graph_missing", "Snapshot 图不存在");
      if (error instanceof SyntaxError) throw new AppError(500, "snapshot_graph_corrupt", "Snapshot 图 JSON 损坏");
      throw error;
    }
  }

  private async readSnapshotSkillManifest(projectId: string, revisionId: string, skillId: string): Promise<SkillManifest> {
    const revision = await this.readRevision(projectId, revisionId);
    try {
      const manifest = JSON.parse(
        await readFile(path.join(this.snapshotFilesDir(projectId, revision.snapshotId), "skill.json"), "utf8")
      ) as SkillManifest;
      if (manifest.skillId !== skillId) throw new AppError(409, "snapshot_manifest_identity_mismatch", "Snapshot 清单的 Skill 身份不一致");
      return manifest;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "snapshot_manifest_missing", "Snapshot 清单不存在");
      if (error instanceof SyntaxError) throw new AppError(500, "snapshot_manifest_corrupt", "Snapshot 清单 JSON 损坏");
      throw error;
    }
  }

  private async readBaseline(projectId: string): Promise<ProjectBaseline> {
    try {
      const baseline = JSON.parse(await readFile(this.baselineFile(projectId), "utf8")) as ProjectBaseline;
      if (baseline.projectId !== projectId) throw new AppError(409, "baseline_identity_mismatch", "Baseline 身份数据不一致");
      return baseline;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(404, "baseline_not_found", "Baseline 不存在");
      throw error;
    }
  }

  private diffSnapshots(before: ProjectSnapshotManifest, after: ProjectSnapshotManifest): ProjectRevisionStatus["changedFiles"] {
    const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
    const afterFiles = new Map(after.files.map((file) => [file.path, file]));
    const paths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort((left, right) => left.localeCompare(right));
    const changedFiles: ProjectRevisionStatus["changedFiles"] = [];
    for (const filePath of paths) {
      const previous = beforeFiles.get(filePath);
      const current = afterFiles.get(filePath);
      if (!previous && current) changedFiles.push({ path: filePath, status: "added", afterHash: current.sha256 });
      else if (previous && !current) changedFiles.push({ path: filePath, status: "deleted", beforeHash: previous.sha256 });
      if (previous && current && previous.sha256 !== current.sha256) {
        changedFiles.push({ path: filePath, status: "modified", beforeHash: previous.sha256, afterHash: current.sha256 });
      }
    }
    return changedFiles;
  }

  private async computeProjectContentHash(source: ProjectSource): Promise<string> {
    const files = await this.walkProjectFiles(source, source.root);
    const hash = createHash("sha256");
    for (const file of files.sort((left, right) => left.localeCompare(right))) {
      const relative = path.relative(source.root, file).split(path.sep).join("/").normalize("NFC");
      const buffer = await readFile(file);
      const normalized = this.normalizeProjectFile(file, buffer);
      hash.update(relative);
      hash.update("\0");
      hash.update(String(normalized.length));
      hash.update("\0");
      hash.update(normalized);
      hash.update("\0");
    }
    return `sha256:${hash.digest("hex")}`;
  }

  private normalizeProjectFile(file: string, buffer: Buffer): Buffer {
    const extension = path.extname(file).toLowerCase();
    return textFileExtensions.has(extension)
      ? Buffer.from(buffer.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").normalize("NFC"), "utf8")
      : buffer;
  }

  private async walkProjectFiles(source: ProjectSource, directory: string): Promise<string[]> {
    this.assertProjectPath(source, directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name.toLowerCase() === ".git" || entry.name.toLowerCase() === ".ds_store") continue;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new AppError(403, "project_symlink_unsupported", "运行快照不接受符号链接");
      if (entry.isDirectory()) files.push(...await this.walkProjectFiles(source, target));
      else if (entry.isFile()) files.push(target);
    }
    return files;
  }

  private async markConflicted(
    changeSet: ProjectChangeSet,
    code: string,
    message: string,
    currentRevision: string,
    details?: unknown
  ): Promise<void> {
    const conflicted: ProjectChangeSet = {
      ...changeSet,
      status: "conflicted",
      conflict: {
        code,
        message,
        detectedAt: this.now().toISOString(),
        baseRevision: changeSet.baseRevision,
        currentRevision,
        ...(details === undefined ? {} : { details })
      }
    };
    await this.writeChangeSet(conflicted);
  }

  private assertChangeSetId(value: string): void {
    if (!/^change-[0-9a-f-]{36}$/i.test(value)) throw new AppError(400, "invalid_changeset_id", "ChangeSet ID 无效");
  }

  private assertRunId(value: string): void {
    if (!/^run-[0-9a-f-]{36}$/i.test(value)) throw new AppError(400, "invalid_run_id", "Run ID 无效");
  }

  private assertArtifactId(value: string): void {
    if (!/^artifact-[0-9a-f-]{36}$/i.test(value)) throw new AppError(400, "invalid_artifact_id", "Artifact ID 无效");
  }

  private assertImportId(value: string): void {
    if (!/^import-[0-9a-f-]{36}$/i.test(value)) throw new AppError(400, "invalid_import_id", "Import ID 无效");
  }

  private assertExportId(value: string): void {
    if (!/^export-[0-9a-f-]{36}$/i.test(value)) throw new AppError(400, "invalid_export_id", "Export ID 无效");
  }

  private assertBugReportId(value: string): void {
    if (!/^report-[0-9a-f-]{36}$/i.test(value)) throw new AppError(400, "invalid_report_id", "Report ID 无效");
  }

  private assertReportImportId(value: string): void {
    if (!/^report-import-[0-9a-f-]{36}$/i.test(value)) throw new AppError(400, "invalid_report_import_id", "报告导入 ID 无效");
  }

  private assertDiagnosisId(value: string): void {
    if (!/^diagnosis-[0-9a-f-]{36}$/i.test(value)) throw new AppError(400, "invalid_diagnosis_id", "Diagnosis ID 无效");
  }

  private assertRepairId(value: string): void {
    if (!/^repair-[0-9a-f-]{36}$/i.test(value)) throw new AppError(400, "invalid_repair_id", "Repair ID 无效");
  }

  private assertFixtureId(value: string): void {
    if (!/^fixture-[0-9a-f-]{36}$/i.test(value)) throw new AppError(400, "invalid_fixture_id", "Fixture ID 无效");
  }

  private assertBenchmarkCandidateId(value: string): void {
    if (!/^benchmark-candidate-[0-9a-f-]{36}$/i.test(value)) throw new AppError(400, "invalid_benchmark_candidate_id", "候选用例 ID 无效");
  }

  private assertBenchmarkCaseId(value: string): void {
    if (!/^case-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new AppError(400, "invalid_benchmark_case_id", "测试用例 ID 无效");
    }
  }

  private assertProjectPath(source: ProjectSource, target: string): void {
    const root = path.resolve(source.root);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new AppError(403, "path_outside_project", "路径超出 Skill Project 根目录");
    }
    if (source.mode === "managed-copy") {
      const managedRelative = path.relative(this.managedProjectRoot(), root);
      if (managedRelative.startsWith("..") || path.isAbsolute(managedRelative)) {
        throw new AppError(403, "managed_project_outside_root", "管理项目路径无效");
      }
    }
  }

  private async assertProjectReadPath(source: ProjectSource, target: string): Promise<void> {
    this.assertProjectPath(source, target);
    const root = path.resolve(source.root);
    const relative = path.relative(root, path.resolve(target));
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (info.isSymbolicLink()) {
        throw new AppError(403, "project_symlink_unsupported", "Skill Project 文件读取不接受符号链接");
      }
    }
  }

  private toSummary(workspace: Workspace): WorkspaceSummary {
    return {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      selectedProjectId: workspace.selectedProjectId,
      memberCount: workspace.members.length,
      readyCount: workspace.members.filter((member) => member.status === "ready").length,
      errorCount: workspace.members.filter((member) => member.status === "error" || member.status === "missing").length,
      updatedAt: workspace.updatedAt
    };
  }

  private async readWorkspace(workspaceId: string): Promise<Workspace> {
    try {
      const content = await readFile(this.workspaceFile(workspaceId), "utf8");
      const workspace = JSON.parse(content) as Workspace;
      const orderedMembers = [...workspace.members].sort((left, right) => left.order - right.order);
      workspace.members = await Promise.all(orderedMembers.map(async (member, order) => {
        member = { ...member, order };
        if (member.status === "pending-import") return member;
        try {
          const [source, state] = await Promise.all([
            this.readProjectSource(member.projectId),
            this.readProjectState(member.projectId)
          ]);
          if (source.skillId !== member.skillId) {
            return { ...member, sourcePath: source.root, status: "error" as const, statusDetail: "项目来源的 skillId 与 Workspace 记录不一致" };
          }
          await this.assertProjectReadPath(source, path.join(source.root, "skill.json"));
          const [manifest, graph, gitStatus] = await Promise.all([
            readFile(path.join(source.root, "skill.json"), "utf8").then((value) => JSON.parse(value) as SkillManifest),
            this.readGraph(source),
            this.git.status(source.root, source.mode).catch(() => ({ capability: { available: false }, files: [] }))
          ]);
          if (manifest.skillId !== member.skillId) {
            return { ...member, sourcePath: source.root, status: "error" as const, statusDetail: "skill.json 的 skillId 与 Workspace 记录不一致" };
          }
          const graphLint = [...lintGraph(graph), ...await this.lintDocumentBindings(source, graph)];
          const { statusDetail: _statusDetail, ...memberWithoutDetail } = member;
          return {
            ...memberWithoutDetail,
            sourcePath: source.root,
            displayName: manifest.name,
            capability: manifest.capability,
            activeRevision: state.activeRevision,
            git: { available: gitStatus.capability.available, changedFiles: gitStatus.files.length },
            lint: {
              errors: graphLint.filter((issue) => issue.severity === "error").length,
              warnings: graphLint.filter((issue) => issue.severity === "warning").length
            },
            status: "ready" as const
          };
        } catch (error) {
          const code = error instanceof AppError ? error.code : (error as NodeJS.ErrnoException).code;
          const missing = code === "ENOENT" || code === "project_not_found" || code === "project_state_not_found" || code === "graph_not_found";
          const statusDetail = error instanceof Error ? error.message : "无法读取 Skill Project";
          return { ...member, status: missing ? "missing" as const : "error" as const, statusDetail };
        }
      }));
      return workspace;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AppError(404, "workspace_not_found", "Workspace 不存在");
      }
      if (error instanceof SyntaxError) throw new AppError(500, "workspace_corrupt", "Workspace 数据损坏");
      throw error;
    }
  }

  private async writeWorkspace(workspace: Workspace): Promise<void> {
    await this.atomicWrite(this.workspaceFile(workspace.workspaceId), JSON.stringify(workspace, null, 2) + "\n");
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const temp = `${target}.${this.idFactory()}.tmp`;
    await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    await rename(temp, target);
  }

  private async atomicWriteBuffer(target: string, content: Buffer): Promise<void> {
    const temp = `${target}.${this.idFactory()}.tmp`;
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, target);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private assertId(value: string, prefix: "workspace" | "project"): void {
    if (!new RegExp(`^${prefix}-[0-9a-f-]{36}$`, "i").test(value)) {
      throw new AppError(400, "invalid_id", `${prefix}Id 无效`);
    }
  }

  private prefixedId(prefix: "workspace" | "project" | "skill" | "change" | "run" | "artifact" | "snapshot" | "import" | "export" | "report" | "transaction"): string {
    return `${prefix}-${this.idFactory()}`;
  }

  private nextRevisionId(createdAt: string): string {
    const entropy = this.idFactory().replace(/-/g, "").slice(-8);
    return `rev-${createdAt.replace(/[-:.TZ]/g, "")}-${entropy}`;
  }

  private workspaceRoot(): string {
    return path.join(this.dataDir, "workspaces");
  }

  private workspaceDir(workspaceId: string): string {
    return path.join(this.workspaceRoot(), workspaceId);
  }

  private workspaceFile(workspaceId: string): string {
    return path.join(this.workspaceDir(workspaceId), "workspace.json");
  }

  private projectStateRoot(): string {
    return path.join(this.dataDir, "projects");
  }

  private importDir(importId: string): string {
    return path.join(this.dataDir, "imports", importId);
  }

  private importFilesDir(importId: string): string {
    return path.join(this.importDir(importId), "files");
  }

  private importCandidateFile(importId: string): string {
    return path.join(this.importDir(importId), "candidate.json");
  }

  private projectStateFile(projectId: string): string {
    return path.join(this.projectStateRoot(), projectId, "state.json");
  }

  private changeSetDir(projectId: string): string {
    return path.join(this.projectStateRoot(), projectId, "changesets");
  }

  private transactionDir(projectId: string): string {
    return path.join(this.projectStateRoot(), projectId, "transactions");
  }

  private transactionFile(projectId: string, transactionId: string): string {
    return path.join(this.transactionDir(projectId), `${transactionId}.json`);
  }

  private revisionDir(projectId: string): string {
    return path.join(this.projectStateRoot(), projectId, "revisions");
  }

  private revisionFile(projectId: string, revisionId: string): string {
    return path.join(this.revisionDir(projectId), `${revisionId}.json`);
  }

  private snapshotDir(projectId: string, snapshotId: string): string {
    return path.join(this.projectStateRoot(), projectId, "snapshots", snapshotId);
  }

  private snapshotManifestFile(projectId: string, snapshotId: string): string {
    return path.join(this.snapshotDir(projectId, snapshotId), "manifest.json");
  }

  private snapshotFilesDir(projectId: string, snapshotId: string): string {
    return path.join(this.snapshotDir(projectId, snapshotId), "files");
  }

  private baselineFile(projectId: string): string {
    return path.join(this.projectStateRoot(), projectId, "baseline.json");
  }

  private exportDir(exportId: string): string {
    return path.join(this.dataDir, "exports", exportId);
  }

  private exportRecordFile(exportId: string): string {
    return path.join(this.exportDir(exportId), "export.json");
  }

  private exportGeneratedFile(exportId: string, relativePath: string): string {
    const target = path.resolve(this.exportDir(exportId), ...relativePath.split("/"));
    const root = path.resolve(this.exportDir(exportId));
    if (!target.startsWith(root + path.sep)) throw new AppError(500, "export_path_invalid", "导出内部路径无效");
    return target;
  }

  private exportArchiveFile(exportId: string): string {
    return path.join(this.exportDir(exportId), "package.zip");
  }

  private reportRoot(): string {
    return path.join(this.dataDir, "reports");
  }

  private reportDir(reportId: string): string {
    return path.join(this.reportRoot(), reportId);
  }

  private reportRecordFile(reportId: string): string {
    return path.join(this.reportDir(reportId), "record.json");
  }

  private reportDownloadFile(reportId: string, format: "json" | "markdown" = "json"): string {
    return path.join(this.reportDir(reportId), format === "markdown" ? "report.md" : "report.json");
  }

  private reportImportDir(workspaceId: string): string {
    return path.join(this.dataDir, "report-imports", workspaceId);
  }

  private reportImportFile(workspaceId: string, reportImportId: string): string {
    return path.join(this.reportImportDir(workspaceId), `${reportImportId}.json`);
  }

  private diagnosisDir(workspaceId: string, reportImportId: string): string {
    return path.join(this.dataDir, "diagnoses", workspaceId, reportImportId);
  }

  private diagnosisRepairDir(workspaceId: string, reportImportId: string): string {
    return path.join(this.diagnosisDir(workspaceId, reportImportId), "repairs");
  }

  private reportFixtureDir(workspaceId: string, reportImportId: string): string {
    return path.join(this.dataDir, "report-fixtures", workspaceId, reportImportId);
  }

  private reportBenchmarkCandidateDir(workspaceId: string, reportImportId: string): string {
    return path.join(this.dataDir, "report-benchmark-candidates", workspaceId, reportImportId);
  }

  private runtimeArtifactDir(projectId: string): string {
    return path.join(this.projectStateRoot(), projectId, "runtime-artifacts");
  }

  private runtimeArtifactFile(projectId: string, artifactId: string): string {
    return path.join(this.runtimeArtifactDir(projectId), `${artifactId}.json`);
  }

  private runDir(projectId: string): string {
    return path.join(this.projectStateRoot(), projectId, "runs");
  }

  private runFile(projectId: string, runId: string): string {
    return path.join(this.runDir(projectId), `${runId}.json`);
  }

  private managedProjectRoot(): string {
    return path.join(this.dataDir, "managed-projects");
  }
}
