/** True when `candidate` (a run of backticks or tildes) closes a fence opened with `open`. */
export function closesFence(open: string, candidate: string | undefined): boolean {
  return candidate?.startsWith(open.charAt(0)) === true && candidate.length >= open.length;
}

/** Regex groups come back as empty strings when they match nothing; treat those as absent. */
export function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}
