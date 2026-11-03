import type { Excerpt, Facts } from './facts.js';

/** One section of a document, before any prose is written. */
export interface PlannedSection {
  id: string;
  heading: string;
  /** Markdown built from repository data alone; may contain [[path:lines]] citations. */
  facts: string;
  /** File excerpts the model may draw on, and that its citations are checked against. */
  evidence: Excerpt[];
  /** Material that is not a file, such as commit messages; never cited. */
  notes?: string;
  /** What to ask the model to write for this section. Without it the section is facts only. */
  prose?: string;
  /** Set when the repository had nothing to build this section from. */
  missing?: string;
}

export interface DocPlan {
  title: string;
  sections: PlannedSection[];
  notes: string[];
}

export interface GenerateOptions {
  /** Changelog range. */
  from?: string;
  to?: string;
}

export type Generator = (facts: Facts, options: GenerateOptions) => Promise<DocPlan>;

export function section(
  id: string,
  heading: string,
  over: Partial<Omit<PlannedSection, 'id' | 'heading'>> = {},
): PlannedSection {
  return { id, heading, facts: '', evidence: [], ...over };
}
