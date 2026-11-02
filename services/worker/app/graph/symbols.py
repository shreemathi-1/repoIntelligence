"""Definitions, inheritance and call edges, best effort by name."""

from dataclasses import dataclass, field

from tree_sitter import Node

from app.graph.imports import ImportEdge
from app.graph.parse import SourceFile, line_of, text, walk

MAX_SYMBOLS = 20_000
MAX_CALLS = 60_000
CALL_NOISE = {"console", "require", "print", "len", "str", "int", "super", "this", "self", "System"}


@dataclass
class Symbol:
    path: str
    name: str
    qualified: str
    kind: str
    line: int
    end_line: int
    exported: bool
    node: Node = field(repr=False)

    @property
    def id(self) -> str:
        return f"{self.path}#{self.qualified}"

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "path": self.path,
            "name": self.name,
            "qualifiedName": self.qualified,
            "kind": self.kind,
            "line": self.line,
            "endLine": self.end_line,
            "exported": self.exported,
        }


@dataclass
class Relation:
    source: str
    target: str
    kind: str
    line: int
    resolution: str

    def to_dict(self) -> dict[str, object]:
        return {
            "from": self.source,
            "to": self.target,
            "kind": self.kind,
            "line": self.line,
            "resolution": self.resolution,
        }


def _exported_js(node: Node) -> bool:
    parent = node.parent
    while parent is not None and parent.type in (
        "lexical_declaration",
        "variable_declaration",
        "variable_declarator",
    ):
        parent = parent.parent
    return parent is not None and parent.type == "export_statement"


def _heritage(node: Node) -> list[str]:
    """Names this class extends or implements, across the three grammars."""
    names: list[str] = []
    for field_name in ("superclass", "interfaces", "superclasses"):
        value = node.child_by_field_name(field_name)
        if value is not None:
            for child in walk(value):
                if (
                    child.type
                    in (
                        "identifier",
                        "type_identifier",
                        "scoped_type_identifier",
                        "attribute",
                        "generic_type",
                    )
                    and child.parent is value
                    or (
                        child.type in ("type_identifier", "identifier")
                        and child.parent is not None
                        and child.parent.type
                        in (
                            "extends_clause",
                            "implements_clause",
                            "type_list",
                            "class_heritage",
                            "argument_list",
                            "superclass",
                            "super_interfaces",
                            "generic_type",
                            "scoped_type_identifier",
                        )
                    )
                ):
                    name = text(child).split("<")[0]
                    if name and name[0].isupper():
                        names.append(name.split(".")[-1])
    for child in node.children:
        if child.type == "class_heritage":
            for sub in walk(child):
                if (
                    sub.type in ("identifier", "member_expression", "type_identifier")
                    and sub.parent is not None
                    and sub.parent.type in ("class_heritage", "extends_clause", "implements_clause")
                ):
                    names.append(text(sub).split("<")[0].split(".")[-1])
    return list(dict.fromkeys(n for n in names if n))


def extract_symbols(file: SourceFile) -> tuple[list[Symbol], list[tuple[Symbol, str]]]:
    """Symbols plus (symbol, parent name) pairs for inheritance."""
    symbols: list[Symbol] = []
    extends: list[tuple[Symbol, str]] = []
    root = file.tree.root_node

    def add(node: Node, name: str, kind: str, qualified: str, exported: bool) -> Symbol:
        symbol = Symbol(
            file.path, name, qualified, kind, line_of(node), node.end_point[0] + 1, exported, node
        )
        symbols.append(symbol)
        return symbol

    def visit(node: Node, scope: list[str]) -> None:
        if len(symbols) >= MAX_SYMBOLS:
            return
        name_node = node.child_by_field_name("name")
        name = text(name_node)
        kind: str | None = None
        if file.language in ("javascript", "typescript"):
            if node.type in ("function_declaration", "generator_function_declaration"):
                kind = "function"
            elif node.type in ("class_declaration", "abstract_class_declaration"):
                kind = "class"
            elif node.type == "method_definition" and scope:
                kind = "method"
                name = text(node.child_by_field_name("name"))
            elif node.type == "interface_declaration":
                kind = "interface"
            elif node.type == "type_alias_declaration":
                kind = "type"
            elif node.type == "enum_declaration":
                kind = "enum"
            elif node.type == "variable_declarator" and not scope:
                value = node.child_by_field_name("value")
                if value is not None and value.type in (
                    "arrow_function",
                    "function_expression",
                    "function",
                ):
                    kind = "function"
            exported = _exported_js(node)
        elif file.language == "python":
            if node.type == "function_definition":
                kind = "method" if scope and scope[-1][0].isupper() else "function"
            elif node.type == "class_definition":
                kind = "class"
            exported = not name.startswith("_")
        else:
            if node.type in ("class_declaration", "record_declaration"):
                kind = "class"
            elif node.type == "interface_declaration":
                kind = "interface"
            elif node.type == "enum_declaration":
                kind = "enum"
            elif node.type == "method_declaration" or node.type == "constructor_declaration":
                kind = "method"
            modifiers = next((c for c in node.children if c.type == "modifiers"), None)
            exported = "public" in text(modifiers) or "protected" in text(modifiers)

        if kind and name:
            qualified = ".".join([*scope, name])
            symbol = add(node, name, kind, qualified, exported)
            if kind in ("class", "interface"):
                for parent in _heritage(node):
                    extends.append((symbol, parent))
            inner_scope = [*scope, name] if kind in ("class", "interface", "enum") else scope
            body = node.child_by_field_name("body")
            if body is not None and kind in ("class", "interface", "enum"):
                for child in body.children:
                    visit(child, inner_scope)
            return
        for child in node.children:
            # Do not descend into function bodies for definitions; nested helpers are noise.
            if node.type in (
                "function_declaration",
                "method_definition",
                "function_definition",
                "method_declaration",
                "arrow_function",
            ):
                continue
            visit(child, scope)

    for child in root.children:
        visit(child, [])
    return symbols, extends


def _callee_name(fn: Node) -> str | None:
    if fn.type in ("identifier", "field_identifier"):
        return text(fn)
    if fn.type in ("member_expression", "attribute", "field_access"):
        prop = (
            fn.child_by_field_name("property")
            or fn.child_by_field_name("attribute")
            or fn.child_by_field_name("field")
        )
        return text(prop) or None
    return None


def extract_calls(
    file: SourceFile,
    symbols: list[Symbol],
    by_file: dict[str, list[Symbol]],
    imports: list[ImportEdge],
    budget: int,
) -> list[Relation]:
    """Call edges from each symbol body to symbols it names, within the file or via imports."""
    local = {s.name: s for s in reversed(symbols)}
    imported: dict[str, Symbol] = {}
    for edge in imports:
        if edge.target is None:
            continue
        for candidate in by_file.get(edge.target, []):
            if candidate.exported and (candidate.name in edge.names or not edge.names):
                imported.setdefault(candidate.name, candidate)
    seen: set[tuple[str, str]] = set()
    relations: list[Relation] = []

    for symbol in symbols:
        if len(relations) >= budget:
            break
        for node in walk(symbol.node):
            if node.type not in (
                "call_expression",
                "call",
                "method_invocation",
                "new_expression",
                "object_creation_expression",
            ):
                continue
            fn = (
                node.child_by_field_name("function")
                or node.child_by_field_name("name")
                or node.child_by_field_name("constructor")
                or node.child_by_field_name("type")
            )
            if fn is None:
                continue
            callee = (
                _callee_name(fn)
                if fn.type not in ("type_identifier", "generic_type")
                else text(fn).split("<")[0]
            )
            if not callee or callee in CALL_NOISE or callee == symbol.name:
                continue
            target = local.get(callee)
            resolution = "same-file"
            if target is None or target is symbol:
                target = imported.get(callee)
                resolution = "import"
            if target is None or (symbol.id, target.id) in seen:
                continue
            seen.add((symbol.id, target.id))
            relations.append(Relation(symbol.id, target.id, "call", line_of(node), resolution))
    return relations
