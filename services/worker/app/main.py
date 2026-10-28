import time

from fastapi import Depends, FastAPI
from pydantic import BaseModel

from app.auth import require_worker_secret
from app.config import get_settings

VERSION = "0.1.0"
_started = time.monotonic()


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    uptime_seconds: float


def create_app() -> FastAPI:
    get_settings()  # fail fast on a missing or weak secret
    app = FastAPI(title="RepoIntelligence worker", version=VERSION)

    # Open on purpose so container and uptime probes work without the secret.
    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            service="repointelligence-worker",
            version=VERSION,
            uptime_seconds=round(time.monotonic() - _started, 3),
        )

    @app.get("/internal/ping", dependencies=[Depends(require_worker_secret)])
    def ping() -> dict[str, str]:
        return {"pong": "ok"}

    return app


app = create_app()
