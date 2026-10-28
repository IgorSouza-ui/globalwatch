"""Persistência simples em SQLite + arquivos em disco.

Cada análise pertence a um usuário (owner_id). Toda leitura de análise passa
por `get_analysis(owner_id, analysis_id)`, que filtra pelo dono — é isso que
garante o isolamento de dados entre usuários.
"""
from __future__ import annotations

import json
import shutil
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import get_settings

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    picture TEXT,
    created_at REAL NOT NULL,
    last_login REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    created_at REAL NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_analyses_owner ON analyses(owner_id, created_at);
CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_analysis ON chat_messages(analysis_id, owner_id);
CREATE TABLE IF NOT EXISTS usage (
    owner_id TEXT NOT NULL,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (owner_id, day, kind)
);
CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti TEXT PRIMARY KEY,
    exp REAL NOT NULL
);
"""


def _db_path() -> Path:
    return get_settings().data_dir / "app.db"


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    with _lock:
        conn = sqlite3.connect(_db_path())
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def init_db() -> None:
    with connect() as c:
        c.executescript(SCHEMA)


# ---------------------------------------------------------------- usuários
def upsert_user(user_id: str, email: str, name: str | None, picture: str | None) -> None:
    now = time.time()
    with connect() as c:
        c.execute(
            """INSERT INTO users (id, email, name, picture, created_at, last_login)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name,
               picture=excluded.picture, last_login=excluded.last_login""",
            (user_id, email, name, picture, now, now),
        )


# ---------------------------------------------------------------- tokens
def revoke_token(jti: str, exp: float) -> None:
    with connect() as c:
        c.execute("INSERT OR IGNORE INTO revoked_tokens (jti, exp) VALUES (?, ?)", (jti, exp))


def is_revoked(jti: str) -> bool:
    with connect() as c:
        row = c.execute("SELECT 1 FROM revoked_tokens WHERE jti = ?", (jti,)).fetchone()
    return row is not None


# ---------------------------------------------------------------- cotas
def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def consume_quota(owner_id: str, kind: str, limit: int) -> tuple[bool, int]:
    """Incrementa o uso diário se ainda houver cota. Retorna (permitido, restante)."""
    day = _today()
    with connect() as c:
        row = c.execute(
            "SELECT count FROM usage WHERE owner_id=? AND day=? AND kind=?", (owner_id, day, kind)
        ).fetchone()
        used = row["count"] if row else 0
        if used >= limit:
            return False, 0
        c.execute(
            """INSERT INTO usage (owner_id, day, kind, count) VALUES (?, ?, ?, 1)
               ON CONFLICT(owner_id, day, kind) DO UPDATE SET count = count + 1""",
            (owner_id, day, kind),
        )
    return True, limit - used - 1


def get_usage(owner_id: str) -> dict[str, int]:
    with connect() as c:
        rows = c.execute(
            "SELECT kind, count FROM usage WHERE owner_id=? AND day=?", (owner_id, _today())
        ).fetchall()
    return {r["kind"]: r["count"] for r in rows}


# ---------------------------------------------------------------- análises
def user_dir(owner_id: str) -> Path:
    # owner_id já é um hash (ver auth.py), seguro para nome de pasta.
    p = get_settings().data_dir / "users" / owner_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def analysis_dir(owner_id: str, analysis_id: str) -> Path:
    return user_dir(owner_id) / analysis_id


def create_analysis(owner_id: str, analysis_id: str, filename: str) -> None:
    with connect() as c:
        c.execute(
            "INSERT INTO analyses (id, owner_id, filename, created_at, status) VALUES (?, ?, ?, ?, ?)",
            (analysis_id, owner_id, filename, time.time(), "processing"),
        )


def finish_analysis(analysis_id: str, result: dict[str, Any]) -> None:
    with connect() as c:
        c.execute(
            "UPDATE analyses SET status='done', result_json=? WHERE id=?",
            (json.dumps(result, ensure_ascii=False), analysis_id),
        )


def fail_analysis(analysis_id: str, error: str) -> None:
    with connect() as c:
        c.execute("UPDATE analyses SET status='error', error=? WHERE id=?", (error, analysis_id))


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    d["result"] = json.loads(d.pop("result_json")) if d.get("result_json") else None
    return d


def get_analysis(owner_id: str, analysis_id: str) -> dict[str, Any] | None:
    with connect() as c:
        row = c.execute(
            "SELECT * FROM analyses WHERE id=? AND owner_id=?", (analysis_id, owner_id)
        ).fetchone()
    return _row_to_dict(row) if row else None


def list_analyses(owner_id: str) -> list[dict[str, Any]]:
    with connect() as c:
        rows = c.execute(
            "SELECT * FROM analyses WHERE owner_id=? ORDER BY created_at DESC", (owner_id,)
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def delete_analysis(owner_id: str, analysis_id: str) -> bool:
    with connect() as c:
        cur = c.execute("DELETE FROM analyses WHERE id=? AND owner_id=?", (analysis_id, owner_id))
        c.execute("DELETE FROM chat_messages WHERE analysis_id=? AND owner_id=?", (analysis_id, owner_id))
        deleted = cur.rowcount > 0
    if deleted:
        shutil.rmtree(analysis_dir(owner_id, analysis_id), ignore_errors=True)
    return deleted


def enforce_max_stored(owner_id: str, max_items: int) -> None:
    """Mantém apenas as N análises mais recentes do usuário."""
    items = list_analyses(owner_id)
    for item in items[max_items:]:
        delete_analysis(owner_id, item["id"])


# ---------------------------------------------------------------- chat
def add_message(owner_id: str, analysis_id: str, role: str, content: str) -> None:
    with connect() as c:
        c.execute(
            "INSERT INTO chat_messages (analysis_id, owner_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            (analysis_id, owner_id, role, content, time.time()),
        )


def get_messages(owner_id: str, analysis_id: str, limit: int = 50) -> list[dict[str, Any]]:
    with connect() as c:
        rows = c.execute(
            """SELECT role, content, created_at FROM chat_messages
               WHERE analysis_id=? AND owner_id=? ORDER BY id DESC LIMIT ?""",
            (analysis_id, owner_id, limit),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


# ---------------------------------------------------------------- retenção
def purge_expired(retention_hours: int) -> int:
    """Remove análises (arquivos + registros) mais antigas que a retenção."""
    cutoff = time.time() - retention_hours * 3600
    with connect() as c:
        rows = c.execute("SELECT id, owner_id FROM analyses WHERE created_at < ?", (cutoff,)).fetchall()
        c.execute("DELETE FROM revoked_tokens WHERE exp < ?", (time.time(),))
    for r in rows:
        delete_analysis(r["owner_id"], r["id"])
    return len(rows)
