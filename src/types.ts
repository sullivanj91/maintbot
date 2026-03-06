// Shared types for the Autopilot maintenance agent

export type TriggerType =
  | "scheduled"
  | "pr-merged"
  | "issue-urgent"
  | "incident"
  | "manual";

export interface SessionId {
  /** ISO 8601 timestamp, e.g. "2026-03-05T14:00Z" */
  timestamp: string;
  /** Compact label used in commit prefixes, e.g. "20260305-1400" */
  label: string;
}

export interface SessionContext {
  id: SessionId;
  triggerType: TriggerType;
  /** PR number, issue number, or incident ID that triggered this session */
  triggerRef?: string;
  /** Absolute path to the target repo root */
  repoPath: string;
  /** GitHub owner/repo slug of the target repo */
  repoSlug: string;
  /** GitHub owner/repo slug of the Autopilot repo itself */
  autopilotRepoSlug: string;
  /** Absolute path to the Autopilot repo root */
  autopilotRepoPath: string;
}

// ─── Journal ────────────────────────────────────────────────────────────────

export interface JournalEntry {
  sessionId: SessionId;
  triggerType: TriggerType;
  triggerRef?: string;
  workDone: string[];
  failedAttempts: string[];
  observations: string[];
  nextSessionHints: string[];
  /** Issue numbers filed by the agent during this session */
  issuesFiled: number[];
  /** Issue numbers addressed/closed during this session */
  issuesAddressed: number[];
  /** LEARN-xxx IDs consulted at session start */
  learningsConsulted: string[];
  /** LEARN-xxx IDs appended at session end */
  learningsAppended: string[];
}

// ─── Learnings ───────────────────────────────────────────────────────────────

export interface Learning {
  /** e.g. "LEARN-042" */
  id: string;
  title: string;
  learnedAt: string;
  /** e.g. "repo:data-pipeline, session:20260218-0800" */
  source: string;
  tags: string[];
  body: string;
  /** Repos where this pattern has been applied */
  confirmedInRepos: string[];
}

// ─── Constitutional Constraints ──────────────────────────────────────────────

export interface ConstraintViolation {
  rule: string;
  proposedAction: string;
  filesTouched: string[];
}

export interface ConstraintCheckResult {
  allowed: boolean;
  violation?: ConstraintViolation;
}

// ─── Issues ──────────────────────────────────────────────────────────────────

export type IssueLabel =
  | "autopilot-input"
  | "autopilot-filed"
  | "autopilot-urgent";

export interface AutopilotIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  reactions: number;
  comments: number;
  createdAt: string;
}

export interface FileIssueOptions {
  title: string;
  body: string;
  labels: IssueLabel[];
}

// ─── Config (.autopilot.yml) ─────────────────────────────────────────────────

export interface AutopilotConfig {
  schedule: {
    frequency: string;
    sessionTimeLimitMinutes: number;
    immediateTriggerOn: Array<{
      label?: string;
      incidentSeverity?: string;
    }>;
  };
  issues: {
    inputLabel: string;
    urgentLabel: string;
    filedLabel: string;
    maxIssuesFiledPerSession: number;
    maxIssuesProcessedPerSession: number;
  };
  transparency: {
    commitPrefix: string;
    sessionSummaryInCommit: boolean;
  };
  /** SHA-256 hash of the ## Autopilot Constraints section in AGENT.md */
  constitutionalHash: string;
}

// ─── Commit ──────────────────────────────────────────────────────────────────

export interface CommitMetadata {
  sessionId: SessionId;
  triggerType: TriggerType;
  repoSlug: string;
  issuesAddressed: number[];
  issuesFiled: number[];
  learningsConsulted: string[];
  constraintsChecked: boolean;
}

export interface CommitOptions {
  message: string;
  files: string[];
  metadata: CommitMetadata;
}
