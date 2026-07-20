import type { ProjectRecord } from '../shared/types.js';

interface GeminiDecision {
  ownership: 'mine' | 'vendor' | 'review';
  confidence: number;
  reason: string;
}

export function geminiIsConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export async function reviewAmbiguousProject(project: ProjectRecord, readmeExcerpt: string): Promise<GeminiDecision | null> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || project.ownership !== 'review') return null;

  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash';
  const prompt = [
    'Classify whether this local code project was likely created by Nilhan with AI, is a third-party/vendor copy, or remains uncertain.',
    'Use only the supplied metadata. Do not assume that AI-related wording proves ownership.',
    'Return JSON with ownership (mine|vendor|review), confidence (0-100), and one concise reason.',
    JSON.stringify({
      name: project.name,
      path: project.path,
      markers: project.markers,
      stack: project.stack,
      gitAuthors: project.git.authors,
      remoteOwner: project.github.remoteOwner,
      deterministicSignals: project.ownershipReasons.map((reason) => reason.label),
      readmeExcerpt: readmeExcerpt.slice(0, 6_000),
    }),
  ].join('\n');

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<GeminiDecision>;
    if (!['mine', 'vendor', 'review'].includes(parsed.ownership ?? '')) return null;
    return {
      ownership: parsed.ownership as GeminiDecision['ownership'],
      confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)),
      reason: String(parsed.reason ?? 'Gemini metadata review').slice(0, 240),
    };
  } catch {
    return null;
  }
}
