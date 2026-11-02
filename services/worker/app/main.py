import time
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from app.archive import ArchiveError
from app.auth import require_worker_secret
from app.config import get_settings
from app.embed import MAX_TEXTS, embed_texts
from app.graph_service import graph_archive
from app.scan import ALL_TOOLS, list_scanners, scan_archive

VERSION = "0.4.0"
MAX_UPLOAD_BYTES = 60 * 1024 * 1024
_started = time.monotonic()


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=MAX_TEXTS)


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    uptime_seconds: float


def create_app() -> FastAPI:
    get_settings()  # fail fast on a missing or weak secret
    app = FastAPI(title="RepoIntelligence worker", version=VERSION)
    protected = [Depends(require_worker_secret)]

    # Open on purpose so container and uptime probes work without the secret.
    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            service="repointelligence-worker",
            version=VERSION,
            uptime_seconds=round(time.monotonic() - _started, 3),
        )

    @app.get("/internal/ping", dependencies=protected)
    def ping() -> dict[str, str]:
        return {"pong": "ok"}

    @app.get("/v1/scanners", dependencies=protected)
    def scanners() -> dict[str, object]:
        return {"scanners": list_scanners()}

    @app.post("/v1/scan", dependencies=protected)
    async def scan(
        request: Request,
        tools: Annotated[list[str] | None, Query()] = None,
    ) -> dict[str, object]:
        """Body: a gzipped tarball of the repository. Query: which tools to run (default all)."""
        selected = tools or list(ALL_TOOLS)
        unknown = [t for t in selected if t not in ALL_TOOLS]
        if unknown:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unknown tools: {', '.join(unknown)}")
        body = await _archive_body(request)
        try:
            return scan_archive(body, selected)
        except ArchiveError as err:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(err)) from err

    @app.post("/v1/graph", dependencies=protected)
    async def graph(request: Request) -> dict[str, object]:
        """Body: a gzipped tarball. Returns the import, symbol and detection graph."""
        body = await _archive_body(request)
        try:
            return graph_archive(body)
        except ArchiveError as err:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(err)) from err

    @app.post("/v1/embed", dependencies=protected)
    def embed(body: EmbedRequest) -> dict[str, object]:
        """Embeds texts with the local model. Long texts are clipped, never rejected."""
        return embed_texts(body.texts)

    return app


async def _archive_body(request: Request) -> bytes:
    length = request.headers.get("content-length")
    if length and int(length) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "archive is too large")
    body = await request.body()
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "archive is too large")
    if not body:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "archive body is empty")
    return body


app = create_app()
