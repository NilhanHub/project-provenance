import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubMatch } from '../shared/types.js';
import { extractGitHubSlug, normalizeRepositoryName } from './classifier.js';

const execFileAsync = promisify(execFile);

interface GitHubRepository {
  name: string;
  nameWithOwner: string;
  url: string;
  isPrivate: boolean;
}

export async function loadNilhanHubRepositories(): Promise<{ available: boolean; repositories: GitHubRepository[] }> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['repo', 'list', 'NilhanHub', '--limit', '1000', '--json', 'name,nameWithOwner,url,isPrivate'],
      { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return { available: true, repositories: JSON.parse(stdout) as GitHubRepository[] };
  } catch {
    return { available: false, repositories: [] };
  }
}

export function matchGitHubRepository(
  projectName: string,
  folderName: string,
  remote: string | null,
  repositories: GitHubRepository[],
  githubAvailable: boolean,
): GitHubMatch {
  const remoteSlug = extractGitHubSlug(remote);
  if (remoteSlug && /^NilhanHub$/i.test(remoteSlug.owner)) {
    const repository = repositories.find((item) => item.name.toLowerCase() === remoteSlug.repository.toLowerCase());
    return {
      kind: 'exact-remote',
      repositoryName: repository?.name ?? remoteSlug.repository,
      repositoryUrl: repository?.url ?? `https://github.com/NilhanHub/${remoteSlug.repository}`,
      remoteOwner: remoteSlug.owner,
      remoteRepository: remoteSlug.repository,
    };
  }
  if (remoteSlug) {
    return {
      kind: 'different-owner',
      repositoryName: null,
      repositoryUrl: null,
      remoteOwner: remoteSlug.owner,
      remoteRepository: remoteSlug.repository,
    };
  }
  if (!githubAvailable) {
    return { kind: 'unknown', repositoryName: null, repositoryUrl: null, remoteOwner: null, remoteRepository: null };
  }

  const candidateNames = new Set([normalizeRepositoryName(projectName), normalizeRepositoryName(folderName)]);
  const matches = repositories.filter((item) => candidateNames.has(normalizeRepositoryName(item.name)));
  if (matches.length === 1) {
    return {
      kind: 'name-match',
      repositoryName: matches[0].name,
      repositoryUrl: matches[0].url,
      remoteOwner: null,
      remoteRepository: null,
    };
  }
  return { kind: 'not-found', repositoryName: null, repositoryUrl: null, remoteOwner: null, remoteRepository: null };
}
