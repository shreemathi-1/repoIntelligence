import { useState } from 'react';
import {
  AUTH_APPROACHES,
  COPYLEFT_LIMITS,
  DB_ENGINES,
  DEPLOYMENTS,
  INFRASTRUCTURE,
  LICENSE_USES,
  OPERATING_SYSTEMS,
  RUNTIMES,
  type StackProfileInput,
} from '@repointelligence/shared';
import { Button } from '@/components/ui/button';
import { useParseManifest } from '@/hooks/use-adaptability';
import { ApiError } from '@/lib/api-client';
import { formatFrameworks, parseFrameworks } from '@/lib/stack-profile';

const field = 'border-input bg-background h-8 rounded-md border px-2 text-sm';
const LABELS: Record<string, string> = {
  node: 'Node.js', python: 'Python', java: 'Java', go: 'Go',
  postgresql: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite', mongodb: 'MongoDB', mssql: 'SQL Server',
  none: 'None', session: 'Server sessions', jwt: 'JSON Web Tokens', oauth: 'OAuth / OpenID Connect', saml: 'SAML', hosted: 'Hosted identity provider',
  linux: 'Linux', macos: 'macOS', windows: 'Windows',
  container: 'Containers', serverless: 'Serverless functions', vm: 'Virtual machines', paas: 'Platform as a service',
  docker: 'Docker', redis: 'Redis', queue: 'Message queue', 'object-storage': 'Object storage', smtp: 'SMTP', search: 'Search engine',
  internal: 'Internal use only', saas: 'Run as a hosted service', distributed: 'Ship it to others',
  weak: 'Weak copyleft (MPL, LGPL)', strong: 'Strong copyleft (GPL, AGPL)',
}; // prettier-ignore
const MANIFESTS = ['package.json', 'requirements.txt', 'pyproject.toml', 'pom.xml', 'go.mod'];
const label = (key: string): string => LABELS[key] ?? key;

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

interface StackFormProps {
  value: StackProfileInput;
  onChange: (next: StackProfileInput) => void;
}

/** The questionnaire about the user's own stack. It only edits the draft; the parent submits it. */
export function StackForm({ value, onChange }: StackFormProps) {
  const set = (patch: Partial<StackProfileInput>) => {
    onChange({ ...value, ...patch });
  };
  // Typed text is kept as typed, so a half-written entry is not rewritten under the cursor.
  const [frameworks, setFrameworks] = useState(() => formatFrameworks(value.frameworks));
  const [manifest, setManifest] = useState({ filename: 'package.json', content: '' });
  const parse = useParseManifest();

  const load = () => {
    parse.mutate(manifest, {
      onSuccess: (parsed) => {
        const other = value.dependencies.filter((d) => d.ecosystem !== parsed.ecosystem);
        set({ dependencies: [...other, ...parsed.dependencies], runtimes: { ...parsed.runtimes, ...value.runtimes } });
        setManifest({ ...manifest, content: '' });
      },
    });
  }; // prettier-ignore

  return (
    <div className="space-y-4 text-sm">
      <label className="block space-y-1">
        <span className="font-medium">Profile name</span>
        <input className={`${field} w-full max-w-xs`} value={value.name} maxLength={60} onChange={(e) => { set({ name: e.target.value }); }} />
      </label>

      <fieldset className="space-y-1">
        <legend className="font-medium">Runtime versions you run</legend>
        <div className="flex flex-wrap gap-3">
          {RUNTIMES.map((r) => (
            <label key={r} className="flex items-center gap-1.5">
              {label(r)}
              <input
                className={`${field} w-20`}
                placeholder="none"
                inputMode="decimal"
                value={value.runtimes[r] ?? ''}
                onChange={(e) => {
                  set({ runtimes: { ...value.runtimes, [r]: e.target.value.trim() || undefined } });
                }}
              />
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block space-y-1">
        <span className="font-medium">Frameworks</span>
        <input
          className={`${field} w-full`}
          placeholder="Express 5.1, React 19"
          value={frameworks}
          onChange={(e) => {
            setFrameworks(e.target.value);
            set({ frameworks: parseFrameworks(e.target.value) });
          }}
        />
      </label>

      <fieldset className="space-y-1">
        <legend className="font-medium">Databases</legend>
        <div className="flex flex-wrap gap-3">
          {DB_ENGINES.map((engine) => (
            <label key={engine} className="flex items-center gap-1.5">
              <input type="checkbox" checked={value.databases.some((d) => d.engine === engine)} onChange={() => { set({ databases: value.databases.some((d) => d.engine === engine) ? value.databases.filter((d) => d.engine !== engine) : [...value.databases, { engine }] }); }} />
              {label(engine)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-4">
        <label className="space-y-1">
          <span className="block font-medium">Authentication</span>
          <select className={field} value={value.auth} onChange={(e) => { set({ auth: e.target.value as StackProfileInput['auth'] }); }}>
            {AUTH_APPROACHES.map((a) => <option key={a} value={a}>{label(a)}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block font-medium">Deployment target</span>
          <select className={field} value={value.deployment ?? ''} onChange={(e) => { set({ deployment: (e.target.value || undefined) as StackProfileInput['deployment'] }); }}>
            <option value="">Not specified</option>
            {DEPLOYMENTS.map((d) => <option key={d} value={d}>{label(d)}</option>)}
          </select>
        </label>
      </div>

      <fieldset className="space-y-1">
        <legend className="font-medium">Operating systems</legend>
        <div className="flex flex-wrap gap-3">
          {OPERATING_SYSTEMS.map((os) => (
            <label key={os} className="flex items-center gap-1.5">
              <input type="checkbox" checked={value.os.includes(os)} onChange={() => { set({ os: toggle(value.os, os) }); }} />
              {label(os)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-1">
        <legend className="font-medium">Infrastructure you already run</legend>
        <div className="flex flex-wrap gap-3">
          {INFRASTRUCTURE.map((item) => (
            <label key={item} className="flex items-center gap-1.5">
              <input type="checkbox" checked={value.infrastructure.includes(item)} onChange={() => { set({ infrastructure: toggle(value.infrastructure, item) }); }} />
              {label(item)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-4">
        <label className="space-y-1">
          <span className="block font-medium">How you will use the code</span>
          <select className={field} value={value.license.use} onChange={(e) => { set({ license: { ...value.license, use: e.target.value as StackProfileInput['license']['use'] } }); }}>
            {LICENSE_USES.map((u) => <option key={u} value={u}>{label(u)}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block font-medium">Copyleft you accept</span>
          <select className={field} value={value.license.copyleft} onChange={(e) => { set({ license: { ...value.license, copyleft: e.target.value as StackProfileInput['license']['copyleft'] } }); }}>
            {COPYLEFT_LIMITS.map((c) => <option key={c} value={c}>{label(c)}</option>)}
          </select>
        </label>
      </div>

      <fieldset className="space-y-1">
        <legend className="font-medium">Your dependencies (optional)</legend>
        <p className="text-muted-foreground text-xs">
          Paste a manifest to check for version conflicts. {value.dependencies.length} dependencies loaded.
          {value.dependencies.length > 0 && (
            <button type="button" className="ml-2 underline" onClick={() => { set({ dependencies: [] }); }}>Clear</button>
          )}
        </p>
        <div className="flex flex-wrap items-start gap-2">
          <select aria-label="Manifest type" className={field} value={manifest.filename} onChange={(e) => { setManifest({ ...manifest, filename: e.target.value }); }}>
            {MANIFESTS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <textarea aria-label="Manifest contents" className="border-input bg-background min-h-16 flex-1 rounded-md border p-2 font-mono text-xs" value={manifest.content} maxLength={80_000} onChange={(e) => { setManifest({ ...manifest, content: e.target.value }); }} />
          <Button type="button" size="sm" variant="outline" disabled={!manifest.content.trim() || parse.isPending} onClick={load}>Load</Button>
        </div>
        {parse.error && <p role="alert" className="text-destructive text-xs">{parse.error instanceof ApiError ? parse.error.message : 'Could not read the manifest.'}</p>}
      </fieldset>

      <label className="block space-y-1">
        <span className="font-medium">Other requirements (optional)</span>
        <textarea className="border-input bg-background min-h-12 w-full rounded-md border p-2 text-sm" maxLength={500} value={value.requirements} onChange={(e) => { set({ requirements: e.target.value }); }} />
      </label>
    </div>
  );
} // prettier-ignore
