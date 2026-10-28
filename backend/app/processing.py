"""Pipeline de geoprocessamento: GeoTIFF multiespectral -> áreas POTENCIAIS de café.

Etapas
1. Leitura e validação do raster (CRS, bandas, dimensões).
2. Conversão radiométrica DN -> reflectância usando scale/offset do próprio GeoTIFF
   (aplicada uma única vez; NoData excluído).
3. Máscara de qualidade com a SCL do Sentinel-2 (nuvem, sombra, saturação, água).
4. Índices espectrais: NDVI, SAVI, NDWI e GNDVI.
5. Classificação por regras (conhecimento + assinatura espectral) em 6 classes.
6. Pós-processamento por objeto (morfologia, área mínima, buffer de mata).
7. Vetorização em polígonos, cálculo de área geodésica (ha) e exportação.

IMPORTANTE: o resultado é "área potencial", não "café validado". Índice de
vegetação sozinho não comprova café — ver docs/NOTA_PESQUISA.md.
"""
from __future__ import annotations

import json
import math
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from PIL import Image, ImageDraw, ImageFont
from pyproj import Geod
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.features import shapes
from rasterio.warp import calculate_default_transform, reproject, transform_bounds, transform_geom
from scipy import ndimage as ndi
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

GEOD = Geod(ellps="WGS84")
WEB_MERCATOR = CRS.from_epsg(3857)
WGS84 = CRS.from_epsg(4326)


class ProcessingError(ValueError):
    """Erro de validação/processamento com mensagem amigável ao usuário."""


# --------------------------------------------------------------------------- classes
CLASSES: dict[int, dict[str, Any]] = {
    0: {"key": "invalido", "nome": "Sem dado / nuvem / sombra", "cor": (0, 0, 0, 0)},
    1: {"key": "agua", "nome": "Água", "cor": (37, 99, 235, 200)},
    2: {"key": "vegetacao_densa", "nome": "Vegetação densa (mata/silvicultura)", "cor": (20, 83, 45, 190)},
    3: {"key": "cafe_potencial", "nome": "Área potencial de café", "cor": (234, 179, 8, 230)},
    4: {"key": "vegetacao_baixa", "nome": "Vegetação baixa / pastagem seca", "cor": (190, 242, 100, 150)},
    5: {"key": "solo_construido", "nome": "Solo exposto / área construída", "cor": (168, 120, 90, 160)},
    6: {"key": "intermediaria_descartada", "nome": "Vegetação intermediária descartada", "cor": (148, 163, 184, 150)},
}

# Classes da SCL (Sentinel-2 L2A) tratadas como inválidas para análise.
SCL_INVALID = {0: "sem dado", 1: "saturado/defeituoso", 2: "área escura/sombra topográfica",
               3: "sombra de nuvem", 8: "nuvem (prob. média)", 9: "nuvem (prob. alta)",
               10: "cirrus", 11: "neve"}
SCL_WATER = 6


@dataclass
class ClassParams:
    """Parâmetros da regra de classificação (documentados no README)."""

    ndvi_min: float = 0.50       # abaixo: pastagem seca / solo (estação seca)
    ndvi_dense: float = 0.76     # acima: mata, eucalipto, pivô muito vigoroso
    red_min: float = 0.035       # café expõe solo entre linhas -> vermelho maior que mata
    vis_max: float = 0.07        # brilho visível médio (B,G,R): lavouras anuais/gramíneas irrigadas são mais claras
    ndvi_soil: float = 0.25      # abaixo: solo exposto / construído
    ndwi_water: float = 0.0      # NDWI (McFeeters) > 0 -> água
    dense_buffer_px: int = 1     # remove borda mista de mata (pixels de transição)
    min_area_ha: float = 1.0     # objetos menores são descartados
    obj_ndvi_min: float = 0.52   # NDVI médio mínimo do objeto
    obj_ndvi_max: float = 0.74   # NDVI médio máximo do objeto

    def validate(self) -> "ClassParams":
        if not (0 <= self.ndvi_soil < self.ndvi_min < self.ndvi_dense <= 1):
            raise ProcessingError("Parâmetros inválidos: exige 0 ≤ ndvi_soil < ndvi_min < ndvi_dense ≤ 1.")
        if not (0 <= self.red_min <= 0.3):
            raise ProcessingError("red_min deve estar entre 0 e 0,3.")
        if not (0.01 <= self.vis_max <= 0.5):
            raise ProcessingError("vis_max deve estar entre 0,01 e 0,5.")
        if not (0.1 <= self.min_area_ha <= 100):
            raise ProcessingError("min_area_ha deve estar entre 0,1 e 100 ha.")
        if not (0 <= self.dense_buffer_px <= 5):
            raise ProcessingError("dense_buffer_px deve estar entre 0 e 5.")
        if self.obj_ndvi_min > self.obj_ndvi_max:
            raise ProcessingError("obj_ndvi_min deve ser menor que obj_ndvi_max.")
        return self


@dataclass
class RasterInfo:
    crs: str
    width: int
    height: int
    pixel_size_m: float
    bounds_native: list[float]
    band_map: dict[str, int]
    radiometry: str
    acquisition: str | None
    source_item: str | None
    attribution: str | None
    warnings: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- leitura
BAND_ALIASES = {
    "blue": ("b02", "blue", "azul"),
    "green": ("b03", "green", "verde"),
    "red": ("b04", "red", "vermelho"),
    "nir": ("b08", "nir", "infravermelho", "b8"),
}


def _detect_bands(descriptions: tuple[str | None, ...], count: int) -> tuple[dict[str, int], list[str]]:
    warnings: list[str] = []
    found: dict[str, int] = {}
    for idx, desc in enumerate(descriptions, start=1):
        if not desc:
            continue
        d = desc.lower()
        for key, aliases in BAND_ALIASES.items():
            if key not in found and any(re.search(rf"(^|[^a-z0-9]){a}([^a-z0-9]|$)", d) for a in aliases):
                found[key] = idx
    if len(found) == 4:
        return found, warnings
    if count == 4:
        warnings.append("Bandas sem descrição reconhecida: assumida a ordem B02, B03, B04, B08 (azul, verde, vermelho, NIR).")
        return {"blue": 1, "green": 2, "red": 3, "nir": 4}, warnings
    raise ProcessingError(
        "Não foi possível identificar as bandas azul, verde, vermelho e infravermelho próximo. "
        "Envie um GeoTIFF com 4 bandas (B02, B03, B04, B08) ou com descrições das bandas."
    )


def _guess_acquisition(tags: dict[str, str], filename: str) -> str | None:
    for k in ("ACQUISITION_UTC", "ACQUISITION_DATE", "DATETIME", "TIFFTAG_DATETIME", "datetime"):
        if tags.get(k):
            return tags[k]
    m = re.search(r"(20\d{2})(\d{2})(\d{2})T?", filename)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return None


def read_raster(path: Path, filename: str, max_pixels: int) -> tuple[np.ndarray, np.ndarray, rasterio.Affine, CRS, RasterInfo]:
    """Retorna (reflectância [4,H,W] float32, máscara válida, transform, crs, info)."""
    try:
        src = rasterio.open(path)
    except Exception as exc:  # arquivo não é raster legível
        raise ProcessingError("O arquivo não é um GeoTIFF válido.") from exc
    with src:
        if src.driver != "GTiff":
            raise ProcessingError("Formato não suportado: envie um GeoTIFF (.tif).")
        if src.crs is None or src.transform.is_identity:
            raise ProcessingError("A imagem não é georreferenciada (sem CRS/transform).")
        if src.count < 4:
            raise ProcessingError(f"A imagem tem {src.count} banda(s); são necessárias ao menos 4 (azul, verde, vermelho, NIR).")
        if src.width * src.height > max_pixels:
            raise ProcessingError(f"Imagem grande demais ({src.width}x{src.height}). Limite: {max_pixels:,} pixels.".replace(",", "."))
        if src.width < 16 or src.height < 16:
            raise ProcessingError("Imagem pequena demais para análise (mínimo 16x16 pixels).")

        band_map, warnings = _detect_bands(src.descriptions, src.count)
        order = [band_map[k] for k in ("blue", "green", "red", "nir")]
        dn = src.read(order).astype("float32")
        nodata = src.nodata
        tags = src.tags()

        if nodata is not None:
            valid = ~np.any(dn == nodata, axis=0)
        else:
            valid = ~np.any(dn == 0, axis=0) if np.issubdtype(np.dtype(src.dtypes[0]), np.integer) else np.ones(dn.shape[1:], bool)
        valid &= np.all(np.isfinite(dn), axis=0)

        scales = [src.scales[i - 1] for i in order]
        offsets = [src.offsets[i - 1] for i in order]
        has_meta = any(s != 1.0 for s in scales) or any(o != 0.0 for o in offsets)
        if has_meta:
            refl = dn * np.array(scales, "float32")[:, None, None] + np.array(offsets, "float32")[:, None, None]
            radiometry = f"DN × {scales[0]:g} + ({offsets[0]:g}) — scale/offset lidos do GeoTIFF"
        else:
            p99 = float(np.percentile(dn[:, valid], 99)) if valid.any() else 0.0
            if p99 > 2.0:
                refl = dn * 0.0001 - 0.1
                radiometry = "DN × 0.0001 − 0.1 (padrão Sentinel-2 L2A, baseline ≥ 04.00)"
                warnings.append("GeoTIFF sem scale/offset: aplicado o padrão Sentinel-2 L2A (×0,0001 −0,1). Verifique se é o caso.")
            else:
                refl = dn
                radiometry = "valores já em reflectância (sem conversão)"
        crs, transform = src.crs, src.transform
        pixel_size = abs(transform.a)
        if crs.is_geographic:
            # converte grau -> metro (aprox.) apenas para reportar
            lat = (src.bounds.top + src.bounds.bottom) / 2
            pixel_size = pixel_size * 111_320 * math.cos(math.radians(lat))
        info = RasterInfo(
            crs=crs.to_string(), width=src.width, height=src.height, pixel_size_m=round(pixel_size, 2),
            bounds_native=[round(v, 6) for v in src.bounds], band_map=band_map, radiometry=radiometry,
            acquisition=_guess_acquisition(tags, filename), source_item=tags.get("SOURCE_ITEM"),
            attribution=tags.get("ATTRIBUTION"), warnings=warnings,
        )
    if not valid.any():
        raise ProcessingError("A imagem não possui pixels válidos (tudo NoData).")
    refl[:, ~valid] = np.nan
    return refl, valid, transform, crs, info


def read_scl(path: Path, transform: rasterio.Affine, crs: CRS, shape_hw: tuple[int, int]) -> np.ndarray:
    """Lê a SCL e reamostra (vizinho mais próximo — classes categóricas) para a grade da imagem."""
    try:
        with rasterio.open(path) as src:
            if src.crs is None:
                raise ProcessingError("A camada SCL não é georreferenciada.")
            if src.count != 1 or not np.issubdtype(np.dtype(src.dtypes[0]), np.integer):
                raise ProcessingError("A SCL deve ter 1 banda inteira (classes 0–11).")
            data = src.read(1)
            if data.max() > 11:
                raise ProcessingError("A SCL contém valores fora das classes 0–11.")
            out = np.zeros(shape_hw, dtype="uint8")
            reproject(data, out, src_transform=src.transform, src_crs=src.crs,
                      dst_transform=transform, dst_crs=crs, resampling=Resampling.nearest,
                      src_nodata=None, dst_nodata=0)
            return out
    except ProcessingError:
        raise
    except Exception as exc:
        raise ProcessingError("Não foi possível ler a camada SCL (GeoTIFF inválido).") from exc


# --------------------------------------------------------------------------- índices
def compute_indices(refl: np.ndarray) -> dict[str, np.ndarray]:
    blue, green, red, nir = refl
    with np.errstate(divide="ignore", invalid="ignore"):
        ndvi = (nir - red) / (nir + red)
        savi = 1.5 * (nir - red) / (nir + red + 0.5)
        ndwi = (green - nir) / (green + nir)
        gndvi = (nir - green) / (nir + green)
    return {"ndvi": ndvi, "savi": savi, "ndwi": ndwi, "gndvi": gndvi}


def _stats(a: np.ndarray, mask: np.ndarray) -> dict[str, float] | None:
    v = a[mask & np.isfinite(a)]
    if v.size == 0:
        return None
    p10, p50, p90 = np.percentile(v, [10, 50, 90])
    return {"media": round(float(v.mean()), 3), "p10": round(float(p10), 3),
            "mediana": round(float(p50), 3), "p90": round(float(p90), 3)}


# --------------------------------------------------------------------------- classificação
def classify(refl: np.ndarray, idx: dict[str, np.ndarray], valid: np.ndarray, scl: np.ndarray | None,
             p: ClassParams, pixel_area_ha: float) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    """Retorna (mapa de classes uint8, rótulos dos objetos candidatos int32, diagnóstico)."""
    red = refl[2]
    ndvi, ndwi = idx["ndvi"], idx["ndwi"]
    h, w = ndvi.shape
    cls = np.zeros((h, w), dtype="uint8")
    diag: dict[str, Any] = {}

    usable = valid & np.isfinite(ndvi)
    if scl is not None:
        scl_bad = np.isin(scl, list(SCL_INVALID))
        diag["pixels_excluidos_scl"] = int((scl_bad & valid).sum())
        usable &= ~scl_bad
        water = usable & ((scl == SCL_WATER) | (ndwi > p.ndwi_water))
    else:
        # Sem SCL: heurística simples de nuvem (muito brilhante no azul) e água por NDWI.
        cloud = refl[0] > 0.18
        diag["pixels_excluidos_heuristica_nuvem"] = int((cloud & usable).sum())
        usable &= ~cloud
        water = usable & (ndwi > p.ndwi_water)

    cls[water] = 1
    land = usable & ~water
    dense = land & (ndvi >= p.ndvi_dense)
    soil = land & (ndvi < p.ndvi_soil)
    low = land & (ndvi >= p.ndvi_soil) & (ndvi < p.ndvi_min)
    inter = land & (ndvi >= p.ndvi_min) & (ndvi < p.ndvi_dense)
    cls[dense], cls[soil], cls[low], cls[inter] = 2, 5, 4, 6

    # Pixels candidatos: NDVI intermediário + vermelho acima do típico de mata fechada
    # + brilho visível moderado (dossel + sombra das entrelinhas deixam o café escuro).
    vis = (refl[0] + refl[1] + refl[2]) / 3
    cand = inter & (red >= p.red_min) & (vis <= p.vis_max)
    # Remove o anel de transição na borda da mata (pixels mistos têm NDVI intermediário).
    ring = ndi.binary_dilation(dense, iterations=p.dense_buffer_px) if p.dense_buffer_px > 0 else dense
    cand &= ~ring
    # Morfologia: abertura remove ruído/linhas finas; fechamento une lacunas pequenas.
    st = ndi.generate_binary_structure(2, 1)
    cand = ndi.binary_opening(cand, structure=st)
    cand = ndi.binary_closing(cand, structure=st)
    cand = ndi.binary_fill_holes(cand) & land & ~ring

    labels, n = ndi.label(cand, structure=np.ones((3, 3)))
    min_px = max(1, int(round(p.min_area_ha / pixel_area_ha)))
    removed = {"area_minima": 0, "ndvi_medio_fora_da_faixa": 0}
    lut = np.zeros(n + 1, dtype="int32")  # rótulo bruto -> rótulo final (0 = descartado)
    next_id = 1
    if n:
        idxs = np.arange(1, n + 1)
        sizes = ndi.sum(np.ones_like(labels), labels, idxs)
        means = ndi.mean(np.where(np.isfinite(ndvi), ndvi, 0), labels, idxs)
        for lab, size, mean in zip(idxs, sizes, means):
            if size < min_px:
                removed["area_minima"] += 1
                continue
            if not (p.obj_ndvi_min <= mean <= p.obj_ndvi_max):
                removed["ndvi_medio_fora_da_faixa"] += 1
                continue
            lut[lab] = next_id
            next_id += 1
    kept = lut[labels]
    cls[kept > 0] = 3
    diag["objetos_brutos"] = int(n)
    diag["objetos_removidos"] = removed
    diag["objetos_mantidos"] = int(next_id - 1)
    return cls, kept.astype("int32"), diag


# --------------------------------------------------------------------------- vetorização
def polygonize(labels: np.ndarray, transform: rasterio.Affine, crs: CRS, idx: dict[str, np.ndarray],
               refl: np.ndarray, pixel_size: float) -> list[dict[str, Any]]:
    geoms: dict[int, list] = {}
    for geom, val in shapes(labels, mask=labels > 0, transform=transform, connectivity=8):
        geoms.setdefault(int(val), []).append(shape(geom))
    features = []
    tol = 0.5 * abs(transform.a)  # simplifica o "serrilhado" dos pixels (meio pixel)
    for lab, parts in sorted(geoms.items()):
        poly = unary_union(parts).buffer(0)
        simple = poly.simplify(tol, preserve_topology=True)
        geo = shape(transform_geom(crs, WGS84, mapping(simple), precision=7))
        area_m2, perim_m = GEOD.geometry_area_perimeter(shape(transform_geom(crs, WGS84, mapping(poly), precision=9)))
        area_ha = abs(area_m2) / 10_000
        sel = labels == lab
        c = geo.representative_point()
        features.append({
            "type": "Feature",
            "geometry": mapping(geo),
            "properties": {
                "id": f"C{lab:02d}",
                "classe": "area_potencial_cafe",
                "status": "potencial — não validado em campo",
                "area_ha": round(area_ha, 2),
                "perimetro_m": round(abs(perim_m), 1),
                "compacidade": round(4 * math.pi * abs(area_m2) / (perim_m ** 2), 3) if perim_m else None,
                "ndvi_medio": round(float(np.nanmean(idx["ndvi"][sel])), 3),
                "savi_medio": round(float(np.nanmean(idx["savi"][sel])), 3),
                "gndvi_medio": round(float(np.nanmean(idx["gndvi"][sel])), 3),
                "vermelho_medio": round(float(np.nanmean(refl[2][sel])), 4),
                "pixels": int(sel.sum()),
                "centro_lat": round(c.y, 6),
                "centro_lon": round(c.x, 6),
            },
        })
    features.sort(key=lambda f: -f["properties"]["area_ha"])
    return features


# --------------------------------------------------------------------------- imagens
def _rgb_uint8(refl: np.ndarray, valid: np.ndarray) -> np.ndarray:
    rgb = np.stack([refl[2], refl[1], refl[0]], axis=-1)
    v = rgb[valid]
    lo, hi = np.nanpercentile(v, 2, axis=0), np.nanpercentile(v, 98, axis=0)
    out = np.clip((rgb - lo) / np.maximum(hi - lo, 1e-6), 0, 1) ** (1 / 1.2)
    out = np.nan_to_num(out * 255).astype("uint8")
    alpha = np.where(valid, 255, 0).astype("uint8")
    return np.dstack([out, alpha])


def _ndvi_rgba(ndvi: np.ndarray, valid: np.ndarray) -> np.ndarray:
    stops = np.array([[-0.1, 165, 0, 38], [0.2, 244, 109, 67], [0.4, 254, 224, 139],
                      [0.6, 166, 217, 106], [0.8, 26, 152, 80], [1.0, 0, 104, 55]], dtype="float32")
    x = np.clip(np.nan_to_num(ndvi, nan=0), -0.1, 1.0)
    rgb = np.stack([np.interp(x, stops[:, 0], stops[:, i]) for i in (1, 2, 3)], axis=-1).astype("uint8")
    return np.dstack([rgb, np.where(valid, 230, 0).astype("uint8")])


def _class_rgba(cls: np.ndarray) -> np.ndarray:
    out = np.zeros(cls.shape + (4,), dtype="uint8")
    for k, c in CLASSES.items():
        out[cls == k] = c["cor"]
    return out


def _to_web_mercator(rgba: np.ndarray, transform: rasterio.Affine, crs: CRS) -> tuple[np.ndarray, list[list[float]]]:
    """Reprojeta um RGBA para EPSG:3857 (o que o Leaflet desenha) e devolve os limites lat/lon."""
    h, w = rgba.shape[:2]
    left, top = transform @ (0, 0)
    right, bottom = transform @ (w, h)
    bounds = (min(left, right), min(top, bottom), max(left, right), max(top, bottom))
    dst_tr, dw, dh = calculate_default_transform(crs, WEB_MERCATOR, w, h, *bounds)
    out = np.zeros((4, dh, dw), dtype="uint8")
    for b in range(4):
        reproject(rgba[..., b], out[b], src_transform=transform, src_crs=crs,
                  dst_transform=dst_tr, dst_crs=WEB_MERCATOR, resampling=Resampling.nearest)
    l, t = dst_tr @ (0, 0)
    r, btm = dst_tr @ (dw, dh)
    w4326 = transform_bounds(WEB_MERCATOR, WGS84, l, btm, r, t)
    return np.moveaxis(out, 0, -1), [[w4326[1], w4326[0]], [w4326[3], w4326[2]]]


def _font(size: int) -> ImageFont.ImageFont:
    for name in ("DejaVuSans.ttf", "arial.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def render_polygons_png(rgba: np.ndarray, features: list[dict[str, Any]], transform: rasterio.Affine,
                        crs: CRS, out: Path, title: str, subtitle: str, total_ha: float, attribution: str) -> None:
    """PNG para download: imagem RGB + contornos dos polígonos + legenda + data + área."""
    scale = max(1, int(round(1024 / max(rgba.shape[:2]))))
    base = Image.fromarray(rgba, "RGBA").convert("RGB")
    base = base.resize((base.width * scale, base.height * scale), Image.NEAREST)
    draw = ImageDraw.Draw(base, "RGBA")
    inv = ~transform
    f_lab = _font(max(12, 7 * scale))
    for f in features:
        geom = shape(transform_geom(WGS84, crs, f["geometry"]))
        polys = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
        for poly in polys:
            ring = [tuple(np.array(inv @ pt) * scale) for pt in poly.exterior.coords]
            draw.polygon(ring, fill=(234, 179, 8, 70), outline=(250, 204, 21, 255), width=max(2, scale))
        cx, cy = inv @ transform_geom(WGS84, crs, {"type": "Point", "coordinates": [f["properties"]["centro_lon"], f["properties"]["centro_lat"]]})["coordinates"]
        draw.text((cx * scale, cy * scale), f["properties"]["id"], fill="white", font=f_lab, anchor="mm",
                  stroke_width=2, stroke_fill="black")
    pad, bar = 16, 120
    canvas = Image.new("RGB", (base.width, base.height + bar), (15, 23, 42))
    canvas.paste(base, (0, 0))
    d = ImageDraw.Draw(canvas)
    y = base.height + 12
    d.text((pad, y), title, fill="white", font=_font(22))
    d.text((pad, y + 30), subtitle, fill=(203, 213, 225), font=_font(15))
    d.rectangle((pad, y + 60, pad + 18, y + 76), fill=(234, 179, 8), outline=(250, 204, 21))
    d.text((pad + 26, y + 60), f"Área potencial de café (não validada em campo): {len(features)} polígonos · {total_ha:.2f} ha",
           fill="white", font=_font(15))
    d.text((pad, y + 86), attribution, fill=(148, 163, 184), font=_font(12))
    canvas.save(out, "PNG", optimize=True)


def _save_png(rgba: np.ndarray, path: Path) -> None:
    Image.fromarray(rgba, "RGBA").save(path, "PNG", optimize=True)


# --------------------------------------------------------------------------- orquestração
def run_pipeline(image_path: Path, filename: str, out_dir: Path, scl_path: Path | None = None,
                 params: ClassParams | None = None, max_pixels: int = 2048 * 2048,
                 acquisition_override: str | None = None) -> dict[str, Any]:
    t0 = time.perf_counter()
    p = (params or ClassParams()).validate()
    out_dir.mkdir(parents=True, exist_ok=True)

    refl, valid, transform, crs, info = read_raster(image_path, filename, max_pixels)
    h, w = valid.shape
    scl = read_scl(scl_path, transform, crs, (h, w)) if scl_path else None
    if scl is None:
        info.warnings.append("SCL não enviada: nuvens detectadas por heurística simples (menos confiável).")
    if acquisition_override:
        info.acquisition = acquisition_override

    pixel_area_m2 = info.pixel_size_m ** 2
    pixel_area_ha = pixel_area_m2 / 10_000
    idx = compute_indices(refl)
    cls, labels, diag = classify(refl, idx, valid, scl, p, pixel_area_ha)
    features = polygonize(labels, transform, crs, idx, refl, info.pixel_size_m)

    # Áreas por classe (contagem de pixels × área do pixel)
    class_areas = []
    total_px = h * w
    for k, c in CLASSES.items():
        n = int((cls == k).sum())
        class_areas.append({"classe": k, "key": c["key"], "nome": c["nome"], "cor": "#%02x%02x%02x" % c["cor"][:3],
                            "pixels": n, "area_ha": round(n * pixel_area_ha, 2), "percentual": round(100 * n / total_px, 2)})
    cand_px = int((cls == 3).sum())
    usable_px = int((cls > 0).sum())
    poly_total = round(sum(f["properties"]["area_ha"] for f in features), 2)

    # ----- arquivos de saída
    geojson = {"type": "FeatureCollection", "name": "areas_potenciais_cafe",
               "metadata": {"fonte": filename, "data_imagem": info.acquisition, "metodo": "regras espectrais + objeto",
                            "aviso": "Áreas potenciais, não validadas em campo."},
               "features": features}
    (out_dir / "areas_potenciais_cafe.geojson").write_text(json.dumps(geojson, ensure_ascii=False), encoding="utf-8")

    profile = dict(driver="GTiff", dtype="uint8", width=w, height=h, count=1, crs=crs, transform=transform,
                   compress="deflate", nodata=0)
    with rasterio.open(out_dir / "classificacao.tif", "w", **profile) as dst:
        dst.write(cls, 1)
        dst.write_colormap(1, {k: c["cor"] if c["cor"][3] else (0, 0, 0, 0) for k, c in CLASSES.items()})
        dst.update_tags(1, **{f"CLASS_{k}": c["nome"] for k, c in CLASSES.items()})
        dst.update_tags(ACQUISITION=str(info.acquisition), ATTRIBUTION=str(info.attribution or ""),
                        NOTE="Area potencial de cafe (classe 3) - nao validada em campo")

    rgb = _rgb_uint8(refl, valid)
    overlays = {}
    for name, rgba in (("rgb", rgb), ("classes", _class_rgba(cls)), ("ndvi", _ndvi_rgba(idx["ndvi"], valid))):
        merc, bounds_ll = _to_web_mercator(rgba, transform, crs)
        _save_png(merc, out_dir / f"overlay_{name}.png")
        overlays[name] = f"overlay_{name}.png"

    date_txt = (info.acquisition or "data desconhecida")[:10]
    attribution = info.attribution or "Fonte da imagem: enviada pelo usuário"
    render_polygons_png(rgb, features, transform, crs, out_dir / "imagem_com_poligonos.png",
                        title="Global Watch · Áreas potenciais de café",
                        subtitle=f"{filename} · imagem de {date_txt} · {info.crs} · {info.pixel_size_m:g} m",
                        total_ha=poly_total, attribution=attribution)

    ll = transform_bounds(crs, WGS84, *info.bounds_native)
    result = {
        "arquivo": filename,
        "imagem": asdict(info),
        "data_imagem": info.acquisition,
        "limites_latlon": [[ll[1], ll[0]], [ll[3], ll[2]]],
        "limites_overlay": bounds_ll,
        "area_total_ha": round(total_px * pixel_area_ha, 2),
        "area_valida_ha": round(usable_px * pixel_area_ha, 2),
        "scl_utilizada": scl is not None,
        "indices": {k: _stats(v, cls > 0) for k, v in idx.items()},
        "indices_candidatas": {k: _stats(v, cls == 3) for k, v in idx.items()},
        "classes": class_areas,
        "candidatas": {
            "quantidade_poligonos": len(features),
            "area_total_ha": poly_total,
            "area_pixels_ha": round(cand_px * pixel_area_ha, 2),
            "percentual_area_valida": round(100 * cand_px / usable_px, 2) if usable_px else 0,
            "maior_poligono_ha": features[0]["properties"]["area_ha"] if features else 0,
        },
        "diagnostico": diag,
        "poligonos_resumo": [f["properties"] for f in features[:30]],
        "parametros": asdict(p),
        "metodo": {
            "resumo": ("Regras espectrais baseadas em conhecimento para a estação seca: café adulto mantém folhas "
                       "(NDVI intermediário), mas as entrelinhas expõem solo (vermelho mais alto que mata) e o dossel "
                       "com sombras deixa o alvo escuro no visível (lavouras anuais e gramíneas irrigadas são mais "
                       "claras). Pastagem seca tem NDVI baixo; mata/eucalipto têm NDVI alto e vermelho baixo. Depois, "
                       "filtros por objeto (área mínima, NDVI médio, remoção da borda de mata) e vetorização."),
            "indices": ["NDVI (classificação)", "SAVI, GNDVI (descrição)", "NDWI McFeeters (água)"],
            "mascara": "SCL Sentinel-2 (classes 0,1,2,3,8,9,10,11 excluídas; 6 = água)" if scl is not None else "heurística sem SCL",
        },
        "limitacoes": [
            "Índice de vegetação sozinho não comprova café: o resultado é ÁREA POTENCIAL, sem validação de campo.",
            "Sem gabarito no kit: não há acurácia calculada. A concordância com o MapBiomas está documentada à parte e não é acurácia.",
            "Uma única data (estação seca): pastagens irrigadas, cana em rebrota, pomares e capoeiras podem ter assinatura parecida.",
            "Resolução de 10 m mistura linhas de café e solo; talhões pequenos (< área mínima) e bordas são perdidos.",
            "Sem bandas SWIR/red-edge (kit tem só B02, B03, B04, B08): limita a separação de café x mata secundária.",
            "Café recém-podado (esqueletamento/recepa) ou em formação pode ficar abaixo do NDVI mínimo.",
        ],
        "arquivos": {
            "geojson": "areas_potenciais_cafe.geojson",
            "imagem_poligonos": "imagem_com_poligonos.png",
            "classificacao_tif": "classificacao.tif",
            **{f"overlay_{k}": v for k, v in overlays.items()},
        },
        "atribuicao": attribution,
        "tempo_processamento_s": round(time.perf_counter() - t0, 2),
    }
    return result
