import type { AdaptabilityReport, Evidence } from '@repointelligence/shared';
import { table } from '../docs/facts.js';

/** Evidence as a link to the exact line at the evaluated commit, where there is one. */
export function evidenceLink(e: Evidence, fullName: string, sha: string): string {
  if (e.source !== 'file' || !e.path) return e.text;
  const where = e.line ? `${e.path}:${e.line}` : e.path;
  const url = `https://github.com/${fullName}/blob/${sha}/${e.path.split('/').map(encodeURIComponent).join('/')}${e.line ? `#L${e.line}` : ''}`;
  return `${e.text} ([${where}](${url}))`;
} // prettier-ignore

const hours = (h: { low: number; high: number }): string => `${h.low}–${h.high} h`;

/** The integration readiness report as Markdown. Rule results and model text are separate sections. */
export function toMarkdown(report: AdaptabilityReport): string {
  const { facts, fullName, sha, profile } = report;
  const link = (e: Evidence) => evidenceLink(e, fullName, sha);
  const lines: string[] = [
    `# Integration readiness: ${fullName}`,
    '',
    `> Evaluated at commit ${sha.slice(0, 12)} against the stack "${profile.name}" on ${report.generatedAt.slice(0, 10)}.`,
    '> Scores, warnings and hours come from fixed rules over the repository files. License results are guidance, not legal advice.',
    '',
    '## Summary',
    '',
    `- Overall adaptability: **${facts.overall.score ?? 'not scored'}${facts.overall.score === null ? '' : ' / 100'}**${facts.overall.verdict ? ` (${facts.overall.verdict})` : ''}, ${Math.round(facts.overall.confidence * 100)}% of the weight compared`,
    `- Breaking-change risk: **${facts.breakingRisk.level}**`,
    `- Setup complexity: **${facts.setupComplexity.level}**${facts.setupComplexity.factors.length ? ` (${facts.setupComplexity.factors.join('; ')})` : ''}`,
    `- Estimated effort: **${hours(facts.effort.hours)}** (an estimate built from the items below)`,
    ...report.notes.map((n) => `- Note: ${n}`),
    '',
    '## Dimensions',
    '',
    table(['Dimension', 'Score', 'Finding'], facts.dimensions.map((d) => [d.label, d.score === null ? 'not compared' : String(d.score), d.summary])),
    '',
    '## Warnings',
    '',
    ...(facts.warnings.length === 0
      ? ['None.']
      : facts.warnings.flatMap((w) => [`- **${w.severity}** (${w.dimension}): ${w.message}`, ...w.evidence.map((e) => `  - Evidence: ${link(e)}`)])),
    '',
    '## Breaking-change risk',
    '',
    ...(facts.breakingRisk.reasons.length === 0 ? ['No breaking changes were identified.'] : facts.breakingRisk.reasons.map((r) => `- ${r.text}`)),
    '',
    '## Requirements detected',
    '',
    `- Runtimes: ${facts.requirements.runtimes.map((r) => `${r.runtime} ${r.range}${r.pinned ? ' (pinned)' : ''}`).join(', ') || 'none detected'}`,
    `- Frameworks: ${facts.requirements.frameworks.map((f) => `${f.name}${f.version ? ` ${f.version}` : ''}`).join(', ') || 'none detected'}`,
    `- Database: ${facts.requirements.database.engines.join(', ') || 'none detected'}${facts.requirements.database.orms.length ? ` via ${facts.requirements.database.orms.join(', ')}` : ''}, ${facts.requirements.database.migrations} migrations`,
    `- Authentication: ${facts.requirements.auth.map((a) => a.label).join(', ') || 'none detected'}`,
    `- External services: ${facts.requirements.services.map((s) => s.label).join(', ') || 'none detected'}`,
    `- Missing infrastructure: ${facts.missingInfrastructure.map((m) => m.label).join(', ') || 'none'}`,
    `- License: ${facts.requirements.license.spdxId ?? 'none'} (${facts.requirements.license.category})`,
    '',
    '### Environment variables',
    '',
    ...(facts.requirements.envVars.length === 0
      ? ['No environment example file was found.']
      : [table(['Variable', 'Required', 'Description'], facts.requirements.envVars.map((v) => [`\`${v.name}\``, v.required ? 'yes' : 'has a default', v.description ?? '']))]),
    '',
    '## Required modifications',
    '',
    ...(facts.modifications.length === 0 ? ['None.'] : [table(['Change', 'Detail', 'Effort'], facts.modifications.map((m) => [m.title, m.detail, hours(m.hours)]))]),
    '',
    '## Effort estimate',
    '',
    table(['Item', 'Hours'], [...facts.effort.basis.map((b) => [b.text, hours(b.hours)]), ['**Total**', `**${hours(facts.effort.hours)}**`]]),
    '',
    '## Adaptation checklist',
    '',
    ...report.checklist.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`),
    '',
  ];
  if (report.interpretation) {
    lines.push(
      '## AI interpretation',
      '',
      `> Written by ${report.interpretation.writtenBy} from the results above. It adds no findings of its own; check it before relying on it.`,
      '',
      report.interpretation.summary,
      '',
      ...report.interpretation.highlights.map((h) => `- Fits: ${h}`),
      ...report.interpretation.risks.map((r) => `- Resolve: ${r}`),
      '',
    );
  }
  return lines.join('\n');
} // prettier-ignore
