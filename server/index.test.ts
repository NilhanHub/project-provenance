import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startProjectProvenanceServer } from './index.js';

describe('local service', () => {
  it('binds privately on an ephemeral port and serves its API', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'project-provenance-'));
    const localServer = await startProjectProvenanceServer({
      port: 0,
      dataDirectory: temporaryDirectory,
      distDirectory: temporaryDirectory,
      defaultRoots: ['D:\\'],
    });
    try {
      expect(localServer.host).toBe('127.0.0.1');
      expect(localServer.port).toBeGreaterThan(0);
      const response = await fetch(`${localServer.url}/api/config`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      await expect(response.json()).resolves.toMatchObject({
        githubOwner: 'NilhanHub',
        localOnly: true,
      });
      const missingApiResponse = await fetch(`${localServer.url}/api/not-real`);
      expect(missingApiResponse.status).toBe(404);
      await expect(missingApiResponse.json()).resolves.toEqual({ error: 'Unknown local API endpoint.' });
    } finally {
      await localServer.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('persists portfolio review decisions alongside the scanned inventory', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'project-provenance-review-'));
    const inventoryPath = path.join(temporaryDirectory, 'inventory.json');
    await writeFile(inventoryPath, JSON.stringify({
      projects: [{
        id: 'project-1',
        name: 'Project One',
        path: 'D:\\Repo\\Project_One',
        markers: ['package.json'],
        stack: ['JavaScript/TypeScript'],
        ownership: 'mine',
        ownershipScore: 50,
        ownershipConfidence: 90,
        ownershipReasons: [],
        aiAssisted: true,
        aiSignals: [],
        git: { isRepository: true, branch: 'main', remote: null, authors: [], lastCommitAt: null },
        github: { kind: 'not-found', repositoryName: null, repositoryUrl: null, remoteOwner: null, remoteRepository: null },
        lastChangedAt: '2026-07-16T00:00:00.000Z',
        scannedAt: '2026-07-16T00:00:00.000Z',
      }],
      reviews: [],
      scan: {
        state: 'idle', roots: ['D:\\'], currentPath: null, directoriesVisited: 1,
        projectsFound: 1, startedAt: null, completedAt: null, error: null,
        githubAvailable: true, geminiAvailable: false,
      },
    }), 'utf8');

    const localServer = await startProjectProvenanceServer({
      port: 0,
      dataDirectory: temporaryDirectory,
      distDirectory: temporaryDirectory,
      defaultRoots: ['D:\\'],
    });
    try {
      const invalidResponse = await fetch(`${localServer.url}/api/portfolio-reviews/project-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownershipVerdict: 'confirmed-mine',
          rightsVerdict: 'cleared',
          significanceScore: 23,
          disposition: 'published',
          summary: 'Invalid because a metric is negative.',
          evidence: [],
          risks: [],
          metrics: {
            files: -1, sourceFiles: 10, sourceLines: 1200, testFiles: 2,
            documentationFiles: 2, workflowFiles: 1, commits: 4, codexSessions: 1,
          },
        }),
      });
      expect(invalidResponse.status).toBe(400);

      const response = await fetch(`${localServer.url}/api/portfolio-reviews/project-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-1',
          projectPath: 'D:\\Repo\\Project_One',
          canonicalProjectId: 'project-1',
          canonicalName: 'Project One',
          ownershipVerdict: 'confirmed-mine',
          rightsVerdict: 'cleared',
          significanceScore: 23,
          disposition: 'published',
          summary: 'Verified original project and published after disclosure checks.',
          introduction: 'A substantial local-first project.',
          evidence: ['Codex build session and local Git history agree.'],
          risks: [],
          metrics: {
            files: 20,
            sourceFiles: 10,
            sourceLines: 1200,
            testFiles: 2,
            documentationFiles: 2,
            workflowFiles: 1,
            commits: 4,
            codexSessions: 1,
          },
          publication: {
            owner: 'NilhanHub',
            repository: 'project-one',
            url: 'https://github.com/NilhanHub/project-one',
            visibility: 'public',
            publishedAt: '2026-07-16T00:00:00.000Z',
            commit: 'abc1234',
          },
          reviewedAt: '2026-07-16T00:00:00.000Z',
        }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json() as { reviews: Array<{ disposition: string }> };
      expect(payload.reviews).toHaveLength(1);
      expect(payload.reviews[0]?.disposition).toBe('published');
    } finally {
      await localServer.close();
    }

    const persisted = JSON.parse(await readFile(inventoryPath, 'utf8')) as { reviews?: Array<{ publication?: { url?: string } }> };
    expect(persisted.reviews?.[0]?.publication?.url).toBe('https://github.com/NilhanHub/project-one');
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
});
