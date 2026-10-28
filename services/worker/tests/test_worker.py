import pytest
from app.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient
from pydantic import ValidationError

SECRET = "test-secret-0123456789"
client = TestClient(create_app())


def test_health_is_open() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["uptime_seconds"] >= 0


def test_protected_route_rejects_missing_secret() -> None:
    assert client.get("/internal/ping").status_code == 401


def test_protected_route_rejects_wrong_secret() -> None:
    res = client.get("/internal/ping", headers={"X-Worker-Secret": "wrong-secret-value-123"})
    assert res.status_code == 401


def test_protected_route_accepts_correct_secret() -> None:
    res = client.get("/internal/ping", headers={"X-Worker-Secret": SECRET})
    assert res.status_code == 200
    assert res.json() == {"pong": "ok"}


def test_short_secret_is_rejected_at_startup() -> None:
    with pytest.raises(ValidationError):
        Settings(worker_shared_secret="short")
