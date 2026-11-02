import type {
  Area,
  AreaScore,
  Finding,
  HealthScore,
  Metric,
  MetricStatus,
} from '@repointelligence/shared';
import { toolOutcome, type AnalysisInputs } from './inputs.js';

export const WEIGHTS: Record<Area, number> = {
  codeQuality: 15,
  security: 15,
  tests: 12,
  maintainability: 10,
  documentation: 10,
  dependencies: 10,
  architecture: 10,
  community: 5,
  activity: 5,
  cicd: 5,
  busFactor: 3,
};

export const AREA_LABELS: Record<Area, string> = {
  codeQuality: 'Code quality',
  security: 'Security',
  tests: 'Tests',
  maintainability: 'Maintainability',
  documentation: 'Documentation',
  dependencies: 'Dependencies',
  architecture: 'Architecture',
  community: 'Community',
  activity: 'Activity',
  cicd: 'CI/CD',
  busFactor: 'Bus factor',
};

export const FORMULA =
  'Each metric scores 0-100 from a stated rule. An area is the weight-averaged mean of its ' +
  'measured and inferred metrics; unavailable metrics are left out and lower confidence. The ' +
  'overall score is the weight-averaged mean of scored areas. If less than half of the total ' +
  'weight could be observed, no overall number is given.';

/** Below this share of observed weight the overall score reads "insufficient data". */
export const MIN_CONFIDENCE_FOR_SCORE = 0.5;
const MAX_FINDINGS_PER_TOOL = 200;
const DAY_MS = 86_400_000;

// ---- helpers ------------------------------------------------------------------------------------

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/** 100 at `best` or better, 0 at `worst` or worse, linear between. Works in either direction. */
export function scale(value: number, best: number, worst: number): number {
  if (best === worst) return value <= best ? 100 : 0;
  return clamp(((value - worst) / (best - worst)) * 100);
}

interface MetricSpec {
  id: string;
  label: string;
  weight: number;
  source: string;
}

function measured(
  spec: MetricSpec,
  value: number,
  unit: string | null,
  score: number,
  evidence: string,
): Metric {
  return { ...spec, status: 'measured', value, unit, score: clamp(score), evidence };
}

function inferred(
  spec: MetricSpec,
  present: boolean,
  scoreIfPresent: number,
  scoreIfAbsent: number,
  evidence: string,
): Metric {
  return {
    ...spec,
    status: 'inferred',
    value: present ? 1 : 0,
    unit: 'present',
    score: present ? scoreIfPresent : scoreIfAbsent,
    evidence,
  };
}

function unavailable(spec: MetricSpec, reason: string): Metric {
  return { ...spec, status: 'unavailable', value: null, unit: null, score: null, evidence: reason };
}

const yesNo = (present: boolean, what: string): string =>
  present ? `${what} found` : `${what} not found`;

function perKloc(count: number, lines: number | null): number | null {
  return lines && lines > 0 ? (count / lines) * 1000 : null;
}

// ---- metrics per area -----------------------------------------------------------------------------

type Builder = (inputs: AnalysisInputs, now: number) => Metric[];

const codeQuality: Builder = (inputs) => {
  const lizard = toolOutcome(inputs, 'lizard');
  const jscpd = toolOutcome(inputs, 'jscpd');
  const ruff = toolOutcome(inputs, 'ruff');
  const inventory = toolOutcome(inputs, 'inventory');
  const metrics: Metric[] = [];

  const avgSpec = {
    id: 'complexity.average',
    label: 'Average cyclomatic complexity',
    weight: 3,
    source: 'lizard',
  };
  const hotSpec = {
    id: 'complexity.hotspots',
    label: 'Functions over complexity 15',
    weight: 3,
    source: 'lizard',
  };
  if (lizard.status === 'ok' && lizard.data.functionCount > 0 && lizard.data.averageCcn !== null) {
    const avg = lizard.data.averageCcn;
    metrics.push(
      measured(
        avgSpec,
        avg,
        'CCN',
        scale(avg, 3, 12),
        `Mean complexity ${avg} over ${lizard.data.functionCount} functions`,
      ),
    );
    const share = lizard.data.complexFunctions.length / lizard.data.functionCount;
    metrics.push(
      measured(
        hotSpec,
        Math.round(share * 1000) / 10,
        '%',
        scale(share, 0, 0.1),
        `${lizard.data.complexFunctions.length} of ${lizard.data.functionCount} functions have CCN above 15`,
      ),
    );
  } else {
    const reason = lizard.status === 'ok' ? 'no functions were found to measure' : lizard.reason;
    metrics.push(unavailable(avgSpec, reason), unavailable(hotSpec, reason));
  }

  const dupSpec = { id: 'duplication', label: 'Duplicated lines', weight: 3, source: 'jscpd' };
  if (jscpd.status === 'ok' && jscpd.data.totalLines > 0) {
    const pct = jscpd.data.duplicationPercent;
    metrics.push(
      measured(
        dupSpec,
        pct,
        '%',
        scale(pct, 0, 20),
        `${jscpd.data.duplicatedLines} of ${jscpd.data.totalLines} lines appear in ${jscpd.data.cloneCount} clones`,
      ),
    );
  } else {
    metrics.push(unavailable(dupSpec, jscpd.status === 'ok' ? 'nothing to compare' : jscpd.reason));
  }

  const lintSpec = {
    id: 'lint.density',
    label: 'Lint findings per 1,000 lines',
    weight: 3,
    source: 'ruff',
  };
  const pyLines = inventory.status === 'ok' ? (inventory.data.linesByLanguage.Python ?? 0) : null;
  if (ruff.status === 'ok' && pyLines) {
    const density = perKloc(ruff.data.count, pyLines) ?? 0;
    metrics.push(
      measured(
        lintSpec,
        Math.round(density * 10) / 10,
        'per kloc',
        scale(density, 0, 40),
        `${ruff.data.count} findings (E, F, B, S rules) in ${pyLines} lines of Python`,
      ),
    );
  } else if (inventory.status === 'ok' && !pyLines) {
    metrics.push(unavailable(lintSpec, 'no Python code; other languages are not linted yet'));
  } else {
    metrics.push(
      unavailable(lintSpec, ruff.status === 'ok' ? 'line counts are unavailable' : ruff.reason),
    );
  }

  const cfgSpec = {
    id: 'lint.configured',
    label: 'Linter configured',
    weight: 1,
    source: 'inventory',
  };
  metrics.push(
    inventory.status === 'ok'
      ? inferred(
          cfgSpec,
          inventory.data.linterConfig.length > 0,
          100,
          30,
          inventory.data.linterConfig.length
            ? `Configuration for ${inventory.data.linterConfig.join(', ')}`
            : 'No linter configuration file',
        )
      : unavailable(cfgSpec, inventory.reason),
  );
  return metrics;
};

const SEVERITY_WEIGHT: Record<Finding['severity'], number> = {
  critical: 30,
  high: 15,
  medium: 5,
  low: 1,
  info: 0,
};

const security: Builder = (inputs) => {
  const gitleaks = toolOutcome(inputs, 'gitleaks');
  const semgrep = toolOutcome(inputs, 'semgrep');
  const ruff = toolOutcome(inputs, 'ruff');
  const inventory = toolOutcome(inputs, 'inventory');
  const metrics: Metric[] = [];

  const secretsSpec = {
    id: 'secrets',
    label: 'Possible committed secrets',
    weight: 4,
    source: 'gitleaks',
  };
  metrics.push(
    gitleaks.status === 'ok'
      ? measured(
          secretsSpec,
          gitleaks.data.count,
          'findings',
          100 - gitleaks.data.count * 40,
          gitleaks.data.count
            ? `${gitleaks.data.count} possible secret(s); matched text is never stored`
            : 'No secrets detected',
        )
      : unavailable(secretsSpec, gitleaks.reason),
  );

  const sastSpec = {
    id: 'sast',
    label: 'Static analysis findings (weighted, per 1,000 lines)',
    weight: 4,
    source: 'semgrep',
  };
  if (semgrep.status === 'ok' && inputs.sourceLines) {
    const weighted = semgrep.data.findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
    const density = perKloc(weighted, inputs.sourceLines) ?? 0;
    metrics.push(
      measured(
        sastSpec,
        Math.round(density * 10) / 10,
        'per kloc',
        scale(density, 0, 20),
        `${semgrep.data.count} findings from the default rule pack over ${inputs.sourceLines} lines`,
      ),
    );
  } else {
    metrics.push(
      unavailable(
        sastSpec,
        semgrep.status === 'ok' ? 'line counts are unavailable' : semgrep.reason,
      ),
    );
  }

  const ruffSecSpec = {
    id: 'lint.security',
    label: 'Python security lint findings',
    weight: 2,
    source: 'ruff',
  };
  if (ruff.status === 'ok') {
    const count = ruff.data.findings.filter((f) => f.rule.startsWith('S')).length;
    metrics.push(
      measured(
        ruffSecSpec,
        count,
        'findings',
        100 - count * 10,
        `${count} findings from the S (bandit) rules`,
      ),
    );
  } else {
    metrics.push(unavailable(ruffSecSpec, ruff.reason));
  }

  const policySpec = {
    id: 'security.policy',
    label: 'Security policy',
    weight: 1,
    source: 'inventory',
  };
  metrics.push(
    inventory.status === 'ok'
      ? inferred(
          policySpec,
          inventory.data.securityPolicy,
          100,
          40,
          yesNo(inventory.data.securityPolicy, 'SECURITY.md'),
        )
      : unavailable(policySpec, inventory.reason),
  );
  return metrics;
};

const tests: Builder = (inputs) => {
  const inventory = toolOutcome(inputs, 'inventory');
  const metrics: Metric[] = [];
  metrics.push(
    unavailable(
      { id: 'coverage', label: 'Test coverage', weight: 3, source: 'coverage report' },
      'No coverage report is published with the repository, so coverage is not scored',
    ),
  );
  const ratioSpec = {
    id: 'tests.ratio',
    label: 'Test files per source file',
    weight: 3,
    source: 'inventory',
  };
  const fwSpec = {
    id: 'tests.framework',
    label: 'Test framework in use',
    weight: 2,
    source: 'inventory',
  };
  if (inventory.status === 'ok') {
    const { sourceFiles, testFiles, testFrameworks } = inventory.data;
    metrics.push(
      sourceFiles > 0
        ? measured(
            ratioSpec,
            Math.round((testFiles / sourceFiles) * 100) / 100,
            'ratio',
            scale(testFiles / sourceFiles, 0.3, 0),
            `${testFiles} test files for ${sourceFiles} source files`,
          )
        : unavailable(ratioSpec, 'no source files were found'),
    );
    metrics.push(
      inferred(
        fwSpec,
        testFrameworks.length > 0,
        100,
        0,
        testFrameworks.length ? `Uses ${testFrameworks.join(', ')}` : 'No test framework detected',
      ),
    );
  } else {
    metrics.push(unavailable(ratioSpec, inventory.reason), unavailable(fwSpec, inventory.reason));
  }
  return metrics;
};

const maintainability: Builder = (inputs) => {
  const lizard = toolOutcome(inputs, 'lizard');
  const inventory = toolOutcome(inputs, 'inventory');
  const metrics: Metric[] = [];
  const sizeSpec = {
    id: 'functions.size',
    label: 'Average function length',
    weight: 3,
    source: 'lizard',
  };
  if (lizard.status === 'ok' && lizard.data.functionCount > 0) {
    const avg = Math.round(lizard.data.nloc / lizard.data.functionCount);
    metrics.push(
      measured(
        sizeSpec,
        avg,
        'lines',
        scale(avg, 15, 60),
        `${lizard.data.nloc} lines of code across ${lizard.data.functionCount} functions`,
      ),
    );
  } else {
    metrics.push(
      unavailable(sizeSpec, lizard.status === 'ok' ? 'no functions were found' : lizard.reason),
    );
  }
  const specs = [
    {
      spec: { id: 'types', label: 'Type checking', weight: 2, source: 'inventory' },
      key: 'typeChecking',
      absent: 50,
      what: 'TypeScript, mypy or pyright configuration',
    },
    {
      spec: { id: 'formatter', label: 'Formatter configured', weight: 1, source: 'inventory' },
      key: 'formatterConfig',
      absent: 60,
      what: 'formatter configuration',
    },
    {
      spec: { id: 'hooks', label: 'Pre-commit hooks', weight: 1, source: 'inventory' },
      key: 'preCommitHooks',
      absent: 60,
      what: 'pre-commit or husky configuration',
    },
  ] as const;
  for (const { spec, key, absent, what } of specs) {
    if (inventory.status !== 'ok') {
      metrics.push(unavailable(spec, inventory.reason));
      continue;
    }
    const raw = inventory.data[key];
    const present = Array.isArray(raw) ? raw.length > 0 : raw;
    metrics.push(inferred(spec, present, 100, absent, yesNo(present, what)));
  }
  return metrics;
};

const documentation: Builder = (inputs) => {
  const inventory = toolOutcome(inputs, 'inventory');
  const readmeSpec = { id: 'readme.length', label: 'README depth', weight: 3, source: 'inventory' };
  const installSpec = {
    id: 'readme.install',
    label: 'Installation or setup section',
    weight: 2,
    source: 'inventory',
  };
  const usageSpec = {
    id: 'readme.usage',
    label: 'Usage or examples section',
    weight: 2,
    source: 'inventory',
  };
  const codeSpec = {
    id: 'readme.code',
    label: 'Code examples in README',
    weight: 1,
    source: 'inventory',
  };
  const apiSpec = { id: 'docs.api', label: 'API documentation', weight: 1, source: 'inventory' };
  const contribSpec = {
    id: 'docs.contributing',
    label: 'Contributing guide',
    weight: 1,
    source: 'inventory',
  };
  const changelogSpec = {
    id: 'docs.changelog',
    label: 'Changelog',
    weight: 1,
    source: 'inventory',
  };
  const licenseSpec = { id: 'docs.license', label: 'License file', weight: 1, source: 'inventory' };
  if (inventory.status !== 'ok') {
    return [
      readmeSpec,
      installSpec,
      usageSpec,
      codeSpec,
      apiSpec,
      contribSpec,
      changelogSpec,
      licenseSpec,
    ].map((s) => unavailable(s, inventory.reason));
  }
  const d = inventory.data;
  const metrics: Metric[] = [];
  if (d.readmeLines === null) {
    metrics.push(measured(readmeSpec, 0, 'lines', 0, 'No README at the repository root'));
    metrics.push(
      measured(installSpec, 0, 'present', 0, 'No README'),
      measured(usageSpec, 0, 'present', 0, 'No README'),
      measured(codeSpec, 0, 'present', 0, 'No README'),
    );
  } else {
    metrics.push(
      measured(
        readmeSpec,
        d.readmeLines,
        'lines',
        scale(d.readmeLines, 60, 5),
        `README has ${d.readmeLines} lines`,
      ),
    );
    metrics.push(
      inferred(
        installSpec,
        d.readmeHasInstall === true,
        100,
        0,
        yesNo(d.readmeHasInstall === true, 'An install/setup heading'),
      ),
    );
    metrics.push(
      inferred(
        usageSpec,
        d.readmeHasUsage === true,
        100,
        0,
        yesNo(d.readmeHasUsage === true, 'A usage/examples heading'),
      ),
    );
    metrics.push(
      inferred(
        codeSpec,
        d.readmeHasCodeBlocks === true,
        100,
        30,
        yesNo(d.readmeHasCodeBlocks === true, 'A fenced code block'),
      ),
    );
  }
  metrics.push(
    inferred(apiSpec, d.apiDocs, 100, 50, yesNo(d.apiDocs, 'An OpenAPI file or docs/api')),
  );
  metrics.push(
    inferred(
      contribSpec,
      d.communityFiles.CONTRIBUTING === true,
      100,
      40,
      yesNo(d.communityFiles.CONTRIBUTING === true, 'CONTRIBUTING'),
    ),
  );
  metrics.push(
    inferred(
      changelogSpec,
      d.communityFiles.CHANGELOG === true,
      100,
      50,
      yesNo(d.communityFiles.CHANGELOG === true, 'A changelog'),
    ),
  );
  metrics.push(
    inferred(
      licenseSpec,
      d.communityFiles.LICENSE === true,
      100,
      0,
      yesNo(d.communityFiles.LICENSE === true, 'LICENSE'),
    ),
  );
  return metrics;
};

const dependencies: Builder = (inputs) => {
  const osv = toolOutcome(inputs, 'osv');
  const inventory = toolOutcome(inputs, 'inventory');
  const metrics: Metric[] = [];
  const vulnSpec = {
    id: 'vulnerabilities',
    label: 'Known vulnerabilities (severity weighted)',
    weight: 5,
    source: 'osv-scanner',
  };
  if (osv.status === 'ok') {
    const weighted = osv.data.vulnerabilities.reduce(
      (sum, v) => sum + SEVERITY_WEIGHT[v.severity],
      0,
    );
    const counts = Object.entries(
      osv.data.vulnerabilities.reduce<Record<string, number>>(
        (acc, v) => ({ ...acc, [v.severity]: (acc[v.severity] ?? 0) + 1 }),
        {},
      ),
    ).map(([k, n]) => `${n} ${k}`);
    metrics.push(
      measured(
        vulnSpec,
        osv.data.vulnerabilities.length,
        'advisories',
        100 - weighted,
        osv.data.vulnerabilities.length
          ? `${counts.join(', ')} across ${osv.data.packagesScanned} packages in ${osv.data.lockfilesScanned.join(', ')}`
          : `No known vulnerabilities in ${osv.data.packagesScanned} packages`,
      ),
    );
  } else {
    metrics.push(unavailable(vulnSpec, osv.reason));
  }
  const lockSpec = { id: 'lockfile', label: 'Dependency lockfile', weight: 2, source: 'inventory' };
  const botSpec = {
    id: 'dependency.updates',
    label: 'Automated dependency updates',
    weight: 2,
    source: 'inventory',
  };
  if (inventory.status === 'ok') {
    const hasManifests = inventory.data.manifests.length > 0;
    metrics.push(
      hasManifests
        ? inferred(
            lockSpec,
            inventory.data.lockfiles.length > 0,
            100,
            40,
            inventory.data.lockfiles.length
              ? `Found ${inventory.data.lockfiles.join(', ')}`
              : 'Manifests without a lockfile',
          )
        : unavailable(lockSpec, 'no dependency manifest found'),
    );
    metrics.push(
      inferred(
        botSpec,
        inventory.data.dependabotOrRenovate,
        100,
        50,
        yesNo(inventory.data.dependabotOrRenovate, 'Dependabot or Renovate configuration'),
      ),
    );
  } else {
    metrics.push(unavailable(lockSpec, inventory.reason), unavailable(botSpec, inventory.reason));
  }
  return metrics;
};

const architecture: Builder = (inputs) => {
  const a = inputs.architecture ?? null;
  const cyclesSpec = {
    id: 'architecture.cycles',
    label: 'Files caught in import cycles',
    weight: 3,
    source: 'module graph',
  };
  const layersSpec = {
    id: 'architecture.layering',
    label: 'Imports against the layer direction',
    weight: 3,
    source: 'module graph',
  };
  const hubSpec = {
    id: 'architecture.hub',
    label: 'Dependence on a single hub file',
    weight: 2,
    source: 'module graph',
  };
  const structureSpec = {
    id: 'architecture.structure',
    label: 'Code in recognisable layers',
    weight: 2,
    source: 'module graph',
  };
  if (!a || a.files === 0) {
    const reason = a
      ? 'the graph has no parsed files'
      : 'No architecture graph has been built for this commit; map the repository first';
    return [cyclesSpec, layersSpec, hubSpec, structureSpec].map((spec) =>
      unavailable(spec, reason),
    );
  }
  const cycleShare = a.filesInCycles / a.files;
  const violationShare = a.internalImports > 0 ? a.layerViolations / a.internalImports : 0;
  return [
    measured(
      cyclesSpec,
      Math.round(cycleShare * 1000) / 10,
      '%',
      scale(cycleShare, 0, 0.25),
      `${a.filesInCycles} of ${a.files} files sit in ${a.cycles} import cycle(s)`,
    ),
    a.internalImports > 0
      ? measured(
          layersSpec,
          Math.round(violationShare * 1000) / 10,
          '%',
          scale(violationShare, 0, 0.2),
          `${a.layerViolations} of ${a.internalImports} internal imports go against the layer direction`,
        )
      : unavailable(layersSpec, 'no internal imports to judge'),
    a.topFanInShare !== null
      ? measured(
          hubSpec,
          Math.round(a.topFanInShare * 100),
          '%',
          scale(a.topFanInShare, 0.15, 0.6),
          `${Math.round(a.topFanInShare * 100)}% of internal imports target one file`,
        )
      : unavailable(hubSpec, 'no internal imports to judge'),
    measured(
      structureSpec,
      Math.round(a.layeredShare * 100),
      '%',
      scale(a.layeredShare, 0.8, 0.3),
      `${Math.round(a.layeredShare * 100)}% of files fall into a recognised layer`,
    ),
  ];
};

const community: Builder = (inputs) => {
  const s = inputs.signals;
  const inventory = toolOutcome(inputs, 'inventory');
  const metrics: Metric[] = [];
  const responseSpec = {
    id: 'issues.response',
    label: 'Median time to first issue response',
    weight: 3,
    source: 'github',
  };
  const contributorsSpec = {
    id: 'contributors',
    label: 'Contributors',
    weight: 2,
    source: 'github',
  };
  const cocSpec = {
    id: 'code-of-conduct',
    label: 'Code of conduct',
    weight: 1,
    source: 'inventory',
  };
  if (!s) {
    metrics.push(
      unavailable(responseSpec, 'GitHub signals were not collected'),
      unavailable(contributorsSpec, 'GitHub signals were not collected'),
    );
  } else {
    metrics.push(
      s.medianFirstResponseHours !== null
        ? measured(
            responseSpec,
            Math.round(s.medianFirstResponseHours),
            'hours',
            scale(s.medianFirstResponseHours, 24, 24 * 14),
            `Median of ${s.issuesSampled} recent issues`,
          )
        : unavailable(
            responseSpec,
            s.issuesSampled === 0
              ? 'no recent issues with comments to measure'
              : 'issue comments could not be read',
          ),
    );
    metrics.push(
      s.contributors !== null
        ? measured(
            contributorsSpec,
            s.contributors,
            'people',
            scale(s.contributors, 10, 1),
            `${s.contributors} contributor(s) listed by GitHub`,
          )
        : unavailable(contributorsSpec, 'contributor list could not be read'),
    );
  }
  metrics.push(
    inventory.status === 'ok'
      ? inferred(
          cocSpec,
          inventory.data.communityFiles.CODE_OF_CONDUCT === true,
          100,
          50,
          yesNo(inventory.data.communityFiles.CODE_OF_CONDUCT === true, 'CODE_OF_CONDUCT'),
        )
      : unavailable(cocSpec, inventory.reason),
  );
  return metrics;
};

const activity: Builder = (inputs, now) => {
  const s = inputs.signals;
  const pushSpec = {
    id: 'push.recency',
    label: 'Days since last push',
    weight: 3,
    source: 'github',
  };
  const commitsSpec = {
    id: 'commits.90d',
    label: 'Commits in the last 90 days',
    weight: 2,
    source: 'github',
  };
  const releasesSpec = {
    id: 'releases.year',
    label: 'Releases in the last year',
    weight: 1,
    source: 'github',
  };
  if (!s)
    return [pushSpec, commitsSpec, releasesSpec].map((spec) =>
      unavailable(spec, 'GitHub signals were not collected'),
    );
  if (s.archived) {
    return [
      measured(pushSpec, 0, 'archived', 0, 'The repository is archived'),
      measured(commitsSpec, 0, 'archived', 0, 'The repository is archived'),
      measured(releasesSpec, 0, 'archived', 0, 'The repository is archived'),
    ];
  }
  const metrics: Metric[] = [];
  if (s.pushedAt) {
    const days = Math.max(0, Math.round((now - Date.parse(s.pushedAt)) / DAY_MS));
    metrics.push(
      measured(pushSpec, days, 'days', scale(days, 7, 365), `Last push ${days} day(s) ago`),
    );
  } else {
    metrics.push(unavailable(pushSpec, 'GitHub did not report a push date'));
  }
  metrics.push(
    s.commitsLast90Days !== null
      ? measured(
          commitsSpec,
          s.commitsLast90Days,
          'commits',
          scale(s.commitsLast90Days, 30, 0),
          `${s.commitsLast90Days} commit(s) on the default branch in 90 days`,
        )
      : unavailable(commitsSpec, 'commit history could not be read'),
  );
  metrics.push(
    s.releasesLastYear !== null
      ? s.releasesLastYear > 0
        ? measured(
            releasesSpec,
            s.releasesLastYear,
            'releases',
            scale(s.releasesLastYear, 4, 0),
            `${s.releasesLastYear} release(s) in the last year`,
          )
        : inferred(releasesSpec, false, 100, 30, 'No GitHub releases; the project may not use them')
      : unavailable(releasesSpec, 'releases could not be read'),
  );
  return metrics;
};

const cicd: Builder = (inputs) => {
  const inventory = toolOutcome(inputs, 'inventory');
  const s = inputs.signals;
  const wfSpec = { id: 'ci.workflows', label: 'CI workflows', weight: 2, source: 'inventory' };
  const checksSpec = {
    id: 'ci.checks',
    label: 'Checks on the analysed commit',
    weight: 2,
    source: 'github',
  };
  const ownersSpec = { id: 'codeowners', label: 'CODEOWNERS', weight: 1, source: 'inventory' };
  const metrics: Metric[] = [];
  if (inventory.status === 'ok') {
    const n = inventory.data.ciWorkflows.length;
    metrics.push(
      inferred(
        wfSpec,
        n > 0,
        100,
        0,
        n ? `${n} workflow file(s) under .github/workflows` : 'No GitHub Actions workflows',
      ),
    );
    metrics.push(
      inferred(
        ownersSpec,
        inventory.data.codeowners,
        100,
        60,
        yesNo(inventory.data.codeowners, 'CODEOWNERS'),
      ),
    );
  } else {
    metrics.push(unavailable(wfSpec, inventory.reason), unavailable(ownersSpec, inventory.reason));
  }
  if (!s) metrics.push(unavailable(checksSpec, 'GitHub signals were not collected'));
  else if (s.checkRuns === null)
    metrics.push(unavailable(checksSpec, 'check runs could not be read'));
  else if (s.checkRuns.length === 0)
    metrics.push(unavailable(checksSpec, 'no checks ran on this commit'));
  else {
    const failed = s.checkRuns.filter(
      (c) => c === 'failure' || c === 'timed_out' || c === 'cancelled',
    ).length;
    const passed = s.checkRuns.filter((c) => c === 'success').length;
    metrics.push(
      measured(
        checksSpec,
        passed,
        'passed',
        failed === 0 ? 100 : 30,
        `${passed} passed, ${failed} failed of ${s.checkRuns.length} check run(s)`,
      ),
    );
  }
  return metrics;
};

const busFactor: Builder = (inputs) => {
  const s = inputs.signals;
  const shareSpec = {
    id: 'bus.top-share',
    label: 'Share of commits by the top contributor',
    weight: 2,
    source: 'github',
  };
  const coreSpec = {
    id: 'bus.core',
    label: 'Contributors with over 10% of commits',
    weight: 1,
    source: 'github',
  };
  if (!s)
    return [
      unavailable(shareSpec, 'GitHub signals were not collected'),
      unavailable(coreSpec, 'GitHub signals were not collected'),
    ];
  return [
    s.topContributorShare !== null
      ? measured(
          shareSpec,
          Math.round(s.topContributorShare * 100),
          '%',
          scale(s.topContributorShare, 0.4, 0.9),
          `Top contributor made ${Math.round(s.topContributorShare * 100)}% of commits`,
        )
      : unavailable(shareSpec, 'contributor statistics could not be read'),
    s.maintainersOver10Percent !== null
      ? measured(
          coreSpec,
          s.maintainersOver10Percent,
          'people',
          scale(s.maintainersOver10Percent, 3, 0),
          `${s.maintainersOver10Percent} contributor(s) made over 10% of commits each`,
        )
      : unavailable(coreSpec, 'contributor statistics could not be read'),
  ];
};

const BUILDERS: Record<Area, Builder> = {
  codeQuality,
  security,
  tests,
  maintainability,
  documentation,
  dependencies,
  architecture,
  community,
  activity,
  cicd,
  busFactor,
};

// ---- aggregation ------------------------------------------------------------------------------------

export function scoreArea(id: Area, metrics: Metric[]): AreaScore {
  const total = metrics.reduce((sum, m) => sum + m.weight, 0);
  const observed = metrics.filter((m): m is Metric & { score: number } => m.score !== null);
  const observedWeight = observed.reduce((sum, m) => sum + m.weight, 0);
  const score =
    observedWeight > 0
      ? clamp(observed.reduce((sum, m) => sum + m.score * m.weight, 0) / observedWeight)
      : null;
  return {
    id,
    label: AREA_LABELS[id],
    weight: WEIGHTS[id],
    score,
    confidence: total > 0 ? Math.round((observedWeight / total) * 100) / 100 : 0,
    metrics,
  };
}

/** Findings worth listing on the score, bounded per tool, with complexity hotspots included. */
export function collectFindings(inputs: AnalysisInputs): {
  findings: Finding[];
  truncated: Record<string, number>;
} {
  const findings: Finding[] = [];
  const truncated: Record<string, number> = {};
  const take = (tool: string, list: Finding[]): void => {
    findings.push(...list.slice(0, MAX_FINDINGS_PER_TOOL));
    if (list.length > MAX_FINDINGS_PER_TOOL) truncated[tool] = list.length - MAX_FINDINGS_PER_TOOL;
  };
  for (const tool of ['gitleaks', 'semgrep', 'ruff'] as const) {
    const outcome = toolOutcome(inputs, tool);
    if (outcome.status === 'ok') take(tool, outcome.data.findings);
  }
  const osv = toolOutcome(inputs, 'osv');
  if (osv.status === 'ok') {
    take(
      'osv',
      osv.data.vulnerabilities.map((v) => ({
        tool: 'osv' as const,
        rule: v.id,
        severity: v.severity,
        message: `${v.package} ${v.version} (${v.ecosystem})${v.fixedIn ? `, fixed in ${v.fixedIn}` : ''}`,
        path: osv.data.lockfilesScanned[0] ?? '',
        line: null,
      })),
    );
  }
  const lizard = toolOutcome(inputs, 'lizard');
  if (lizard.status === 'ok') {
    take(
      'lizard',
      lizard.data.complexFunctions.map((f) => ({
        tool: 'lizard' as const,
        rule: 'complexity',
        severity: f.ccn > 30 ? ('medium' as const) : ('low' as const),
        message: `${f.name} has cyclomatic complexity ${f.ccn}`,
        path: f.path,
        line: f.line,
      })),
    );
  }
  return { findings, truncated };
}

export function computeHealth(inputs: AnalysisInputs, now: number = Date.now()): HealthScore {
  const areas = (Object.keys(BUILDERS) as Area[]).map((id) =>
    scoreArea(id, BUILDERS[id](inputs, now)),
  );
  const totalWeight = areas.reduce((sum, a) => sum + a.weight, 0);
  // An area counts towards what was observed in proportion to how much of it could be seen.
  const observedWeight = areas.reduce(
    (sum, a) => sum + (a.score === null ? 0 : a.weight * a.confidence),
    0,
  );
  const confidence = Math.round((observedWeight / totalWeight) * 100) / 100;
  const scored = areas.filter((a): a is AreaScore & { score: number } => a.score !== null);
  const scoredWeight = scored.reduce((sum, a) => sum + a.weight, 0);
  const enough = confidence >= MIN_CONFIDENCE_FOR_SCORE && scoredWeight > 0;
  const overall = enough
    ? clamp(scored.reduce((sum, a) => sum + a.score * a.weight, 0) / scoredWeight)
    : null;
  const { findings, truncated } = collectFindings(inputs);
  return {
    overall,
    status: enough ? 'scored' : 'insufficient-data',
    confidence,
    observedWeight: Math.round(observedWeight * 100) / 100,
    totalWeight,
    formula: FORMULA,
    weights: WEIGHTS,
    areas,
    findings,
    findingsTruncated: truncated,
  };
}

export type MetricStatusCount = Record<MetricStatus, number>;

export function countStatuses(score: HealthScore): MetricStatusCount {
  const counts: MetricStatusCount = { measured: 0, inferred: 0, unavailable: 0 };
  for (const area of score.areas) for (const m of area.metrics) counts[m.status] += 1;
  return counts;
}
