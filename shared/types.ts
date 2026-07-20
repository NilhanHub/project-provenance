export type OwnershipLabel = 'mine' | 'review' | 'vendor';
export type GitHubMatchKind = 'exact-remote' | 'name-match' | 'different-owner' | 'not-found' | 'unknown';
export type PortfolioOwnershipVerdict = 'confirmed-mine' | 'probable-mine' | 'unclear' | 'third-party';
export type PortfolioRightsVerdict = 'cleared' | 'needs-review' | 'not-cleared' | 'not-applicable';
export type PortfolioDisposition =
  | 'pending'
  | 'publish-candidate'
  | 'published'
  | 'already-published'
  | 'consolidate'
  | 'hold-rights'
  | 'hold-security'
  | 'hold-too-small'
  | 'hold-duplicate'
  | 'exclude-vendor'
  | 'exclude-fixture'
  | 'exclude-backup'
  | 'not-published';

export interface EvidenceSignal {
  code: string;
  label: string;
  weight: number;
}

export interface GitHubMatch {
  kind: GitHubMatchKind;
  repositoryName: string | null;
  repositoryUrl: string | null;
  remoteOwner: string | null;
  remoteRepository: string | null;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  markers: string[];
  stack: string[];
  ownership: OwnershipLabel;
  ownershipScore: number;
  ownershipConfidence: number;
  ownershipReasons: EvidenceSignal[];
  aiAssisted: boolean;
  aiSignals: string[];
  git: {
    isRepository: boolean;
    branch: string | null;
    remote: string | null;
    authors: string[];
    lastCommitAt: string | null;
  };
  github: GitHubMatch;
  lastChangedAt: string;
  scannedAt: string;
}

export interface PortfolioReviewMetrics {
  files: number;
  sourceFiles: number;
  sourceLines: number;
  testFiles: number;
  documentationFiles: number;
  workflowFiles: number;
  commits: number;
  codexSessions: number;
}

export interface PortfolioPublication {
  owner: string;
  repository: string;
  url: string;
  visibility: 'public' | 'private';
  publishedAt: string;
  commit: string | null;
}

export interface PortfolioReview {
  projectId: string;
  projectPath: string;
  canonicalProjectId: string;
  canonicalName: string;
  ownershipVerdict: PortfolioOwnershipVerdict;
  rightsVerdict: PortfolioRightsVerdict;
  significanceScore: number;
  disposition: PortfolioDisposition;
  summary: string;
  introduction: string | null;
  evidence: string[];
  risks: string[];
  metrics: PortfolioReviewMetrics;
  publication: PortfolioPublication | null;
  reviewedAt: string;
}

export interface ScanStatus {
  state: 'idle' | 'running' | 'complete' | 'cancelled' | 'failed';
  roots: string[];
  currentPath: string | null;
  directoriesVisited: number;
  projectsFound: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  githubAvailable: boolean;
  geminiAvailable: boolean;
}

export interface InventoryPayload {
  projects: ProjectRecord[];
  reviews?: PortfolioReview[];
  scan: ScanStatus;
}
