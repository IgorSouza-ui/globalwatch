"""Autenticação: Google Identity Services -> token de sessão próprio (JWT HS256).

Fluxo
1. O frontend obtém um ID token do Google (botão "Entrar com Google").
2. POST /api/auth/google envia esse ID token; o backend VALIDA assinatura,
   emissor, audiência (nosso Client ID), expiração e e-mail verificado.
3. O backend devolve um token de sessão curto, assinado com SESSION_SECRET.
4. Todo endpoint protegido exige `Authorization: Bearer <token>`.
5. Logout revoga o `jti` do token (lista de revogação no SQLite).
"""
from __future__ import annotations

import hashlib
import time
import uuid
from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

from . import storage
from .config import Settings, get_settings

ALGORITHM = "HS256"
ISSUER = "globalwatch-cafe-api"
_bearer = HTTPBearer(auto_error=False)
_google_request = google_requests.Request()


@dataclass
class User:
    id: str
    email: str
    name: str | None
    picture: str | None
    jti: str
    exp: float


def _user_id(provider: str, subject: str) -> str:
    # Hash estável: não expõe o "sub" do Google e serve como nome de pasta seguro.
    return hashlib.sha256(f"{provider}:{subject}".encode()).hexdigest()[:32]


def verify_google_credential(credential: str, settings: Settings) -> dict:
    if not settings.google_client_id:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Login Google não configurado no servidor.")
    try:
        info = google_id_token.verify_oauth2_token(credential, _google_request, settings.google_client_id,
                                                   clock_skew_in_seconds=10)
    except ValueError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token do Google inválido ou expirado.") from exc
    if info.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Emissor do token inválido.")
    if not info.get("email_verified"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "E-mail do Google não verificado.")
    return info


def issue_session(provider: str, subject: str, email: str, name: str | None, picture: str | None,
                  settings: Settings) -> tuple[str, dict]:
    uid = _user_id(provider, subject)
    storage.upsert_user(uid, email, name, picture)
    now = int(time.time())
    exp = now + settings.session_ttl_minutes * 60
    payload = {"sub": uid, "email": email, "name": name, "picture": picture, "iat": now, "exp": exp,
               "iss": ISSUER, "jti": uuid.uuid4().hex}
    token = jwt.encode(payload, settings.session_secret, algorithm=ALGORITHM)
    user = {"id": uid, "email": email, "name": name, "picture": picture, "expires_at": exp}
    return token, user


def get_current_user(creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
                     settings: Settings = Depends(get_settings)) -> User:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Autenticação necessária.",
                            headers={"WWW-Authenticate": "Bearer"})
    try:
        data = jwt.decode(creds.credentials, settings.session_secret, algorithms=[ALGORITHM], issuer=ISSUER,
                          options={"require": ["exp", "sub", "jti", "iss"]})
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessão expirada. Entre novamente.") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token de sessão inválido.") from exc
    if storage.is_revoked(data["jti"]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sessão encerrada. Entre novamente.")
    return User(id=data["sub"], email=data.get("email", ""), name=data.get("name"), picture=data.get("picture"),
                jti=data["jti"], exp=float(data["exp"]))
