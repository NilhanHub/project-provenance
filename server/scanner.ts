import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectRecord, ScanStatus } from '../shared/types.js';
import { classifyOwnership, extractGitHubSlug } from './classifier.js';
import { geminiIsConfigured, reviewAmbiguousProject } from './gemini.js';
import { loadNilhanHubRepositories, matchGitHubRepository } from './github.js';

const execFileAsync = promisify(execFile);

const PROJECT_MARKERS = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'uv.lock',
  'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'composer.json', 'Gemfile', 'mix.exs', 'deno.json', 'deno.jsonc',
  'firebase.json', 'wrangler.toml', 'wrangler.jsonc', 'CMakeLists.txt',
]);
const STRONG_PROJECT_MARKERS = new Set([
  'package.json', 'pyproject.toml', 'Pipfile', 'Cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile',
  'mix.exs', 'deno.json', 'deno.jsonc', 'firebase.json', 'wrangler.toml',
  'wrangler.jsonc', 'CMakeLists.txt',
]);
const AI_MARKERS = new Set(['AGENTS.md', '.claude', '.codex', '.kiro']);
const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'env', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '__pycache__', '.pytest_cache', '.mypy_cache',
  'target', 'bin', 'obj', '.gradle', '.terraform', '.wrangler', '.firebase',
  '.pnpm-store', '$RECYCLE.BIN', 'System Volume Information', 'cache', 'caches',
  'UV_CACHE_DIR', 'site-packages', 'User Data', 'Evidence', 'artifacts', 'backups',
  'snapshots', '_verify_tmp', 'tool_sandboxes', '.local-ai-studio-baselines',
  '.gemini', '.claude', '.codex', '.kiro', '.kilocode', '.cursor', '.vscode',
  '.idea', '.windsurf', '.opencode',
]);
const SKIP_DIRECTORIES_CASEFOLDED = new Set([...SKIP_DIRECTORIES].map((name) => name.toLowerCase()));

function shouldSkipDirectory(name: string): boolean {
  return SKIP_DIRECTORIES_CASEFOLDED.has(name.toLowerCase()) || /^\.?venv(?:[-_.].*)?$/i.test(name);
}

export interface ScanHooks {
  onStatus: (status: ScanStatus) => void;
  onProject: (project: ProjectRecord) => void;
  isCancelled: () => boolean;
}

interface ProjectDraft {
  projectPath: string;
  entries: string[];
  markers: string[];
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function sanitizeRemote(remote: string | null): string | null {
  if (!remote) return null;
  return remote.replace(/^(https?:\/\/)[^/@]+@/i, '$1');
}

function sanitizeAuthor(author: string): string {
  return author.replace(/<([^@<>])[^@<>]*@([^<>]+)>/, '<$1***@$2>');
}

async function readText(filePath: string, maxBytes = 64_000): Promise<string> {
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

function detectStack(entries: string[], packageText: string, pyprojectText: string): string[] {
  let packageSignals = '';
  try {
    const parsed = JSON.parse(packageText) as Record<string, Record<string, unknown> | undefined>;
    packageSignals = ['dependencies', 'devDependencies', 'peerDependencies']
      .flatMap((key) => Object.keys(parsed[key] ?? {}))
      .join(' ');
  } catch { /* malformed package metadata should not invent a framework */ }
  const haystack = `${packageSignals}\n${pyprojectText}`.toLowerCase();
  const stack: string[] = [];
  const add = (value: string) => { if (!stack.includes(value)) stack.push(value); };
  if (entries.includes('package.json')) add('JavaScript/TypeScript');
  if (/\breact\b/.test(haystack)) add('React');
  if (/\bvite\b/.test(haystack)) add('Vite');
  if (/\bnext\b/.test(haystack)) add('Next.js');
  if (/\bexpress\b/.test(haystack)) add('Express');
  if (/\bfirebase\b/.test(haystack) || entries.includes('firebase.json')) add('Firebase');
  if (entries.some((entry) => ['pyproject.toml', 'requirements.txt', 'Pipfile', 'uv.lock'].includes(entry))) add('Python');
  if (/\bfastapi\b/.test(haystack)) add('FastAPI');
  if (entries.includes('Cargo.toml')) add('Rust');
  if (entries.includes('go.mod')) add('Go');
  if (entries.some((entry) => ['pom.xml', 'build.gradle', 'build.gradle.kts'].includes(entry))) add('Java/Kotlin');
  if (entries.some((entry) => /\.(?:sln|csproj)$/i.test(entry))) add('.NET');
  if (entries.includes('composer.json')) add('PHP');
  return stack.slice(0, 4);
}

function detectProjectName(folderName: string, packageText: string, pyprojectText: string): string {
  try {
    const packageName = (JSON.parse(packageText) as { name?: unknown }).name;
    if (typeof packageName === 'string' && packageName.trim()) {
      const cleaned = packageName.replace(/^@[^/]+\//, '');
      if (!/^(?:react-example|my-video|temp-app|my-app|vite-project|untitled|starter|app|web|frontend|backend|server|client)$/i.test(cleaned)) return cleaned;
    }
  } catch { /* malformed packages are still valid discoveries */ }
  const pyName = pyprojectText.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1];
  return pyName?.trim() || folderName;
}

async function buildProject(draft: ProjectDraft, github: Awaited<ReturnType<typeof loadNilhanHubRepositories>>): Promise<ProjectRecord> {
  const packageText = draft.entries.includes('package.json') ? await readText(path.join(draft.projectPath, 'package.json')) : '';
  const pyprojectText = draft.entries.includes('pyproject.toml') ? await readText(path.join(draft.projectPath, 'pyproject.toml')) : '';
  const readmeName = draft.entries.find((entry) => /^readme(?:\.[^.]+)?$/i.test(entry));
  const readmeText = readmeName ? await readText(path.join(draft.projectPath, readmeName)) : '';
  const gitProbe = draft.entries.includes('.git') ? await runGit(draft.projectPath, ['rev-parse', '--is-inside-work-tree']) : null;
  const hasGit = gitProbe === 'true';
  const branch = hasGit ? await runGit(draft.projectPath, ['branch', '--show-current']) : null;
  const remote = sanitizeRemote(hasGit ? await runGit(draft.projectPath, ['remote', 'get-url', 'origin']) : null);
  const authorText = hasGit ? await runGit(draft.projectPath, ['log', '--all', '--format=%an <%ae>']) : null;
  const authors = [...new Set((authorText ?? '').split(/\r?\n/).filter(Boolean).map(sanitizeAuthor))].slice(0, 20);
  const lastCommitAt = hasGit ? await runGit(draft.projectPath, ['log', '-1', '--format=%cI']) : null;
  const stat = await fs.stat(draft.projectPath);
  const name = detectProjectName(path.basename(draft.projectPath), packageText, pyprojectText);
  const remoteOwner = extractGitHubSlug(remote)?.owner ?? null;
  const classification = classifyOwnership({
    projectPath: draft.projectPath,
    authors,
    remoteOwner,
    hasGit,
    markers: draft.markers,
    readmeText,
  });
  const githubMatch = matchGitHubRepository(name, path.basename(draft.projectPath), remote, github.repositories, github.available);
  const scannedAt = new Date().toISOString();
  const project: ProjectRecord = {
    id: createHash('sha256').update(draft.projectPath.toLowerCase()).digest('hex').slice(0, 16),
    name,
    path: draft.projectPath,
    markers: draft.markers,
    stack: detectStack(draft.entries, packageText, pyprojectText),
    ownership: classification.ownership,
    ownershipScore: classification.score,
    ownershipConfidence: classification.confidence,
    ownershipReasons: classification.reasons,
    aiAssisted: classification.aiAssisted,
    aiSignals: classification.aiSignals,
    git: { isRepository: hasGit, branch, remote, authors, lastCommitAt },
    github: githubMatch,
    lastChangedAt: lastCommitAt ?? stat.mtime.toISOString(),
    scannedAt,
  };

  const gemini = await reviewAmbiguousProject(project, readmeText);
  if (gemini) {
    project.ownership = gemini.ownership;
    project.ownershipConfidence = gemini.confidence;
    project.ownershipReasons.push({ code: 'gemini-metadata-review', label: `Gemini metadata review: ${gemini.reason}`, weight: 0 });
  }
  return project;
}

function markerNames(entries: string[]): string[] {
  const markers = entries.filter((entry) => PROJECT_MARKERS.has(entry) || AI_MARKERS.has(entry));
  if (entries.includes('.git')) markers.unshift('.git');
  for (const entry of entries) {
    if (/\.(?:sln|csproj)$/i.test(entry)) markers.push(entry);
  }
  return [...new Set(markers)];
}

export async function scanRoots(roots: string[], hooks: ScanHooks): Promise<{ projects: ProjectRecord[]; githubAvailable: boolean }> {
  const github = await loadNilhanHubRepositories();
  const projects: ProjectRecord[] = [];
  const normalizedRoots = [...new Set(roots.map((root) => path.resolve(root)))];
  const queue = [...normalizedRoots];
  let directoriesVisited = 0;
  const startedAt = new Date().toISOString();

  while (queue.length > 0) {
    if (hooks.isCancelled()) break;
    const currentPath = queue.pop()!;
    directoriesVisited += 1;
    if (directoriesVisited % 25 === 0) {
      hooks.onStatus({
        state: 'running', roots: normalizedRoots, currentPath, directoriesVisited,
        projectsFound: projects.length, startedAt, completedAt: null, error: null,
        githubAvailable: github.available, geminiAvailable: geminiIsConfigured(),
      });
      await new Promise((resolve) => setImmediate(resolve));
    }

    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }
    const entries = dirents.map((entry) => entry.name);
    const markers = markerNames(entries);
    let repositoryBoundary = false;
    if (markers.some((marker) => marker === '.git' || STRONG_PROJECT_MARKERS.has(marker) || /\.(?:sln|csproj)$/i.test(marker))) {
      try {
        const project = await buildProject({ projectPath: currentPath, entries, markers }, github);
        const strongManifest = markers.some((marker) => STRONG_PROJECT_MARKERS.has(marker) || /\.(?:sln|csproj)$/i.test(marker));
        if (project.git.isRepository || strongManifest) {
          projects.push(project);
          hooks.onProject(project);
          repositoryBoundary = project.git.isRepository;
        }
      } catch {
        // One malformed or inaccessible project must not stop the drive inventory.
      }
    }
    // A Git root is the project boundary. Descending into its packages turns one
    // repository or vendor clone into hundreds of false project records.
    if (repositoryBoundary) continue;
    for (const entry of dirents) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || shouldSkipDirectory(entry.name)) continue;
      queue.push(path.join(currentPath, entry.name));
    }
  }

  return { projects, githubAvailable: github.available };
}
