import { z } from 'zod';

export const STAGES = ['INTAKE', 'CODEBASE_SCAN', 'ANALYSIS', 'CLARIFY', 'BREAKDOWN', 'DESIGN', 'PLANNING', 'DEVELOP', 'TEST', 'BUGFIX', 'DONE', 'CHANGE'] as const;
export type Stage = (typeof STAGES)[number];

export type RequestStatus = 'running' | 'awaiting_approval' | 'awaiting_customer' | 'paused' | 'needs_human' | 'failed' | 'done' | 'cancelled';
export type ProjectKind = 'new' | 'existing';
export type RunMode = 'auto' | 'review';
export type SoftwareType = 'web' | 'mobile' | 'api' | 'background';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'paused';
export type AnswerSource = 'excel' | 'web' | 'staff';
export type TestStatus = 'P' | 'F' | 'PE';
export type UserRole = 'admin' | 'member';
export type CrKind = 'add' | 'modify' | 'remove' | 'nfr' | 'other';
export type CrSource = 'staff' | 'customer';
export type CrStatus = 'proposed' | 'pending' | 'analyzing' | 'awaiting_decision' | 'accepted' | 'rejected' | 'applied';
export type ScopeStatus = 'active' | 'cancelled';
export const SCOPE_STATUSES = ['active', 'cancelled'] as const;

// ---- Zod schemas for Claude outputs (spec section 8/9) ----

export const QUESTION_CATEGORIES = ['Chức năng', 'Phi chức năng', 'Hiệu năng', 'Dữ liệu', 'Tích hợp', 'Giao diện', 'Khác'] as const;

export const QuestionSchema = z.object({
  id: z.string(),
  category: z.string(),
  question: z.string(),
  why: z.string(),
  type: z.enum(['single', 'multi', 'text']),
  options: z.array(z.string()).default([]),
  suggested_answer: z.string().default(''),
  priority: z.enum(['must', 'should']),
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionsOut = z.object({ questions: z.array(QuestionSchema) });

export const FeatureSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  type_code: z.string(),
  unit_test: z.boolean(),
  note: z.string().default(''),
  kind: z.enum(['function', 'nonfunction']).default('function'),
  scope_status: z.enum(SCOPE_STATUSES).default('active'),
});
export type FeatureOut = z.infer<typeof FeatureSchema>;
export const FeaturesOut = z.object({ features: z.array(FeatureSchema) });

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  feature_id: z.string(),
  depends_on: z.array(z.string()).default([]),
  scope_status: z.enum(SCOPE_STATUSES).default('active'),
});
export const TasksOut = z.object({ tasks: z.array(TaskSchema) });

export const TestCaseSchema = z.object({
  id: z.string(),
  feature_id: z.string(),
  purpose: z.string(),
  data: z.string().default(''),
  steps: z.string(),
  expected: z.string(),
  scope_status: z.enum(SCOPE_STATUSES).default('active'),
});
export const TestCasesOut = z.object({ test_cases: z.array(TestCaseSchema) });

export const TestResultSchema = z.object({
  tc_id: z.string(),
  status: z.enum(['P', 'F', 'PE']),
  real_result: z.string().default(''),
  evidence: z.array(z.string()).default([]),
  comment: z.string().default(''),
});
export const TestResultsOut = z.object({ results: z.array(TestResultSchema) });

export const ReviewOut = z.object({
  approved: z.boolean(),
  comments: z.array(z.object({
    file: z.string(),
    line: z.number().optional(),
    severity: z.string(),
    body: z.string(),
  })),
});

export const CR_REENTER_STAGES = ['ANALYSIS', 'BREAKDOWN', 'DESIGN', 'PLANNING', 'DEVELOP', 'TEST'] as const;
export const ImpactOut = z.object({
  cr_id: z.string(),
  summary: z.string(),
  scope: z.object({
    add: z.array(z.object({ name: z.string(), description: z.string() })),
    modify: z.array(z.object({ feature_id: z.string(), change: z.string() })),
    remove: z.array(z.string()),
  }),
  affected: z.object({ features: z.array(z.string()), tasks: z.array(z.string()), test_cases: z.array(z.string()) }),
  questions: z.array(QuestionSchema).default([]),
  effort_delta_mh: z.number(),
  risks: z.array(z.string()).default([]),
  reenter: z.enum(CR_REENTER_STAGES),
});
export type ImpactOutT = z.infer<typeof ImpactOut>;

// ---- DB row types ----

export interface NewRequest {
  title: string;
  description: string;
  perfReq: string;
  nonfuncReq: string;
  projectKind: ProjectKind;
  gitlabProject: string | null;
  softwareTypes: SoftwareType[];
  runMode: RunMode;
  createdBy: number | null;
}

export interface RequestRow extends NewRequest {
  id: string;
  stage: Stage;
  status: RequestStatus;
  clarifyRound: number;
  baselineVersion: number;
  iteration: number;
  createdAt: number;
  updatedAt: number;
}

export type RequestPatch = Partial<Omit<RequestRow, 'id' | 'createdAt'>>;

export interface UserRow { id: number; username: string; passwordHash: string; role: UserRole; gitlabTokenEnc: string | null; createdAt: number }

export interface AttachmentRow { id: number; requestId: string; filename: string; path: string; size: number; createdAt: number }

export interface StageRunRow {
  id: number; requestId: string; stage: Stage; attempt: number; status: string;
  feedback: string | null; startedAt: number; finishedAt: number | null; claudeSessionId: string | null; error: string | null;
}

export interface JobRow {
  id: number; requestId: string | null; kind: string; payload: unknown; status: JobStatus;
  runAfter: number; attempts: number; lastError: string | null;
}

export interface QuestionRow extends Question { requestId: string; round: number }
export interface AnswerRow { requestId: string; questionId: string; answer: string; source: AnswerSource; createdAt: number }
export interface SurveyLinkRow { token: string; requestId: string; round: number; expiresAt: number; submittedAt: number | null }
export interface EventRow { id: number; requestId: string; ts: number; level: string; message: string }

export interface FeatureRow {
  id: string; code: string; name: string; description: string; typeCode: string; unitTest: boolean; note: string; kind: 'function' | 'nonfunction';
  scopeStatus: ScopeStatus; changedByCr: string | null;
}
export interface TaskRow {
  id: string; title: string; featureId: string | null; dependsOn: string[]; status: string; reviewRounds: number; branch: string | null; mrIid: number | null;
  scopeStatus: ScopeStatus; changedByCr: string | null;
}
export interface TestCaseRow {
  id: string; featureId: string | null; purpose: string; data: string; steps: string; expected: string;
  status1: TestStatus | null; status2: TestStatus | null; realResult: string | null; evidence: string[]; comment: string | null;
  scopeStatus: ScopeStatus; changedByCr: string | null; baseline: number | null;
}
export interface BugRow {
  tcId: string; gitlabIid: number | null; fixAttempts: number; status: string;
  /** Why the bug was closed outside TEST (e.g. "Đóng do CR-01"). */
  note?: string | null;
}

export interface ChangeRequestRow {
  id: string; requestId: string; title: string; description: string; kind: CrKind; source: CrSource; status: CrStatus;
  createdBy: number | null; createdAt: number; decidedBy: number | null; decidedAt: number | null; decisionNote: string | null;
  /**
   * Baseline the CR was decided against. NOTE: rejected CRs also carry baselineFrom — it is the pipeline's
   * "decision finalized" marker, not proof the CR changed the baseline. Consumers listing CRs of a baseline must
   * filter by status (`accepted`/`applied`) or by `baselineTo != null`.
   */
  baselineFrom: number | null;
  /** Baseline produced by accepting this CR (null unless accepted and finalized). */
  baselineTo: number | null;
  reenterStage: Stage | null;
  interruptedStage: Stage | null; interruptedStatus: RequestStatus | null;
  /** run_after of the interrupted request's parked job (rate-limit pause), reused when a paused origin is restored. */
  interruptedRunAfter: number | null;
  impactSummary: string | null;
}
export interface CrAttachmentRow { crId: string; requestId: string; filename: string; path: string }
