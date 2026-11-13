import type { FileRef, ImplementationPlan, PlanTask } from '@repointelligence/shared';

const blob = (plan: ImplementationPlan, ref: FileRef | { path: string; line?: number | null }): string =>
  `https://github.com/${plan.fullName}/blob/${plan.sha}/${ref.path.split('/').map(encodeURIComponent).join('/')}${ref.line ? `#L${ref.line}` : ''}`; // prettier-ignore
const hours = (h: { low: number; high: number }): string => `${h.low}–${h.high} h`;

function origin(plan: ImplementationPlan): string {
  return plan.origin === 'model'
    ? `Tasks were proposed by ${plan.writtenBy ?? 'a model'} and checked against the repository: every path exists at the commit or is a new file in an existing directory. Order, tests, effort and risk were computed by rules.`
    : 'No model wrote tasks for this plan. It lists the files most related to the goal, in dependency order, with rule-based risk.';
}

function fileLine(plan: ImplementationPlan, f: PlanTask['files'][number]): string {
  const name =
    f.change === 'create' ? `\`${f.path}\` (new file)` : `[\`${f.path}\`](${blob(plan, f)})`;
  return `${name}${f.reason ? `: ${f.reason}` : ''}`;
}

/** The whole plan as a document. */
export function planMarkdown(plan: ImplementationPlan): string {
  const lines = [
    `# Implementation plan: ${plan.goal}`,
    '',
    `> For ${plan.fullName} at commit ${plan.sha.slice(0, 12)}, generated ${plan.generatedAt.slice(0, 10)}.`,
    `> ${origin(plan)}`,
    ...(plan.dropped.tasks + plan.dropped.files > 0 ? [`> ${plan.dropped.tasks} proposed tasks and ${plan.dropped.files} proposed files were removed because they did not match the repository.`] : []),
    '',
    `- Tasks: ${plan.tasks.length}, touching ${plan.totals.files} files`,
    `- Estimated effort: ${hours(plan.totals.effort)} (a range built from fixed hours per file and test)`,
    `- Overall risk: ${plan.totals.risk}`,
    ...plan.notes.map((n) => `- Note: ${n}`),
    '',
  ];
  for (const t of plan.tasks) {
    lines.push(`## ${t.order}. ${t.title}`, '');
    if (t.description) lines.push(t.description, '');
    lines.push(`- Status: ${t.done ? 'done' : 'to do'}`, `- Effort: ${hours(t.effort)}; risk: ${t.risk.level}${t.risk.reasons.length ? ` (${t.risk.reasons.join('; ')})` : ''}`);
    if (t.dependsOn.length) lines.push(`- After: ${t.dependsOn.map((id) => plan.tasks.find((x) => x.id === id)?.order).filter(Boolean).map((n) => `task ${n}`).join(', ')}`);
    lines.push('- Files:', ...t.files.map((f) => `  - ${fileLine(plan, f)}`));
    if (t.api.length) lines.push('- API:', ...t.api.map((a) => `  - ${a.change === 'new' ? 'Add' : 'Change'} \`${a.method} ${a.route}\`${a.path ? ` ([${a.path}](${blob(plan, { path: a.path, line: a.line })}))` : ''}`));
    if (t.database.length) lines.push('- Database:', ...t.database.map((d) => `  - ${d.change === 'new' ? 'Add' : 'Change'} model \`${d.model}\`${d.path ? ` ([${d.path}](${blob(plan, { path: d.path })}))` : ''}`));
    if (t.tests.length) lines.push('- Tests:', ...t.tests.map((x) => `  - \`${x.path}\`${x.exists ? '' : ' (new)'}: ${x.note}`));
    lines.push('');
  }
  if (plan.relevantFiles.length) {
    lines.push('## Related files', '', ...plan.relevantFiles.map((f) => `- [\`${f.path}\`](${blob(plan, f)}): ${f.why}`), '');
  }
  return lines.join('\n');
} // prettier-ignore

/** A task list to paste into a GitHub issue: one checkbox per task, files underneath. */
export function planIssue(plan: ImplementationPlan): string {
  return [
    `## ${plan.goal}`,
    '',
    `Plan for commit \`${plan.sha.slice(0, 12)}\`. ${origin(plan)}`,
    '',
    `Estimated effort: ${hours(plan.totals.effort)}. Overall risk: ${plan.totals.risk}.`,
    '',
    ...plan.tasks.flatMap((t) => [
      `- [${t.done ? 'x' : ' '}] **${t.title}** (${hours(t.effort)}, ${t.risk.level} risk)`,
      ...t.files.map((f) => `  - ${f.change === 'create' ? 'new' : 'edit'} \`${f.path}\``),
      ...t.tests.map((x) => `  - test \`${x.path}\``),
    ]),
    '',
  ].join('\n');
} // prettier-ignore
