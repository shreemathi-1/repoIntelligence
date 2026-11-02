"""Builds the architecture graph of an extracted repository."""

import re
import time
from collections import Counter
from pathlib import Path

from app.graph.detect import (
    Detection,
    Model,
    Route,
    detect_in_file,
    detect_stack,
    migration_files,
    prisma_models,
)
from app.graph.imports import ImportEdge, Resolver, extract_imports
from app.graph.layers import find_cycles, layer_of, layer_violations
from app.graph.parse import discover
from app.graph.symbols import MAX_CALLS, Relation, Symbol, extract_calls, extract_symbols

MANIFEST_NAMES = re.compile(
    r"^(package\.json|pyproject\.toml|requirements[\w.-]*\.txt|pom\.xml|build\.gradle(\.kts)?|tsconfig[\w.-]*\.json|jsconfig\.json|schema\.prisma)$"
)
MAX_MANIFEST_BYTES = 256 * 1024


def _read_manifests(root: Path, other_paths: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for rel in other_paths:
        if MANIFEST_NAMES.match(rel.rsplit("/", 1)[-1]) or rel.endswith(".prisma"):
            try:
                out[rel] = (root / rel).read_bytes()[:MAX_MANIFEST_BYTES].decode("utf-8", "replace")
            except OSError:
                continue
    return out


def _dedupe_entries(entries: list[Detection]) -> list[Detection]:
    seen: set[tuple[str, str, str]] = set()
    out: list[Detection] = []
    for entry in entries:
        key = (entry.kind, entry.path, entry.label)
        if key not in seen:
            seen.add(key)
            out.append(entry)
    return out


def build_graph(root: Path) -> dict[str, object]:
    started = time.monotonic()
    found = discover(root)
    paths = {f.path for f in found.files} | set(found.other_paths)
    manifests = _read_manifests(root, found.other_paths)
    resolver = Resolver(paths, manifests)

    imports: list[ImportEdge] = []
    symbols: list[Symbol] = []
    extends_pairs: list[tuple[Symbol, str]] = []
    imports_by_file: dict[str, list[ImportEdge]] = {}
    symbols_by_file: dict[str, list[Symbol]] = {}
    for file in found.files:
        edges = extract_imports(file, resolver)
        imports.extend(edges)
        imports_by_file[file.path] = edges
        syms, ext = extract_symbols(file)
        symbols.extend(syms)
        extends_pairs.extend(ext)
        symbols_by_file[file.path] = syms

    by_name: dict[str, list[Symbol]] = {}
    for symbol in symbols:
        if symbol.kind in ("class", "interface"):
            by_name.setdefault(symbol.name, []).append(symbol)
    relations: list[Relation] = []
    for symbol, parent in extends_pairs:
        imported_files = {e.target for e in imports_by_file.get(symbol.path, []) if e.target}
        # Same file, an imported file, or the same directory (Java packages need no import).
        folder = symbol.path.rsplit("/", 1)[0]
        candidates = [
            c
            for c in by_name.get(parent, [])
            if c.path == symbol.path
            or c.path in imported_files
            or c.path.rsplit("/", 1)[0] == folder
        ]
        target = candidates[0].id if candidates else f"external:{parent}"
        relations.append(Relation(symbol.id, target, "extends", symbol.line, "name"))

    budget = MAX_CALLS
    for file in found.files:
        if budget <= 0:
            break
        calls = extract_calls(
            file, symbols_by_file[file.path], symbols_by_file, imports_by_file[file.path], budget
        )
        budget -= len(calls)
        relations.extend(calls)

    entries: list[Detection] = []
    routes: list[Route] = []
    models: list[Model] = []
    auth: list[Detection] = []
    for file in found.files:
        e, r, m, a = detect_in_file(file, symbols_by_file[file.path], imports_by_file[file.path])
        entries.extend(e)
        routes.extend(r)
        models.extend(m)
        auth.extend(a)
    models.extend(migration_files(found.other_paths))
    models.extend(prisma_models(manifests))
    entries.extend(_manifest_entries(manifests))

    layers = {f.path: layer_of(f.path) for f in found.files}
    files_by_language = Counter(f.language for f in found.files)
    externals = sorted({e.external for e in imports if e.external})
    stack = detect_stack(manifests, imports, {str(k): v for k, v in files_by_language.items()})

    return {
        "files": [
            {
                "path": f.path,
                "language": f.language,
                "lines": f.lines,
                "layer": layers[f.path],
                "symbols": len(symbols_by_file[f.path]),
                "imports": sum(1 for e in imports_by_file[f.path] if e.target),
                "importedBy": 0,
            }
            for f in found.files
        ],
        "externals": externals,
        "imports": [e.to_dict() for e in imports],
        "symbols": [s.to_dict() for s in symbols],
        "relations": [r.to_dict() for r in relations],
        "entryPoints": [d.to_dict() for d in _dedupe_entries(entries)],
        "routes": [r.to_dict() for r in routes],
        "models": [m.to_dict() for m in models],
        "auth": [a.to_dict() for a in auth],
        "stack": [s.to_dict() for s in stack],
        "layerViolations": layer_violations(imports, layers),
        "cycles": find_cycles(imports),
        "stats": {
            "filesParsed": len(found.files),
            "filesSkipped": found.skipped,
            "parseErrors": found.parse_errors,
            "truncated": found.truncated,
            "callEdgesTruncated": budget <= 0,
            "durationMs": int((time.monotonic() - started) * 1000),
        },
    }


def _manifest_entries(manifests: dict[str, str]) -> list[Detection]:
    import json

    out: list[Detection] = []
    for path, body in manifests.items():
        if path.rsplit("/", 1)[-1] != "package.json":
            continue
        try:
            data = json.loads(body)
        except ValueError:
            continue
        if not isinstance(data, dict):
            continue
        for key in ("main", "module"):
            value = data.get(key)
            if isinstance(value, str):
                out.append(Detection("entry", path, None, value, f"package.json {key}"))
        bins = data.get("bin")
        if isinstance(bins, str):
            out.append(Detection("entry", path, None, bins, "package.json bin"))
        elif isinstance(bins, dict):
            for name, target in bins.items():
                out.append(
                    Detection("entry", path, None, f"{name} -> {target}", "package.json bin")
                )
        scripts = data.get("scripts")
        if isinstance(scripts, dict):
            for name in ("start", "dev", "serve"):
                if isinstance(scripts.get(name), str):
                    out.append(
                        Detection("script", path, None, f"npm run {name}", str(scripts[name])[:120])
                    )
    return out
