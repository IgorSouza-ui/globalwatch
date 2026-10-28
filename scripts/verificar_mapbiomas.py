"""Verificação independente: compara as áreas potenciais com o MapBiomas.

Uso (a partir da pasta backend, com o venv ativo):
    python ../scripts/verificar_mapbiomas.py ../data/kit/imagem_multiespectral.tif ../data/kit/qualidade_scl.tif

O que faz
1. Roda o MESMO pipeline da API sobre a imagem.
2. Baixa (via HTTP range / COG) só o recorte do MapBiomas Coleção 9 (2023) da área.
3. Reprojeta para a grade de 10 m (vizinho mais próximo) e cruza com a classificação.

Atenção: MapBiomas é um produto de 30 m, de outro ano (2023), com seus próprios
erros. Isto mede CONCORDÂNCIA com uma referência pública, não acurácia de campo.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import Resampling, reproject, transform_bounds
from rasterio.windows import from_bounds

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.processing import run_pipeline  # noqa: E402

MAPBIOMAS_URL = ("/vsicurl/https://storage.googleapis.com/mapbiomas-public/initiatives/brasil/"
                 "collection_9/lclu/coverage/brasil_coverage_2023.tif")
NOMES = {3: "Formação florestal", 4: "Formação savânica", 9: "Silvicultura", 11: "Campo alagado", 12: "Formação campestre",
         15: "Pastagem", 20: "Cana", 21: "Mosaico de usos", 24: "Área urbana", 25: "Outra área não vegetada",
         33: "Rio/lago", 39: "Soja", 41: "Outras lavouras temporárias", 46: "Café", 47: "Citrus", 48: "Outras perenes"}
CAFE = 46


def mapbiomas_na_grade(img_path: Path) -> np.ndarray:
    with rasterio.open(img_path) as s:
        crs, tr, h, w = s.crs, s.transform, s.height, s.width
        b = transform_bounds(s.crs, "EPSG:4326", *s.bounds)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        with rasterio.open(MAPBIOMAS_URL) as m:
            pad = 0.003
            win = from_bounds(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad, m.transform).round_offsets().round_lengths()
            arr = m.read(1, window=win)
            out = np.zeros((h, w), "uint8")
            reproject(arr, out, src_transform=m.window_transform(win), src_crs=m.crs,
                      dst_transform=tr, dst_crs=crs, resampling=Resampling.nearest)
    return out


def main(img: str, scl: str | None) -> None:
    img_p = Path(img)
    with tempfile.TemporaryDirectory() as tmp:
        res = run_pipeline(img_p, img_p.name, Path(tmp), Path(scl) if scl else None)
        with rasterio.open(Path(tmp) / "classificacao.tif") as s:
            cls = s.read(1)
    mb = mapbiomas_na_grade(img_p)
    valid = cls > 0
    pred = (cls == 3) & valid
    ref = (mb == CAFE) & valid
    tp, fp, fn = int((pred & ref).sum()), int((pred & ~ref).sum()), int((~pred & ref).sum())
    px_ha = (res["imagem"]["pixel_size_m"] ** 2) / 10_000

    print(f"\n# Verificação — {img_p.name} (data {res['data_imagem']})")
    print(f"Áreas potenciais (app): {res['candidatas']['quantidade_poligonos']} polígonos, {res['candidatas']['area_total_ha']} ha")
    print(f"Café MapBiomas 2023 na área válida: {ref.sum() * px_ha:.1f} ha")
    print(f"Sobreposição: {tp * px_ha:.1f} ha | só app: {fp * px_ha:.1f} ha | só MapBiomas: {fn * px_ha:.1f} ha")
    if pred.sum():
        print(f"Fração das áreas do app que o MapBiomas chama de café: {100 * tp / pred.sum():.1f}%")
    if ref.sum():
        print(f"Fração do café MapBiomas recuperada pelo app: {100 * tp / ref.sum():.1f}%")

    print("\n## Em que classe do MapBiomas caem as áreas potenciais do app")
    u, c = np.unique(mb[pred], return_counts=True)
    for k, n in sorted(zip(u.tolist(), c.tolist()), key=lambda x: -x[1]):
        print(f"- {NOMES.get(k, k)} ({k}): {n * px_ha:.1f} ha ({100 * n / pred.sum():.1f}%)")

    print("\n## Classe do app para os pixels de café do MapBiomas")
    u, c = np.unique(cls[ref], return_counts=True)
    nomes_app = {1: "água", 2: "vegetação densa", 3: "café potencial", 4: "vegetação baixa", 5: "solo/construído", 6: "intermediária descartada"}
    for k, n in sorted(zip(u.tolist(), c.tolist()), key=lambda x: -x[1]):
        print(f"- {nomes_app.get(k, k)}: {n * px_ha:.1f} ha ({100 * n / max(ref.sum(), 1):.1f}%)")
    print("\nParâmetros:", json.dumps(res["parametros"]))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
