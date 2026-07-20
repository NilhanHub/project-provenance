import path from 'node:path';
import type { EvidenceSignal, OwnershipLabel } from '../shared/types.js';

export interface ClassificationInput {
  projectPath: string;
  authors: string[];
  remoteOwner: string | null;
  hasGit: boolean;
  markers: string[];
  readmeText: string;
}

const OWN_IDENTITY = /nilhan(?:[\s._-]*de[\s._-]*mel|hub|\.dev)?/i;
const VENDOR_PATH = /(?:^|[\\/])(?:_?vendor|vendor_sources|_sources|intake|staging|select_skills\d*|only to select skills|cookbook|node_modules)(?:[\\/]|$)/i;
const OWN_ROOT = /^[a-z]:[\\/](?:Repo|gaps|Kiro_master|Codex_master|AI-Apps-In-Drive)(?:[\\/]|$)/i;
const AI_TEXT = /\b(?:AI Studio|Gemini|Codex|Claude|Antigravity|Kiro|vibe cod(?:e|ing)|generated with AI|built with AI)\b/i;

export function classifyOwnership(input: ClassificationInput): {
  ownership: OwnershipLabel;
  score: number;
  confidence: number;
  reasons: EvidenceSignal[];
  aiAssisted: boolean;
  aiSignals: string[];
} {
  const reasons: EvidenceSignal[] = [];
  const add = (code: string, label: string, weight: number) => reasons.push({ code, label, weight });

  if (input.authors.some((author) => OWN_IDENTITY.test(author))) {
    add('own-git-author', 'Git history includes a Nilhan identity', 55);
  }
  if (input.remoteOwner && /^(?:NilhanHub|Nilhan-DeMel)$/i.test(input.remoteOwner)) {
    add('own-github-owner', `Git remote belongs to ${input.remoteOwner}`, 45);
  } else if (input.remoteOwner) {
    add('other-github-owner', `Git remote belongs to another owner: ${input.remoteOwner}`, -65);
  }
  if (VENDOR_PATH.test(input.projectPath)) {
    add('vendor-path', 'Path is inside a vendor, staging, intake, or source-mirror area', -50);
  }
  if (OWN_ROOT.test(input.projectPath)) {
    add('own-workspace-root', `Path is under a primary Nilhan workspace (${path.parse(input.projectPath).root})`, 12);
  }
  if (!input.hasGit && input.markers.length >= 2) {
    add('uncommitted-project', 'Multiple project manifests exist without imported Git history', 8);
  }

  const aiSignals: string[] = [];
  if (AI_TEXT.test(input.readmeText)) aiSignals.push('Project documentation references an AI coding tool or workflow');
  if (input.markers.includes('AGENTS.md')) aiSignals.push('Contains AGENTS.md agent instructions');
  if (input.markers.some((marker) => /^(?:\.claude|\.codex|\.kiro)$/i.test(marker))) {
    aiSignals.push('Contains AI-agent workspace metadata');
  }
  if (aiSignals.length > 0) add('ai-workflow-evidence', 'AI-assisted development evidence is present', 5);

  const score = Math.max(-100, Math.min(100, reasons.reduce((total, reason) => total + reason.weight, 0)));
  const ownership: OwnershipLabel = score >= 35 ? 'mine' : score <= -25 ? 'vendor' : 'review';
  const confidence = ownership === 'review'
    ? Math.max(20, Math.min(74, Math.round(50 + Math.abs(score) * 0.6)))
    : Math.max(65, Math.min(99, Math.round(68 + Math.abs(score) * 0.3)));

  return { ownership, score, confidence, reasons, aiAssisted: aiSignals.length > 0, aiSignals };
}

export function extractGitHubSlug(remote: string | null): { owner: string; repository: string } | null {
  if (!remote) return null;
  const match = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) return null;
  return { owner: match[1], repository: match[2] };
}

export function normalizeRepositoryName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
