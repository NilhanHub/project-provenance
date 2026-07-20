import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./github.js', () => ({
  loadNilhanHubRepositories: async () => ({ available: true, repositories: [] }),
  matchGitHubRepository: () => ({
    kind: 'not-found', repositoryName: null, repositoryUrl: null,
    remoteOwner: null, remoteRepository: null,
  }),
}));

vi.mock('./gemini.js', () => ({
  geminiIsConfigured: () => false,
  reviewAmbiguousProject: async () => null,
}));

import { scanRoots } from './scanner.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('project scanner', () => {
  it('detects a real project while skipping dependency trees', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'project-provenance-scanner-'));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'temp-app',
      dependencies: { react: '^19.0.0' },
      devDependencies: { vite: '^7.0.0' },
    }), 'utf8');
    await mkdir(path.join(root, 'node_modules', 'false-project'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'false-project', 'package.json'), '{"name":"false-project"}', 'utf8');
    const discovered: string[] = [];
    const result = await scanRoots([root], {
      isCancelled: () => false,
      onStatus: () => undefined,
      onProject: (project) => discovered.push(project.name),
    });

    expect(result.projects).toHaveLength(1);
    expect(discovered).toEqual([path.basename(root)]);
    expect(result.projects[0]?.stack).toEqual(['JavaScript/TypeScript', 'React', 'Vite']);
    expect(result.projects.some((project) => project.name === 'false-project')).toBe(false);
  });
});
