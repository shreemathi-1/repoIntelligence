import pytest
from app.main import create_app
from fastapi.testclient import TestClient

from tests.fixtures import PYTHON_PROJECT, tarball

SECRET = "test-secret-0123456789"
client = TestClient(create_app())
headers = {"X-Worker-Secret": SECRET, "Content-Type": "application/gzip"}


def test_scan_requires_the_secret() -> None:
    assert client.post("/v1/scan", content=tarball({"a": "b"})).status_code == 401
    assert client.get("/v1/scanners").status_code == 401


def test_lists_scanners_with_availability() -> None:
    res = client.get("/v1/scanners", headers=headers)
    assert res.status_code == 200
    rows = {row["tool"]: row for row in res.json()["scanners"]}
    assert rows["inventory"]["available"] is True
    assert rows["ruff"]["available"] is True
    assert rows["ruff"]["version"]
    assert set(rows) == {"inventory", "lizard", "jscpd", "ruff", "semgrep", "gitleaks", "osv"}


def test_scan_rejects_bad_input() -> None:
    assert client.post("/v1/scan", headers=headers, content=b"").status_code == 400
    assert (
        client.post("/v1/scan?tools=nope", headers=headers, content=tarball({"a": "b"})).status_code
        == 400
    )
    assert client.post("/v1/scan", headers=headers, content=b"garbage").status_code == 422
    traversal = tarball({"../x": "boom"}, prefix="")
    assert client.post("/v1/scan", headers=headers, content=traversal).status_code == 422


def test_scan_rejects_oversized_uploads(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import main

    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 10)
    app = main.create_app()
    res = TestClient(app).post("/v1/scan", headers=headers, content=tarball({"a": "b"}))
    assert res.status_code == 413


def test_scan_returns_schema_shaped_results() -> None:
    res = client.post(
        "/v1/scan?tools=inventory&tools=ruff&tools=semgrep",
        headers=headers,
        content=tarball(PYTHON_PROJECT),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["archiveFiles"] == len(PYTHON_PROJECT)
    by_tool = {r["tool"]: r for r in body["results"]}
    assert set(by_tool) == {"inventory", "ruff", "semgrep"}
    for row in by_tool.values():
        assert set(row) == {"tool", "status", "version", "reason", "durationMs", "data"}
    assert by_tool["inventory"]["status"] == "ok"
    assert by_tool["ruff"]["status"] == "ok"
    assert by_tool["ruff"]["data"]["count"] >= 2
    # Not installed here: must say so instead of looking clean.
    if by_tool["semgrep"]["status"] == "unavailable":
        assert by_tool["semgrep"]["data"] is None
        assert "not installed" in by_tool["semgrep"]["reason"]


def test_graph_route_builds_a_graph() -> None:
    from tests.graph_fixtures import FASTAPI_PY

    res = client.post("/v1/graph", headers=headers, content=tarball(FASTAPI_PY))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["archiveFiles"] == len(FASTAPI_PY)
    assert {f["path"] for f in body["files"]} >= {"app/main.py", "app/api/items.py"}
    assert any(r["route"] == "/items" for r in body["routes"])
    assert body["stats"]["filesParsed"] == 11
    assert client.post("/v1/graph", content=tarball(FASTAPI_PY)).status_code == 401
    assert client.post("/v1/graph", headers=headers, content=b"").status_code == 400
    assert client.post("/v1/graph", headers=headers, content=b"junk").status_code == 422
