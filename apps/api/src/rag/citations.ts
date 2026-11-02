import type { Citation, Confidence } from '@repointelligence/shared';
import type { Chunk } from '../ingest/types.js';

/** The marker the model is asked to write: [[path:start-end]] or [[path:line]]. */
const MARKER = /\[\[([^[\]:\s]+(?:[^[\]:]*[^[\]:\s])?):(\d+)(?:-(\d+))?\]\]/g;

export const NO_EVIDENCE = 'NO_EVIDENCE';

export interface ValidatedAnswer {
  text: string;
  citations: Citation[];
  dropped: number;
  confidence: Confidence;
  noEvidence: boolean;
}

export function parseCitations(text: string): (Citation & { raw: string })[] {
  const out: (Citation & { raw: string })[] = [];
  for (const m of text.matchAll(MARKER)) {
    const start = Number(m[2]);
    const end = m[3] ? Number(m[3]) : start;
    out.push({
      raw: m[0],
      path: (m[1] ?? '').replace(/^\.?\//, ''),
      startLine: Math.min(start, end),
      endLine: Math.max(start, end),
    });
  }
  return out;
}

/**
 * Checks a citation against the chunks the model was shown. A citation holds when its file
 * was in the evidence and its lines fall inside a chunk of that file; a range that spills over
 * a chunk edge is clamped rather than dropped.
 */
export function checkCitation(citation: Citation, evidence: Chunk[]): Citation | null {
  const candidates = evidence.filter((c) => c.provenance.path === citation.path);
  if (candidates.length === 0) return null;
  for (const chunk of candidates) {
    const { startLine, endLine } = chunk.provenance;
    const overlaps = citation.startLine <= endLine && citation.endLine >= startLine;
    if (!overlaps) continue;
    return {
      path: citation.path,
      startLine: Math.max(citation.startLine, startLine),
      endLine: Math.min(citation.endLine, endLine),
    };
  }
  return null;
}

const dedupe = (citations: Citation[]): Citation[] => {
  const seen = new Set<string>();
  return citations.filter((c) => {
    const key = `${c.path}:${c.startLine}-${c.endLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Turns a raw model reply into an answer whose citations all point at real lines. Invalid
 * markers are removed from the text; the confidence label says how much survived.
 */
export function validateAnswer(
  raw: string,
  evidence: Chunk[],
  options: { hasEvidence: boolean },
): ValidatedAnswer {
  const trimmed = raw.trim();
  if (!options.hasEvidence || trimmed === NO_EVIDENCE || trimmed.startsWith(NO_EVIDENCE)) {
    return { text: '', citations: [], dropped: 0, confidence: 'insufficient', noEvidence: true };
  }
  const found = parseCitations(trimmed);
  const kept: Citation[] = [];
  let dropped = 0;
  let text = trimmed;
  for (const citation of found) {
    const checked = checkCitation(citation, evidence);
    if (checked) {
      kept.push(checked);
      text = text.replace(
        citation.raw,
        `[[${checked.path}:${checked.startLine}-${checked.endLine}]]`,
      );
    } else {
      dropped += 1;
      text = text.replace(citation.raw, '');
    }
  }
  text = text
    .replace(/[ \t]+([.,;:)])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const citations = dedupe(kept);
  const confidence: Confidence = citations.length > 0 && dropped === 0 ? 'verified' : 'inferred';
  return { text, citations, dropped, confidence, noEvidence: false };
}
