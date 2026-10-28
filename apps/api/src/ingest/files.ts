import type { Language } from './types.js';

export const LIMITS = {
  maxFiles: 2000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 20_000_000,
  /** Source files are fetched last and only up to this many. */
  maxSourceFiles: 300,
} as const;

export type FileKind = 'markdown' | 'manifest' | 'env' | 'openapi' | 'source' | 'other';

export type SkipReason = 'binary' | 'generated' | 'lock' | 'vendor' | 'too-large';

export interface FileClass {
  include: boolean;
  reason: SkipReason | null;
  kind: FileKind;
  language: Language | null;
}

const VENDOR_DIRS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.git',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  '.idea',
  '.vscode',
]);

const LOCK_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'uv.lock',
  'cargo.lock',
  'go.sum',
  'composer.lock',
  'gemfile.lock',
  'pipfile.lock',
]);

const BINARY_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'ico',
  'bmp',
  'webp',
  'svgz',
  'pdf',
  'zip',
  'tar',
  'gz',
  'tgz',
  '7z',
  'rar',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'wav',
  'wasm',
  'exe',
  'dll',
  'so',
  'dylib',
  'jar',
  'class',
  'pyc',
  'o',
  'a',
  'bin',
  'dat',
  'db',
  'sqlite',
]);

const SOURCE_LANGUAGE: Record<string, Language> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  java: 'java',
};

const GENERATED = /(\.min\.(js|css)|\.map|\.generated\.\w+|\.pb\.go|_pb2(_grpc)?\.py|\.d\.ts)$/i;

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function extension(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isManifestName(name: string): boolean {
  return (
    name === 'package.json' ||
    name === 'pyproject.toml' ||
    name === 'pom.xml' ||
    name === 'go.mod' ||
    /^requirements([-_.][\w.-]+)?\.txt$/i.test(name)
  );
}

function isEnvExample(name: string): boolean {
  return /^\.env\.(example|sample|template)$/i.test(name) || /^env\.(example|sample)$/i.test(name);
}

function isOpenApiName(name: string): boolean {
  return /^(openapi|swagger)([-_.][\w.-]*)?\.(json|ya?ml)$/i.test(name);
}

/** Decides whether a path is worth fetching and what it is for. Size is checked separately. */
export function classifyPath(path: string): FileClass {
  const parts = path.split('/');
  const name = parts[parts.length - 1] ?? path;
  const lower = name.toLowerCase();
  const none = { include: false, kind: 'other' as FileKind, language: null };

  if (parts.slice(0, -1).some((part) => VENDOR_DIRS.has(part))) {
    return { ...none, reason: 'vendor' };
  }
  if (LOCK_FILES.has(lower)) return { ...none, reason: 'lock' };
  if (BINARY_EXT.has(extension(path))) return { ...none, reason: 'binary' };
  if (GENERATED.test(lower)) return { ...none, reason: 'generated' };

  const ext = extension(path);
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') {
    return { include: true, reason: null, kind: 'markdown', language: null };
  }
  if (isManifestName(name))
    return { include: true, reason: null, kind: 'manifest', language: null };
  if (isEnvExample(name)) return { include: true, reason: null, kind: 'env', language: null };
  if (isOpenApiName(name)) return { include: true, reason: null, kind: 'openapi', language: null };

  const language = SOURCE_LANGUAGE[ext];
  if (language) return { include: true, reason: null, kind: 'source', language };
  return { ...none, reason: null };
}
