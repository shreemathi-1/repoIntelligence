import hashlib
from collections.abc import Iterator

import pytest
from app import embed
from app.main import create_app
from fastapi.testclient import TestClient

app = create_app()

SECRET = {"X-Worker-Secret": "test-secret-0123456789"}


class FakeEmbedder:
    model = "fake-embedder"
    dimensions = 4

    def __init__(self) -> None:
        self.seen: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.seen.append(texts)
        out: list[list[float]] = []
        for text in texts:
            digest = hashlib.sha1(text.encode()).digest()  # noqa: S324
            out.append([b / 255 for b in digest[:4]])
        return out


@pytest.fixture
def fake() -> Iterator[FakeEmbedder]:
    embedder = FakeEmbedder()
    embed.set_embedder(embedder)
    yield embedder
    embed.set_embedder(None)


def test_embed_needs_the_secret(fake: FakeEmbedder) -> None:
    client = TestClient(app)
    assert client.post("/v1/embed", json={"texts": ["a"]}).status_code == 401
    assert fake.seen == []


def test_embed_returns_one_vector_per_text(fake: FakeEmbedder) -> None:
    client = TestClient(app)
    res = client.post("/v1/embed", json={"texts": ["hello", "world"]}, headers=SECRET)
    assert res.status_code == 200
    body = res.json()
    assert body["model"] == "fake-embedder"
    assert body["dimensions"] == 4
    assert len(body["vectors"]) == 2
    assert all(len(v) == 4 for v in body["vectors"])
    assert fake.seen == [["hello", "world"]]


def test_embed_clips_long_texts_and_rejects_too_many(fake: FakeEmbedder) -> None:
    client = TestClient(app)
    res = client.post("/v1/embed", json={"texts": ["x" * 20_000]}, headers=SECRET)
    assert res.status_code == 200
    assert len(fake.seen[0][0]) == embed.MAX_CHARS

    too_many = {"texts": ["a"] * (embed.MAX_TEXTS + 1)}
    assert client.post("/v1/embed", json=too_many, headers=SECRET).status_code == 422
    assert client.post("/v1/embed", json={"texts": []}, headers=SECRET).status_code == 422


def test_as_list_accepts_arrays_and_lists() -> None:
    class Arr:
        def tolist(self) -> list[float]:
            return [1.0, 2.0]

    assert embed._as_list(Arr()) == [1.0, 2.0]
    assert embed._as_list([3, 4]) == [3.0, 4.0]
    with pytest.raises(TypeError):
        embed._as_list("nope")
