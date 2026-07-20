import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import type {
  InventoryPayload,
  PortfolioOwnershipVerdict,
  PortfolioReview,
  PortfolioReviewMetrics,
  PortfolioRightsVerdict,
  ProjectRecord,
} from '../shared/types.js';
import { decidePortfolioDisposition, scoreProjectSignificance } from './portfolio-policy.js';

const execFileAsync = promisify(execFile);
const ownEmails = new Set(
  (process.env.PROJECT_PROVENANCE_OWN_EMAILS ?? 'nilhan.dev@gmail.com')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);
const ownOwners = new Set(['nilhanhub', 'nilhan-demel']);
const sourceExtensions = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.dart', '.ex', '.exs', '.go', '.h', '.hpp', '.html',
  '.java', '.js', '.jsx', '.kt', '.kts', '.lua', '.mjs', '.cjs', '.php', '.ps1', '.py', '.rb',
  '.rs', '.scss', '.sh', '.sql', '.svelte', '.swift', '.ts', '.tsx', '.vue',
]);
const generatedDirectories = new Set([
  '.git', '.next', '.nuxt', '.output', '.parcel-cache', '.pnpm-store', '.pytest_cache', '.ruff_cache',
  '.terraform', '.venv', '.vite', '.wrangler', '__pycache__', 'artifacts', 'bin', 'build', 'cache',
  'coverage', 'dist', 'dist-electron', 'env', 'generated', 'node_modules', 'obj', 'out', 'release',
  'site-packages', 'target', 'tmp', 'venv',
]);
const generatedPathSegments = new Set(['evidence', 'snapshots', 'backups', 'artifacts']);
const corporatePattern = /(?:^|[\\/_. -])(1bt|apexhrm|hbs|prasath)(?:$|[\\/_. -])/i;
const backupPattern = /GitHub-Portfolio-(?:Backups|Verification|Work)|restore-verification|_codex_audit_/i;
const fixturePattern = /(?:^|[\\/])(?:fixtures?|workspace_visibility_probe[^\\/]*|Weapons_test[^\\/]*|ExampleGithub|hello-world-agent|test[-_ ]?corpus|skill-playwright-minimal|skills\.__shadow__[^\\/]*|Only to select skills|_migration_sources|tmp_model_probe[^\\/]*)(?:$|[\\/])/i;
const secretFilenamePattern = /(?:^|[\\/])(?:\.env(?!\.(?:example|sample|template))|credentials?(?:\.[^\\/]+)?|service[-_]?account(?:\.[^\\/]+)?|firebase-adminsdk[^\\/]*\.json|id_rsa|[^\\/]+\.(?:pem|p12|pfx|key))(?:$|[\\/])/i;
const infrastructurePattern = /(?:^|[\\/])(?:Dockerfile|docker-compose[^\\/]*|firebase\.json|wrangler\.(?:toml|jsonc?)|vercel\.json|apphosting\.ya?ml|[^\\/]+\.tf|kustomization\.ya?ml)$/i;
const testPattern = /(?:^|[\\/])(?:__tests__|tests?|specs?)(?:[\\/]|$)|\.(?:test|spec)\.[^.]+$/i;
const documentationPattern = /(?:^|[\\/])(?:README(?:\.[^\\/]+)?|CHANGELOG(?:\.[^\\/]+)?|SECURITY\.md|CONTRIBUTING\.md|ARCHITECTURE\.md|docs[\\/].+\.md)$/i;
const workflowPattern = /(?:^|[\\/])\.github[\\/]workflows[\\/].+\.ya?ml$/i;

interface ProjectMetrics extends PortfolioReviewMetrics {
  infrastructureFiles: number;
  sensitiveFilenames: string[];
  largeFiles: string[];
  fingerprint: string | null;
  readmeExcerpt: string | null;
}

interface SessionEvidence {
  id: string;
  cwd: string;
  userText: string;
  assistantText: string;
}

interface GitEvidence {
  valid: boolean;
  commits: number;
  ownAuthor: boolean;
  rootCommit: string | null;
  remoteOwner: string | null;
  remoteRepository: string | null;
}

interface ExistingRepository {
  owner: string;
  name: string;
  url: string;
  visibility: 'public' | 'private';
}

interface AuditDraft {
  project: ProjectRecord;
  metrics: ProjectMetrics;
  git: GitEvidence;
  sessionCount: number;
  exactSessionCount: number;
  mentionedSessionCount: number;
  existing: ExistingRepository | null;
  ownershipVerdict: PortfolioOwnershipVerdict;
  rightsVerdict: PortfolioRightsVerdict;
  backup: boolean;
  fixture: boolean;
  duplicate: boolean;
  nestedComponent: boolean;
  canonicalProjectId: string;
  canonicalName: string;
}

interface AuditOverride {
  projectPath: string;
  ownershipVerdict?: PortfolioOwnershipVerdict;
  rightsVerdict?: PortfolioRightsVerdict;
  significanceScore?: number;
  disposition?: PortfolioReview['disposition'];
  canonicalProjectPath?: string;
  canonicalName?: string;
  summary?: string;
  introduction?: string | null;
  evidenceAppend?: string[];
  risksAppend?: string[];
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function canonicalNameFor(project: ProjectRecord): string {
  const genericName = /^(?:react-example|my-video|temp-app|my-app|vite-project|untitled|starter|app|web|frontend|backend|server|client)$/i;
  return genericName.test(project.name.trim()) ? path.basename(project.path) : project.name;
}

function parseGitHubRemote(remote: string | null): { owner: string; repository: string } | null {
  if (!remote) return null;
  const match = remote.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i);
  return match ? { owner: match[1], repository: match[2] } : null;
}

async function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: options.timeout ?? 15_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function work(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => work()));
  return results;
}

function inventoryGitEvidence(project: ProjectRecord): GitEvidence {
  const remote = parseGitHubRemote(project.git.remote);
  return {
    valid: project.git.isRepository,
    commits: 0,
    ownAuthor: false,
    rootCommit: null,
    remoteOwner: remote?.owner ?? null,
    remoteRepository: remote?.repository ?? null,
  };
}

async function collectFiles(root: string): Promise<ProjectMetrics> {
  const stack = [root];
  const fingerprintEntries: string[] = [];
  const sensitiveFilenames: string[] = [];
  const largeFiles: string[] = [];
  let files = 0;
  let sourceFiles = 0;
  let sourceLines = 0;
  let testFiles = 0;
  let documentationFiles = 0;
  let workflowFiles = 0;
  let infrastructureFiles = 0;
  let readmeExcerpt: string | null = null;

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      const relative = path.relative(root, fullPath).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (!generatedDirectories.has(entry.name.toLowerCase())) stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      files += 1;
      const portablePath = relative.replaceAll('/', '\\');
      if (secretFilenamePattern.test(portablePath) && sensitiveFilenames.length < 20) sensitiveFilenames.push(relative);
      let stat: import('node:fs').Stats;
      try { stat = await fs.stat(fullPath); } catch { continue; }
      if (stat.size > 10 * 1024 * 1024 && largeFiles.length < 20) largeFiles.push(`${relative} (${Math.ceil(stat.size / 1024 / 1024)} MB)`);
      if (testPattern.test(portablePath)) testFiles += 1;
      if (documentationPattern.test(portablePath)) documentationFiles += 1;
      if (workflowPattern.test(portablePath)) workflowFiles += 1;
      if (infrastructurePattern.test(portablePath)) infrastructureFiles += 1;

      const extension = path.extname(entry.name).toLowerCase();
      const segments = relative.toLowerCase().split('/');
      const generatedContext = segments.some((segment) => generatedPathSegments.has(segment));
      if (!sourceExtensions.has(extension) || generatedContext || stat.size > 2 * 1024 * 1024) {
        if (!readmeExcerpt && /^readme(?:\.[^.]+)?$/i.test(entry.name) && stat.size <= 512 * 1024) {
          readmeExcerpt = extractReadmeExcerpt(await fs.readFile(fullPath, 'utf8'));
        }
        continue;
      }

      sourceFiles += 1;
      let content: Buffer;
      try { content = await fs.readFile(fullPath); } catch { continue; }
      if (content.includes(0)) continue;
      sourceLines += content.length ? content.toString('utf8').split(/\r?\n/).length : 0;
      const contentHash = createHash('sha256').update(content).digest('hex');
      fingerprintEntries.push(`${relative.toLowerCase()}:${contentHash}`);
    }
  }

  const fingerprint = sourceFiles
    ? createHash('sha256').update(fingerprintEntries.sort().join('\n')).digest('hex')
    : null;
  return {
    files, sourceFiles, sourceLines, testFiles, documentationFiles, workflowFiles,
    infrastructureFiles, commits: 0, codexSessions: 0, sensitiveFilenames,
    largeFiles, fingerprint, readmeExcerpt,
  };
}

function extractReadmeExcerpt(markdown: string): string | null {
  const paragraphs = markdown.replace(/<!--[^]*?-->/g, '').split(/\r?\n\s*\r?\n/);
  for (const paragraph of paragraphs) {
    const cleaned = paragraph
      .replace(/^#{1,6}\s+.*$/gm, '')
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/[`*_>#|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length >= 45) return cleaned.slice(0, 420);
  }
  return null;
}

async function getGitEvidence(project: ProjectRecord): Promise<GitEvidence> {
  const remote = parseGitHubRemote(project.git.remote);
  const valid = await run('git', ['-C', project.path, 'rev-parse', '--is-inside-work-tree']) === 'true';
  if (!valid) return { valid: false, commits: 0, ownAuthor: false, rootCommit: null, remoteOwner: remote?.owner ?? null, remoteRepository: remote?.repository ?? null };
  const commitText = await run('git', ['-C', project.path, 'rev-list', '--count', 'HEAD']);
  const rootCommitText = await run('git', ['-C', project.path, 'rev-list', '--max-parents=0', 'HEAD']);
  const authors = await run('git', ['-C', project.path, 'log', '--all', '--format=%ae%x09%an'], { timeout: 30_000 });
  const ownAuthor = (authors ?? '').split(/\r?\n/).some((line) => {
    const [email = '', name = ''] = line.split('\t');
    return ownEmails.has(email.trim().toLowerCase()) || /nilhan|de[ -]?mel/i.test(name);
  });
  return {
    valid: true,
    commits: Number.parseInt(commitText ?? '0', 10) || 0,
    ownAuthor,
    rootCommit: rootCommitText?.split(/\r?\n/)[0] ?? null,
    remoteOwner: remote?.owner ?? null,
    remoteRepository: remote?.repository ?? null,
  };
}

async function findJsonlFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(full);
    }
  }
  return result;
}

async function loadSessionEvidence(sessionRoot: string): Promise<SessionEvidence[]> {
  const sessions: SessionEvidence[] = [];
  for (const file of await findJsonlFiles(sessionRoot)) {
    let id = path.basename(file, '.jsonl');
    let cwd = '';
    const userText: string[] = [];
    const assistantText: string[] = [];
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      let record: { type?: string; payload?: Record<string, unknown> };
      try { record = JSON.parse(line) as typeof record; } catch { continue; }
      const payload = record.payload;
      if (!payload) continue;
      if (record.type === 'session_meta') {
        if (typeof payload.id === 'string') id = payload.id;
        if (typeof payload.cwd === 'string') cwd = payload.cwd;
      }
      if (record.type === 'turn_context' && typeof payload.cwd === 'string') cwd ||= payload.cwd;
      if (record.type === 'response_item' && payload.type === 'message'
        && (payload.role === 'user' || payload.role === 'assistant') && Array.isArray(payload.content)) {
        for (const part of payload.content as Array<Record<string, unknown>>) {
          const text = typeof part.text === 'string' ? part.text : typeof part.input_text === 'string' ? part.input_text : '';
          if (!text || text.startsWith('# AGENTS.md instructions')) continue;
          if (payload.role === 'user') userText.push(text.slice(0, 30_000));
          else assistantText.push(text.slice(0, 30_000));
        }
      }
    }
    if (cwd || userText.length || assistantText.length) sessions.push({
      id,
      cwd,
      userText: userText.join('\n').toLowerCase(),
      assistantText: assistantText.join('\n').toLowerCase(),
    });
  }
  return sessions;
}

function matchSessions(project: ProjectRecord, sessions: SessionEvidence[]): { total: number; exact: number; mentioned: number } {
  const projectPath = normalizePath(project.path);
  const mentionedPath = project.path.toLowerCase();
  const ids = new Set<string>();
  let exact = 0;
  let mentioned = 0;
  for (const session of sessions) {
    const sessionPath = session.cwd ? normalizePath(session.cwd) : '';
    const exactMatch = sessionPath === projectPath;
    const relative = sessionPath ? path.relative(sessionPath, projectPath) : '';
    const sessionDepth = sessionPath ? sessionPath.split(/[\\/]/).filter(Boolean).length : 0;
    const nearDescendant = Boolean(sessionPath) && sessionDepth >= 3
      && relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
      && relative.split(/[\\/]/).length <= 2;
    const userPathMention = session.userText.includes(mentionedPath);
    const assistantPathMention = session.assistantText.includes(mentionedPath);
    const pathMention = userPathMention || (assistantPathMention && Boolean(session.userText));
    if (exactMatch || nearDescendant || pathMention) {
      ids.add(session.id);
      if (exactMatch) exact += 1;
      if (pathMention) mentioned += 1;
    }
  }
  return { total: ids.size, exact, mentioned };
}

async function loadGitHubRepositories(owner: string): Promise<ExistingRepository[]> {
  const token = await run('gh', ['auth', 'token', '--hostname', 'github.com', '--user', owner]);
  if (!token) return [];
  const json = await run('gh', ['repo', 'list', owner, '--limit', '300', '--json', 'name,url,visibility'], {
    env: { ...process.env, GH_TOKEN: token },
    timeout: 30_000,
  });
  if (!json) return [];
  try {
    return (JSON.parse(json) as Array<{ name: string; url: string; visibility: string }>).map((repo) => ({
      owner,
      name: repo.name,
      url: repo.url,
      visibility: repo.visibility.toLowerCase() === 'private' ? 'private' : 'public',
    }));
  } catch {
    return [];
  }
}

function chooseExisting(project: ProjectRecord, git: GitEvidence, repositories: ExistingRepository[]): ExistingRepository | null {
  if (git.remoteOwner && ownOwners.has(git.remoteOwner.toLowerCase()) && git.remoteRepository) {
    const remote = repositories.find((repo) => repo.owner.toLowerCase() === git.remoteOwner!.toLowerCase()
      && normalizeName(repo.name) === normalizeName(git.remoteRepository!));
    if (remote) return remote;
  }
  if (project.github.repositoryUrl) {
    const matched = repositories.find((repo) => repo.url.toLowerCase() === project.github.repositoryUrl!.toLowerCase());
    if (matched) return matched;
  }
  const normalizedNames = new Set([normalizeName(project.name), normalizeName(path.basename(project.path))]);
  const matches = repositories.filter((repo) => normalizedNames.has(normalizeName(repo.name)));
  return matches.length === 1 ? matches[0] : null;
}

function classifyOwnership(project: ProjectRecord, git: GitEvidence, sessionCount: number, exactSessionCount: number): PortfolioOwnershipVerdict {
  if (git.remoteOwner && !ownOwners.has(git.remoteOwner.toLowerCase())) return 'third-party';
  if (project.ownership === 'vendor') return 'third-party';
  if ((git.remoteOwner && ownOwners.has(git.remoteOwner.toLowerCase())) || git.ownAuthor || exactSessionCount > 0) return 'confirmed-mine';
  if (project.ownership === 'mine' && sessionCount > 0) return 'confirmed-mine';
  if (project.ownership === 'mine') return 'probable-mine';
  if (sessionCount > 0) return 'probable-mine';
  return 'unclear';
}

function classifyRights(project: ProjectRecord, ownership: PortfolioOwnershipVerdict, existing: ExistingRepository | null): PortfolioRightsVerdict {
  if (ownership === 'third-party') return 'not-applicable';
  if (existing) return 'cleared';
  if (corporatePattern.test(project.path) || corporatePattern.test(project.name)) return 'needs-review';
  return ownership === 'confirmed-mine' ? 'cleared' : 'needs-review';
}

function chooseCanonical(group: AuditDraft[]): AuditDraft {
  return [...group].sort((a, b) => {
    const rank = (draft: AuditDraft) =>
      (draft.existing ? 1000 : 0)
      + (!draft.backup && !draft.fixture ? 300 : 0)
      + (draft.git.valid ? 100 : 0)
      + scoreProjectSignificance({ ...draft.metrics, commits: draft.git.commits });
    return rank(b) - rank(a) || a.project.path.length - b.project.path.length;
  })[0];
}

function reviewSummary(draft: AuditDraft, score: number, disposition: PortfolioReview['disposition']): string {
  if (disposition === 'exclude-vendor') return 'Excluded from the personal portfolio because repository ownership or path evidence identifies third-party or vendor code.';
  if (disposition === 'exclude-backup') return 'Excluded as a backup, verification clone, or audit copy rather than an independent project.';
  if (disposition === 'exclude-fixture') return 'Excluded as a fixture, probe, test corpus, or small demonstration workspace.';
  if (disposition === 'published') return 'Published as a cleared portfolio release; the exact repository URL and commit are recorded in publication metadata.';
  if (disposition === 'already-published') return `Already represented on GitHub${draft.existing ? ` at ${draft.existing.owner}/${draft.existing.name}` : ''}; no duplicate repository should be created.`;
  if (disposition === 'hold-duplicate' || disposition === 'consolidate') return `Part of the canonical ${draft.canonicalName} project family; consolidate instead of publishing this path independently.`;
  if (disposition === 'hold-rights') return 'Substantive work may exist, but public-source rights or corporate/client boundaries require manual clearance before publication.';
  if (disposition === 'hold-security') return 'Publication is paused until sensitive filenames or large disclosure-risk artifacts are inspected and cleared.';
  if (disposition === 'hold-too-small') return `Ownership evidence is plausible, but the current significance score (${score}/30) is below the standalone portfolio threshold.`;
  if (disposition === 'publish-candidate') return `Evidence supports original work and substantial implementation (${score}/30); advance to the full disclosure and publication gates.`;
  return 'Not published because ownership or standalone portfolio value is not yet sufficiently established.';
}

function seedIntroduction(draft: AuditDraft): string | null {
  if (draft.metrics.sourceFiles === 0) return null;
  const stack = draft.project.stack.length ? draft.project.stack.join(', ') : 'multi-language engineering';
  const proof = `${draft.metrics.sourceFiles} source files${draft.metrics.testFiles ? ` and ${draft.metrics.testFiles} test files` : ''}`;
  const readme = draft.metrics.readmeExcerpt ? ` ${draft.metrics.readmeExcerpt}` : '';
  return `${draft.canonicalName} is an AI-assisted ${stack} project backed by ${proof}.${readme}`.slice(0, 1_200);
}

function markdownEscape(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

async function writeReports(outputDirectory: string, reviews: PortfolioReview[], projects: ProjectRecord[]): Promise<void> {
  await fs.mkdir(outputDirectory, { recursive: true });
  const counts = new Map<string, number>();
  reviews.forEach((review) => counts.set(review.disposition, (counts.get(review.disposition) ?? 0) + 1));
  const lines = [
    '# GitHub Portfolio Intake Audit',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Rows reviewed: **${reviews.length}**`,
    '',
    '## Disposition summary',
    '',
    '| Disposition | Count |',
    '|---|---:|',
    ...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `| ${key} | ${value} |`),
    '',
    '## Complete row ledger',
    '',
    '| Project | Machine path | Ownership | Score | Disposition | GitHub |',
    '|---|---|---|---:|---|---|',
    ...reviews.map((review) => {
      const project = projects.find((item) => item.id === review.projectId);
      const github = review.publication?.url ?? project?.github.repositoryUrl ?? '';
      return `| ${markdownEscape(review.canonicalName)} | ${markdownEscape(review.projectPath)} | ${review.ownershipVerdict} | ${review.significanceScore} | ${review.disposition} | ${github ? `[link](${github})` : ''} |`;
    }),
    '',
  ];
  await fs.writeFile(path.join(outputDirectory, 'PORTFOLIO-AUDIT.md'), lines.join('\n'), 'utf8');
  await fs.writeFile(path.join(outputDirectory, 'portfolio-audit.json'), JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    reviews,
  }, null, 2), 'utf8');
}

async function loadAuditOverrides(outputDirectory: string): Promise<AuditOverride[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(outputDirectory, 'manual-overrides.json'), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AuditOverride => Boolean(item) && typeof item === 'object'
      && typeof (item as AuditOverride).projectPath === 'string');
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1))), '..');
  const inventoryPath = path.resolve(process.env.PROJECT_PROVENANCE_INVENTORY ?? path.join(repoRoot, '.project-provenance', 'inventory.json'));
  const outputDirectory = path.resolve(
    process.env.PROJECT_PROVENANCE_AUDIT_OUTPUT ?? path.join(repoRoot, '.project-provenance', 'portfolio-audit'),
  );
  const sessionRoot = path.resolve(process.env.CODEX_SESSION_ROOT ?? path.join(os.homedir(), '.codex', 'sessions'));
  const inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8')) as InventoryPayload;
  const previousReviews = new Map((inventory.reviews ?? []).map((review) => [review.projectId, review]));
  const overrides = await loadAuditOverrides(outputDirectory);
  const overrideByPath = new Map(overrides.map((override) => [normalizePath(override.projectPath), override]));
  const sessions = await loadSessionEvidence(sessionRoot);
  const repositories = [
    ...await loadGitHubRepositories('NilhanHub'),
    ...await loadGitHubRepositories('Nilhan-DeMel'),
  ];

  let completed = 0;
  const drafts = await mapWithConcurrency(inventory.projects, 4, async (project): Promise<AuditDraft> => {
    const sessionMatches = matchSessions(project, sessions);
    const backup = backupPattern.test(project.path);
    const fixture = fixturePattern.test(project.path);
    const shouldMeasure = project.ownership !== 'vendor' && !backup && !fixture;
    const metrics = shouldMeasure ? await collectFiles(project.path) : {
      files: 0, sourceFiles: 0, sourceLines: 0, testFiles: 0, documentationFiles: 0,
      workflowFiles: 0, infrastructureFiles: 0, commits: 0, codexSessions: 0,
      sensitiveFilenames: [], largeFiles: [], fingerprint: null, readmeExcerpt: null,
    } satisfies ProjectMetrics;
    const git = shouldMeasure ? await getGitEvidence(project) : inventoryGitEvidence(project);
    metrics.commits = git.commits;
    metrics.codexSessions = sessionMatches.total;
    const existing = chooseExisting(project, git, repositories);
    const ownershipVerdict = classifyOwnership(project, git, sessionMatches.total, sessionMatches.exact);
    const rightsVerdict = classifyRights(project, ownershipVerdict, existing);
    const draft: AuditDraft = {
      project, metrics, git,
      sessionCount: sessionMatches.total,
      exactSessionCount: sessionMatches.exact,
      mentionedSessionCount: sessionMatches.mentioned,
      existing, ownershipVerdict, rightsVerdict,
      backup,
      fixture,
      duplicate: false,
      nestedComponent: false,
      canonicalProjectId: project.id,
      canonicalName: canonicalNameFor(project),
    };
    completed += 1;
    if (completed % 20 === 0 || completed === inventory.projects.length) {
      process.stdout.write(`Audited ${completed}/${inventory.projects.length} inventory rows\n`);
    }
    return draft;
  });

  const candidateDrafts = drafts.filter((draft) => draft.ownershipVerdict !== 'third-party' && !draft.backup && !draft.fixture);
  for (const draft of candidateDrafts) {
    const parents = candidateDrafts.filter((candidate) => candidate !== draft
      && normalizePath(draft.project.path).startsWith(`${normalizePath(candidate.project.path)}${path.sep}`));
    if (parents.length) {
      const parent = parents.sort((a, b) => b.project.path.length - a.project.path.length)[0];
      draft.nestedComponent = true;
      draft.duplicate = true;
      draft.canonicalProjectId = parent.project.id;
      draft.canonicalName = parent.canonicalName;
    }
  }

  const fingerprintGroups = new Map<string, AuditDraft[]>();
  for (const draft of candidateDrafts.filter((item) => item.metrics.fingerprint)) {
    const group = fingerprintGroups.get(draft.metrics.fingerprint!) ?? [];
    group.push(draft);
    fingerprintGroups.set(draft.metrics.fingerprint!, group);
  }
  for (const group of fingerprintGroups.values()) {
    if (group.length < 2) continue;
    const canonical = chooseCanonical(group);
    for (const draft of group) {
      if (draft === canonical) continue;
      draft.duplicate = true;
      draft.canonicalProjectId = canonical.project.id;
      draft.canonicalName = canonical.canonicalName;
    }
  }

  const historyGroups = new Map<string, AuditDraft[]>();
  for (const draft of candidateDrafts.filter((item) => item.git.rootCommit)) {
    const group = historyGroups.get(draft.git.rootCommit!) ?? [];
    group.push(draft);
    historyGroups.set(draft.git.rootCommit!, group);
  }
  for (const group of historyGroups.values()) {
    if (group.length < 2) continue;
    const canonical = chooseCanonical(group);
    for (const draft of group) {
      if (draft === canonical || draft.existing) continue;
      draft.duplicate = true;
      draft.canonicalProjectId = canonical.project.id;
      draft.canonicalName = canonical.canonicalName;
    }
  }

  const reviews: PortfolioReview[] = drafts.map((draft) => {
    const score = scoreProjectSignificance({ ...draft.metrics, commits: draft.git.commits });
    const securityBlocked = draft.metrics.sensitiveFilenames.length > 0 || draft.metrics.largeFiles.length > 0;
    let disposition = decidePortfolioDisposition({
      ownershipVerdict: draft.ownershipVerdict,
      rightsVerdict: draft.rightsVerdict,
      significanceScore: score,
      alreadyPublished: Boolean(draft.existing),
      backup: draft.backup,
      duplicate: draft.duplicate,
      fixture: draft.fixture,
      securityBlocked,
    });
    if (draft.duplicate && !draft.backup && !draft.fixture && !draft.existing && !draft.nestedComponent) disposition = 'consolidate';
    const previous = previousReviews.get(draft.project.id);
    const publication = previous?.publication ?? (draft.existing ? {
      owner: draft.existing.owner,
      repository: draft.existing.name,
      url: draft.existing.url,
      visibility: draft.existing.visibility,
      publishedAt: previous?.publication?.publishedAt ?? draft.project.scannedAt,
      commit: previous?.publication?.commit ?? null,
    } : null);
    if (publication && previous?.disposition === 'published') disposition = 'published';

    const evidence = [
      ...draft.project.ownershipReasons.map((reason) => reason.label),
      draft.git.ownAuthor ? 'Local Git history includes an authorized Nilhan identity.' : '',
      draft.git.remoteOwner ? `Git remote owner: ${draft.git.remoteOwner}.` : '',
      draft.sessionCount ? `${draft.sessionCount} Codex session(s) connect this path to user-directed work (${draft.exactSessionCount} exact workspace match).` : '',
      draft.existing ? `Existing GitHub representation: ${draft.existing.owner}/${draft.existing.name}.` : '',
      `${draft.metrics.sourceFiles} source files, ${draft.metrics.sourceLines} source lines, ${draft.metrics.testFiles} test files, ${draft.git.commits} commits.`,
    ].filter(Boolean);
    const risks = [
      ...draft.metrics.sensitiveFilenames.map((item) => `Sensitive filename requires inspection: ${item}`),
      ...draft.metrics.largeFiles.map((item) => `Large file requires inspection: ${item}`),
      draft.rightsVerdict === 'needs-review' ? 'Public-source rights require manual confirmation.' : '',
      draft.duplicate ? `Canonical project: ${draft.canonicalName}.` : '',
    ].filter(Boolean);
    const review = {
      projectId: draft.project.id,
      projectPath: draft.project.path,
      canonicalProjectId: draft.canonicalProjectId,
      canonicalName: draft.canonicalName,
      ownershipVerdict: draft.ownershipVerdict,
      rightsVerdict: draft.rightsVerdict,
      significanceScore: score,
      disposition,
      summary: reviewSummary(draft, score, disposition),
      introduction: previous?.introduction ?? (disposition === 'publish-candidate' ? seedIntroduction(draft) : null),
      evidence,
      risks,
      metrics: {
        files: draft.metrics.files,
        sourceFiles: draft.metrics.sourceFiles,
        sourceLines: draft.metrics.sourceLines,
        testFiles: draft.metrics.testFiles,
        documentationFiles: draft.metrics.documentationFiles,
        workflowFiles: draft.metrics.workflowFiles,
        commits: draft.git.commits,
        codexSessions: draft.sessionCount,
      },
      publication,
      reviewedAt: new Date().toISOString(),
    } satisfies PortfolioReview;
    const override = overrideByPath.get(normalizePath(draft.project.path));
    if (!override) return review;
    const canonicalProject = override.canonicalProjectPath
      ? inventory.projects.find((project) => normalizePath(project.path) === normalizePath(override.canonicalProjectPath!))
      : null;
    return {
      ...review,
      ownershipVerdict: override.ownershipVerdict ?? review.ownershipVerdict,
      rightsVerdict: override.rightsVerdict ?? review.rightsVerdict,
      significanceScore: typeof override.significanceScore === 'number'
        ? Math.max(0, Math.min(30, override.significanceScore)) : review.significanceScore,
      disposition: override.disposition ?? review.disposition,
      canonicalProjectId: canonicalProject?.id ?? review.canonicalProjectId,
      canonicalName: override.canonicalName ?? canonicalProject?.name ?? review.canonicalName,
      summary: override.summary ?? review.summary,
      introduction: override.introduction !== undefined ? override.introduction : review.introduction,
      evidence: [...review.evidence, ...(override.evidenceAppend ?? [])],
      risks: [...review.risks, ...(override.risksAppend ?? [])],
    } satisfies PortfolioReview;
  }).sort((a, b) => a.canonicalName.localeCompare(b.canonicalName) || a.projectPath.localeCompare(b.projectPath));

  const temporaryInventory = `${inventoryPath}.portfolio-audit.tmp`;
  await fs.writeFile(temporaryInventory, JSON.stringify({ ...inventory, reviews }, null, 2), 'utf8');
  await fs.rename(temporaryInventory, inventoryPath);
  await writeReports(outputDirectory, reviews, inventory.projects);
  process.stdout.write(`Portfolio audit complete: ${reviews.length} rows written to ${outputDirectory}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown portfolio audit failure.';
  process.stderr.write(`Portfolio audit failed: ${message}\n`);
  process.exitCode = 1;
});
