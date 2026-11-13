interface FileLinkProps {
  fullName: string;
  sha: string;
  path: string;
  line?: number | null | undefined;
}

/** A path as a link to that file, and line, on GitHub at the ingested commit. */
export function FileLink({ fullName, sha, path, line }: FileLinkProps) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return (
    <a
      className="font-mono text-xs underline"
      href={`https://github.com/${fullName}/blob/${sha}/${encoded}${line ? `#L${line}` : ''}`}
      target="_blank"
      rel="noreferrer"
    >
      {path}
      {line ? `:${line}` : ''}
    </a>
  );
}
