"""API FastAPI — Assistente Geoespacial para Café (desafio Global Watch)."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, ValidationError
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from . import chat, storage
from .auth import User, get_current_user, issue_session, verify_google_credential
from .config import Settings, get_settings
from .processing import ClassParams, ProcessingError, run_pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("api")

SAMPLES_DIR = Path(__file__).resolve().parent.parent / "samples"
SAMPLES = json.loads((SAMPLES_DIR / "samples.json").read_text(encoding="utf-8")) if (SAMPLES_DIR / "samples.json").exists() else []
# Arquivos de resultado que podem ser baixados (lista branca; nada vindo do usuário vira caminho).
ALLOWED_FILES = {
    "areas_potenciais_cafe.geojson": "application/geo+json",
    "imagem_com_poligonos.png": "image/png",
    "classificacao.tif": "image/tiff",
    "overlay_rgb.png": "image/png",
    "overlay_classes.png": "image/png",
    "overlay_ndvi.png": "image/png",
}
TIFF_MAGIC = (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")
_processing_slots = asyncio.Semaphore(2)  # limita memória no plano gratuito


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    return fwd.split(",")[0].strip() if fwd else get_remote_address(request)


limiter = Limiter(key_func=_client_ip, default_limits=["120/minute"])


async def _purge_loop(settings: Settings) -> None:
    while True:
        try:
            n = await run_in_threadpool(storage.purge_expired, settings.retention_hours)
            if n:
                log.info("Retenção: %s análise(s) expirada(s) removida(s)", n)
        except Exception:  # pragma: no cover
            log.exception("Falha na limpeza de retenção")
        await asyncio.sleep(3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    storage.init_db()
    if settings.session_secret.startswith("troque") and not settings.allow_dev_login:
        log.warning("SESSION_SECRET padrão em uso! Defina um segredo forte em produção.")
    task = asyncio.create_task(_purge_loop(settings))
    yield
    task.cancel()


app = FastAPI(title="Global Watch · Assistente Geoespacial para Café", version="1.0.0", lifespan=lifespan,
              docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
app.state.limiter = limiter
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    max_age=600,
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Cache-Control", "no-store")
    return response


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse({"detail": "Muitas requisições em pouco tempo. Aguarde um instante e tente novamente."},
                        status_code=429)


# =========================================================================== modelos
class GoogleLogin(BaseModel):
    credential: str = Field(min_length=20, max_length=4096)


class DevLogin(BaseModel):
    name: str = Field(default="Avaliador Local", min_length=1, max_length=60)


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=1000)


class ParamsIn(BaseModel):
    ndvi_min: float = Field(0.50, ge=0, le=1)
    ndvi_dense: float = Field(0.76, ge=0, le=1)
    red_min: float = Field(0.035, ge=0, le=0.3)
    vis_max: float = Field(0.07, ge=0.01, le=0.5)
    min_area_ha: float = Field(1.0, ge=0.1, le=100)


# =========================================================================== públicos
@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok"}


@app.get("/api/config")
def public_config(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {
        "google_login": bool(settings.google_client_id),
        "dev_login": settings.allow_dev_login,
        "ia_configurada": bool(settings.gemini_api_key),
        "limites": {
            "upload_mb": settings.max_upload_mb,
            "max_pixels": settings.max_pixels,
            "analises_por_dia": settings.max_analyses_per_user_day,
            "mensagens_chat_por_dia": settings.max_chat_messages_per_user_day,
            "analises_armazenadas": settings.max_stored_analyses_per_user,
            "retencao_horas": settings.retention_hours,
        },
        "amostras": [{k: v for k, v in s.items() if k != "files"} for s in SAMPLES],
    }


@app.get("/api/samples/{sample_id}/{kind}")
@limiter.limit("30/minute")
def download_sample(request: Request, sample_id: str, kind: str):
    """Download público das imagens de exemplo (dados abertos Copernicus, com atribuição)."""
    sample = next((s for s in SAMPLES if s["id"] == sample_id), None)
    if not sample or kind not in sample["files"]:
        raise HTTPException(404, "Amostra não encontrada.")
    path = SAMPLES_DIR / sample["files"][kind]
    return FileResponse(path, filename=path.name, media_type="image/tiff")


# =========================================================================== auth
@app.post("/api/auth/google")
@limiter.limit("10/minute")
def login_google(request: Request, body: GoogleLogin, settings: Settings = Depends(get_settings)):
    info = verify_google_credential(body.credential, settings)
    token, user = issue_session("google", info["sub"], info["email"], info.get("name"), info.get("picture"), settings)
    return {"token": token, "user": user}


@app.post("/api/auth/dev")
@limiter.limit("10/minute")
def login_dev(request: Request, body: DevLogin, settings: Settings = Depends(get_settings)):
    if not settings.allow_dev_login:
        raise HTTPException(404, "Não encontrado.")
    slug = re.sub(r"[^a-z0-9]+", "-", body.name.lower()).strip("-") or "dev"
    token, user = issue_session("dev", slug, f"{slug}@dev.local", body.name, None, settings)
    return {"token": token, "user": user}


@app.post("/api/auth/logout")
def logout(user: User = Depends(get_current_user)):
    storage.revoke_token(user.jti, user.exp)
    return {"ok": True}


@app.get("/api/me")
def me(user: User = Depends(get_current_user), settings: Settings = Depends(get_settings)):
    usage = storage.get_usage(user.id)
    return {
        "user": {"id": user.id, "email": user.email, "name": user.name, "picture": user.picture},
        "uso_hoje": {
            "analises": usage.get("analysis", 0), "analises_limite": settings.max_analyses_per_user_day,
            "mensagens": usage.get("chat", 0), "mensagens_limite": settings.max_chat_messages_per_user_day,
        },
    }


# =========================================================================== análises
def _safe_display_name(name: str | None) -> str:
    base = Path(name or "imagem.tif").name
    base = re.sub(r"[^\w.\- ]", "_", base)[:100]
    return base or "imagem.tif"


async def _save_upload(upload: UploadFile, dest: Path, max_bytes: int, label: str) -> None:
    if not (upload.filename or "").lower().endswith((".tif", ".tiff")):
        raise HTTPException(415, f"{label}: envie um arquivo .tif/.tiff (GeoTIFF).")
    size = 0
    head = b""
    with dest.open("wb") as f:
        while chunk := await upload.read(1024 * 1024):
            if not head:
                head = chunk[:4]
                if head not in TIFF_MAGIC:
                    raise HTTPException(415, f"{label}: o conteúdo não é um TIFF válido.")
            size += len(chunk)
            if size > max_bytes:
                raise HTTPException(413, f"{label}: arquivo maior que {max_bytes // (1024 * 1024)} MB.")
            f.write(chunk)
    if size == 0:
        raise HTTPException(400, f"{label}: arquivo vazio.")


def _parse_params(raw: str | None) -> ClassParams:
    if not raw:
        return ClassParams()
    try:
        data = ParamsIn.model_validate_json(raw)
    except ValidationError as exc:
        raise HTTPException(422, "Parâmetros avançados inválidos.") from exc
    return ClassParams(ndvi_min=data.ndvi_min, ndvi_dense=data.ndvi_dense, red_min=data.red_min,
                       vis_max=data.vis_max, min_area_ha=data.min_area_ha,
                       obj_ndvi_min=min(data.ndvi_min + 0.02, data.ndvi_dense - 0.03),
                       obj_ndvi_max=max(data.ndvi_dense - 0.02, data.ndvi_min + 0.03))


def _public(a: dict[str, Any]) -> dict[str, Any]:
    return {k: a[k] for k in ("id", "filename", "created_at", "status", "error", "result")}


async def _run_analysis(user: User, settings: Settings, filename: str, image: Path, scl: Path | None,
                        params: ClassParams, acquisition: str | None, analysis_id: str) -> dict[str, Any]:
    out = storage.analysis_dir(user.id, analysis_id)
    try:
        async with _processing_slots:
            result = await run_in_threadpool(run_pipeline, image, filename, out, scl, params,
                                             settings.max_pixels, acquisition)
    except ProcessingError as exc:
        storage.fail_analysis(analysis_id, str(exc))
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        log.exception("Erro inesperado no processamento %s", analysis_id)
        storage.fail_analysis(analysis_id, "Erro interno ao processar a imagem.")
        raise HTTPException(500, "Erro interno ao processar a imagem.") from exc
    storage.finish_analysis(analysis_id, result)
    analysis = storage.get_analysis(user.id, analysis_id)
    storage.add_message(user.id, analysis_id, "assistant", chat.intro_message(analysis))
    storage.enforce_max_stored(user.id, settings.max_stored_analyses_per_user)
    return _public(analysis)


def _consume_analysis_quota(user: User, settings: Settings) -> None:
    ok, _ = storage.consume_quota(user.id, "analysis", settings.max_analyses_per_user_day)
    if not ok:
        raise HTTPException(429, f"Limite diário de {settings.max_analyses_per_user_day} análises atingido.")


@app.post("/api/analyses", status_code=201)
@limiter.limit("6/minute")
async def create_analysis(
    request: Request,
    image: Annotated[UploadFile, File(description="GeoTIFF multiespectral (B02, B03, B04, B08)")],
    scl: Annotated[UploadFile | None, File(description="SCL Sentinel-2 opcional")] = None,
    acquisition_date: Annotated[str | None, Form(max_length=40)] = None,
    params: Annotated[str | None, Form(max_length=1000)] = None,
    user: User = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
):
    if acquisition_date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?", acquisition_date):
        raise HTTPException(422, "Data de aquisição inválida (use AAAA-MM-DD).")
    class_params = _parse_params(params)
    _consume_analysis_quota(user, settings)
    analysis_id = uuid.uuid4().hex
    filename = _safe_display_name(image.filename)
    out = storage.analysis_dir(user.id, analysis_id)
    out.mkdir(parents=True, exist_ok=True)
    storage.create_analysis(user.id, analysis_id, filename)
    max_bytes = settings.max_upload_mb * 1024 * 1024
    try:
        await _save_upload(image, out / "entrada.tif", max_bytes, "Imagem")
        scl_path = None
        if scl is not None and scl.filename:
            scl_path = out / "entrada_scl.tif"
            await _save_upload(scl, scl_path, max_bytes, "SCL")
    except HTTPException as exc:
        storage.fail_analysis(analysis_id, exc.detail)
        shutil.rmtree(out, ignore_errors=True)
        raise
    return await _run_analysis(user, settings, filename, out / "entrada.tif", scl_path, class_params,
                               acquisition_date, analysis_id)


@app.post("/api/analyses/sample/{sample_id}", status_code=201)
@limiter.limit("6/minute")
async def create_sample_analysis(request: Request, sample_id: str, user: User = Depends(get_current_user),
                                 settings: Settings = Depends(get_settings)):
    sample = next((s for s in SAMPLES if s["id"] == sample_id), None)
    if not sample:
        raise HTTPException(404, "Amostra não encontrada.")
    _consume_analysis_quota(user, settings)
    analysis_id = uuid.uuid4().hex
    storage.create_analysis(user.id, analysis_id, sample["filename"])
    scl = SAMPLES_DIR / sample["files"]["scl"] if "scl" in sample["files"] else None
    return await _run_analysis(user, settings, sample["filename"], SAMPLES_DIR / sample["files"]["image"], scl,
                               ClassParams(), None, analysis_id)


@app.get("/api/analyses")
def list_analyses(user: User = Depends(get_current_user)):
    items = storage.list_analyses(user.id)
    out = []
    for a in items:
        r = a.get("result") or {}
        out.append({"id": a["id"], "filename": a["filename"], "created_at": a["created_at"], "status": a["status"],
                    "error": a["error"], "data_imagem": r.get("data_imagem"),
                    "area_candidata_ha": (r.get("candidatas") or {}).get("area_total_ha"),
                    "poligonos": (r.get("candidatas") or {}).get("quantidade_poligonos")})
    return out


def _owned(user: User, analysis_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{32}", analysis_id):
        raise HTTPException(404, "Análise não encontrada.")
    a = storage.get_analysis(user.id, analysis_id)
    if not a:  # inexistente OU de outro usuário: mesma resposta (não vaza existência)
        raise HTTPException(404, "Análise não encontrada.")
    return a


@app.get("/api/analyses/{analysis_id}")
def get_analysis(analysis_id: str, user: User = Depends(get_current_user)):
    return _public(_owned(user, analysis_id))


@app.delete("/api/analyses/{analysis_id}")
def delete_analysis(analysis_id: str, user: User = Depends(get_current_user)):
    _owned(user, analysis_id)
    storage.delete_analysis(user.id, analysis_id)
    return {"ok": True}


@app.get("/api/analyses/{analysis_id}/files/{name}")
def get_file(analysis_id: str, name: str, user: User = Depends(get_current_user)):
    a = _owned(user, analysis_id)
    if name not in ALLOWED_FILES or a["status"] != "done":
        raise HTTPException(404, "Arquivo não encontrado.")
    path = storage.analysis_dir(user.id, analysis_id) / name
    if not path.exists():
        raise HTTPException(404, "Arquivo não encontrado.")
    stem = Path(a["filename"]).stem
    return FileResponse(path, media_type=ALLOWED_FILES[name], filename=f"{stem}_{name}")


@app.get("/api/analyses/{analysis_id}/chat")
def get_chat(analysis_id: str, user: User = Depends(get_current_user)):
    _owned(user, analysis_id)
    return storage.get_messages(user.id, analysis_id)


@app.post("/api/analyses/{analysis_id}/chat")
@limiter.limit("15/minute")
async def post_chat(request: Request, analysis_id: str, body: ChatIn, user: User = Depends(get_current_user),
                    settings: Settings = Depends(get_settings)):
    a = _owned(user, analysis_id)
    if a["status"] != "done":
        raise HTTPException(409, "A análise ainda não está pronta.")
    ok, remaining = storage.consume_quota(user.id, "chat", settings.max_chat_messages_per_user_day)
    if not ok:
        raise HTTPException(429, f"Limite diário de {settings.max_chat_messages_per_user_day} mensagens atingido.")
    question = body.message.strip()
    history = storage.get_messages(user.id, analysis_id, limit=12)
    text, source = await chat.answer(a, history, question, settings)
    storage.add_message(user.id, analysis_id, "user", question)
    storage.add_message(user.id, analysis_id, "assistant", text)
    return {"role": "assistant", "content": text, "origem": source, "restantes_hoje": remaining}
