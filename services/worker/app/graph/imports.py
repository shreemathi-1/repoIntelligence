"""Import extraction per language and resolution to files inside the repository."""

import json
import re
import sys
from dataclasses import dataclass
from pathlib import PurePosixPath

from tree_sitter import Node

from app.graph.parse import SourceFile, line_of, text, unquote, walk

JS_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts")


@dataclass
class ImportEdge:
    source: str
    target: str | None
    external: str | None
    line: int
    names: list[str]
    # Imports resolved through an alias or a workspace package are flagged for the UI.
    via: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "from": self.source,
            "to": self.target,
            "external": self.external,
            "line": self.line,
            "names": self.names[:50],
            "via": self.via,
        }


class Resolver:
    """Knows every file in the repository and how each language locates modules."""

    def __init__(self, paths: set[str], manifests: dict[str, str]) -> None:
        self.paths = paths
        self.dirs = {str(PurePosixPath(p).parent) for p in paths}
        self.aliases = self._ts_aliases(manifests)
        self.workspaces = self._workspace_packages(manifests)
        self.java_index = self._java_index()
        self.py_roots = self._python_roots()

    # ---- javascript / typescript ----

    def _ts_aliases(self, manifests: dict[str, str]) -> list[tuple[str, list[str], str]]:
        """(prefix, targets, config dir) from each tsconfig/jsconfig `paths` entry."""
        aliases: list[tuple[str, list[str], str]] = []
        for path, body in manifests.items():
            name = PurePosixPath(path).name
            if not re.match(r"^(tsconfig|jsconfig)[\w.-]*\.json$", name):
                continue
            try:
                config = json.loads(re.sub(r"//[^\n]*|/\*.*?\*/", "", body, flags=re.S))
            except ValueError:
                continue
            options = config.get("compilerOptions", {}) if isinstance(config, dict) else {}
            base = str(PurePosixPath(path).parent)
            base_url = options.get("baseUrl", ".") if isinstance(options, dict) else "."
            root = self._join(base, str(base_url))
            paths = options.get("paths", {}) if isinstance(options, dict) else {}
            if isinstance(paths, dict):
                for pattern, targets in paths.items():
                    if isinstance(targets, list):
                        aliases.append(
                            (pattern.rstrip("*"), [str(t).rstrip("*") for t in targets], root)
                        )
        return aliases

    def _workspace_packages(self, manifests: dict[str, str]) -> dict[str, str]:
        """Package name -> directory, for monorepos that import their own packages."""
        packages: dict[str, str] = {}
        for path, body in manifests.items():
            if PurePosixPath(path).name != "package.json":
                continue
            try:
                data = json.loads(body)
            except ValueError:
                continue
            name = data.get("name") if isinstance(data, dict) else None
            if isinstance(name, str) and name:
                packages[name] = str(PurePosixPath(path).parent)
        return packages

    @staticmethod
    def _join(base: str, rel: str) -> str:
        parts: list[str] = [] if base in (".", "") else base.split("/")
        for part in rel.replace("\\", "/").split("/"):
            if part in ("", "."):
                continue
            if part == "..":
                if parts:
                    parts.pop()
            else:
                parts.append(part)
        return "/".join(parts)

    def _js_file(self, candidate: str) -> str | None:
        """A path with or without extension, or a directory with an index file."""
        if candidate in self.paths and not candidate.endswith("/"):
            return candidate
        stem = re.sub(r"\.(js|jsx|mjs|cjs)$", "", candidate)
        for suffix in JS_SUFFIXES:
            if f"{stem}{suffix}" in self.paths:
                return f"{stem}{suffix}"
        for suffix in JS_SUFFIXES:
            if f"{candidate}/index{suffix}" in self.paths:
                return f"{candidate}/index{suffix}"
        return None

    def resolve_js(self, source: str, spec: str) -> tuple[str | None, str | None, str | None]:
        """(file, external package, via) for one specifier."""
        spec = spec.split("?")[0]
        if spec.startswith("."):
            return self._js_file(self._join(str(PurePosixPath(source).parent), spec)), None, None
        if spec.startswith("/"):
            return self._js_file(spec.lstrip("/")), None, None
        for prefix, targets, root in self.aliases:
            if spec.startswith(prefix) and (prefix.endswith("/") or spec == prefix.rstrip("/")):
                rest = spec[len(prefix) :]
                for target in targets:
                    found = self._js_file(self._join(root, target + rest))
                    if found:
                        return found, None, "tsconfig paths"
        for name, directory in self.workspaces.items():
            if spec == name or spec.startswith(f"{name}/"):
                rest = spec[len(name) :].lstrip("/")
                for candidate in (
                    (rest, "src/index", "index", "src/main")
                    if rest
                    else ("src/index", "index", "src/main")
                ):
                    found = self._js_file(self._join(directory, candidate))
                    if found:
                        return found, None, "workspace package"
                return None, name, "workspace package"
        if spec.startswith("node:"):
            return None, spec, None
        parts = spec.split("/")
        package = "/".join(parts[:2]) if spec.startswith("@") and len(parts) > 1 else parts[0]
        return None, package, None

    # ---- python ----

    def _python_roots(self) -> list[str]:
        roots = {""}
        for path in self.paths:
            parts = PurePosixPath(path).parts
            if len(parts) >= 2 and parts[0] in ("src", "lib", "app", "packages"):
                roots.add(parts[0])
                if parts[0] == "packages" and len(parts) >= 3:
                    roots.add("/".join(parts[:2]))
                    roots.add("/".join([*parts[:2], "src"]))
        return sorted(roots, key=len)

    def resolve_py(self, source: str, module: str, level: int) -> tuple[str | None, str | None]:
        """(file, external top-level name) for `module` imported with `level` leading dots."""
        if level > 0:
            base = PurePosixPath(source).parent
            for _ in range(level - 1):
                base = base.parent
            parts = [
                *([] if str(base) == "." else base.parts),
                *([p for p in module.split(".") if p]),
            ]
            return self._py_file("/".join(parts)), None
        dotted = module.split(".")
        for root in self.py_roots:
            candidate = "/".join(([root] if root else []) + dotted)
            found = self._py_file(candidate)
            if found:
                return found, None
        # A deeper import such as `pkg.mod.func` still points at `pkg/mod.py`.
        if len(dotted) > 1:
            for root in self.py_roots:
                found = self._py_file("/".join(([root] if root else []) + dotted[:-1]))
                if found:
                    return found, None
        top = dotted[0]
        if top in sys.stdlib_module_names:
            return None, None
        return None, top

    def _py_file(self, candidate: str) -> str | None:
        if f"{candidate}.py" in self.paths:
            return f"{candidate}.py"
        if f"{candidate}/__init__.py" in self.paths:
            return f"{candidate}/__init__.py"
        return None

    # ---- java ----

    def _java_index(self) -> dict[str, str]:
        """Fully qualified class name -> file, from the directory layout."""
        index: dict[str, str] = {}
        for path in self.paths:
            if not path.endswith(".java"):
                continue
            parts = PurePosixPath(path).with_suffix("").parts
            for marker in ("java", "kotlin", "src"):
                if marker in parts:
                    start = len(parts) - 1 - parts[::-1].index(marker) + 1
                    index[".".join(parts[start:])] = path
                    break
            else:
                index[".".join(parts)] = path
        return index

    def resolve_java(self, qualified: str) -> tuple[str | None, str | None]:
        name = qualified.removesuffix(".*")
        found = self.java_index.get(name)
        if found:
            return found, None
        # A wildcard or nested class: fall back to the longest known prefix.
        parts = name.split(".")
        for cut in range(len(parts) - 1, 1, -1):
            found = self.java_index.get(".".join(parts[:cut]))
            if found:
                return found, None
        if parts[0] in ("java", "javax", "jakarta") and len(parts) > 1 and parts[0] != "jakarta":
            return None, None
        return None, ".".join(parts[:3]) if len(parts) >= 3 else name


NAME_PARENTS = {
    "import_specifier",
    "import_clause",
    "namespace_import",
    "export_specifier",
    "shorthand_property_identifier_pattern",
    "object_pattern",
    "pair_pattern",
}


def _js_import_names(node: Node) -> list[str]:
    names: list[str] = []
    for child in walk(node):
        parent = child.parent
        if child.type == "shorthand_property_identifier_pattern":
            names.append(text(child))
        elif child.type in ("identifier", "property_identifier") and parent is not None:
            is_binding = (
                parent.type == "variable_declarator" and parent.child_by_field_name("name") == child
            )
            if parent.type in NAME_PARENTS or is_binding:
                names.append(text(child))
    return list(dict.fromkeys(names))


def extract_imports(file: SourceFile, resolver: Resolver) -> list[ImportEdge]:
    edges: list[ImportEdge] = []
    root = file.tree.root_node

    def add_js(spec: str, node: Node, names: list[str]) -> None:
        target, external, via = resolver.resolve_js(file.path, unquote(spec))
        if target == file.path:
            return
        edges.append(ImportEdge(file.path, target, external, line_of(node), names, via))

    if file.language in ("javascript", "typescript"):
        for node in walk(root):
            if node.type in ("import_statement", "export_statement"):
                source = node.child_by_field_name("source")
                if source is not None:
                    add_js(text(source), node, _js_import_names(node))
            elif node.type == "call_expression":
                fn = node.child_by_field_name("function")
                args = node.child_by_field_name("arguments")
                first = args.named_children[0] if args is not None and args.named_children else None
                if fn is None or first is None or first.type != "string":
                    continue
                if text(fn) == "require" or fn.type == "import":
                    names = (
                        _js_import_names(node.parent)
                        if node.parent is not None and node.parent.type == "variable_declarator"
                        else []
                    )
                    add_js(text(first), node, names)
    elif file.language == "python":
        for node in walk(root):
            if node.type == "import_statement":
                for child in node.named_children:
                    dotted = (
                        child.child_by_field_name("name")
                        if child.type == "aliased_import"
                        else child
                    )
                    module = text(dotted)
                    target, external = resolver.resolve_py(file.path, module, 0)
                    if target != file.path and (target or external):
                        edges.append(
                            ImportEdge(
                                file.path, target, external, line_of(node), [module.split(".")[-1]]
                            )
                        )
            elif node.type == "import_from_statement":
                module_node = node.child_by_field_name("module_name")
                raw = text(module_node)
                level = len(raw) - len(raw.lstrip("."))
                module = raw.lstrip(".")
                names = [
                    text(c.child_by_field_name("name") if c.type == "aliased_import" else c)
                    for c in node.named_children[1:]
                ]
                names = [n for n in names if n and n != module]
                target, external = resolver.resolve_py(file.path, module, level)
                if target is None and external is None and level > 0:
                    continue
                if target != file.path and (target or external):
                    edges.append(ImportEdge(file.path, target, external, line_of(node), names))
    elif file.language == "java":
        for node in root.named_children:
            if node.type != "import_declaration":
                continue
            qualified = (
                text(node).removeprefix("import").removesuffix(";").replace("static", "").strip()
            )
            target, external = resolver.resolve_java(qualified)
            if target != file.path and (target or external):
                edges.append(
                    ImportEdge(
                        file.path, target, external, line_of(node), [qualified.split(".")[-1]]
                    )
                )
    return edges
