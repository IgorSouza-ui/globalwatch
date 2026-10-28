"""Testes essenciais de processamento e segurança.

Rodar (pasta backend):  python -m pytest -q
"""
from __future__ import annotations

import io
import os
import shutil
import tempfile
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

TMP = Path(tempfile.mkdtemp(prefix="gw_test_"))
os.environ.update({
    "DATA_DIR": str(TMP / "storage"),
    "SESSION_SECRET": "segredo-de-teste-com-tamanho-suficiente-123",
    "ALLOW_DEV_LOGIN": "true",
    "GOOGLE_CLIENT_ID": "",
    "GEMINI_API_KEY": "",
    "MAX_ANALYSES_PER_USER_DAY": "50",
})

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.processing import ClassParams, ProcessingError, compute_indices, read_raster, run_pipeline  # noqa: E402

KIT = Path(__file__).resolve().parents[2] / "data" / "kit"
SAMPLES = Path(__file__).resolve().parents[1] / "samples"
KIT_IMG = KIT / "imagem_multiespectral.tif" if (KIT / "imagem_multiespectral.tif").exists() else SAMPLES / "guaxupe_2025_kit.tif"
KIT_SCL = KIT / "qualidade_scl.tif" if (KIT / "qualidade_scl.tif").exists() else SAMPLES / "guaxupe_2025_kit_scl.tif"


def synthetic_tif(path: Path, dn: np.ndarray, scale=0.0001, offset=-0.1, crs="EPSG:32723", descriptions=True) -> Path:
    prof = dict(driver="GTiff", dtype="uint16", width=dn.shape[2], height=dn.shape[1], count=dn.shape[0],
                crs=crs, transform=from_origin(300000, 7600000, 10, 10), nodata=0)
    with rasterio.open(path, "w", **prof) as d:
        d.write(dn.astype("uint16"))
        d.scales = (scale,) * dn.shape[0]
        d.offsets = (offset,) * dn.shape[0]
        if descriptions:
            d.descriptions = ("B02_blue", "B03_green", "B04_red", "B08_nir")[: dn.shape[0]]
    return path


# ============================================================ processamento
def test_conversao_radiometrica_aplicada_uma_vez_e_nodata_excluido(tmp_path):
    dn = np.full((4, 32, 32), 2000, dtype="uint16")
    dn[:, 0, 0] = 0  # NoData
    p = synthetic_tif(tmp_path / "a.tif", dn)
    refl, valid, *_ = read_raster(p, "a.tif", 10**6)
    assert not valid[0, 0]
    assert np.isnan(refl[0, 0, 0])
    assert refl[0, 5, 5] == pytest.approx(2000 * 0.0001 - 0.1, abs=1e-6)  # 0.1, não 0.01 nem 0.2


def test_ndvi_conhecido(tmp_path):
    refl = np.zeros((4, 2, 2), "float32")
    refl[2], refl[3] = 0.1, 0.5  # red, nir
    ndvi = compute_indices(refl)["ndvi"]
    assert np.allclose(ndvi, (0.5 - 0.1) / (0.5 + 0.1))


def test_kit_real_gera_poligonos_e_area_consistente(tmp_path):
    res = run_pipeline(KIT_IMG, "kit.tif", tmp_path, KIT_SCL)
    c = res["candidatas"]
    assert res["area_total_ha"] == pytest.approx(2621.44, abs=0.01)  # 512*512*100 m² (metadados.json)
    assert c["quantidade_poligonos"] > 0
    # Área geodésica dos polígonos ≈ contagem de pixels × 0,01 ha (tolerância 1%)
    assert c["area_total_ha"] == pytest.approx(c["area_pixels_ha"], rel=0.01)
    assert res["scl_utilizada"] is True
    assert res["data_imagem"].startswith("2025-08-16")
    for f in ("areas_potenciais_cafe.geojson", "imagem_com_poligonos.png", "classificacao.tif", "overlay_rgb.png"):
        assert (tmp_path / f).exists()
    # Todos os polígonos respeitam a área mínima
    assert all(p["area_ha"] >= 0.99 for p in res["poligonos_resumo"])


def test_imagem_uniforme_sem_resultados(tmp_path):
    dn = np.full((4, 64, 64), 1500, dtype="uint16")  # cena homogênea, NDVI 0
    res = run_pipeline(synthetic_tif(tmp_path / "u.tif", dn), "u.tif", tmp_path / "out")
    assert res["candidatas"]["quantidade_poligonos"] == 0


def test_rejeita_imagem_com_poucas_bandas(tmp_path):
    p = synthetic_tif(tmp_path / "b.tif", np.full((3, 32, 32), 1000), descriptions=False)
    with pytest.raises(ProcessingError, match="banda"):
        read_raster(p, "b.tif", 10**6)


def test_rejeita_imagem_sem_georreferencia(tmp_path):
    p = tmp_path / "nogeo.tif"
    with rasterio.open(p, "w", driver="GTiff", dtype="uint16", width=32, height=32, count=4) as d:
        d.write(np.ones((4, 32, 32), "uint16"))
    with pytest.raises(ProcessingError, match="georreferenciada"):
        read_raster(p, "nogeo.tif", 10**6)


def test_parametros_invalidos():
    with pytest.raises(ProcessingError):
        ClassParams(ndvi_min=0.9, ndvi_dense=0.5).validate()


# ============================================================ segurança / API
@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _login(client, name):
    r = client.post("/api/auth/dev", json={"name": name})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_endpoints_exigem_autenticacao(client):
    for method, url in [("get", "/api/analyses"), ("post", "/api/analyses"), ("get", "/api/me"),
                        ("get", "/api/analyses/" + "a" * 32), ("post", "/api/analyses/" + "a" * 32 + "/chat")]:
        assert getattr(client, method)(url).status_code == 401, url


def test_token_forjado_e_rejeitado(client):
    import jwt
    fake = jwt.encode({"sub": "x", "jti": "y", "iss": "globalwatch-cafe-api", "exp": 9999999999}, "outro-segredo", "HS256")
    assert client.get("/api/me", headers={"Authorization": f"Bearer {fake}"}).status_code == 401


def test_google_com_token_invalido_e_rejeitado(client):
    r = client.post("/api/auth/google", json={"credential": "x" * 50})
    assert r.status_code in (401, 503)


def test_upload_valida_extensao_e_conteudo(client):
    h = _login(client, "Ana")
    r = client.post("/api/analyses", headers=h, files={"image": ("x.png", b"\x89PNG....", "image/png")})
    assert r.status_code == 415
    r = client.post("/api/analyses", headers=h, files={"image": ("x.tif", b"nao sou tiff", "image/tiff")})
    assert r.status_code == 415


def test_fluxo_completo_isolamento_e_logout(client):
    ana, bruno = _login(client, "Ana Teste"), _login(client, "Bruno Teste")
    with open(KIT_IMG, "rb") as f1, open(KIT_SCL, "rb") as f2:
        r = client.post("/api/analyses", headers=ana,
                        files={"image": ("kit.tif", f1, "image/tiff"), "scl": ("scl.tif", f2, "image/tiff")})
    assert r.status_code == 201, r.text
    aid = r.json()["id"]
    assert r.json()["result"]["candidatas"]["quantidade_poligonos"] > 0

    # dono acessa; outro usuário recebe 404 (não vaza nem a existência)
    assert client.get(f"/api/analyses/{aid}", headers=ana).status_code == 200
    assert client.get(f"/api/analyses/{aid}", headers=bruno).status_code == 404
    assert client.get(f"/api/analyses/{aid}/files/areas_potenciais_cafe.geojson", headers=bruno).status_code == 404
    assert client.post(f"/api/analyses/{aid}/chat", headers=bruno, json={"message": "oi"}).status_code == 404
    assert all(a["id"] != aid for a in client.get("/api/analyses", headers=bruno).json())

    # arquivos fora da lista branca / path traversal
    assert client.get(f"/api/analyses/{aid}/files/entrada.tif", headers=ana).status_code == 404
    assert client.get(f"/api/analyses/{aid}/files/..%2F..%2Fapp.db", headers=ana).status_code == 404

    # GeoJSON válido
    g = client.get(f"/api/analyses/{aid}/files/areas_potenciais_cafe.geojson", headers=ana).json()
    assert g["type"] == "FeatureCollection" and len(g["features"]) > 0

    # chat (modo determinístico sem chave) responde com números do processamento
    r = client.post(f"/api/analyses/{aid}/chat", headers=ana, json={"message": "Quantos hectares?"})
    total = client.get(f"/api/analyses/{aid}", headers=ana).json()["result"]["candidatas"]["area_total_ha"]
    assert r.status_code == 200 and f"{total:.2f}" in r.json()["content"]

    # logout revoga o token
    assert client.post("/api/auth/logout", headers=ana).status_code == 200
    assert client.get("/api/me", headers=ana).status_code == 401


def test_mensagem_de_chat_muito_longa(client):
    h = _login(client, "Carla")
    r = client.post("/api/analyses/" + "b" * 32 + "/chat", headers=h, json={"message": "x" * 5000})
    assert r.status_code == 422


def teardown_module(_):
    shutil.rmtree(TMP, ignore_errors=True)
