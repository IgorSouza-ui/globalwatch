import type { Feature, FeatureCollection, Geometry } from 'geojson'
import L from 'leaflet'
import {
  AlertTriangle,
  Crosshair,
  Eye,
  Globe2,
  Loader2,
  MapPin,
  RotateCcw,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { GeoJSON, ImageOverlay, MapContainer, TileLayer, useMap } from 'react-leaflet'
import { api, type AnalysisRecord, type PolygonProps } from '../api'

type OverlayKind = 'rgb' | 'ndvi' | 'classes' | 'none'
type BaseKind = 'satelite' | 'mapa'

interface MapViewProps {
  analysis: AnalysisRecord | null
  selectedPolygonId: string | null
  onSelectPolygon: (id: string | null) => void
  onOpenSample?: (sampleId: string) => void
}

function FitBoundsAndFocus({
  bounds,
  focusCoord,
  fitTrigger,
}: {
  bounds: [[number, number], [number, number]] | null
  focusCoord: [number, number] | null
  fitTrigger: number
}) {
  const map = useMap()

  useEffect(() => {
    if (bounds) {
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 })
    }
  }, [map, bounds, fitTrigger])

  useEffect(() => {
    if (focusCoord) {
      map.flyTo(focusCoord, Math.max(map.getZoom(), 15), { duration: 0.7 })
    }
  }, [map, focusCoord])

  return null
}

export function MapView({
  analysis,
  selectedPolygonId,
  onSelectPolygon,
  onOpenSample,
}: MapViewProps) {
  const [overlayKind, setOverlayKind] = useState<OverlayKind>('rgb')
  const [baseKind, setBaseKind] = useState<BaseKind>('satelite')
  const [overlayOpacity, setOverlayOpacity] = useState<number>(0.92)
  const [showPolygons, setShowPolygons] = useState<boolean>(true)
  const [showLegend, setShowLegend] = useState<boolean>(true)
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null)
  const [geojson, setGeojson] = useState<FeatureCollection | null>(null)
  const [loadingLayer, setLoadingLayer] = useState<boolean>(false)
  const [fitTrigger, setFitTrigger] = useState<number>(0)

  const result = analysis?.result ?? null

  useEffect(() => {
    let active = true
    setGeojson(null)
    if (!analysis || analysis.status !== 'done') return

    api
      .fetchProtectedBlob(analysis.id, 'areas_potenciais_cafe.geojson')
      .then((blob) => blob.text())
      .then((txt) => {
        if (active) setGeojson(JSON.parse(txt) as FeatureCollection)
      })
      .catch(() => {
        if (active) setGeojson(null)
      })
    return () => {
      active = false
    }
  }, [analysis])

  useEffect(() => {
    let active = true
    let createdUrl: string | null = null
    setOverlayUrl(null)

    if (!analysis || analysis.status !== 'done' || overlayKind === 'none') {
      return
    }

    const fileMap: Record<Exclude<OverlayKind, 'none'>, string> = {
      rgb: 'overlay_rgb.png',
      ndvi: 'overlay_ndvi.png',
      classes: 'overlay_classes.png',
    }
    setLoadingLayer(true)
    api
      .fetchProtectedBlob(analysis.id, fileMap[overlayKind])
      .then((blob) => {
        if (!active) return
        createdUrl = URL.createObjectURL(blob)
        setOverlayUrl(createdUrl)
      })
      .catch(() => {
        if (active) setOverlayUrl(null)
      })
      .finally(() => {
        if (active) setLoadingLayer(false)
      })

    return () => {
      active = false
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [analysis, overlayKind])

  const focusCoord = useMemo<[number, number] | null>(() => {
    if (!selectedPolygonId || !result) return null
    const found = result.poligonos_resumo.find((p) => p.id === selectedPolygonId)
    return found ? [found.centro_lat, found.centro_lon] : null
  }, [selectedPolygonId, result])

  const defaultCenter: [number, number] = [-21.33, -46.68]

  return (
    <div className="relative h-[380px] sm:h-[460px] w-full overflow-hidden bg-[#dfe8dc]">
      <MapContainer center={defaultCenter} zoom={13} className="h-full w-full z-0" zoomControl={false}>
        {baseKind === 'satelite' ? (
          <TileLayer
            url="https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"
            attribution="&copy; Google Satellite / Maxar"
            maxZoom={20}
          />
        ) : (
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
            maxZoom={19}
          />
        )}

        {result && (
          <FitBoundsAndFocus
            bounds={result.limites_overlay}
            focusCoord={focusCoord}
            fitTrigger={fitTrigger}
          />
        )}

        {result && overlayUrl && overlayKind !== 'none' && (
          <ImageOverlay
            key={`${analysis?.id}-${overlayKind}`}
            url={overlayUrl}
            bounds={result.limites_overlay}
            opacity={overlayOpacity}
          />
        )}

        {result && showPolygons && geojson && (
          <GeoJSON
            key={`${analysis?.id}-${selectedPolygonId ?? 'all'}`}
            data={geojson}
            style={(feature?: Feature<Geometry, PolygonProps>) => {
              const isSelected = feature?.properties?.id === selectedPolygonId
              return {
                color: isSelected ? '#1e5d4c' : '#facc15',
                weight: isSelected ? 3.5 : 2,
                fillColor: isSelected ? '#2c8059' : '#eab308',
                fillOpacity: isSelected ? 0.5 : 0.28,
              }
            }}
            onEachFeature={(feature: Feature<Geometry, PolygonProps>, layer: L.Layer) => {
              const p = feature.properties
              if (!p) return
              layer.on('click', () => onSelectPolygon(p.id))
              const html = `
                <div style="min-width:215px;font-size:12px;line-height:1.45;color:#23322d">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                    <strong style="color:#1e5d4c;font-size:13px">Talhão candidato ${p.id}</strong>
                    <span style="background:#eaf4e9;color:#2c6a4f;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:700">${p.area_ha.toFixed(2)} ha</span>
                  </div>
                  <div style="color:#62736a;margin-bottom:6px;font-size:11px">⚠️ ${p.status}</div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 8px;color:#23322d">
                    <span>NDVI médio: <b>${p.ndvi_medio}</b></span>
                    <span>SAVI médio: <b>${p.savi_medio}</b></span>
                    <span>GNDVI médio: <b>${p.gndvi_medio}</b></span>
                    <span>Vermelho: <b>${p.vermelho_medio}</b></span>
                    <span>Perímetro: <b>${p.perimetro_m} m</b></span>
                    <span>Pixels (10m): <b>${p.pixels}</b></span>
                  </div>
                  <div style="margin-top:6px;color:#78877e;font-size:10px">
                    Centro: ${p.centro_lat}, ${p.centro_lon}
                  </div>
                </div>
              `
              layer.bindPopup(html)
            }}
          />
        )}
      </MapContainer>

      {/* Seletor de camada no canto superior esquerdo (apenas quando houver cena carregada) */}
      {result && (
        <div className="pointer-events-auto absolute left-4 top-4 z-[500] flex flex-wrap items-center gap-1.5 rounded-xl border border-white/60 bg-white/92 p-1.5 shadow-sm backdrop-blur">
          {(
            [
              ['rgb', 'RGB'],
              ['ndvi', 'NDVI'],
              ['classes', 'Classes'],
              ['none', 'Base'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setOverlayKind(key)}
              className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition cursor-pointer ${
                overlayKind === key
                  ? 'bg-[#1e5d4c] text-white shadow-xs'
                  : 'text-[#60716a] hover:bg-[#edf3ec]'
              }`}
            >
              {label}
            </button>
          ))}

          <div className="hidden sm:flex items-center gap-1.5 pl-1.5 pr-1 text-[11px] text-[#60716a] border-l border-[#dfe7df]">
            <Eye className="size-3.5" />
            <input
              type="range"
              min={0.15}
              max={1}
              step={0.05}
              value={overlayOpacity}
              onChange={(e) => setOverlayOpacity(parseFloat(e.target.value))}
              className="w-14 accent-[#1e5d4c]"
              title={`Opacidade da camada: ${Math.round(overlayOpacity * 100)}%`}
            />
          </div>
        </div>
      )}

      {/* Botões de ferramentas flutuantes à direita (estilo do repositório UI) */}
      <div className="pointer-events-auto absolute right-4 top-4 z-[500] flex flex-col overflow-hidden rounded-xl border border-white/60 bg-white/92 shadow-sm backdrop-blur">
        <button
          type="button"
          onClick={() => setShowPolygons(!showPolygons)}
          className="border-b border-[#e7ebe7] p-2.5 text-[#52675a] hover:bg-white transition cursor-pointer"
          title={showPolygons ? 'Ocultar polígonos de café' : 'Mostrar polígonos de café'}
        >
          <Crosshair className={`size-4 ${showPolygons ? 'text-[#2c8059]' : 'text-[#9aa69f]'}`} />
        </button>
        <button
          type="button"
          onClick={() => {
            onSelectPolygon(null)
            setFitTrigger((n) => n + 1)
          }}
          className="border-b border-[#e7ebe7] p-2.5 text-[#52675a] hover:bg-white transition cursor-pointer"
          title="Reenquadrar cena no mapa"
        >
          <RotateCcw className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => setBaseKind(baseKind === 'satelite' ? 'mapa' : 'satelite')}
          className="p-2.5 text-[#52675a] hover:bg-white transition cursor-pointer"
          title={`Alternar mapa base (atual: ${baseKind === 'satelite' ? 'Satélite Esri' : 'OpenStreetMap'})`}
        >
          <Globe2 className="size-4" />
        </button>
      </div>

      {/* Indicador de carregamento de camada */}
      {loadingLayer && (
        <div className="pointer-events-none absolute top-16 left-4 z-[500] flex items-center gap-2 rounded-xl border border-[#dfe7df] bg-white/95 px-3 py-1.5 text-xs text-[#23322d] shadow-sm">
          <Loader2 className="size-3.5 animate-spin text-[#1e5d4c]" />
          Atualizando camada georreferenciada...
        </div>
      )}

      {/* Aviso de ausência de resultados (0 polígonos) */}
      {result && result.candidatas.quantidade_poligonos === 0 && (
        <div className="pointer-events-auto absolute top-16 left-1/2 -translate-x-1/2 z-[500] max-w-md rounded-2xl border border-[#e6d5b8] bg-white/95 px-4 py-3 text-xs text-[#5c4827] shadow-lg backdrop-blur">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="size-4 shrink-0 text-[#d19b54] mt-0.5" />
            <div>
              <p className="font-semibold">Nenhuma área potencial de café encontrada nesta cena</p>
              <p className="mt-1 text-[#786b54]">
                Nenhum objeto atingiu a área mínima ({result.parametros.min_area_ha} ha) na faixa espectral configurada. Ajuste os limiares em &ldquo;Parâmetros avançados&rdquo;.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Estado inicial vazio (amigável, sem sobrepor barra e com botão de ação direta) */}
      {!result && (
        <div className="absolute inset-0 z-[400] flex items-center justify-center bg-[#dfe8dc]/80 backdrop-blur-[2px] p-4 sm:p-6">
          <div className="pointer-events-auto max-w-md rounded-2xl border border-[#dfe7df] bg-white p-5 sm:p-6 text-center shadow-lg">
            <div className="mx-auto mb-2.5 flex size-10 items-center justify-center rounded-xl bg-[#eaf3e8] text-[#1e5d4c]">
              <MapPin className="size-5" />
            </div>
            <h3 className="text-sm sm:text-base font-semibold text-[#23322d]">
              Escolha uma área para mapear
            </h3>
            <p className="mt-1 text-xs text-[#718078] leading-relaxed">
              Abra uma das regiões cafeeiras de exemplo logo abaixo ou envie uma nova imagem de satélite da sua fazenda para identificar os cafezais.
            </p>
            {onOpenSample && (
              <button
                type="button"
                onClick={() => onOpenSample('guaxupe_2025_kit')}
                className="mt-3.5 inline-flex items-center gap-1.5 rounded-xl bg-[#1e5d4c] px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-[#164b3d] transition cursor-pointer"
              >
                Ver fazenda de exemplo (Guaxupé/MG)
              </button>
            )}
          </div>
        </div>
      )}

      {/* Legenda flutuante no canto inferior esquerdo */}
      {result && (
        <div className="pointer-events-auto absolute bottom-3 left-3 z-[500] max-w-xs rounded-xl border border-white/70 bg-white/93 p-2.5 text-[11px] text-[#23322d] shadow-md backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setShowLegend(!showLegend)}
              className="font-semibold text-[#1e5d4c] hover:underline cursor-pointer"
            >
              {showLegend ? '▾ Legenda do Mapa' : '▸ Legenda do Mapa'}
            </button>
            <span className="rounded-md bg-[#eaf4e9] px-1.5 py-0.5 text-[10px] font-semibold text-[#2c6a4f]">
              {result.candidatas.area_total_ha.toFixed(2)} ha · {result.candidatas.quantidade_poligonos} pol.
            </span>
          </div>

          {showLegend && (
            <>
              {overlayKind === 'ndvi' ? (
                <div className="mt-2">
                  <div
                    className="h-2 w-full rounded-full"
                    style={{
                      background:
                        'linear-gradient(to right, #a50026, #f46d43, #fee08b, #a6d96a, #1a9850, #006837)',
                    }}
                  />
                  <div className="mt-1 flex justify-between text-[9px] text-[#68796e]">
                    <span>−0,1 (Água/Solo)</span>
                    <span>0,45</span>
                    <span>0,65 (Café pot.)</span>
                    <span>0,85+ (Mata)</span>
                  </div>
                </div>
              ) : (
                <div className="mt-1.5 grid grid-cols-1 gap-1">
                  {result.classes
                    .filter((c) => c.pixels > 0 || c.classe === 3)
                    .map((c) => (
                      <div key={c.classe} className="flex items-center justify-between gap-2 text-[10px]">
                        <div className="flex items-center gap-1.5 truncate">
                          <span
                            className="size-2.5 shrink-0 rounded-xs border border-black/15"
                            style={{ backgroundColor: c.cor }}
                          />
                          <span
                            className={`truncate ${
                              c.classe === 3 ? 'font-semibold text-[#1e5d4c]' : 'text-[#52675a]'
                            }`}
                          >
                            {c.nome}
                          </span>
                        </div>
                        <span className="shrink-0 font-mono text-[#68796e]">
                          {c.area_ha.toFixed(1)} ha
                        </span>
                      </div>
                    ))}
                </div>
              )}
              <div className="mt-1.5 border-t border-[#e8ede8] pt-1 text-[9px] text-[#78877e]">
                ⚠️ Áreas potenciais (não validadas em campo) · {(result.data_imagem || '').slice(0, 10)}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
