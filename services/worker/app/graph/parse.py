"""Source discovery and tree-sitter parsing shared by the graph builders."""

from collections.abc import Iterator
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Literal

from tree_sitter import Node, Parser, Tree
from tree_sitter_language_pack import get_parser

Language = Literal["javascript", "typescript", "python", "java"]

GRAMMAR: dict[str, tuple[Language, str]] = {
    ".js": ("javascript", "javascript"),
    ".jsx": ("javascript", "javascript"),
    ".mjs": ("javascript", "javascript"),
    ".cjs": ("javascript", "javascript"),
    ".ts": ("typescript", "typescript"),
    ".mts": ("typescript", "typescript"),
    ".cts": ("typescript", "typescript"),
    ".tsx": ("typescript", "tsx"),
    ".py": ("python", "python"),
    ".java": ("java", "java"),
}
SKIP_DIRS = {
    "node_modules",
    ".git",
    "vendor",
    "dist",
    "build",
    "out",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    "coverage",
    ".nuxt",
    ".svelte-kit",
    "bower_components",
}
MAX_FILES = 3000
MAX_FILE_BYTES = 1_000_000
GENERATED = (".min.js", ".d.ts", ".bundle.js", "_pb2.py", "_pb2_grpc.py")


@dataclass
class SourceFile:
    path: str
    language: Language
    source: bytes
    tree: Tree
    lines: int


@dataclass
class Discovery:
    files: list[SourceFile] = field(default_factory=list)
    skipped: int = 0
    parse_errors: int = 0
    truncated: bool = False
    # Non-source files other detectors read (manifests, schemas, migrations).
    other_paths: list[str] = field(default_factory=list)


@lru_cache(maxsize=8)
def parser_for(grammar: str) -> Parser:
    return get_parser(grammar)


def is_skipped(rel: Path) -> bool:
    return any(part in SKIP_DIRS for part in rel.parts[:-1]) or rel.name.endswith(GENERATED)


def discover(root: Path) -> Discovery:
    """Parses every supported source file under `root`, up to the limits."""
    found = Discovery()
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        rel = path.relative_to(root)
        if is_skipped(rel):
            continue
        grammar = GRAMMAR.get(path.suffix.lower())
        if grammar is None:
            found.other_paths.append(rel.as_posix())
            continue
        if len(found.files) >= MAX_FILES:
            found.truncated = True
            found.skipped += 1
            continue
        try:
            source = path.read_bytes()
        except OSError:
            found.skipped += 1
            continue
        if len(source) > MAX_FILE_BYTES or b"\0" in source:
            found.skipped += 1
            continue
        tree = parser_for(grammar[1]).parse(source)
        if tree.root_node.has_error:
            found.parse_errors += 1
        found.files.append(
            SourceFile(rel.as_posix(), grammar[0], source, tree, source.count(b"\n") + 1)
        )
    return found


def text(node: Node | None) -> str:
    return node.text.decode("utf-8", "replace") if node is not None and node.text else ""


def walk(node: Node) -> Iterator[Node]:
    """Every node in document order."""
    stack = [node]
    while stack:
        current = stack.pop()
        yield current
        stack.extend(reversed(current.children))


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"`":
        return value[1:-1]
    return value


def line_of(node: Node) -> int:
    return node.start_point[0] + 1
