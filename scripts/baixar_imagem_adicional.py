"""Obtém uma imagem Sentinel-2 L2A ADICIONAL (outra data e/ou área) no mesmo
formato do kit: GeoTIFF 4 bandas (B02, B03, B04, B08), uint16, DN original
com scale/offset gravados, + SCL de 20 m.

Fonte: catálogo STAC público Earth Search (Element 84), coleção
sentinel-2-c1-l2a, COGs abertos na AWS (Registry of Open Data). Lê só a janela
necessária por HTTP range (sem baixar a cena inteira).

Exemplos (pasta backend, venv ativo):
  # Mesma área do kit, outra data (estação seca de 2024)
  python ../scripts/baixar_imagem_adicional.py --lon -46.680 --lat -21.330 --inicio 2024-07-15 --fim 2024-09-15 --nome guaxupe_2024
  # Outra área cafeeira (Três Pontas/MG), mesma estação de 2025
  python ../scripts/baixar_imagem_adicional.py --lon -45.560 --lat -21.390 --inicio 2025-07-15 --fim 2025-09-15 --nome tres_pontas_2025
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio
import requests
from rasterio.warp import transform as warp_transform
from rasterio.windows import Window

STAC = "https://earth-search.aws.element84.com/v1/search"
BANDS = [("blue", "B02_blue"), ("green", "B03_green"), ("red", "B04_red"), ("nir", "B08_nir")]
SCL_BAD = [0, 1, 3, 8, 9, 10, 11]


def search(lon: float, lat: float, start: str, end: str, max_cloud: float) -> list[dict]:
    body = {"collections": ["sentinel-2-c1-l2a"], "intersects": {"type": "Point", "coordinates": [lon, lat]},
            "datetime": f"{start}T00:00:00Z/{end}T23:59:59Z", "limit": 50,
            "query": {"eo:cloud_cover": {"lt": max_cloud}}}
    r = requests.post(STAC, json=body, timeout=60)
    r.raise_for_status()
    items = r.json()["features"]
    return sorted(items, key=lambda it: it["properties"]["eo:cloud_cover"])


def window_for(href: str, lon: float, lat: float, size: int, res: int):
    with rasterio.open(href) as src:
        xs, ys = warp_transform("EPSG:4326", src.crs, [lon], [lat])
        col, row = ~src.transform * (xs[0], ys[0])
        half = size // 2
        win = Window(int(col) - half, int(row) - half, size, size)
        return win, src.window_transform(win), src.crs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--inicio", required=True)
    ap.add_argument("--fim", required=True)
    ap.add_argument("--nome", required=True)
    ap.add_argument("--tamanho", type=int, default=512)
    ap.add_argument("--max-nuvem", type=float, default=10)
    ap.add_argument("--saida", default=str(Path(__file__).resolve().parents[1] / "backend" / "samples"))
    a = ap.parse_args()
    out = Path(a.saida)
    out.mkdir(parents=True, exist_ok=True)

    items = search(a.lon, a.lat, a.inicio, a.fim, a.max_nuvem)
    if not items:
        raise SystemExit("Nenhuma cena encontrada com esses filtros.")
    env = rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", AWS_NO_SIGN_REQUEST="YES")
    with env:
        for it in items[:8]:
            assets = it["assets"]
            # SCL primeiro: verifica nuvem DENTRO da janela, não só na cena
            win10, tr10, crs = window_for(assets["red"]["href"], a.lon, a.lat, a.tamanho, 10)
            with rasterio.open(assets["scl"]["href"]) as s:
                win20 = Window(win10.col_off // 2, win10.row_off // 2, a.tamanho // 2, a.tamanho // 2)
                scl = s.read(1, window=win20)
                tr20 = s.window_transform(win20)
            bad = float(np.isin(scl, SCL_BAD).mean())
            print(f"{it['id']}  nuvem cena={it['properties']['eo:cloud_cover']:.2f}%  inválido janela={100 * bad:.2f}%")
            if bad > 0.02:
                continue
            stack, scales, offsets = [], [], []
            for key, _ in BANDS:
                rb = assets[key]["raster:bands"][0]
                scales.append(rb.get("scale", 1.0)); offsets.append(rb.get("offset", 0.0))
                with rasterio.open(assets[key]["href"]) as s:
                    stack.append(s.read(1, window=win10))
            arr = np.stack(stack)
            img_path = out / f"{a.nome}.tif"
            prof = dict(driver="GTiff", dtype="uint16", width=a.tamanho, height=a.tamanho, count=4, crs=crs,
                        transform=tr10, nodata=0, compress="deflate", tiled=True, blockxsize=256, blockysize=256)
            with rasterio.open(img_path, "w", **prof) as d:
                d.write(arr)
                d.scales, d.offsets = tuple(scales), tuple(offsets)
                d.descriptions = tuple(desc for _, desc in BANDS)
                d.update_tags(ACQUISITION_UTC=it["properties"]["datetime"],
                              ATTRIBUTION=f"Contains modified Copernicus Sentinel data ({it['properties']['datetime'][:4]})",
                              MODIFICATION="Spatial crop and four-band stack; original DN preserved",
                              SOURCE_ITEM=it["id"])
            scl_path = out / f"{a.nome}_scl.tif"
            with rasterio.open(scl_path, "w", driver="GTiff", dtype="uint8", width=scl.shape[1], height=scl.shape[0],
                               count=1, crs=crs, transform=tr20, nodata=0, compress="deflate") as d:
                d.write(scl, 1)
            meta = {"item": it["id"], "datetime": it["properties"]["datetime"], "nuvem_cena": it["properties"]["eo:cloud_cover"],
                    "invalido_janela": bad, "stac": f"https://earth-search.aws.element84.com/v1/collections/sentinel-2-c1-l2a/items/{it['id']}",
                    "centro": [a.lon, a.lat], "crs": str(crs)}
            (out / f"{a.nome}.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
            print("OK ->", img_path, json.dumps(meta))
            return
    raise SystemExit("Todas as cenas candidatas tinham nuvem na janela.")


if __name__ == "__main__":
    main()
