/** GitHub integration port. Adapters (gh CLI today) implement these; the domain never shells out directly. */
export interface PullRequest {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";
  isDraft: boolean;
  title: string;
  headRefName: string;
}

export interface CheckRun {
  name: string;
  status: "QUEUED" | "IN_PROGRESS" | "COMPLETED" | "UNKNOWN";
  conclusion: string | null;
}

export interface PrReview {
  /** Stable review id from GitHub; null when the backend provides none. */
  id: string | null;
  author: string;
  state: string;
  body: string;
}

export interface CiStatus {
  checkRuns: CheckRun[];
  /** FAILED when any completed check has a non-success conclusion, else the aggregate state. */
  aggregate: "PENDING" | "PASSING" | "FAILING";
}

export interface CreateDraftPrInput {
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
}

export interface GitHubPort {
  /** Pushes headBranch from the repository at repoPath to origin. */
  pushBranch(repoPath: string, headBranch: string): Promise<void>;
  /**
   * Commits every pending change in the worktree (agents are told not to
   * commit, so delivery owns this step). Returns false when the worktree was
   * already clean — a PR over zero new commits is pointless.
   */
  commitAll(repoPath: string, message: string): Promise<boolean>;
  createDraftPr(repoPath: string, input: CreateDraftPrInput): Promise<PullRequest>;
  findPrForBranch(repoPath: string, headBranch: string): Promise<PullRequest | null>;
  ciStatus(repoPath: string, prNumber: number): Promise<CiStatus>;
  reviews(repoPath: string, prNumber: number): Promise<PrReview[]>;
}
