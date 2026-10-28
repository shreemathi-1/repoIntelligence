from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Worker settings. Startup fails if the shared secret is missing or too short."""

    model_config = SettingsConfigDict(env_file="../../.env", extra="ignore")

    worker_shared_secret: str = Field(min_length=16)


@lru_cache
def get_settings() -> Settings:
    return Settings()
