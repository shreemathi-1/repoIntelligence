import hmac
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status

from app.config import Settings, get_settings


def require_worker_secret(
    settings: Annotated[Settings, Depends(get_settings)],
    x_worker_secret: Annotated[str | None, Header()] = None,
) -> None:
    """Rejects requests that do not carry the shared secret in X-Worker-Secret."""
    expected = settings.worker_shared_secret.encode()
    provided = (x_worker_secret or "").encode()
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid worker secret"
        )
