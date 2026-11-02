"""Local text embeddings. The model runs on the CPU; nothing leaves the worker."""

from collections.abc import Iterable
from typing import Protocol

MODEL_NAME = "BAAI/bge-small-en-v1.5"
DIMENSIONS = 384
MAX_TEXTS = 256
MAX_CHARS = 8_000


class Embedder(Protocol):
    model: str
    dimensions: int

    def embed(self, texts: list[str]) -> list[list[float]]: ...


class FastEmbedder:
    """bge-small through fastembed (ONNX). The weights download on first use (~130 MB)."""

    model = MODEL_NAME
    dimensions = DIMENSIONS

    def __init__(self) -> None:
        from fastembed import TextEmbedding

        self._engine = TextEmbedding(model_name=MODEL_NAME)

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors: Iterable[object] = self._engine.embed(texts, batch_size=32)
        return [[float(x) for x in _as_list(v)] for v in vectors]


def _as_list(vector: object) -> list[float]:
    tolist = getattr(vector, "tolist", None)
    if callable(tolist):
        result = tolist()
        if isinstance(result, list):
            return [float(x) for x in result]
    if isinstance(vector, list):
        return [float(x) for x in vector]
    raise TypeError("unexpected embedding vector type")


_embedder: Embedder | None = None


def get_embedder() -> Embedder:
    global _embedder
    if _embedder is None:
        _embedder = FastEmbedder()
    return _embedder


def set_embedder(embedder: Embedder | None) -> None:
    """Swaps the engine; tests install a fake so no model is downloaded."""
    global _embedder
    _embedder = embedder


def embed_texts(texts: list[str]) -> dict[str, object]:
    engine = get_embedder()
    clipped = [t[:MAX_CHARS] for t in texts]
    return {
        "model": engine.model,
        "dimensions": engine.dimensions,
        "vectors": engine.embed(clipped) if clipped else [],
    }
