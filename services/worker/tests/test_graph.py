from pathlib import Path

import pytest
from app.archive import extract_tarball
from app.graph.build import build_graph
from app.graph.imports import ImportEdge
from app.graph.layers import find_cycles, layer_of

from tests.fixtures import tarball
from tests.graph_fixtures import EXPRESS_TS, FASTAPI_PY, SPRING_JAVA


def graph_of(tmp_path: Path, files: dict[str, bytes | str]) -> dict[str, object]:
    root = extract_tarball(tarball(files), tmp_path / "repo").root
    return build_graph(root)


def rows(graph: dict[str, object], key: str) -> list[dict[str, object]]:
    value = graph[key]
    assert isinstance(value, list)
    return [row for row in value if isinstance(row, dict)]


def externals(graph: dict[str, object]) -> set[str]:
    value = graph["externals"]
    assert isinstance(value, list)
    return {str(v) for v in value}


def internal_edges(graph: dict[str, object]) -> set[tuple[str, str]]:
    return {(str(e["from"]), str(e["to"])) for e in rows(graph, "imports") if e["to"] is not None}


class TestExpress:
    @pytest.fixture
    def graph(self, tmp_path: Path) -> dict[str, object]:
        return graph_of(tmp_path, EXPRESS_TS)

    def test_resolves_relative_alias_and_external_imports(self, graph: dict[str, object]) -> None:
        edges = internal_edges(graph)
        assert ("src/index.ts", "src/routes/orders.ts") in edges
        assert ("src/index.ts", "src/middleware/auth.ts") in edges  # via tsconfig paths
        assert ("src/routes/orders.ts", "src/services/orders.ts") in edges
        alias = next(e for e in rows(graph, "imports") if e["to"] == "src/middleware/auth.ts")
        assert alias["via"] == "tsconfig paths"
        assert externals(graph) >= {"express", "mongoose", "jsonwebtoken", "vitest"}

    def test_symbols_calls_and_inheritance(self, graph: dict[str, object]) -> None:
        names = {s["qualifiedName"] for s in rows(graph, "symbols")}
        assert {
            "listOrders",
            "createOrder",
            "requireAuth",
            "notify",
            "BaseEntity",
            "Audited",
        } <= names
        relations = rows(graph, "relations")
        calls = {(r["from"], r["to"]) for r in relations if r["kind"] == "call"}
        assert ("src/services/orders.ts#createOrder", "src/clients/mailer.ts#notify") in calls
        extends = [r for r in relations if r["kind"] == "extends"]
        assert extends == [
            {
                "from": "src/models/order.ts#Audited",
                "to": "src/models/order.ts#BaseEntity",
                "kind": "extends",
                "line": 7,
                "resolution": "name",
            }
        ]

    def test_routes_models_entry_points_and_auth(self, graph: dict[str, object]) -> None:
        routes = {(r["method"], r["route"]): r for r in rows(graph, "routes")}
        assert ("GET", "/orders") in routes and ("POST", "/orders") in routes
        assert (
            routes[("GET", "/orders")]["handler"] == "src/routes/orders.ts#listOrders"
            or routes[("GET", "/orders")]["handler"] is None
        )
        assert routes[("USE", "/api")]["middleware"] == ["requireAuth", "router"]
        models = rows(graph, "models")
        assert {(m["name"], m["orm"]) for m in models} == {("Order", "mongoose")}
        entries = {(e["label"], e["evidence"]) for e in rows(graph, "entryPoints")}
        assert ("index.ts", "conventional entry file name") in entries
        assert ("app.listen", "starts a server") in entries
        assert ("src/index.ts", "package.json main") in entries
        assert ("npm run start", "node dist/index.js") in entries
        auth = rows(graph, "auth")
        assert any(a["kind"] == "jwt" and a["path"] == "src/middleware/auth.ts" for a in auth)
        assert any(a["kind"] == "handler" and a["label"] == "requireAuth" for a in auth)

    def test_stack_layers_and_cycles(self, graph: dict[str, object]) -> None:
        stack = {s["name"]: s for s in rows(graph, "stack")}
        assert stack["Express"]["version"] == "5.0.0"
        assert stack["Mongoose"]["category"] == "database"
        assert "TypeScript" in stack
        layers = {f["path"]: f["layer"] for f in rows(graph, "files")}
        assert layers["src/routes/orders.ts"] == "presentation"
        assert layers["src/services/orders.ts"] == "service"
        assert layers["src/models/order.ts"] == "data"
        assert layers["src/clients/mailer.ts"] == "integration"
        assert layers["src/index.test.ts"] == "test"
        # order.ts imports a service, which imports it back.
        assert graph["cycles"] == [["src/models/order.ts", "src/services/orders.ts"]]
        violations = rows(graph, "layerViolations")
        assert any(
            v["from"] == "src/models/order.ts" and v["toLayer"] == "service" for v in violations
        )
        stats = graph["stats"]
        assert isinstance(stats, dict)
        assert (
            stats["filesParsed"] == 7 and stats["parseErrors"] == 0 and stats["truncated"] is False
        )


class TestFastApi:
    @pytest.fixture
    def graph(self, tmp_path: Path) -> dict[str, object]:
        return graph_of(tmp_path, FASTAPI_PY)

    def test_imports_resolve_packages_and_skip_stdlib(self, graph: dict[str, object]) -> None:
        edges = internal_edges(graph)
        assert ("app/main.py", "app/api/items.py") in edges
        assert ("app/api/items.py", "app/services/items.py") in edges
        assert ("app/services/items.py", "app/models/item.py") in edges
        found = externals(graph)
        assert {"fastapi", "sqlalchemy", "jose", "uvicorn"} <= found
        assert "os" not in found

    def test_routes_with_dependencies_models_and_migrations(self, graph: dict[str, object]) -> None:
        routes = {(r["method"], r["route"]): r for r in rows(graph, "routes")}
        assert routes[("GET", "/items")]["framework"] == "fastapi"
        assert routes[("GET", "/items")]["handler"] == "app/api/items.py#read_items"
        assert routes[("GET", "/items")]["middleware"] == ["get_current_user"]
        assert ("POST", "/items") in routes
        models = {(m["name"], m["orm"], m["kind"]) for m in rows(graph, "models")}
        assert ("Item", "sqlalchemy", "model") in models
        assert ("0001_init.py", "alembic", "migration") in models
        entries = {e["evidence"] for e in rows(graph, "entryPoints")}
        assert 'if __name__ == "__main__"' in entries
        auth = {(a["kind"], a["label"]) for a in rows(graph, "auth")}
        assert ("jwt", "jose") in auth
        assert ("handler", "get_current_user") in auth

    def test_symbols_and_calls(self, graph: dict[str, object]) -> None:
        kinds = {s["qualifiedName"]: s["kind"] for s in rows(graph, "symbols")}
        assert (
            kinds["Item"] == "class"
            and kinds["list_items"] == "function"
            and kinds["read_items"] == "function"
        )
        calls = {(r["from"], r["to"]) for r in rows(graph, "relations") if r["kind"] == "call"}
        assert ("app/api/items.py#read_items", "app/services/items.py#list_items") in calls
        extends = {(r["from"], r["to"]) for r in rows(graph, "relations") if r["kind"] == "extends"}
        assert ("app/models/item.py#Item", "app/models/item.py#Base") in extends
        assert ("app/models/item.py#Base", "external:DeclarativeBase") in extends


class TestSpring:
    @pytest.fixture
    def graph(self, tmp_path: Path) -> dict[str, object]:
        return graph_of(tmp_path, SPRING_JAVA)

    def test_java_imports_resolve_by_package(self, graph: dict[str, object]) -> None:
        edges = internal_edges(graph)
        assert (
            "src/main/java/demo/web/AccountController.java",
            "src/main/java/demo/service/AccountService.java",
        ) in edges
        assert (
            "src/main/java/demo/service/AccountService.java",
            "src/main/java/demo/data/AccountRepository.java",
        ) in edges
        found = externals(graph)
        assert "org.springframework.web" in found
        assert not any(e.startswith("java.") for e in found)

    def test_spring_routes_entities_entry_and_auth(self, graph: dict[str, object]) -> None:
        routes = {(r["method"], r["route"]): r for r in rows(graph, "routes")}
        assert routes[("USE", "/accounts")]["framework"] == "spring"
        assert (
            routes[("GET", "/{id}")]["handler"]
            == "src/main/java/demo/web/AccountController.java#AccountController.find"
        )
        assert ("POST", "/") in routes
        models = {(m["name"], m["orm"], m["kind"]) for m in rows(graph, "models")}
        assert ("Account", "jpa", "model") in models
        assert ("V1__init.sql", "flyway", "migration") in models
        entries = {e["label"] for e in rows(graph, "entryPoints")}
        assert {"main", "@SpringBootApplication"} <= entries
        assert any(a["label"] == "@PreAuthorize" for a in rows(graph, "auth"))
        stack = {s["name"]: s for s in rows(graph, "stack")}
        assert stack["Spring Boot"]["version"] == "3.3.0"
        assert "Spring Data JPA" in stack and "Java" in stack

    def test_java_symbols_methods_and_inheritance(self, graph: dict[str, object]) -> None:
        symbols = {s["qualifiedName"]: s for s in rows(graph, "symbols")}
        assert symbols["AccountController.find"]["kind"] == "method"
        assert symbols["AccountController.find"]["exported"] is True
        assert symbols["AccountRepository"]["kind"] == "interface"
        extends = {(r["from"], r["to"]) for r in rows(graph, "relations") if r["kind"] == "extends"}
        assert (
            "src/main/java/demo/data/Account.java#Account",
            "src/main/java/demo/data/BaseEntity.java#BaseEntity",
        ) in extends
        layers = {str(f["path"]).split("/")[-1]: f["layer"] for f in rows(graph, "files")}
        assert layers["AccountController.java"] == "presentation"
        assert layers["AccountRepository.java"] == "data"


def test_find_cycles_reports_each_strongly_connected_group_once() -> None:
    def edge(a: str, b: str) -> ImportEdge:
        return ImportEdge(a, b, None, 1, [])

    cycles = find_cycles(
        [
            edge("a", "b"),
            edge("b", "c"),
            edge("c", "a"),
            edge("c", "d"),
            edge("x", "y"),
            edge("y", "x"),
            edge("d", "e"),
        ]
    )
    assert cycles == [["x", "y"], ["a", "b", "c"]]


def test_layer_of_defaults_to_other() -> None:
    assert layer_of("README.md") == "other"
    assert layer_of("src/pages/Home.tsx") == "presentation"
    assert layer_of("conftest.py") == "config"
