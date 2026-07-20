import { describe, expect, it } from 'vitest';
import { classifyOwnership, extractGitHubSlug, normalizeRepositoryName } from './classifier.js';

describe('ownership classification', () => {
  it('recognizes Nilhan-authored repositories as likely mine', () => {
    const result = classifyOwnership({
      projectPath: 'D:\\Repo\\Repo\\CV_Pro',
      authors: ['Nilhan-DeMel <masked@example.com>'],
      remoteOwner: 'NilhanHub',
      hasGit: true,
      markers: ['.git', 'package.json'],
      readmeText: 'Built with Google AI Studio',
    });
    expect(result.ownership).toBe('mine');
    expect(result.aiAssisted).toBe(true);
  });

  it('recognizes third-party mirrors as vendor code', () => {
    const result = classifyOwnership({
      projectPath: 'D:\\AI\\Staging\\open-design',
      authors: ['Someone Else <else@example.com>'],
      remoteOwner: 'nexu-io',
      hasGit: true,
      markers: ['.git', 'package.json'],
      readmeText: '',
    });
    expect(result.ownership).toBe('vendor');
  });

  it('keeps plausible uncommitted projects in review', () => {
    const result = classifyOwnership({
      projectPath: 'D:\\Repo\\The_Child',
      authors: [],
      remoteOwner: null,
      hasGit: false,
      markers: ['package.json', 'AGENTS.md'],
      readmeText: 'AI Studio export',
    });
    expect(result.ownership).toBe('review');
  });
});

describe('repository normalization', () => {
  it('parses HTTPS and SSH GitHub remotes', () => {
    expect(extractGitHubSlug('https://github.com/NilhanHub/CV-Pro.git')).toEqual({ owner: 'NilhanHub', repository: 'CV-Pro' });
    expect(extractGitHubSlug('git@github.com:NilhanHub/CV-Pro.git')).toEqual({ owner: 'NilhanHub', repository: 'CV-Pro' });
  });

  it('normalizes punctuation and casing', () => {
    expect(normalizeRepositoryName('CV-Pro')).toBe('cvpro');
    expect(normalizeRepositoryName('CV_Pro')).toBe('cvpro');
  });
});
