import type {
  ApplyChangeSetResult,
  BenchmarkCaseEntry,
  BenchmarkCapabilityReport,
  BenchmarkRunRecord,
  BugReportRecord,
  BugReportDeletionResult,
  BugReportSanitizationMode,
  CreateManagedSkillInput,
  CreateChangeSetInput,
  CreateWorkspaceInput,
  DocumentEntry,
  DocumentFile,
  DocumentReference,
  DiagnosisRecord,
  DiagnosisRepairProposal,
  DiagnosisRepairRecord,
  DesignAssistantSession,
  DesignAssistantSessionSummary,
  DesignAssistantCancellationResult,
  DesignAssistantTurnResult,
  ExecutionTracePage,
  GraphLintIssue,
  ImportedBugReport,
  ImportedBugReportDeletionResult,
  GenericExportRecord,
  GenericExportDeletionResult,
  GitDiffResult,
  GitReferencesResult,
  ProjectRun,
  ProjectRunView,
  ProjectChangeSet,
  ProjectRevision,
  ProjectRevisionStatus,
  ProjectTransactionJournal,
  ModelProviderCapability,
  ModelConnectionResult,
  ModelSettings,
  UpdateModelSettingsInput,
  ProjectDocumentSlice,
  ProjectBenchmarkCase,
  ProjectAssetEntry,
  ProjectAssetFile,
  ReportBenchmarkCandidate,
  ReportFixture,
  ReportFixtureReplay,
  RuntimeBenchmarkCandidate,
  SandboxCapabilityReport,
  SandboxSelfTestRecord,
  SkillImportPreview,
  SkillManifest,
  SkillGraph,
  Workspace,
  WorkspaceDeletionResult,
  WorkspaceSummary
} from "@skill-designer/engine";

interface ApiSuccess<T> {
  ok: true;
  data: T;
}

interface ApiFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let tokenPromise: Promise<string> | undefined;

async function sessionToken(): Promise<string> {
  tokenPromise ??= fetch("/api/session", { headers: { Accept: "application/json" } })
    .then(async (response) => {
      const payload = (await response.json()) as ApiSuccess<{ token: string }> | ApiFailure;
      if (!payload.ok) throw new ApiError(payload.error.message, payload.error.code, payload.error.details);
      return payload.data.token;
    })
    .catch((error) => {
      tokenPromise = undefined;
      throw error;
    });
  return tokenPromise;
}

async function request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const token = await sessionToken();
  const response = await fetch(pathname, {
    ...init,
    headers: {
      Accept: "application/json",
      "x-skill-designer-token": token,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });
  const payload = (await response.json()) as ApiSuccess<T> | ApiFailure;
  if (!payload.ok) throw new ApiError(payload.error.message, payload.error.code, payload.error.details);
  return payload.data;
}

function traceSocketUrl(projectId: string, runId: string, afterSeq: number): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/projects/${projectId}/traces/${runId}/stream?afterSeq=${afterSeq}`;
}

export const api = {
  getModelSettings: () => request<ModelSettings>("/api/settings/model"),
  updateModelSettings: (input: UpdateModelSettingsInput) =>
    request<ModelSettings>("/api/settings/model", { method: "PUT", body: JSON.stringify(input) }),
  testModelConnection: () => request<ModelConnectionResult>("/api/settings/model/test", { method: "POST", body: "{}" }),
  deleteStoredModelKey: () => request<ModelSettings>("/api/settings/model", { method: "DELETE" }),
  getDesignAssistantCapabilities: () => request<ModelProviderCapability>("/api/assistant/capabilities"),
  getSkillManifest: (projectId: string) => request<{ manifest: SkillManifest; activeRevision: string }>(`/api/projects/${projectId}/manifest`),
  listAssets: (projectId: string) => request<ProjectAssetEntry[]>(`/api/projects/${projectId}/assets`),
  readAsset: (projectId: string, assetPath: string) => request<ProjectAssetFile>(`/api/projects/${projectId}/asset?path=${encodeURIComponent(assetPath)}`),
  createDesignAssistantSession: (projectId: string, workspaceId: string) =>
    request<DesignAssistantSession>(`/api/projects/${projectId}/assistant/sessions`, { method: "POST", body: JSON.stringify({ workspaceId }) }),
  listDesignAssistantSessions: (workspaceId: string, projectId?: string) =>
    request<DesignAssistantSessionSummary[]>(`/api/workspaces/${workspaceId}/assistant/sessions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  getDesignAssistantSession: (sessionId: string) => request<DesignAssistantSession>(`/api/assistant/sessions/${sessionId}`),
  sendDesignAssistantMessage: (sessionId: string, input: { content: string; model?: string; reasoningEffort?: import("@skill-designer/engine").ModelReasoningEffort }) =>
    request<DesignAssistantTurnResult>(`/api/assistant/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify(input) }),
  cancelDesignAssistantMessage: (sessionId: string) =>
    request<DesignAssistantCancellationResult>(`/api/assistant/sessions/${sessionId}/cancel`, { method: "POST", body: "{}" }),
  getSandboxCapabilities: () => request<SandboxCapabilityReport>("/api/sandbox/capabilities"),
  getSandboxSelfTest: () => request<SandboxSelfTestRecord | null>("/api/sandbox/self-test"),
  runSandboxSelfTest: () => request<SandboxSelfTestRecord>("/api/sandbox/self-test", { method: "POST", body: "{}" }),
  getBenchmarkCapabilities: () => request<BenchmarkCapabilityReport>("/api/benchmark/capabilities"),
  listWorkspaces: () => request<WorkspaceSummary[]>("/api/workspaces"),
  getWorkspace: (workspaceId: string) => request<Workspace>(`/api/workspaces/${workspaceId}`),
  createWorkspace: (input: CreateWorkspaceInput) =>
    request<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify(input) }),
  renameWorkspace: (workspaceId: string, name: string) =>
    request<Workspace>(`/api/workspaces/${workspaceId}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteWorkspace: (workspaceId: string) =>
    request<WorkspaceDeletionResult>(`/api/workspaces/${workspaceId}`, { method: "DELETE" }),
  listImportedBugReports: (workspaceId: string) =>
    request<ImportedBugReport[]>(`/api/workspaces/${workspaceId}/report-imports`),
  importBugReport: (workspaceId: string, contentBase64: string) =>
    request<ImportedBugReport>(`/api/workspaces/${workspaceId}/report-imports`, { method: "POST", body: JSON.stringify({ contentBase64 }) }),
  deleteImportedBugReport: (workspaceId: string, reportImportId: string) =>
    request<ImportedBugReportDeletionResult>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}`, { method: "DELETE" }),
  listDiagnoses: (workspaceId: string, reportImportId: string) =>
    request<DiagnosisRecord[]>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/diagnoses`),
  createDiagnosis: (workspaceId: string, reportImportId: string) =>
    request<DiagnosisRecord>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/diagnoses`, { method: "POST", body: "{}" }),
  listReportFixtures: (workspaceId: string, reportImportId: string) =>
    request<ReportFixture[]>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/fixtures`),
  createReportFixture: (workspaceId: string, reportImportId: string) =>
    request<{ fixture: ReportFixture; replay: ReportFixtureReplay }>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/fixtures`, { method: "POST", body: "{}" }),
  listReportBenchmarkCandidates: (workspaceId: string, reportImportId: string) =>
    request<ReportBenchmarkCandidate[]>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/benchmark-candidates`),
  createReportBenchmarkCandidate: (workspaceId: string, reportImportId: string) =>
    request<ReportBenchmarkCandidate>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/benchmark-candidates`, { method: "POST", body: "{}" }),
  createReportBenchmarkChangeSet: (workspaceId: string, reportImportId: string, candidateId: string, benchmarkCase: ReportBenchmarkCandidate["case"]) =>
    request<{ candidate: ReportBenchmarkCandidate; changeSet: ProjectChangeSet }>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/benchmark-candidates/${candidateId}/changeset`, {
      method: "POST", body: JSON.stringify({ case: benchmarkCase })
    }),
  confirmReportBenchmarkCandidate: (workspaceId: string, reportImportId: string, candidateId: string, input: { digest: string; baseRevision: string }) =>
    request<{ candidate: ReportBenchmarkCandidate; applied: ApplyChangeSetResult }>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/benchmark-candidates/${candidateId}/confirm-and-apply`, {
      method: "POST", body: JSON.stringify(input)
    }),
  rejectReportBenchmarkCandidate: (workspaceId: string, reportImportId: string, candidateId: string, input: import("@skill-designer/engine").RejectChangeSetInput) =>
    request<{ candidate: ReportBenchmarkCandidate; changeSet: ProjectChangeSet }>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/benchmark-candidates/${candidateId}/reject`, {
      method: "POST", body: JSON.stringify(input)
    }),
  listDiagnosisRepairs: (workspaceId: string, reportImportId: string) =>
    request<DiagnosisRepairRecord[]>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/repairs`),
  createDiagnosisRepair: (workspaceId: string, reportImportId: string, diagnosisId: string, candidateId: string) =>
    request<DiagnosisRepairProposal>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/repairs`, {
      method: "POST", body: JSON.stringify({ diagnosisId, candidateId })
    }),
  confirmDiagnosisRepair: (workspaceId: string, reportImportId: string, repairId: string, input: { digest: string; baseRevision: string }) =>
    request<{ repair: DiagnosisRepairRecord; applied: ApplyChangeSetResult }>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/repairs/${repairId}/confirm-and-apply`, {
      method: "POST", body: JSON.stringify(input)
    }),
  rejectDiagnosisRepair: (workspaceId: string, reportImportId: string, repairId: string, input: import("@skill-designer/engine").RejectChangeSetInput) =>
    request<{ repair: DiagnosisRepairRecord; changeSet: ProjectChangeSet }>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/repairs/${repairId}/reject`, {
      method: "POST", body: JSON.stringify(input)
    }),
  verifyDiagnosisRepair: (workspaceId: string, reportImportId: string, repairId: string, runId: string) =>
    request<DiagnosisRepairRecord>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/repairs/${repairId}/verify`, {
      method: "POST", body: JSON.stringify({ level: "runtime", runId })
    }),
  startPostRepairBenchmark: (workspaceId: string, reportImportId: string, repairId: string, input: { model?: string; reasoningEffort?: import("@skill-designer/engine").ModelReasoningEffort } = {}) =>
    request<BenchmarkRunRecord>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/repairs/${repairId}/benchmark`, { method: "POST", body: JSON.stringify(input) }),
  verifyPostRepairBenchmark: (workspaceId: string, reportImportId: string, repairId: string, benchmarkRunId: string) =>
    request<DiagnosisRepairRecord>(`/api/workspaces/${workspaceId}/report-imports/${reportImportId}/repairs/${repairId}/verify-benchmark`, { method: "POST", body: JSON.stringify({ benchmarkRunId }) }),
  createManagedSkill: (workspaceId: string, input: CreateManagedSkillInput) =>
    request<Workspace>(`/api/workspaces/${workspaceId}/members`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  openInPlaceProject: (workspaceId: string, rootPath: string) =>
    request<Workspace>(`/api/workspaces/${workspaceId}/in-place`, { method: "POST", body: JSON.stringify({ rootPath }) }),
  createSkillImport: (workspaceId: string, input: { folderName: string; files: Array<{ path: string; contentBase64: string }> }) =>
    request<SkillImportPreview>(`/api/workspaces/${workspaceId}/imports`, { method: "POST", body: JSON.stringify(input) }),
  confirmSkillImport: (importId: string, input: { workspaceId: string; digest: string }) =>
    request<Workspace>(`/api/imports/${importId}/confirm`, { method: "POST", body: JSON.stringify(input) }),
  updateSkillImportReview: (importId: string, input: import("@skill-designer/engine").UpdateSkillImportReviewInput) =>
    request<import("@skill-designer/engine").SkillImportCandidate>(`/api/imports/${importId}/review`, { method: "PATCH", body: JSON.stringify(input) }),
  reparseSkillImport: (importId: string, input: { workspaceId: string; reviewRevision: number }) =>
    request<import("@skill-designer/engine").SkillImportCandidate>(`/api/imports/${importId}/reparse`, { method: "POST", body: JSON.stringify(input) }),
  getLatestImportLLMParse: (importId: string, workspaceId: string) =>
    request<import("@skill-designer/engine").ImportLLMParseRun | null>(`/api/imports/${importId}/llm-parse?workspaceId=${encodeURIComponent(workspaceId)}`),
  startImportLLMParse: (importId: string, input: import("@skill-designer/engine").StartImportLLMParseInput) =>
    request<import("@skill-designer/engine").ImportLLMParseResult>(`/api/imports/${importId}/llm-parse`, { method: "POST", body: JSON.stringify(input) }),
  cancelImportLLMParse: (importId: string, workspaceId: string) =>
    request<import("@skill-designer/engine").ImportLLMParseRun | null>(`/api/imports/${importId}/llm-parse/cancel`, { method: "POST", body: JSON.stringify({ workspaceId }) }),
  resolveSkillImportReparse: (importId: string, input: import("@skill-designer/engine").ResolveImportReparseInput) =>
    request<import("@skill-designer/engine").SkillImportCandidate>(`/api/imports/${importId}/reparse/resolve`, { method: "POST", body: JSON.stringify(input) }),
  cancelSkillImport: (importId: string, workspaceId: string) =>
    request<Workspace>(`/api/imports/${importId}/cancel`, { method: "POST", body: JSON.stringify({ workspaceId }) }),
  selectProject: (workspaceId: string, projectId: string) =>
    request<Workspace>(`/api/workspaces/${workspaceId}/select`, {
      method: "POST",
      body: JSON.stringify({ projectId })
    }),
  reorderWorkspaceMembers: (workspaceId: string, projectIds: string[]) =>
    request<Workspace>(`/api/workspaces/${workspaceId}/members/order`, {
      method: "PUT",
      body: JSON.stringify({ projectIds })
    }),
  repairWorkspaceMember: (workspaceId: string, projectId: string, rootPath: string) =>
    request<Workspace>(`/api/workspaces/${workspaceId}/members/${projectId}/repair`, {
      method: "POST",
      body: JSON.stringify({ rootPath })
    }),
  removeMember: (workspaceId: string, projectId: string) =>
    request<Workspace>(`/api/workspaces/${workspaceId}/members/${projectId}`, { method: "DELETE" }),
  getProjectGraph: (projectId: string) =>
    request<{ graph: SkillGraph; lint: GraphLintIssue[]; activeRevision: string }>(`/api/projects/${projectId}/graph`),
  getProjectGitReferences: (projectId: string) => request<GitReferencesResult>(`/api/projects/${projectId}/git/refs`),
  getProjectGitDiff: (projectId: string, base = "HEAD") => request<GitDiffResult>(`/api/projects/${projectId}/git/diff?base=${encodeURIComponent(base)}`),
  listDocuments: (projectId: string) => request<DocumentEntry[]>(`/api/projects/${projectId}/docs`),
  readDocument: (projectId: string, documentPath: string) =>
    request<DocumentFile>(`/api/projects/${projectId}/docs/file?path=${encodeURIComponent(documentPath)}`),
  getDocumentSlice: (projectId: string, documentPath: string, anchor = "") =>
    request<ProjectDocumentSlice>(`/api/projects/${projectId}/docs/slice?path=${encodeURIComponent(documentPath)}&anchor=${encodeURIComponent(anchor)}`),
  listDocumentReferences: (projectId: string, documentPath?: string) =>
    request<DocumentReference[]>(`/api/projects/${projectId}/docs/references${documentPath ? `?path=${encodeURIComponent(documentPath)}` : ""}`),
  listBenchmarkCases: (projectId: string) => request<BenchmarkCaseEntry[]>(`/api/projects/${projectId}/benchmark-cases`),
  readBenchmarkCase: (projectId: string, caseId: string) =>
    request<ProjectBenchmarkCase>(`/api/projects/${projectId}/benchmark-cases/${caseId}`),
  listBenchmarkRuns: (projectId: string) => request<BenchmarkRunRecord[]>(`/api/projects/${projectId}/benchmark-runs`),
  getBenchmarkRun: (projectId: string, benchmarkRunId: string) => request<BenchmarkRunRecord>(`/api/projects/${projectId}/benchmark-runs/${benchmarkRunId}`),
  startBenchmarkRun: (projectId: string, input: { workspaceId: string; caseId: string; model: string; reasoningEffort: import("@skill-designer/engine").ModelReasoningEffort; parentBenchmarkRunId?: string }) =>
    request<BenchmarkRunRecord>(`/api/projects/${projectId}/benchmark-runs`, { method: "POST", body: JSON.stringify(input) }),
  startBenchmarkBatch: (projectId: string, input: { workspaceId: string; caseIds: string[]; model: string; reasoningEffort: import("@skill-designer/engine").ModelReasoningEffort }) =>
    request<BenchmarkRunRecord[]>(`/api/projects/${projectId}/benchmark-runs/batch`, { method: "POST", body: JSON.stringify(input) }),
  cancelBenchmarkRun: (projectId: string, benchmarkRunId: string) =>
    request<BenchmarkRunRecord>(`/api/projects/${projectId}/benchmark-runs/${benchmarkRunId}/cancel`, { method: "POST", body: "{}" }),
  reviewBenchmarkRun: (projectId: string, benchmarkRunId: string, input: { verdict: import("@skill-designer/engine").BenchmarkHumanVerdict; note: string }) =>
    request<BenchmarkRunRecord>(`/api/projects/${projectId}/benchmark-runs/${benchmarkRunId}/reviews`, { method: "POST", body: JSON.stringify(input) }),
  createBenchmarkBugReport: (projectId: string, benchmarkRunId: string, input: { workspaceId: string; sanitizationMode: BugReportSanitizationMode; userNote: string }) =>
    request<BugReportRecord>(`/api/projects/${projectId}/benchmark-runs/${benchmarkRunId}/reports`, { method: "POST", body: JSON.stringify(input) }),
  createChangeSet: (projectId: string, input: CreateChangeSetInput) =>
    request<ProjectChangeSet>(`/api/projects/${projectId}/changesets`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  createUndoChangeSet: (projectId: string, input: import("@skill-designer/engine").CreateUndoChangeSetInput) =>
    request<ProjectChangeSet>(`/api/projects/${projectId}/undo-changesets`, { method: "POST", body: JSON.stringify(input) }),
  getChangeSet: (changeSetId: string) => request<ProjectChangeSet>(`/api/changesets/${changeSetId}`),
  rejectChangeSet: (changeSetId: string, input: import("@skill-designer/engine").RejectChangeSetInput) =>
    request<ProjectChangeSet>(`/api/changesets/${changeSetId}/reject`, { method: "POST", body: JSON.stringify(input) }),
  reproposeChangeSet: (changeSetId: string, input: import("@skill-designer/engine").ReproposeChangeSetInput) =>
    request<ProjectChangeSet>(`/api/changesets/${changeSetId}/repropose`, { method: "POST", body: JSON.stringify(input) }),
  confirmAndApplyChangeSet: (changeSetId: string, confirmation: { digest: string; baseRevision: string }) =>
    request<ApplyChangeSetResult>(
      `/api/changesets/${changeSetId}/confirm-and-apply`,
      { method: "POST", body: JSON.stringify(confirmation) }
    ),
  listRevisions: (projectId: string) => request<ProjectRevision[]>(`/api/projects/${projectId}/revisions`),
  listProjectTransactions: (projectId: string) => request<ProjectTransactionJournal[]>(`/api/projects/${projectId}/transactions`),
  getRevisionStatus: (projectId: string) => request<ProjectRevisionStatus>(`/api/projects/${projectId}/revision-status`),
  acknowledgeBaseline: (projectId: string, input: { workspaceId: string; revisionId: string; snapshotId: string }) =>
    request<ProjectRevisionStatus>(`/api/projects/${projectId}/baseline`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  createGenericExport: (projectId: string, input: { workspaceId: string; revisionId: string; profile: "generic/1" }) =>
    request<GenericExportRecord>(`/api/projects/${projectId}/exports`, { method: "POST", body: JSON.stringify(input) }),
  listGenericExports: (projectId: string, workspaceId: string) =>
    request<GenericExportRecord[]>(`/api/projects/${projectId}/exports?workspaceId=${encodeURIComponent(workspaceId)}`),
  deleteGenericExport: (exportId: string, workspaceId: string) =>
    request<GenericExportDeletionResult>(`/api/exports/${exportId}`, { method: "DELETE", body: JSON.stringify({ workspaceId }) }),
  confirmGenericExport: (exportId: string, input: { digest: string; revisionId: string }) =>
    request<GenericExportRecord>(`/api/exports/${exportId}/confirm`, { method: "POST", body: JSON.stringify(input) }),
  downloadGenericExport: async (exportId: string): Promise<{ blob: Blob; fileName: string }> => {
    const token = await sessionToken();
    const response = await fetch(`/api/exports/${exportId}/download`, {
      headers: { Accept: "application/zip", "x-skill-designer-token": token }
    });
    if (!response.ok) {
      const payload = (await response.json()) as ApiFailure;
      throw new ApiError(payload.error.message, payload.error.code, payload.error.details);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const fileName = disposition.match(/filename="([^"]+)"/i)?.[1] ?? `skill-export-${exportId}.zip`;
    return { blob: await response.blob(), fileName };
  },
  listRuns: (projectId: string) => request<ProjectRun[]>(`/api/projects/${projectId}/runs`),
  getRuntimeArtifactStorage: (projectId: string, workspaceId: string) =>
    request<import("@skill-designer/engine").RuntimeArtifactStorageStatus>(`/api/projects/${projectId}/runtime-artifacts/storage?workspaceId=${encodeURIComponent(workspaceId)}`),
  cleanupRuntimeArtifacts: (projectId: string, workspaceId: string) =>
    request<import("@skill-designer/engine").RuntimeArtifactCleanupResult>(`/api/projects/${projectId}/runtime-artifacts/storage`, {
      method: "POST", body: JSON.stringify({ workspaceId })
    }),
  createRun: (projectId: string, input: { workspaceId: string; initialVariables?: Record<string, unknown> }) =>
    request<ProjectRunView>(`/api/projects/${projectId}/runs`, { method: "POST", body: JSON.stringify(input) }),
  getRun: (projectId: string, runId: string) => request<ProjectRunView>(`/api/projects/${projectId}/runs/${runId}`),
  createRuntimeBenchmarkCandidate: (projectId: string, runId: string, workspaceId: string) =>
    request<RuntimeBenchmarkCandidate>(`/api/projects/${projectId}/runs/${runId}/benchmark-candidate`, {
      method: "POST", body: JSON.stringify({ workspaceId })
    }),
  getTraceEvents: (projectId: string, runId: string, afterSeq = 0) =>
    request<ExecutionTracePage>(`/api/projects/${projectId}/traces/${runId}/events?afterSeq=${afterSeq}`),
  createBugReport: (projectId: string, runId: string, input: { workspaceId: string; sanitizationMode: BugReportSanitizationMode; userNote: string }) =>
    request<BugReportRecord>(`/api/projects/${projectId}/runs/${runId}/reports`, { method: "POST", body: JSON.stringify(input) }),
  listBugReports: (projectId: string, workspaceId: string) =>
    request<BugReportRecord[]>(`/api/projects/${projectId}/reports?workspaceId=${encodeURIComponent(workspaceId)}`),
  deleteBugReport: (reportId: string, workspaceId: string) =>
    request<BugReportDeletionResult>(`/api/reports/${reportId}`, { method: "DELETE", body: JSON.stringify({ workspaceId }) }),
  confirmBugReport: (reportId: string, digest: string) =>
    request<BugReportRecord>(`/api/reports/${reportId}/confirm`, { method: "POST", body: JSON.stringify({ digest }) }),
  importStoredBugReport: (reportId: string, workspaceId: string) =>
    request<ImportedBugReport>(`/api/reports/${reportId}/import-to-workspace`, { method: "POST", body: JSON.stringify({ workspaceId }) }),
  downloadBugReport: async (reportId: string, format: "json" | "markdown" = "json"): Promise<{ blob: Blob; fileName: string }> => {
    const token = await sessionToken();
    const response = await fetch(`/api/reports/${reportId}/download?format=${format}`, {
      headers: { Accept: format === "markdown" ? "text/markdown" : "application/json", "x-skill-designer-token": token }
    });
    if (!response.ok) {
      const payload = (await response.json()) as ApiFailure;
      throw new ApiError(payload.error.message, payload.error.code, payload.error.details);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const fileName = encodedName
      ? decodeURIComponent(encodedName)
      : disposition.match(/filename="([^"]+)"/i)?.[1] ?? `skill-${reportId}.report.json`;
    return { blob: await response.blob(), fileName };
  },
  subscribeTrace: (
    projectId: string,
    runId: string,
    afterSeq: number,
    onPage: (page: ExecutionTracePage) => void,
    onError: (error: Error) => void
  ): (() => void) => {
    let stopped = false;
    let cursor = afterSeq;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;

    const connect = async () => {
      try {
        const token = await sessionToken();
        if (stopped) return;
        socket = new WebSocket(traceSocketUrl(projectId, runId, cursor), ["skill-designer.trace.v1", token]);
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(String(event.data)) as
              | { type: "trace.page"; data: ExecutionTracePage }
              | { type: "trace.error"; error: { code: string; message: string } };
            if (message.type === "trace.error") {
              onError(new ApiError(message.error.message, message.error.code));
              return;
            }
            cursor = Math.max(cursor, message.data.latestSeq);
            onPage(message.data);
          } catch (cause) {
            onError(cause instanceof Error ? cause : new Error("Trace 消息解析失败"));
          }
        };
        socket.onclose = (event) => {
          if (stopped || event.code === 1000 || event.code === 1008) return;
          reconnectTimer = window.setTimeout(() => void connect(), 750);
        };
      } catch (cause) {
        onError(cause instanceof Error ? cause : new Error("Trace 连接失败"));
        if (!stopped) reconnectTimer = window.setTimeout(() => void connect(), 750);
      }
    };

    void connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close(1000, "Trace view closed");
    };
  },
  commandRun: (projectId: string, runId: string, command: "next" | "pause" | "resume" | "stop", input: Record<string, unknown> = {}) =>
    request<ProjectRunView>(`/api/projects/${projectId}/runs/${runId}/${command}`, { method: "POST", body: JSON.stringify(input) }),
  getRuntimeDialog: (projectId: string, runId: string, workspaceId: string) =>
    request<import("@skill-designer/engine").RuntimeDialogSession>(`/api/projects/${projectId}/runs/${runId}/dialog?workspaceId=${encodeURIComponent(workspaceId)}`),
  sendRuntimeDialogMessage: (projectId: string, runId: string, input: { workspaceId: string; content: string; model?: string; reasoningEffort?: import("@skill-designer/engine").ModelReasoningEffort }) =>
    request<import("@skill-designer/engine").RuntimeDialogTurnResult>(`/api/projects/${projectId}/runs/${runId}/dialog`, { method: "POST", body: JSON.stringify(input) }),
  cancelRuntimeDialog: (projectId: string, runId: string, workspaceId: string) =>
    request<import("@skill-designer/engine").RuntimeDialogCancellationResult>(`/api/projects/${projectId}/runs/${runId}/dialog/cancel`, { method: "POST", body: JSON.stringify({ workspaceId }) })
};
