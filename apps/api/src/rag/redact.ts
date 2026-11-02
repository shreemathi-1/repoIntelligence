/**
 * Removes secret values from text before it reaches a model or a user. Variable names stay,
 * values go, so an answer can still say where a setting lives.
 */

const REDACTED = '[redacted]';

const KEY_VALUE =
  /\b((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|authorization|private[_-]?key|client[_-]?secret|access[_-]?key)[\w.-]*)(\s*[:=]\s*)(["']?)([^\s"',;]{8,})(\3)/gi;

const TOKEN_SHAPES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgsk_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

// user:password@ inside a URL
const URL_CREDENTIALS = /(\/\/[^\s/:@]+:)([^\s/@]+)(@)/g;

export function redactSecrets(text: string): string {
  let out = text.replace(KEY_VALUE, (_m, key: string, sep: string, quote: string) => {
    return `${key}${sep}${quote}${REDACTED}${quote}`;
  });
  out = out.replace(URL_CREDENTIALS, `$1${REDACTED}$3`);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

/** True when the text looks like it still carries a secret value. */
export function looksSecret(text: string): boolean {
  return TOKEN_SHAPES.some((shape) => new RegExp(shape.source).test(text));
}
