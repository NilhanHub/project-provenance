import type {
  PortfolioDisposition,
  PortfolioOwnershipVerdict,
  PortfolioRightsVerdict,
} from '../shared/types.js';

export interface SignificanceSignals {
  sourceFiles: number;
  sourceLines: number;
  testFiles: number;
  documentationFiles: number;
  workflowFiles: number;
  commits: number;
  infrastructureFiles: number;
}

export interface DispositionSignals {
  ownershipVerdict: PortfolioOwnershipVerdict;
  rightsVerdict: PortfolioRightsVerdict;
  significanceScore: number;
  alreadyPublished: boolean;
  backup: boolean;
  duplicate: boolean;
  fixture: boolean;
  securityBlocked: boolean;
}

function thresholdScore(value: number, thresholds: Array<[number, number]>): number {
  for (const [minimum, score] of thresholds) {
    if (value >= minimum) return score;
  }
  return 0;
}

export function scoreProjectSignificance(signals: SignificanceSignals): number {
  const score =
    thresholdScore(signals.sourceFiles, [[100, 9], [40, 8], [15, 6], [6, 4], [3, 2], [1, 1]])
    + thresholdScore(signals.sourceLines, [[25_000, 6], [10_000, 5], [5_000, 4], [2_000, 3], [500, 2], [200, 1]])
    + thresholdScore(signals.testFiles, [[15, 4], [5, 3], [2, 2], [1, 1]])
    + thresholdScore(signals.documentationFiles, [[4, 3], [2, 2], [1, 1]])
    + thresholdScore(signals.workflowFiles, [[1, 1]])
    + thresholdScore(signals.commits, [[15, 4], [5, 3], [2, 2], [1, 1]])
    + thresholdScore(signals.infrastructureFiles, [[1, 1]]);
  return Math.max(0, Math.min(30, score));
}

export function decidePortfolioDisposition(signals: DispositionSignals): PortfolioDisposition {
  if (signals.ownershipVerdict === 'third-party') return 'exclude-vendor';
  if (signals.backup) return 'exclude-backup';
  if (signals.fixture) return 'exclude-fixture';
  if (signals.alreadyPublished) return 'already-published';
  if (signals.duplicate) return 'hold-duplicate';
  if (signals.securityBlocked) return 'hold-security';
  if (signals.rightsVerdict === 'needs-review' || signals.rightsVerdict === 'not-cleared') return 'hold-rights';
  if (signals.ownershipVerdict === 'unclear') return 'not-published';
  if (signals.significanceScore < 14) return 'hold-too-small';
  if (signals.significanceScore >= 16) return 'publish-candidate';
  return 'not-published';
}
