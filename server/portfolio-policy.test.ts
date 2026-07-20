import { describe, expect, it } from 'vitest';
import { decidePortfolioDisposition, scoreProjectSignificance } from './portfolio-policy.js';

describe('portfolio significance policy', () => {
  it('recognizes a substantial tested application without inflating generated files', () => {
    expect(scoreProjectSignificance({
      sourceFiles: 64,
      sourceLines: 12_000,
      testFiles: 14,
      documentationFiles: 5,
      workflowFiles: 2,
      commits: 28,
      infrastructureFiles: 4,
    })).toBeGreaterThanOrEqual(24);
  });

  it('keeps a small proof or fixture below the public-portfolio threshold', () => {
    expect(scoreProjectSignificance({
      sourceFiles: 2,
      sourceLines: 180,
      testFiles: 0,
      documentationFiles: 0,
      workflowFiles: 0,
      commits: 1,
      infrastructureFiles: 0,
    })).toBeLessThan(14);
  });
});

describe('portfolio publication policy', () => {
  it('selects only substantial owned work with publication rights', () => {
    expect(decidePortfolioDisposition({
      ownershipVerdict: 'confirmed-mine',
      rightsVerdict: 'cleared',
      significanceScore: 22,
      alreadyPublished: false,
      backup: false,
      duplicate: false,
      fixture: false,
      securityBlocked: false,
    })).toBe('publish-candidate');
  });

  it('never presents vendor code as original work', () => {
    expect(decidePortfolioDisposition({
      ownershipVerdict: 'third-party',
      rightsVerdict: 'not-applicable',
      significanceScore: 30,
      alreadyPublished: false,
      backup: false,
      duplicate: false,
      fixture: false,
      securityBlocked: false,
    })).toBe('exclude-vendor');
  });

  it('holds corporate or client work until publication rights are established', () => {
    expect(decidePortfolioDisposition({
      ownershipVerdict: 'confirmed-mine',
      rightsVerdict: 'needs-review',
      significanceScore: 25,
      alreadyPublished: false,
      backup: false,
      duplicate: false,
      fixture: false,
      securityBlocked: false,
    })).toBe('hold-rights');
  });
});
