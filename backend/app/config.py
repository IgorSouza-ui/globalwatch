"""Configuração central da API, lida de variáveis de ambiente.

Nenhum segredo fica no código: tudo vem do ambiente (Render / .env local).
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Autenticação ---------------------------------------------------
    google_client_id: str = ""
    # Segredo usado para assinar o token de sessão da própria API (HS256).
    session_secret: str = "troque-este-segredo-em-producao"
    session_ttl_minutes: int = 480
    # Login de desenvolvimento (SEM Google). Nunca habilitar em produção.
    allow_dev_login: bool = False

    # --- CORS -----------------------------------------------------------
    # Lista separada por vírgula, ex: "https://app.vercel.app,http://localhost:5173" ou "*"
    cors_origins: str = "*"

    # --- IA (chatbot) ---------------------------------------------------
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"
    gemini_fallback_models: str = "gemini-2.5-flash-lite"

    # --- Armazenamento e limites ---------------------------------------
    data_dir: Path = Path("./storage")
    max_upload_mb: int = 40
    max_pixels: int = 2048 * 2048
    retention_hours: int = 24
    max_analyses_per_user_day: int = 15
    max_chat_messages_per_user_day: int = 60
    max_stored_analyses_per_user: int = 10

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def fallback_models(self) -> list[str]:
        return [m.strip() for m in self.gemini_fallback_models.split(",") if m.strip()]


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.data_dir.mkdir(parents=True, exist_ok=True)
    return s
