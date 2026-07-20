import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import express from 'express';
import type {
  InventoryPayload,
  PortfolioDisposition,
  PortfolioOwnershipVerdict,
  PortfolioPublication,
  PortfolioReview,
  PortfolioReviewMetrics,
  PortfolioRightsVerdict,
  ProjectRecord,
  ScanStatus,
} from '../shared/types.js';
import { geminiIsConfigured } from './gemini.js';
import { scanRoots } from './scanner.js';

export interface ProjectProvenanceServerOptions {
  host?: string;
  port?: number;
  dataDirectory?: string;
  distDirectory?: string;
  defaultRoots?: string[];
  seedInventoryPath?: string;
}

export interface ProjectProvenanceServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

const REVIEW_METRIC_KEYS: Array<keyof PortfolioReviewMetrics> = [
  'files', 'sourceFiles', 'sourceLines', 'testFiles', 'documentationFiles',
  'workflowFiles', 'commits', 'codexSessions',
];

function normalizeReviewMetrics(value: unknown): PortfolioReviewMetrics | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const metrics = {} as PortfolioReviewMetrics;
  for (const key of REVIEW_METRIC_KEYS) {
    const metric = candidate[key];
    if (typeof metric !== 'number' || !Number.isSafeInteger(metric) || metric < 0) return null;
    metrics[key] = metric;
  }
  return metrics;
}

function normalizePublication(value: unknown): PortfolioPublication | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<PortfolioPublication>;
  if (typeof candidate.owner !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(candidate.owner)
    || typeof candidate.repository !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(candidate.repository)
    || !['public', 'private'].includes(candidate.visibility ?? '')
    || typeof candidate.publishedAt !== 'string' || !Number.isFinite(Date.parse(candidate.publishedAt))
    || (candidate.commit !== null && candidate.commit !== undefined
      && (typeof candidate.commit !== 'string' || candidate.commit.length > 100))) return undefined;
  try {
    const publicationUrl = new URL(String(candidate.url));
    if (publicationUrl.protocol !== 'https:' || publicationUrl.hostname.toLowerCase() !== 'github.com') return undefined;
    const expectedPath = `/${candidate.owner}/${candidate.repository}`.toLowerCase();
    if (publicationUrl.pathname.replace(/\/$/, '').toLowerCase() !== expectedPath) return undefined;
    return {
      owner: candidate.owner,
      repository: candidate.repository,
      url: publicationUrl.toString().replace(/\/$/, ''),
      visibility: candidate.visibility as PortfolioPublication['visibility'],
      publishedAt: new Date(candidate.publishedAt).toISOString(),
      commit: candidate.commit?.trim() || null,
    };
  } catch {
    return undefined;
  }
}

export async function startProjectProvenanceServer(
  options: ProjectProvenanceServerOptions = {},
): Promise<ProjectProvenanceServer> {
  const app = express();
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? Number(process.env.PROJECT_PROVENANCE_PORT || 4317);
  const projectDirectory = path.resolve(process.env.PROJECT_PROVENANCE_PROJECT_DIRECTORY || process.cwd());
  const dataDirectory = options.dataDirectory ?? path.join(projectDirectory, '.project-provenance');
  const inventoryPath = path.join(dataDirectory, 'inventory.json');
  const distDirectory = options.distDirectory ?? path.join(projectDirectory, 'dist');
  const defaultRoots = options.defaultRoots ?? (process.env.PROJECT_PROVENANCE_ROOTS || 'D:\\')
    .split(',')
    .map((root) => root.trim())
    .filter(Boolean);

  let projects: ProjectRecord[] = [];
  let reviews: PortfolioReview[] = [];
  let cancelRequested = false;
  let scanStatus: ScanStatus = {
    state: 'idle', roots: defaultRoots, currentPath: null, directoriesVisited: 0,
    projectsFound: 0, startedAt: null, completedAt: null, error: null,
    githubAvailable: false, geminiAvailable: geminiIsConfigured(),
  };

  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'");
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  async function applyInventory(payload: InventoryPayload): Promise<void> {
    projects = Array.isArray(payload.projects) ? payload.projects : [];
    reviews = Array.isArray(payload.reviews) ? payload.reviews : [];
    scanStatus = {
      ...(payload.scan ?? scanStatus),
      state: 'idle',
      currentPath: null,
      error: null,
      geminiAvailable: geminiIsConfigured(),
    };
  }

  async function loadInventory(): Promise<void> {
    let loadedLocalInventory = false;
    try {
      await applyInventory(JSON.parse(await fs.readFile(inventoryPath, 'utf8')) as InventoryPayload);
      loadedLocalInventory = true;
    } catch {
      // A first run or damaged cache can fall back to the packaged local scan.
    }

    if (!options.seedInventoryPath) return;
    try {
      const seed = JSON.parse(await fs.readFile(options.seedInventoryPath, 'utf8')) as InventoryPayload;
      if (!loadedLocalInventory) {
        await applyInventory(seed);
        await saveInventory();
        return;
      }

      const reviewByProject = new Map(reviews.map((review) => [review.projectId, review]));
      for (const review of seed.reviews ?? []) {
        const current = reviewByProject.get(review.projectId);
        if (!current || Date.parse(review.reviewedAt) > Date.parse(current.reviewedAt)) {
          reviewByProject.set(review.projectId, review);
        }
      }
      reviews = [...reviewByProject.values()].sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
      await saveInventory();
    } catch {
      // If the optional seed is missing, the installed app starts with an empty inventory.
    }
  }

  async function saveInventory(): Promise<void> {
    await fs.mkdir(dataDirectory, { recursive: true });
    const temporaryPath = `${inventoryPath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify({ projects, reviews, scan: scanStatus }, null, 2), 'utf8');
    await fs.rename(temporaryPath, inventoryPath);
  }

  function safeRoots(value: unknown): string[] {
    const requested = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : defaultRoots;
    const roots = [...new Set(requested.map((root) => path.resolve(root.trim())).filter(Boolean))];
    if (roots.length === 0 || roots.length > 12) throw new Error('Choose between one and twelve scan roots.');
    return roots;
  }

  app.get('/api/config', (_request, response) => {
    response.json({ defaultRoots, githubOwner: 'NilhanHub', localOnly: true, geminiAvailable: geminiIsConfigured() });
  });

  app.get('/api/projects', (_request, response) => {
    response.json({ projects, reviews, scan: scanStatus } satisfies InventoryPayload);
  });

  const ownershipVerdicts = new Set<PortfolioOwnershipVerdict>(['confirmed-mine', 'probable-mine', 'unclear', 'third-party']);
  const rightsVerdicts = new Set<PortfolioRightsVerdict>(['cleared', 'needs-review', 'not-cleared', 'not-applicable']);
  const dispositions = new Set<PortfolioDisposition>([
    'pending', 'publish-candidate', 'published', 'already-published', 'consolidate',
    'hold-rights', 'hold-security', 'hold-too-small', 'hold-duplicate',
    'exclude-vendor', 'exclude-fixture', 'exclude-backup', 'not-published',
  ]);

  app.put('/api/portfolio-reviews/:projectId', async (request, response) => {
    const project = projects.find((item) => item.id === request.params.projectId);
    if (!project) {
      response.status(404).json({ error: 'That project is not in the current inventory.' });
      return;
    }

    const body = request.body as Partial<PortfolioReview> | null;
    const metrics = normalizeReviewMetrics(body?.metrics);
    const publication = normalizePublication(body?.publication);
    if (!body || !ownershipVerdicts.has(body.ownershipVerdict as PortfolioOwnershipVerdict)
      || !rightsVerdicts.has(body.rightsVerdict as PortfolioRightsVerdict)
      || !dispositions.has(body.disposition as PortfolioDisposition)
      || typeof body.significanceScore !== 'number' || !Number.isFinite(body.significanceScore)
      || body.significanceScore < 0 || body.significanceScore > 30
      || typeof body.summary !== 'string' || !body.summary.trim()
      || !Array.isArray(body.evidence) || !Array.isArray(body.risks)
      || !metrics || publication === undefined) {
      response.status(400).json({ error: 'The portfolio review payload is incomplete or invalid.' });
      return;
    }

    const review: PortfolioReview = {
      projectId: project.id,
      projectPath: project.path,
      canonicalProjectId: typeof body.canonicalProjectId === 'string' && body.canonicalProjectId
        ? body.canonicalProjectId.trim().slice(0, 200) : project.id,
      canonicalName: typeof body.canonicalName === 'string' && body.canonicalName.trim()
        ? body.canonicalName.trim().slice(0, 200) : project.name,
      ownershipVerdict: body.ownershipVerdict as PortfolioOwnershipVerdict,
      rightsVerdict: body.rightsVerdict as PortfolioRightsVerdict,
      significanceScore: body.significanceScore,
      disposition: body.disposition as PortfolioDisposition,
      summary: body.summary.trim().slice(0, 2_000),
      introduction: typeof body.introduction === 'string' ? body.introduction.trim().slice(0, 4_000) || null : null,
      evidence: body.evidence.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim().slice(0, 1_000)).slice(0, 30),
      risks: body.risks.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim().slice(0, 1_000)).slice(0, 30),
      metrics,
      publication,
      reviewedAt: typeof body.reviewedAt === 'string' && Number.isFinite(Date.parse(body.reviewedAt))
        ? new Date(body.reviewedAt).toISOString() : new Date().toISOString(),
    };
    reviews = [...reviews.filter((item) => item.projectId !== project.id), review]
      .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
    await saveInventory();
    response.json({ reviews });
  });

  app.get('/api/scan/status', (_request, response) => {
    response.json(scanStatus);
  });

  app.post('/api/scan', (request, response) => {
    if (scanStatus.state === 'running') {
      response.status(409).json({ error: 'A scan is already running.' });
      return;
    }

    let roots: string[];
    try {
      roots = safeRoots(request.body?.roots);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid roots.' });
      return;
    }

    cancelRequested = false;
    projects = [];
    scanStatus = {
      state: 'running', roots, currentPath: roots[0] ?? null, directoriesVisited: 0,
      projectsFound: 0, startedAt: new Date().toISOString(), completedAt: null,
      error: null, githubAvailable: false, geminiAvailable: geminiIsConfigured(),
    };
    response.status(202).json(scanStatus);

    void scanRoots(roots, {
      isCancelled: () => cancelRequested,
      onStatus: (status) => { scanStatus = status; },
      onProject: (project) => {
        projects = [...projects, project].sort((a, b) => a.name.localeCompare(b.name));
        scanStatus = { ...scanStatus, projectsFound: projects.length };
      },
    }).then(async (result) => {
      scanStatus = {
        ...scanStatus,
        state: cancelRequested ? 'cancelled' : 'complete',
        currentPath: null,
        projectsFound: projects.length,
        completedAt: new Date().toISOString(),
        githubAvailable: result.githubAvailable,
      };
      await saveInventory();
    }).catch((error: unknown) => {
      scanStatus = {
        ...scanStatus,
        state: 'failed',
        currentPath: null,
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'The scan failed.',
      };
    });
  });

  app.post('/api/scan/cancel', (_request, response) => {
    cancelRequested = true;
    response.status(202).json({ state: 'cancelling' });
  });

  app.post('/api/open-folder', async (request, response) => {
    const requestedPath = typeof request.body?.path === 'string' ? path.resolve(request.body.path) : '';
    const project = projects.find((item) => item.path.toLowerCase() === requestedPath.toLowerCase());
    if (!project) {
      response.status(404).json({ error: 'That path is not in the current inventory.' });
      return;
    }
    try {
      await fs.access(project.path);
      const child = spawn('explorer.exe', [project.path], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      response.status(202).json({ opened: true });
    } catch {
      response.status(404).json({ error: 'The folder is no longer available.' });
    }
  });

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'Unknown local API endpoint.' });
  });

  app.use(express.static(distDirectory));
  app.get('/{*path}', async (_request, response, next) => {
    try {
      await fs.access(path.join(distDirectory, 'index.html'));
      response.sendFile(path.join(distDirectory, 'index.html'));
    } catch {
      next();
    }
  });

  await loadInventory();
  const server = await new Promise<Server>((resolve, reject) => {
    const listeningServer = app.listen(requestedPort, host, () => resolve(listeningServer));
    listeningServer.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The local service did not receive a TCP port.');
  }
  const port = address.port;
  const url = `http://${host}:${port}`;

  return {
    server,
    host,
    port,
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
