export type SkillCapability = "workflow" | "content-only";
export type WorkspaceMemberStatus = "pending-import" | "ready" | "missing" | "error";
export type ProjectMode = "managed-copy" | "in-place";
export type GraphCapability = SkillCapability;
export const graphNodeTypeRegistry = [
  { kind: "start", plane: "flow", runtimeRole: "entry", legendOrder: 0 },
  { kind: "end", plane: "flow", runtimeRole: "completion", legendOrder: 1 },
  { kind: "step", plane: "flow", runtimeRole: "step", legendOrder: 3 },
  { kind: "decision", plane: "flow", runtimeRole: "step", legendOrder: 2 },
  { kind: "gate", plane: "flow", runtimeRole: "step", legendOrder: 4 },
  { kind: "lookup", plane: "flow", runtimeRole: "step", legendOrder: 5 },
  { kind: "dispatcher", plane: "flow", runtimeRole: "step", legendOrder: 6 },
  { kind: "action", plane: "flow", runtimeRole: "step", legendOrder: 7 },
  { kind: "terminal", plane: "flow", runtimeRole: "step", legendOrder: 8 },
  { kind: "knowledge", plane: "knowledge", runtimeRole: "none", legendOrder: 9 }
] as const;
export const graphEdgeTypeRegistry = [
  { kind: "flow", plane: "flow", executable: true, directional: true },
  { kind: "condition", plane: "flow", executable: true, directional: true },
  { kind: "back", plane: "flow", executable: true, directional: true },
  { kind: "continue", plane: "flow", executable: true, directional: true },
  { kind: "knowledge", plane: "knowledge", executable: false, directional: false }
] as const;
export type GraphNodeKind = typeof graphNodeTypeRegistry[number]["kind"];
export type GraphEdgeKind = typeof graphEdgeTypeRegistry[number]["kind"];
export function isGraphNodeKind(value: unknown): value is GraphNodeKind {
  return typeof value === "string" && graphNodeTypeRegistry.some((item) => item.kind === value);
}
export function isGraphEdgeKind(value: unknown): value is GraphEdgeKind {
  return typeof value === "string" && graphEdgeTypeRegistry.some((item) => item.kind === value);
}
export type JsonScalar = string | number | boolean | null;

export type ProjectFactQuery =
  | { queryId: string; kind: "graph.node"; nodeId: string }
  | { queryId: string; kind: "graph.neighborhood"; nodeId: string; direction: "in" | "out" | "both"; edgeKinds?: GraphEdgeKind[] }
  | { queryId: string; kind: "graph.search"; text: string; nodeKinds?: GraphNodeKind[]; limit?: number }
  | { queryId: string; kind: "document.slice"; path: string; anchor: string; fallback?: "none" | "title" };

export type ProjectFactQueryStatus = "found" | "empty" | "missing" | "ambiguous" | "degraded";

export interface ProjectFactQueryResult {
  queryId: string;
  kind: ProjectFactQuery["kind"];
  status: ProjectFactQueryStatus;
  value?: unknown;
  candidates?: DocumentHeading[];
  diagnostic?: string;
  degradation?: {
    strategy: "title";
    requestedAnchor: string;
    resolvedPath: string;
  };
}

export type ConditionOperand =
  | { kind: "literal"; value: JsonScalar | JsonScalar[] }
  | { kind: "ref"; path: string };

export type ConditionExpression =
  | { op: "boolean"; value: boolean }
  | { op: "not"; condition: ConditionExpression }
  | { op: "equals" | "notEquals"; left: ConditionOperand; right: ConditionOperand }
  | { op: "contains"; container: ConditionOperand; value: ConditionOperand }
  | { op: "and" | "or"; conditions: ConditionExpression[] };

export interface GraphNode {
  [field: string]: unknown;
  id: string;
  kind: GraphNodeKind;
  title: string;
  description?: string;
  doc?: string;
  docAnchor?: string;
  lookup?: ProjectFactQuery[];
  position?: { x: number; y: number };
  extensions?: Record<string, unknown>;
}

export interface GraphEdge {
  [field: string]: unknown;
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  label?: string;
  condition?: ConditionExpression;
  extensions?: Record<string, unknown>;
}

export interface SkillGraph {
  [field: string]: unknown;
  schemaVersion: "1.0";
  skillId: string;
  capability: GraphCapability;
  entry?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphLintIssue extends ValidationIssue {
  severity: "error" | "warning";
}

export interface DocumentEntry {
  path: string;
  name: string;
  size: number;
  updatedAt: string;
  referenceCount: number;
}

export interface DocumentFile {
  path: string;
  content: string;
  activeRevision: string;
}

export interface DocumentHeading {
  title: string;
  level: number;
  path: string;
  anchor: string;
  startLine: number;
  endLine: number;
}

export interface DocumentSlice {
  heading: DocumentHeading;
  content: string;
}

export type DocumentSliceStatus = "found" | "whole-document" | "missing" | "ambiguous";

export interface DocumentSliceResult {
  status: DocumentSliceStatus;
  query: string;
  slice?: DocumentSlice;
  content?: string;
  candidates: DocumentHeading[];
}

export interface ProjectDocumentSlice extends DocumentSliceResult {
  documentPath: string;
  activeRevision: string;
}

export interface DocumentReference {
  nodeId: string;
  nodeTitle: string;
  documentPath: string;
  anchor?: string;
}

export interface DocumentWriteOperation {
  op: "docs.write";
  target: string;
  value: string;
}

export interface DocumentRenameOperation {
  op: "docs.rename";
  target: string;
  value: string;
}

export interface DocumentDeleteOperation {
  op: "docs.delete";
  target: string;
}

export type DocumentChangeOperation = DocumentWriteOperation | DocumentRenameOperation | DocumentDeleteOperation;

export type BenchmarkCaseStatus = "draft" | "ready";
export type BenchmarkPathMode = "subsequence" | "exact";

export interface BenchmarkUserReply {
  nodeId?: string;
  message: string;
}

export interface BenchmarkArtifactAssertion {
  path: string;
  exists: boolean;
  contains?: string;
}

export interface BenchmarkToolResultAssertion {
  tool: string;
  field?: string;
  equals?: unknown;
}

export interface BenchmarkCase {
  schemaVersion: "1.0";
  caseId: string;
  skillId: string;
  title: string;
  status: BenchmarkCaseStatus;
  intent: string;
  fixture: {
    initialVariables: Record<string, unknown>;
    userReplies: BenchmarkUserReply[];
  };
  expected: {
    path: { mode: BenchmarkPathMode; nodeIds: string[] };
    terminal?: { status: "completed" | "stopped"; nodeId?: string };
    variables: Record<string, unknown>;
    artifacts: BenchmarkArtifactAssertion[];
    toolResults: BenchmarkToolResultAssertion[];
    forbiddenEffects: string[];
  };
  tags: string[];
  notes?: string;
  source?: {
    kind: "bug-report";
    reportImportId: string;
    reportId: string;
    sourceRunId: string;
  };
}

export interface BenchmarkCaseIssue extends ValidationIssue {
  severity: "error" | "warning";
}

export interface BenchmarkCaseEntry {
  caseId: string;
  title: string;
  status: BenchmarkCaseStatus;
  path: string;
  tags: string[];
  updatedAt: string;
  valid: boolean;
  issues: BenchmarkCaseIssue[];
}

export interface ProjectBenchmarkCase {
  case: BenchmarkCase;
  path: string;
  activeRevision: string;
  issues: BenchmarkCaseIssue[];
}

export interface RuntimeBenchmarkCandidate {
  schemaVersion: "1.0";
  candidateId: string;
  workspaceId: string;
  projectId: string;
  skillId: string;
  source: {
    runId: string;
    artifactId: string;
    revision: string;
    status: "completed" | "stopped";
  };
  case: BenchmarkCase;
  issues: BenchmarkCaseIssue[];
  createdAt: string;
}

export interface BenchmarkCaseWriteOperation {
  op: "benchmark.case.write";
  target: string;
  value: BenchmarkCase;
}

export interface BenchmarkCaseDeleteOperation {
  op: "benchmark.case.delete";
  target: string;
}

export type BenchmarkCaseChangeOperation = BenchmarkCaseWriteOperation | BenchmarkCaseDeleteOperation;

export interface GraphNodeCreateOperation {
  op: "graph.node.create";
  target: string;
  value: GraphNode;
}

export interface GraphNodeUpdateOperation {
  op: "graph.node.update";
  target: string;
  value: GraphNode;
}

export interface GraphNodeDeleteOperation {
  op: "graph.node.delete";
  target: string;
}

export interface GraphEdgeCreateOperation {
  op: "graph.edge.create";
  target: string;
  value: GraphEdge;
}

export interface GraphEdgeUpdateOperation {
  op: "graph.edge.update";
  target: string;
  value: GraphEdge;
}

export interface GraphEdgeDeleteOperation {
  op: "graph.edge.delete";
  target: string;
}

export type GraphChangeOperation =
  | GraphNodeCreateOperation
  | GraphNodeUpdateOperation
  | GraphNodeDeleteOperation
  | GraphEdgeCreateOperation
  | GraphEdgeUpdateOperation
  | GraphEdgeDeleteOperation;

export interface ProjectRestoreOperation {
  op: "project.restore";
  target: string;
  value: {
    snapshotId: string;
    contentHash: string;
  };
}

export interface SkillManifestUpdateOperation {
  op: "skill.update";
  target: "skill.json";
  value: Pick<SkillManifest, "name" | "version" | "description">;
}

export interface AssetCopyOperation {
  op: "asset.copy";
  target: string;
  value: {
    contentBase64: string;
  };
}

export interface AssetDeleteOperation {
  op: "asset.delete";
  target: string;
}

export type AssetChangeOperation = AssetCopyOperation | AssetDeleteOperation;
export type ChangeOperation = DocumentChangeOperation | GraphChangeOperation | BenchmarkCaseChangeOperation | ProjectRestoreOperation | SkillManifestUpdateOperation | AssetChangeOperation;
export type ChangeSetStatus = "proposed" | "rejected" | "applied" | "conflicted";
export type ChangeSetSourceKind = "manual" | "assistant" | "diagnosis" | "report" | "runtime" | "import" | "system" | "legacy";
export type ChangeSetEvidenceKind = "user-request" | "project-fact" | "document" | "graph" | "trace" | "diagnosis" | "report" | "runtime";

export interface ChangeSetSource {
  kind: ChangeSetSourceKind;
  sourceId?: string;
  label?: string;
}

export interface ChangeSetEvidence {
  kind: ChangeSetEvidenceKind;
  ref: string;
  summary: string;
}

export interface DocumentChangePreview {
  kind: "document";
  target: string;
  action: "create" | "update" | "rename" | "delete";
  destination?: string;
  referenceNodeIds: string[];
  existed: boolean;
  before: string;
  after: string;
  oldLines: number;
  newLines: number;
  addedLines: number;
  removedLines: number;
}

export interface GraphDiffSummary {
  addedNodeIds: string[];
  updatedNodeIds: string[];
  removedNodeIds: string[];
  addedEdgeIds: string[];
  updatedEdgeIds: string[];
  removedEdgeIds: string[];
}

export interface GraphChangePreview extends GraphDiffSummary {
  kind: "graph";
  target: "graph/main.json";
  before: SkillGraph;
  after: SkillGraph;
  lint: GraphLintIssue[];
}

export interface BenchmarkCaseChangePreview {
  kind: "benchmark-case";
  target: string;
  caseId: string;
  action: "create" | "update" | "delete";
  existed: boolean;
  before: string;
  after: string;
  lint: BenchmarkCaseIssue[];
}

export interface ProjectRestoreChangePreview {
  kind: "project-restore";
  target: "project";
  fromRevision: string;
  toRevision: string;
  toSnapshotId: string;
  files: RevisionChangedFile[];
}

export interface SkillManifestChangePreview {
  kind: "skill-manifest";
  target: "skill.json";
  before: SkillManifest;
  after: SkillManifest;
  changedFields: Array<"name" | "version" | "description">;
}

export interface AssetFileFact {
  path: string;
  size: number;
  sha256: string;
  mimeType: string;
}

export interface AssetReferenceImpact {
  sourcePath: string;
  startLine: number;
  kind: string;
  rawTarget: string;
}

export interface AssetChangePreview {
  kind: "asset";
  target: string;
  action: "create" | "replace" | "delete";
  existed: boolean;
  before?: AssetFileFact;
  after?: AssetFileFact;
  references: AssetReferenceImpact[];
}

export interface ProjectAssetEntry extends AssetFileFact {
  updatedAt: string;
  referenceCount: number;
}

export interface ProjectAssetFile extends ProjectAssetEntry {
  contentBase64: string;
}

export type ChangePreview = DocumentChangePreview | GraphChangePreview | BenchmarkCaseChangePreview | ProjectRestoreChangePreview | SkillManifestChangePreview | AssetChangePreview;

export interface ChangeSetConflict {
  code: string;
  message: string;
  detectedAt: string;
  baseRevision: string;
  currentRevision: string;
  details?: unknown;
}

export interface ProjectChangeSet {
  changeSetId: string;
  workspaceId: string;
  projectId: string;
  skillId: string;
  baseRevision: string;
  operations: ChangeOperation[];
  reason: string;
  source: ChangeSetSource;
  evidence: ChangeSetEvidence[];
  status: ChangeSetStatus;
  preview: ChangePreview[];
  digest: string;
  createdAt: string;
  appliedRevision?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  conflict?: ChangeSetConflict;
  recoveredAt?: string;
  recoveryReason?: string;
}

export interface RejectChangeSetInput {
  digest: string;
  baseRevision: string;
  reason?: string;
}

export interface ReproposeChangeSetInput {
  digest: string;
  baseRevision: string;
}

export interface CreateChangeSetInput {
  workspaceId: string;
  baseRevision: string;
  operations: ChangeOperation[];
  reason: string;
  source?: ChangeSetSource;
  evidence?: ChangeSetEvidence[];
}

export interface CreateUndoChangeSetInput {
  workspaceId: string;
  baseRevision: string;
}

export interface ApplyChangeSetResult {
  changeSet: ProjectChangeSet;
  activeRevision: string;
  document?: DocumentFile;
  deletedDocumentPath?: string;
  graph?: SkillGraph;
  benchmarkCase?: ProjectBenchmarkCase;
  deletedBenchmarkCaseId?: string;
  restoredRevision?: string;
  restoredSnapshotId?: string;
  skillManifest?: SkillManifest;
  asset?: ProjectAssetEntry;
  deletedAssetPath?: string;
}

export type ProjectRevisionSource = "initial" | "changeset" | "undo" | "recovered";
export type RevisionFileStatus = "added" | "modified" | "deleted";

export interface SnapshotFileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface ProjectSnapshotManifest {
  snapshotId: string;
  projectId: string;
  skillId: string;
  revisionId: string;
  contentHash: string;
  files: SnapshotFileEntry[];
  createdAt: string;
}

export interface ProjectRevision {
  revisionId: string;
  projectId: string;
  skillId: string;
  parentRevision: string | null;
  contentHash: string;
  snapshotId: string;
  source: ProjectRevisionSource;
  changeSetId?: string;
  createdAt: string;
}

export interface ProjectBaseline {
  projectId: string;
  skillId: string;
  revisionId: string;
  snapshotId: string;
  acknowledgedAt: string;
}

export interface RevisionChangedFile {
  path: string;
  status: RevisionFileStatus;
  beforeHash?: string;
  afterHash?: string;
}

export interface ProjectRevisionStatus {
  activeRevision: ProjectRevision;
  currentSnapshot: ProjectSnapshotManifest;
  baseline: ProjectBaseline;
  changedFiles: RevisionChangedFile[];
}

export type ProjectTransactionStage =
  | "prepared"
  | "files-written"
  | "revision-captured"
  | "state-committed"
  | "completed"
  | "recovered";

export type ProjectFileMutationStep =
  | "document-rename-destination"
  | "document-rename-source"
  | "document-rename-graph";

export interface ProjectTransactionJournal {
  schemaVersion: "1.0";
  transactionId: string;
  projectId: string;
  skillId: string;
  changeSetId: string;
  kind: "changeset" | "undo";
  baseRevision: string;
  baseSnapshotId: string;
  nextRevision: string;
  stage: ProjectTransactionStage;
  fileMutation?: ProjectFileMutationStep;
  capturedSnapshotId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  recoveredAt?: string;
  recoveredFromStage?: Exclude<ProjectTransactionStage, "completed" | "recovered">;
  recoveredFromFileMutation?: ProjectFileMutationStep;
  recoveryAction?: "commit-completed" | "rolled-back";
  recoveryReason?: string;
}

export type ImportCandidateStatus = "proposed" | "confirmed" | "cancelled";
export type ImportDetectedFormat = "skill-designer" | "frontmatter-skill" | "markdown-skill";
export type ImportFileKind = "markdown" | "json" | "config" | "text" | "script" | "asset" | "unknown";
export type ImportStructuredValue = JsonScalar | ImportStructuredValue[] | { [key: string]: ImportStructuredValue };

export interface ImportFileEntry {
  path: string;
  size: number;
  sha256: string;
  kind: ImportFileKind;
}

export interface ImportDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
}

export type ImportFrontmatterDialect = "yaml" | "toml" | "json";
export type ImportFrontmatterStatus = "valid" | "invalid" | "unterminated";

export interface ImportFrontmatterSummary {
  path: "SKILL.md";
  dialect: ImportFrontmatterDialect;
  status: ImportFrontmatterStatus;
  startLine: number;
  endLine: number;
  data: Record<string, ImportStructuredValue>;
  recognized: {
    name?: string;
    description?: string;
    version?: string;
    license?: string;
    compatibility?: string;
    allowedTools?: string[];
  };
  unknownKeys: string[];
  error?: string;
}

export type ImportReferenceKind = "markdown-link" | "markdown-image" | "markdown-definition" | "inline-code" | "frontmatter";
export type ImportReferenceStatus = "resolved" | "missing" | "missing-anchor" | "external" | "invalid" | "escaped";

export interface ImportReference {
  referenceId: string;
  sourcePath: string;
  startLine: number;
  kind: ImportReferenceKind;
  rawTarget: string;
  status: ImportReferenceStatus;
  normalizedTarget?: string;
  fragment?: string;
  message: string;
}

export interface ImportFormatSignal {
  code: "native-manifest" | "native-graph" | "yaml-frontmatter" | "toml-frontmatter" | "json-frontmatter" | "root-skill-markdown";
  path: string;
  confidence: ImportConfidence;
  message: string;
}

export type ImportProvenanceSubject = "detected-format" | "display-name" | "description" | "capability" | "graph";
export type ImportProvenanceMethod = "native-manifest" | "native-graph" | "frontmatter" | "markdown-heading" | "markdown-paragraph" | "folder-name" | "static-inference" | "conservative-fallback";

export interface ImportProvenanceRecord {
  provenanceId: string;
  subject: ImportProvenanceSubject;
  valueSummary: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  method: ImportProvenanceMethod;
  confidence: ImportConfidence;
}

export type ImportReviewDecision = "accepted" | "rejected";
export type ImportConfidence = "high" | "medium" | "low";

export interface ImportParseEvidence {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  kind: "native-graph" | "skill-manifest" | "markdown-heading" | "markdown-list" | "fallback" | "llm";
}

export interface ImportNodeCandidate {
  candidateId: string;
  value: GraphNode;
  decision: ImportReviewDecision;
  confidence: ImportConfidence;
  evidence: ImportParseEvidence[];
  manuallyEdited: boolean;
}

export interface ImportEdgeCandidate {
  candidateId: string;
  value: GraphEdge;
  decision: ImportReviewDecision;
  confidence: ImportConfidence;
  evidence: ImportParseEvidence[];
  manuallyEdited: boolean;
}

export interface ImportUnresolvedQuestion {
  questionId: string;
  message: string;
  blocking: boolean;
  evidence: ImportParseEvidence[];
}

export interface SkillImportReviewSnapshot {
  capability: SkillCapability;
  entry?: string;
  nodes: ImportNodeCandidate[];
  edges: ImportEdgeCandidate[];
  unresolvedQuestions: ImportUnresolvedQuestion[];
  lint: GraphLintIssue[];
}

export interface ImportReparseConflict {
  kind: "manual-vs-reparse";
  detectedAt: string;
  parserVersion?: ImportParserVersion;
  parsed: SkillImportReviewSnapshot;
}

export type ImportParserVersion = "static-v1" | "llm-v1";

export interface SkillImportParseReview extends SkillImportReviewSnapshot {
  parserVersion: ImportParserVersion;
  reviewRevision: number;
  sourceDigest: string;
  manuallyEdited: boolean;
  reparseConflict?: ImportReparseConflict;
}

export type ImportLLMParseStatus = "running" | "completed" | "failed" | "cancelled";

export interface ImportLLMParseRead {
  round: number;
  path: string;
  status: "completed" | "rejected";
  resultChars: number;
  message: string;
  contextMode?: "full" | "summary";
  cacheStatus?: "miss" | "hit" | "promoted";
}

export interface ImportLLMParseRun {
  schemaVersion: "1.0";
  runId: string;
  importId: string;
  workspaceId: string;
  sourceDigest: string;
  baseReviewRevision: number;
  status: ImportLLMParseStatus;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  callCount: number;
  correctionCount: number;
  reads: ImportLLMParseRead[];
  usage: ModelUsage;
  diagnostics: ImportDiagnostic[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  resultReviewRevision?: number;
  createdConflict?: boolean;
}

export interface StartImportLLMParseInput {
  workspaceId: string;
  reviewRevision: number;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
}

export interface ImportLLMParseResult {
  run: ImportLLMParseRun;
  candidate?: SkillImportCandidate;
}

export interface UpdateSkillImportReviewInput {
  workspaceId: string;
  reviewRevision: number;
  entry?: string;
  nodes: Array<Pick<ImportNodeCandidate, "candidateId" | "value" | "decision">>;
  edges: Array<Pick<ImportEdgeCandidate, "candidateId" | "value" | "decision">>;
}

export interface ResolveImportReparseInput {
  workspaceId: string;
  reviewRevision: number;
  choice: "manual" | "reparse";
}

export interface SkillImportCandidate {
  importId: string;
  workspaceId: string;
  projectId: string;
  skillId: string;
  displayName: string;
  description: string;
  capability: SkillCapability;
  detectedFormat: ImportDetectedFormat;
  files: ImportFileEntry[];
  generatedFiles: string[];
  diagnostics: ImportDiagnostic[];
  frontmatter?: ImportFrontmatterSummary;
  references: ImportReference[];
  formatSignals: ImportFormatSignal[];
  provenance: ImportProvenanceRecord[];
  parseReview: SkillImportParseReview;
  digest: string;
  status: ImportCandidateStatus;
  createdAt: string;
  confirmedAt?: string;
}

export interface ImportUploadFile {
  path: string;
  contentBase64: string;
}

export interface CreateSkillImportInput {
  folderName: string;
  files: ImportUploadFile[];
}

export interface SkillImportPreview {
  candidate: SkillImportCandidate;
  workspace: Workspace;
}

export type GenericExportStatus = "proposed" | "ready" | "conflicted";

export interface GenericExportFileEntry {
  path: string;
  size: number;
  sha256: string;
  source: "snapshot" | "generated";
}

export interface GenericExportRecord {
  exportId: string;
  workspaceId: string;
  projectId: string;
  skillId: string;
  revisionId: string;
  snapshotId: string;
  contentHash: string;
  profile: "generic/1";
  files: GenericExportFileEntry[];
  warnings: string[];
  digest: string;
  status: GenericExportStatus;
  createdAt: string;
  archiveName?: string;
  archiveSize?: number;
  completedAt?: string;
}

export interface GenericExportDeletionResult {
  exportId: string;
  projectId: string;
  deleted: true;
}

export type RuntimeStatus = "running" | "paused" | "completed" | "stopped";
export type RuntimeEventType =
  | "engine.start"
  | "engine.enter"
  | "engine.reject"
  | "engine.pause"
  | "engine.resume"
  | "engine.stop"
  | "engine.complete";

export interface RuntimeEngineEvent {
  seq: number;
  type: RuntimeEventType;
  nodeId: string;
  data: Record<string, unknown>;
}

export interface RuntimeEngineState {
  currentNodeId: string;
  status: RuntimeStatus;
  step: number;
  eventSeq: number;
  visitedNodeIds: string[];
  skillVariables: Record<string, unknown>;
}

export interface RuntimeTransition {
  edgeId: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  label?: string;
}

export interface RuntimeConditionEvaluation {
  edgeId: string;
  to: string;
  conditionOp: ConditionExpression["op"];
  result: boolean;
}

export interface RuntimeCommandResult {
  accepted: boolean;
  state: RuntimeEngineState;
  allowedTransitions: RuntimeTransition[];
  events: RuntimeEngineEvent[];
  rejection?: {
    code: "next_node_not_allowed" | "run_not_active";
    message: string;
    requestedNodeId?: string;
  };
}

export interface RuntimeCommandOutcome {
  accepted: boolean;
  eventSeqs: number[];
  rejection?: {
    code: "next_node_not_allowed" | "run_not_active";
    message: string;
    requestedNodeId?: string;
  };
}

export interface RuntimeArtifact {
  schemaVersion: "1.0";
  artifactId: string;
  workspaceId: string;
  projectId: string;
  skillId: string;
  revision: string;
  contentHash: string;
  initialVariables: Record<string, unknown>;
  fingerprint: RuntimeArtifactFingerprint;
  graph: SkillGraph;
  createdAt: string;
}

export interface RuntimeArtifactFingerprint {
  schemaVersion: "1.0";
  algorithm: "sha256";
  projectContentHash: string;
  inputHash: string;
  value: string;
}

export interface ExecutionTraceEvent {
  schemaVersion: "1.0";
  seq: number;
  type: string;
  nodeId: string;
  data: Record<string, unknown>;
  runId: string;
  workspaceId: string;
  projectId: string;
  skillId: string;
  artifactId: string;
  at: string;
  actor: "engine" | "user" | "model" | "tool" | "sandbox" | "system";
}

export interface RuntimeTraceEvent extends ExecutionTraceEvent {}

export interface ProjectRun {
  schemaVersion: "1.0";
  runId: string;
  workspaceId: string;
  projectId: string;
  skillId: string;
  artifactId: string;
  revision: string;
  state: RuntimeEngineState;
  events: RuntimeTraceEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRunView {
  run: ProjectRun;
  allowedTransitions: RuntimeTransition[];
  artifact?: RuntimeArtifact;
  commandResult?: RuntimeCommandOutcome;
  contextFacts?: ProjectFactQueryResult[];
}

export type RuntimeDialogMessageKind = "input" | "reply" | "advanced" | "rejected" | "stopped" | "cancelled" | "error";

export interface RuntimeDialogModelDecision {
  action: "reply" | "advance" | "stop";
  nextNodeId: string | null;
  accepted: boolean | null;
}

export interface RuntimeDialogMessage {
  messageId: string;
  role: "user" | "assistant";
  kind: RuntimeDialogMessageKind;
  content: string;
  createdAt: string;
  nodeId: string;
  traceSeqs: number[];
  decision?: RuntimeDialogModelDecision;
  model?: {
    providerId: string;
    requestedModel: string;
    resolvedModel: string;
    reasoningEffort: ModelReasoningEffort;
    usage: ModelUsage;
    durationMs: number;
  };
}

export interface RuntimeDialogSession {
  schemaVersion: "1.0";
  workspaceId: string;
  projectId: string;
  skillId: string;
  runId: string;
  artifactId: string;
  createdAt: string;
  updatedAt: string;
  messages: RuntimeDialogMessage[];
}

export interface RuntimeDialogTurnResult {
  session: RuntimeDialogSession;
  message: RuntimeDialogMessage;
  view: ProjectRunView;
}

export interface RuntimeDialogCancellationResult {
  runId: string;
  cancelled: boolean;
  cancelledAt: string;
}

export type TraceNodeState = "unvisited" | "visited" | "current" | "rejected" | "completed" | "stopped";

export interface TraceProjection {
  schemaVersion: "1.0";
  latestSeq: number;
  status: RuntimeStatus;
  currentNodeId: string | null;
  nodeStates: Record<string, TraceNodeState>;
  traversedEdgeIds: string[];
  rejectedTransitions: Array<{ seq: number; from: string; requestedNodeId?: string }>;
  unknownEventCount: number;
  missingNodeIds: string[];
}

export interface TraceReplayFrame {
  schemaVersion: "1.0";
  throughSeq: number;
  event: ExecutionTraceEvent | null;
  projection: TraceProjection;
}

export interface TraceRunComparison {
  schemaVersion: "1.0";
  leftRunId: string;
  rightRunId: string;
  sameSkill: boolean;
  revisionDrift: boolean;
  artifactDrift: boolean;
  leftPathNodeIds: string[];
  rightPathNodeIds: string[];
  sharedPrefixNodeIds: string[];
  firstPathDivergence: {
    index: number;
    leftNodeId: string | null;
    rightNodeId: string | null;
  } | null;
  leftSnapshot: TraceRunSnapshot;
  rightSnapshot: TraceRunSnapshot;
  variableDifferences: TraceVariableDifference[];
  eventTypeDifferences: TraceEventTypeDifference[];
}

export interface TraceRunSnapshot {
  runId: string;
  status: RuntimeStatus;
  currentNodeId: string;
  step: number;
  eventSeq: number;
  skillVariables: Record<string, unknown>;
  eventTypeCounts: Record<string, number>;
}

export interface TraceVariableDifference {
  key: string;
  leftPresent: boolean;
  rightPresent: boolean;
  leftValue?: unknown;
  rightValue?: unknown;
}

export interface TraceEventTypeDifference {
  type: string;
  domain: "engine" | "condition" | "document" | "conversation" | "llm" | "model" | "tool" | "sandbox" | "benchmark" | "assertion" | "review" | "proposal" | "diagnosis" | "system" | "other";
  leftCount: number;
  rightCount: number;
}

export interface ExecutionTracePage {
  schemaVersion: "1.0";
  traceId: string;
  workspaceId: string;
  projectId: string;
  skillId: string;
  artifactId: string;
  afterSeq: number;
  latestSeq: number;
  events: RuntimeTraceEvent[];
  projection: TraceProjection;
}

export type BugReportSanitizationMode = "off" | "default" | "strict";
export type BugReportStatus = "proposed" | "ready";

export interface BugReportSymptom {
  code: "transition_rejected" | "run_stopped" | "assertion_failed" | "assertion_inconclusive" | "benchmark_failed";
  seq: number;
  nodeId: string;
  requestedNodeId?: string;
  assertionId?: string;
  assertionKind?: BenchmarkAssertionResult["kind"];
  failureCategory?: BenchmarkFailureCategory;
}

export interface BugReportDocument {
  reportVersion: "1.0";
  reportId: string;
  generatedAt: string;
  skill: {
    skillId: string;
    name: string;
    contentHash: string;
  };
  source: {
    kind?: "runtime" | "benchmark";
    workspaceId: string;
    projectId: string;
    runId: string;
    benchmarkRunId?: string;
    caseId?: string;
    artifactId: string;
    revision: string;
  };
  runtime: {
    status: RuntimeStatus | BenchmarkRunStatus;
    automaticVerdict?: BenchmarkAutomaticVerdict;
    createdAt: string;
    updatedAt: string;
    artifactFingerprint?: RuntimeArtifactFingerprint;
    benchmarkFingerprint?: BenchmarkRuntimeFingerprint;
  };
  coverage: {
    engine: boolean;
    conversation: boolean;
    tools: boolean;
    externalAgentMayBypass: boolean;
  };
  trace: ExecutionTraceEvent[];
  graphProjection: SkillGraph;
  symptoms: BugReportSymptom[];
  userNote: string;
  sanitization: {
    mode: BugReportSanitizationMode;
    sanitized: boolean;
    redactedFieldCount: number;
  };
}

export interface BugReportRecord {
  reportId: string;
  projectId: string;
  runId: string;
  sanitizationMode: BugReportSanitizationMode;
  report: BugReportDocument;
  digest: string;
  status: BugReportStatus;
  createdAt: string;
  fileName?: string;
  fileSize?: number;
  markdownFileName?: string;
  markdownFileSize?: number;
  completedAt?: string;
}

export interface BugReportDeletionResult {
  reportId: string;
  projectId: string;
  deleted: true;
}

export type ReportFixtureCommand =
  | { command: "next"; nextNodeId: string }
  | { command: "pause" | "resume" | "stop" };

export interface ReportFixtureEventSignature {
  type: string;
  nodeId: string;
  requestedNodeId?: string;
  viaEdgeId?: string;
}

export interface ReportFixture {
  schemaVersion: "1.0";
  fixtureId: string;
  kind: "engine-regression";
  benchmarkEligible: false;
  workspaceId: string;
  reportImportId: string;
  reportId: string;
  skillId: string;
  sourceRunId: string;
  sourceArtifactId: string;
  sourceRevision: string;
  sourceContentHash: string;
  graph: SkillGraph;
  initialVariables: Record<string, unknown>;
  commands: ReportFixtureCommand[];
  expectedEvents: ReportFixtureEventSignature[];
  limitations: string[];
  createdAt: string;
}

export interface ReportFixtureReplay {
  matches: boolean;
  actualEvents: ReportFixtureEventSignature[];
  mismatches: string[];
}

export type ReportBenchmarkCandidateStatus = "draft" | "changeset-created" | "rejected" | "conflicted" | "applied";

export interface ReportBenchmarkCandidate {
  schemaVersion: "1.0";
  candidateId: string;
  workspaceId: string;
  reportImportId: string;
  reportId: string;
  projectId: string;
  skillId: string;
  status: ReportBenchmarkCandidateStatus;
  case: BenchmarkCase;
  issues: BenchmarkCaseIssue[];
  createdAt: string;
  updatedAt: string;
  changeSetId?: string;
  appliedRevision?: string;
}

export type SandboxHostPlatform = "macos" | "windows" | "unsupported";
export type SandboxCapabilityStatus = "ready" | "unavailable" | "unsupported" | "degraded";
export type SandboxIsolationLevel = "none" | "container-vm-standard" | "container-vm-hardened";

export interface SandboxPolicy {
  schemaVersion: "1.0";
  filesystem: {
    root: "read-only";
    input: "read-only";
    output: "read-write";
    hostAccess: "deny";
    temporaryMiB: number;
  };
  network: { mode: "none" | "allowlist"; allowedHosts: string[] };
  process: { allowedCommands: string[]; maxProcesses: number };
  resources: { timeoutMs: number; memoryMiB: number; cpuCores: number };
}

export interface SandboxCapabilityCheck {
  id: string;
  status: "pass" | "fail" | "warning";
  message: string;
}

export interface SandboxBackendCapability {
  backendId: "docker-desktop" | "native-macos" | "windows-sandbox";
  label: string;
  status: SandboxCapabilityStatus;
  isolationLevel: SandboxIsolationLevel;
  reason: string;
  checks: SandboxCapabilityCheck[];
  limitations: string[];
}

export interface SandboxCapabilityReport {
  schemaVersion: "1.0";
  platform: SandboxHostPlatform;
  arch: string;
  status: SandboxCapabilityStatus;
  readyForBenchmark: boolean;
  selectedBackend?: SandboxBackendCapability["backendId"];
  policy: SandboxPolicy;
  backends: SandboxBackendCapability[];
  checkedAt: string;
}

export type SandboxSelfTestStatus = "unavailable" | "running" | "passed" | "failed";

export interface SandboxSelfTestRecord {
  schemaVersion: "1.0";
  selfTestId: string;
  platform: SandboxHostPlatform;
  backendId: "docker-desktop";
  status: SandboxSelfTestStatus;
  image?: string;
  handleIds: string[];
  checks: SandboxCapabilityCheck[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  reason?: string;
}

export interface SandboxHandle {
  handleId: string;
  backendId: SandboxBackendCapability["backendId"];
  runtimeArtifactId: string;
  state: "prepared" | "running" | "completed" | "failed" | "cancelled" | "timed-out" | "cleaned";
  createdAt: string;
  updatedAt: string;
}

export interface SandboxPrepareInput {
  runtimeArtifact: RuntimeArtifact;
  benchmarkCase: BenchmarkCase;
  snapshotRoot: string;
}

export interface SandboxExecutionRequest {
  image: string;
  command: { executable: string; args: string[] };
}

export interface SandboxAuditEvent {
  seq: number;
  type: "sandbox.prepared" | "sandbox.started" | "sandbox.stdout" | "sandbox.stderr" | "sandbox.completed" | "sandbox.failed" | "sandbox.cancelled" | "sandbox.timed-out" | "sandbox.collected" | "sandbox.cleaned";
  at: string;
  data: Record<string, unknown>;
}

export interface SandboxCollectedArtifact {
  path: string;
  size: number;
  sha256: string;
  text?: string;
}

export interface SandboxCollectionResult {
  handleId: string;
  artifacts: SandboxCollectedArtifact[];
  auditEvents: SandboxAuditEvent[];
}

export interface SandboxRunner {
  probe(): Promise<SandboxCapabilityReport>;
  prepare(input: SandboxPrepareInput, policy: SandboxPolicy): Promise<SandboxHandle>;
  run(handle: SandboxHandle, request: SandboxExecutionRequest, signal: AbortSignal): AsyncIterable<SandboxAuditEvent>;
  cancel(handle: SandboxHandle): Promise<void>;
  collect(handle: SandboxHandle): Promise<SandboxCollectionResult>;
  cleanup(handle: SandboxHandle): Promise<void>;
}

export type ModelProviderStatus = "ready" | "unavailable";
export type ModelReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelProviderCapability {
  schemaVersion: "1.0";
  providerId: string;
  label: string;
  status: ModelProviderStatus;
  keyConfigured: boolean;
  defaultModel: string;
  reason: string;
  checkedAt: string;
}

export type ModelCredentialSource = "environment" | "os-store" | "none";
export type ModelCredentialBackend = "macos-keychain" | "windows-dpapi" | "unavailable";
export type ModelConnectionStatus = "untested" | "ready" | "failed";

export interface ModelCredentialStoreCapability {
  backend: ModelCredentialBackend;
  status: "ready" | "unavailable" | "error";
  label: string;
  reason: string;
}

export interface ModelConnectionResult {
  status: Exclude<ModelConnectionStatus, "untested">;
  model: string;
  checkedAt: string;
  durationMs: number;
  attempts: number;
  category?: "authentication" | "rate-limit" | "provider" | "protocol" | "timeout" | "cancelled";
  message: string;
}

export interface ModelSettings {
  schemaVersion: "1.0";
  providerId: "openai-responses";
  providerLabel: string;
  model: string;
  timeoutMs: number;
  generationRetries: 0;
  keyConfigured: boolean;
  keySource: ModelCredentialSource;
  credentialStore: ModelCredentialStoreCapability;
  connectionStatus: ModelConnectionStatus;
  lastConnection?: ModelConnectionResult;
  updatedAt: string;
}

export interface UpdateModelSettingsInput {
  providerId?: "openai-responses";
  model?: string;
  timeoutMs?: number;
  apiKey?: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  cacheWriteTokens: number;
}

export interface ModelInvocationRequest {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  instructions: string;
  input: unknown;
  responseSchema: {
    name: string;
    schema: Record<string, unknown>;
  };
}

export interface ModelInvocationResponse<T = unknown> {
  providerId: string;
  responseId: string;
  model: string;
  output: T;
  usage: ModelUsage;
  durationMs: number;
}

export type DesignAssistantMessageKind = "request" | "clarification" | "proposal" | "cancelled";
export type DesignAssistantEvidenceSource = "workspace" | "project" | "schema" | "graph" | "document" | "benchmark";

export interface DesignAssistantEvidence {
  source: DesignAssistantEvidenceSource;
  ref: string;
  fact: string;
}

export type DesignAssistantReadTool = "graph.node" | "graph.neighborhood" | "graph.search" | "docs.read" | "docs.slice" | "benchmark.get";

export interface DesignAssistantToolRead {
  round: number;
  tool: DesignAssistantReadTool;
  ref: string;
  query: string | null;
  status: "completed" | "rejected";
  resultChars: number;
  message: string;
}

export interface DesignAssistantMessage {
  messageId: string;
  role: "user" | "assistant";
  kind: DesignAssistantMessageKind;
  content: string;
  createdAt: string;
  evidence: DesignAssistantEvidence[];
  toolReads?: DesignAssistantToolRead[];
  changeSetId?: string;
  model?: {
    providerId: string;
    requestedModel: string;
    resolvedModel: string;
    reasoningEffort: ModelReasoningEffort;
    usage: ModelUsage;
    durationMs: number;
    callCount?: number;
  };
}

export interface DesignAssistantSession {
  schemaVersion: "1.0";
  sessionId: string;
  workspaceId: string;
  projectId: string;
  skillId: string;
  skillName: string;
  createdAt: string;
  updatedAt: string;
  messages: DesignAssistantMessage[];
}

export interface DesignAssistantSessionSummary {
  sessionId: string;
  workspaceId: string;
  projectId: string;
  skillId: string;
  skillName: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
  busy: boolean;
}

export interface DesignAssistantCancellationResult {
  sessionId: string;
  cancelled: boolean;
  cancelledAt: string;
}

export interface DesignAssistantTurnResult {
  session: DesignAssistantSession;
  message: DesignAssistantMessage;
  changeSet?: ProjectChangeSet;
}

export interface LLMProvider {
  probe(): Promise<ModelProviderCapability>;
  invoke<T>(request: ModelInvocationRequest, signal: AbortSignal): Promise<ModelInvocationResponse<T>>;
}

export interface BenchmarkModelDecision {
  decision: "advance" | "stop";
  nextNodeId: string | null;
  summary: string;
}

export type BenchmarkRunStatus = "queued" | "preparing" | "running" | "completed" | "failed" | "cancelled" | "blocked";
export type BenchmarkAutomaticVerdict = "passed" | "failed" | "inconclusive" | "not-run";
export type BenchmarkFailureCategory =
  | "sandbox-unavailable"
  | "provider-unavailable"
  | "case-invalid"
  | "model-error"
  | "model-protocol-error"
  | "engine-error"
  | "tool-error"
  | "usage-missing"
  | "cancelled"
  | "internal-error";

export interface BenchmarkRuntimeFingerprint {
  schemaVersion: "1.0";
  providerId: string;
  requestedModel: string;
  resolvedModels: string[];
  reasoningEffort: ModelReasoningEffort;
  promptTemplateVersion: string;
  runnerImage: string;
  sandboxBackendId: "docker-desktop";
  sandboxPolicyHash: string;
  runtimeArtifactId?: string;
  revision?: string;
  contentHash?: string;
}

export interface BenchmarkTraceEvent {
  seq: number;
  at: string;
  type:
    | "benchmark.queued"
    | "benchmark.preflight"
    | "sandbox.prepared"
    | "sandbox.started"
    | "sandbox.stdout"
    | "sandbox.stderr"
    | "sandbox.completed"
    | "sandbox.failed"
    | "sandbox.cancelled"
    | "sandbox.timed-out"
    | "sandbox.collected"
    | "sandbox.cleaned"
    | "condition.evaluated"
    | "document.context"
    | "context.queried"
    | "engine.start"
    | "engine.enter"
    | "engine.reject"
    | "engine.pause"
    | "engine.resume"
    | "engine.stop"
    | "engine.complete"
    | "model.request"
    | "model.response"
    | "tool.result"
    | "assertion.result"
    | "benchmark.completed"
    | "benchmark.failed"
    | "benchmark.blocked"
    | "benchmark.cancelled"
    | "review.recorded";
  nodeId?: string;
  data: Record<string, unknown>;
}

export interface BenchmarkObservedToolResult {
  tool: string;
  result: unknown;
}

export interface BenchmarkObservedResult {
  visitedNodeIds: string[];
  terminal: { status: "completed" | "stopped"; nodeId?: string };
  variables: Record<string, unknown>;
  artifacts: SandboxCollectedArtifact[];
  toolResults: BenchmarkObservedToolResult[];
  observedEffects: string[];
}

export interface BenchmarkAssertionResult {
  assertionId: string;
  kind: "path" | "terminal" | "variable" | "artifact" | "tool-result" | "forbidden-effect";
  status: "pass" | "fail" | "inconclusive";
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface BenchmarkRunRecord {
  schemaVersion: "1.0";
  benchmarkRunId: string;
  workspaceId: string;
  projectId: string;
  skillId: string;
  caseId: string;
  status: BenchmarkRunStatus;
  automaticVerdict: BenchmarkAutomaticVerdict;
  fingerprint: BenchmarkRuntimeFingerprint;
  usage: ModelUsage;
  modelCallCount: number;
  sandboxHandleIds: string[];
  events: BenchmarkTraceEvent[];
  assertions: BenchmarkAssertionResult[];
  humanReviews: BenchmarkHumanReview[];
  lineage?: {
    parentBenchmarkRunId: string;
    relation: "rerun";
  } | {
    parentBenchmarkRunId: string;
    relation: "post-repair";
    repairId: string;
    changeSetId: string;
    appliedRevision: string;
  };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failure?: { category: BenchmarkFailureCategory; message: string };
}

export type BenchmarkHumanVerdict = "passed" | "failed" | "inconclusive";

export interface BenchmarkHumanReview {
  reviewId: string;
  verdict: BenchmarkHumanVerdict;
  note: string;
  createdAt: string;
}

export interface BenchmarkCapabilityReport {
  schemaVersion: "1.0";
  ready: boolean;
  provider: ModelProviderCapability;
  sandbox: SandboxCapabilityReport;
  blockers: string[];
  checkedAt: string;
}

export interface PreparedBenchmarkExecution {
  benchmarkCase: BenchmarkCase;
  runtimeArtifact: RuntimeArtifact;
  snapshotRoot: string;
  documents: Record<string, string>;
}

export interface BugReportValidationIssue {
  code: string;
  path: string;
  message: string;
}

export type ImportedBugReportMatchStatus = "matched" | "fingerprint-mismatch" | "skill-missing" | "target-unavailable";

export interface ImportedBugReport {
  reportImportId: string;
  workspaceId: string;
  report: BugReportDocument;
  match: {
    status: ImportedBugReportMatchStatus;
    matchedProjectId?: string;
    currentContentHash?: string;
  };
  importedAt: string;
}

export interface ImportedBugReportDeletionResult {
  reportImportId: string;
  workspaceId: string;
  deleted: true;
  derivedRecordsDeleted: true;
}

export type DiagnosisCategory = "invalid-transition" | "graph-reference" | "condition-evaluation" | "document-context" | "run-control" | "benchmark-assertion" | "benchmark-execution" | "model-output" | "tool-execution" | "environment" | "insufficient-evidence";
export type DiagnosisConfidence = "high" | "medium" | "low";

export interface DiagnosisEvidence {
  source: "trace" | "graph" | "report";
  fact: string;
  seq?: number;
  nodeId?: string;
  field?: string;
}

export interface DiagnosisRepairOption {
  kind: "graph.add-edge";
  title: string;
  operation: GraphEdgeCreateOperation;
}

export interface DiagnosisCandidate {
  candidateId: string;
  category: DiagnosisCategory;
  title: string;
  statement: string;
  confidence: DiagnosisConfidence;
  evidence: DiagnosisEvidence[];
  suggestions: string[];
  verification: {
    method: "inspect-trace" | "rerun-runtime" | "rerun-benchmark" | "check-environment";
    steps: string[];
    successEvidence: string[];
  };
  repair?: DiagnosisRepairOption;
}

export interface DiagnosisRecord {
  schemaVersion: "1.0";
  diagnosisId: string;
  workspaceId: string;
  reportImportId: string;
  reportId: string;
  skillId: string;
  candidates: DiagnosisCandidate[];
  limitations: string[];
  generatedAt: string;
}

export type DiagnosisRepairStatus = "unverified" | "verified" | "failed";
export type DiagnosisVerificationLevel = "runtime" | "benchmark";

export interface DiagnosisRepairRecord {
  schemaVersion: "1.0";
  repairId: string;
  workspaceId: string;
  reportImportId: string;
  diagnosisId: string;
  candidateId: string;
  skillId: string;
  projectId: string;
  sourceRunId: string;
  sourceRevision: string;
  changeSetId: string;
  proposalStatus: ChangeSetStatus;
  status: DiagnosisRepairStatus;
  createdAt: string;
  updatedAt: string;
  appliedRevision?: string;
  verification?: {
    level: DiagnosisVerificationLevel;
    runId: string;
    checkedAt: string;
    evidence: string[];
  };
}

export interface DiagnosisRepairProposal {
  repair: DiagnosisRepairRecord;
  changeSet: ProjectChangeSet;
}

export interface SkillManifest {
  [field: string]: unknown;
  skillId: string;
  name: string;
  version: string;
  description: string;
  capability: SkillCapability;
  entry?: string;
}

export interface WorkspaceMember {
  projectId: string;
  skillId: string;
  displayName: string;
  capability: SkillCapability;
  mode: ProjectMode;
  status: WorkspaceMemberStatus;
  order: number;
  activeRevision: string;
  git: {
    available: boolean;
    changedFiles: number;
  };
  lint: {
    errors: number;
    warnings: number;
  };
  lastRunAt: string | null;
  createdAt: string;
  sourcePath?: string;
  statusDetail?: string;
}

export interface Workspace {
  workspaceId: string;
  name: string;
  selectedProjectId: string | null;
  members: WorkspaceMember[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  selectedProjectId: string | null;
  memberCount: number;
  readyCount: number;
  errorCount: number;
  updatedAt: string;
}

export interface CreateWorkspaceInput {
  name: string;
}

export interface RenameWorkspaceInput {
  name: string;
}

export interface ReorderWorkspaceMembersInput {
  projectIds: string[];
}

export interface RepairWorkspaceMemberInput {
  rootPath: string;
}

export interface WorkspaceDeletionResult {
  workspaceId: string;
  deletedAt: string;
  preservedProjects: Array<{
    projectId: string;
    skillId: string;
    mode: ProjectMode;
    sourcePath?: string;
  }>;
}

export interface CreateManagedSkillInput {
  name: string;
  description?: string;
  capability: SkillCapability;
}

export interface OpenInPlaceProjectInput {
  rootPath: string;
}

export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitFileChange {
  path: string;
  previousPath?: string;
  status: GitFileStatus;
  staged: boolean;
  worktree: boolean;
  binary?: boolean;
}

export interface GitCapability {
  available: boolean;
  reason?: string;
  repositoryRoot?: string;
  branch?: string;
  head?: string;
}

export type GitReferenceKind = "head" | "commit" | "tag";

export interface GitComparisonReference {
  kind: GitReferenceKind;
  name: string;
  oid: string;
  shortOid: string;
  subject?: string;
  committedAt?: string;
}

export interface GitReferencesResult {
  capability: GitCapability;
  refs: GitComparisonReference[];
}

export interface GitBinaryChange {
  path: string;
  previousPath?: string;
  status: GitFileStatus;
  baseBytes: number | null;
  currentBytes: number | null;
}

export interface GitDiffResult {
  capability: GitCapability;
  base: string;
  baseOid?: string;
  files: GitFileChange[];
  patch: string;
  truncated: boolean;
  binaryChanges: GitBinaryChange[];
  binaryTruncated: boolean;
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };
