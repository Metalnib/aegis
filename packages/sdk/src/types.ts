export type Severity = "Critical" | "High" | "Medium" | "Low" | "Unknown";

export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
}

export interface PrEvent {
  kind: "opened" | "synchronize" | "reopened";
  ref: PrRef;
  receivedAt: Date;
}

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  patch?: string;
  oldPath?: string;
}

export interface DiffBundle {
  files: FileDiff[];
  baseSha: string;
  headSha: string;
}

export interface PrInfo {
  ref: PrRef;
  title: string;
  body: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PrSearchQuery {
  repos: string[];
  anyOfKeywords?: string[];
  branchPattern?: string;
  sinceDays?: number;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

export interface Finding {
  severity: Severity;
  category: string;
  summary: string;
  detail?: string;
}

export interface AegisReview {
  severity: Severity;
  prComments: InlineComment[];
  summary: string;
  findings: Finding[];
  markdownReport?: string;
}

export interface ReviewJob {
  id: string;
  ref: PrRef;
  enqueuedAt: Date;
  attempts: number;
}

export type BusEvent =
  | { kind: "pr"; event: PrEvent }
  | { kind: "review-done"; jobId: string; ref: PrRef; review: AegisReview }
  | { kind: "review-failed"; jobId: string; ref: PrRef; error: string };
