"""Architecture layers by path and imports, and import cycles."""

import re

from app.graph.imports import ImportEdge

LAYER_RULES: list[tuple[str, re.Pattern[str]]] = [
    (
        "test",
        re.compile(
            r"(^|/)(tests?|__tests__|spec|specs|e2e)(/|$)|(\.|_)(test|spec)\.\w+$|^test_\w+\.py$"
        ),
    ),
    (
        "presentation",
        re.compile(
            r"(^|/)(routes?|controllers?|views?|pages|components|handlers?|api|endpoints?|resources?|graphql|resolvers?|ui|screens|templates|web|public|app/api)(/|$)"
        ),
    ),
    (
        "data",
        re.compile(
            r"(^|/)(models?|schemas?|entities|entity|repositor(y|ies)|db|data|database|migrations?|dao|persistence|store|stores|orm|prisma)(/|$)"
        ),
    ),
    (
        "integration",
        re.compile(
            r"(^|/)(clients?|adapters?|integrations?|external|gateways?|providers?|connectors?|github|llm|workers?|queue|jobs?|messaging)(/|$)"
        ),
    ),
    (
        "service",
        re.compile(
            r"(^|/)(services?|domain|core|use[-_]?cases?|logic|business|application|lib|utils?|helpers?|common|shared|internal|pkg|analysis|ingest|discovery|auth|middleware|hooks)(/|$)"
        ),
    ),
    (
        "config",
        re.compile(
            r"(^|/)(config|configs?|settings|infra|infrastructure|scripts?|bin|tools?)(/|$)|(^|/)(config|settings|setup|conftest)\.\w+$"
        ),
    ),
]
ORDER = ["presentation", "service", "data", "integration", "config", "test", "other"]
# A layer may import the ones listed; anything else is a violation worth showing.
ALLOWED = {
    "presentation": {"presentation", "service", "integration", "config"},
    "service": {"service", "data", "integration", "config"},
    "data": {"data", "config"},
    "integration": {"integration", "config", "data"},
    "config": {"config"},
    "test": set(ORDER),
    "other": set(ORDER),
}


def layer_of(path: str) -> str:
    for layer, pattern in LAYER_RULES:
        if pattern.search(path):
            return layer
    return "other"


def layer_violations(imports: list[ImportEdge], layers: dict[str, str]) -> list[dict[str, object]]:
    seen: set[tuple[str, str]] = set()
    out: list[dict[str, object]] = []
    for edge in imports:
        if edge.target is None:
            continue
        a = layers.get(edge.source, "other")
        b = layers.get(edge.target, "other")
        if b in ALLOWED[a] or (edge.source, edge.target) in seen:
            continue
        seen.add((edge.source, edge.target))
        out.append(
            {
                "from": edge.source,
                "to": edge.target,
                "fromLayer": a,
                "toLayer": b,
                "line": edge.line,
            }
        )
    return out


def find_cycles(imports: list[ImportEdge]) -> list[list[str]]:
    """Strongly connected components with more than one file, smallest first (Tarjan)."""
    graph: dict[str, set[str]] = {}
    for edge in imports:
        if edge.target:
            graph.setdefault(edge.source, set()).add(edge.target)
            graph.setdefault(edge.target, set())
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    cycles: list[list[str]] = []
    counter = 0

    for start in graph:
        if start in index:
            continue
        # Iterative Tarjan so deep graphs cannot overflow the Python stack.
        work: list[tuple[str, list[str]]] = [(start, sorted(graph[start]))]
        index[start] = low[start] = counter
        counter += 1
        stack.append(start)
        on_stack.add(start)
        while work:
            node, pending = work[-1]
            if pending:
                nxt = pending.pop()
                if nxt not in index:
                    index[nxt] = low[nxt] = counter
                    counter += 1
                    stack.append(nxt)
                    on_stack.add(nxt)
                    work.append((nxt, sorted(graph[nxt])))
                elif nxt in on_stack:
                    low[node] = min(low[node], index[nxt])
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index[node]:
                component: list[str] = []
                while True:
                    member = stack.pop()
                    on_stack.discard(member)
                    component.append(member)
                    if member == node:
                        break
                if len(component) > 1:
                    cycles.append(sorted(component))
    cycles.sort(key=lambda c: (len(c), c))
    return cycles[:200]
