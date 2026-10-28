import { GoogleLogin } from '@react-oauth/google'
import {
  AlertCircle,
  AreaChart,
  BarChart3,
  Check,
  ChevronDown,
  CircleHelp,
  Cloud,
  Crosshair,
  Database,
  Download,
  FileImage,
  FileText,
  Gauge,
  Globe2,
  Layers3,
  Loader2,
  LogOut,
  Map as MapIcon,
  Mountain,
  Paperclip,
  Play,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  getStoredToken,
  setStoredToken,
  type AnalysisListItem,
  type AnalysisRecord,
  type PublicConfig,
  type UsageToday,
  type UserProfile,
} from './api'
import { ChatPanel } from './components/ChatPanel'
import { MapView } from './components/MapView'

export function App() {
  const [config, setBackendConfig] = useState<PublicConfig | null>(null)
  const [user, setUser] = useState<UserProfile | null>(null)
  const [usage, setUsage] = useState<UsageToday | null>(null)
  const [booting, setBooting] = useState(true)
  const [authError, setAuthError] = useState<string | null>(null)

  // Análises
  const [history, setHistory] = useState<AnalysisListItem[]>([])
  const [current, setCurrent] = useState<AnalysisRecord | null>(null)
  const [selectedPolygonId, setSelectedPolygonId] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [processingLabel, setProcessingLabel] = useState('')
  const [errorBanner, setErrorBanner] = useState<string | null>(null)
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Upload e parâmetros avançados
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [sclFile, setSclFile] = useState<File | null>(null)
  const [acqDate, setAcqDate] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showMethodModal, setShowMethodModal] = useState(false)
  const [ndviMin, setNdviMin] = useState(0.5)
  const [ndviDense, setNdviDense] = useState(0.76)
  const [redMin, setRedMin] = useState(0.035)
  const [visMax, setVisMax] = useState(0.07)
  const [minAreaHa, setMinAreaHa] = useState(1.0)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const sclInputRef = useRef<HTMLInputElement | null>(null)
  const uploadSectionRef = useRef<HTMLDivElement | null>(null)
  const historySectionRef = useRef<HTMLDivElement | null>(null)

  const refreshMeAndHistory = useCallback(async (selectFirst = false) => {
    const [meRes, listRes] = await Promise.all([api.me(), api.listAnalyses()])
    setUser(meRes.user)
    setUsage(meRes.uso_hoje)
    setHistory(listRes)
    if (selectFirst && listRes.length > 0) {
      const firstDone = listRes.find((a) => a.status === 'done')
      if (firstDone) {
        const full = await api.getAnalysis(firstDone.id)
        setCurrent(full)
      }
    }
  }, [])

  useEffect(() => {
    let mounted = true
    async function init() {
      try {
        const cfg = await api.getConfig()
        if (!mounted) return
        setBackendConfig(cfg)
        if (getStoredToken()) {
          await refreshMeAndHistory(true)
        }
      } catch (err) {
        if (mounted) {
          setAuthError(
            err instanceof Error ? err.message : 'Não foi possível conectar ao servidor.',
          )
        }
      } finally {
        if (mounted) setBooting(false)
      }
    }
    init()
    return () => {
      mounted = false
    }
  }, [refreshMeAndHistory])

  async function handleGoogleSuccess(credential?: string) {
    if (!credential) return
    setAuthError(null)
    try {
      const res = await api.loginGoogle(credential)
      setStoredToken(res.token)
      await refreshMeAndHistory(true)
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Falha na autenticação Google.')
    }
  }

  async function handleLogout() {
    try {
      await api.logout()
    } catch {
      // ignora erro se já expirou
    }
    setStoredToken(null)
    setUser(null)
    setCurrent(null)
    setHistory([])
  }

  async function handleRunSample(sampleId: string, titulo: string) {
    setErrorBanner(null)
    setProcessing(true)
    setProcessingLabel(`Processando ${titulo}…`)
    try {
      const rec = await api.runSample(sampleId)
      setCurrent(rec)
      setSelectedPolygonId(null)
      await refreshMeAndHistory(false)
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Erro ao processar amostra.')
    } finally {
      setProcessing(false)
      setProcessingLabel('')
    }
  }

  async function handleUploadFile(fileToProcess?: File) {
    const target = fileToProcess || imageFile
    if (!target) {
      setErrorBanner('Selecione um arquivo GeoTIFF (.tif) multiespectral de 4 bandas.')
      return
    }
    setErrorBanner(null)
    setProcessing(true)
    setProcessingLabel(`Processando ${target.name}…`)
    try {
      const fd = new FormData()
      fd.append('image', target)
      if (sclFile) fd.append('scl', sclFile)
      if (acqDate.trim()) fd.append('acquisition_date', acqDate.trim())
      fd.append(
        'params',
        JSON.stringify({
          ndvi_min: ndviMin,
          ndvi_dense: ndviDense,
          red_min: redMin,
          vis_max: visMax,
          min_area_ha: minAreaHa,
        }),
      )
      const rec = await api.uploadAnalysis(fd)
      setCurrent(rec)
      setSelectedPolygonId(null)
      setImageFile(null)
      setSclFile(null)
      await refreshMeAndHistory(false)
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Falha no processamento do GeoTIFF.')
    } finally {
      setProcessing(false)
      setProcessingLabel('')
    }
  }

  async function handleSelectHistory(id: string) {
    setErrorBanner(null)
    try {
      const rec = await api.getAnalysis(id)
      setCurrent(rec)
      setSelectedPolygonId(null)
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Erro ao abrir análise.')
    }
  }

  async function handleDeleteAnalysis(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    if (!window.confirm('Deseja realmente remover esta análise do histórico?')) {
      return
    }
    setDeletingId(id)
    try {
      await api.deleteAnalysis(id)
      setHistory((prev) => prev.filter((item) => item.id !== id))
      if (current?.id === id) {
        setCurrent(null)
        setSelectedPolygonId(null)
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erro ao remover análise.')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleProtectedDownload(filename: string, saveAs: string) {
    if (!current) return
    setDownloadingFile(filename)
    try {
      const blob = await api.fetchProtectedBlob(current.id, filename)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = saveAs
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Erro ao baixar arquivo.')
    } finally {
      setDownloadingFile(null)
    }
  }

  if (booting) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f5f7f4] text-[#23322d]">
        <div className="flex items-center gap-3 rounded-2xl border border-[#dfe7df] bg-white px-6 py-4 shadow-sm">
          <Loader2 className="size-5 animate-spin text-[#1e5d4c]" />
          <span className="text-sm font-medium">Iniciando plataforma geoespacial…</span>
        </div>
      </div>
    )
  }

  // ========================================================================= TELA DE LOGIN
  if (!user) {
    return (
      <main className="min-h-screen bg-[#f5f7f4] text-[#23322d] flex flex-col justify-between">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-[#dfe7df] bg-[#fbfcfa]/95 px-4 backdrop-blur md:px-7">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl bg-[#1e5d4c] text-white">
              <Globe2 className="size-5" />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-tight">GLOBAL WATCH</p>
              <p className="text-[10px] font-medium uppercase tracking-[.18em] text-[#82918a]">
                Geospatial intelligence
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-[#718078]">
            <span className="flex items-center gap-1.5 rounded-full bg-[#edf5ec] px-3 py-1.5 text-[#3c7655]">
              <span className="size-1.5 rounded-full bg-[#4d9a65]" /> Sistema operacional
            </span>
            <span className="hidden sm:inline-block rounded-full border border-[#dfe7df] bg-white px-3 py-1.5">
              Protocolo Sentinel-2 L2A
            </span>
          </div>
        </header>

        <div className="mx-auto my-auto grid max-w-6xl grid-cols-1 gap-8 px-4 py-10 md:px-7 lg:grid-cols-12 items-center">
          <div className="lg:col-span-7 space-y-5">
            <span className="inline-flex items-center gap-2 rounded-full bg-[#eaf3e8] px-3.5 py-1.5 text-xs font-semibold text-[#2c6a4f]">
              <Sparkles className="size-3.5" /> Monitoramento Cafeeiro · Sentinel-2 (10 m)
            </span>
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-[#23322d] leading-tight">
              Identificação de áreas potenciais de cultivo de café com{' '}
              <span className="text-[#1e5d4c]">geoprocessamento e IA</span>.
            </h1>
            <p className="text-sm sm:text-base text-[#62736a] leading-relaxed max-w-xl">
              Envie recortes multiespectrais georreferenciados (B02, B03, B04, B08) e máscara de qualidade SCL. O pipeline calcula índices espectrais (NDVI, SAVI, GNDVI, NDWI), vetoriza talhões candidatos em GeoJSON e conecta os resultados a um assistente IA contextual.
            </p>

            <div className="grid gap-3 sm:grid-cols-3 pt-2">
              <div className="rounded-2xl border border-[#dfe7df] bg-white p-4 shadow-[0_8px_30px_rgba(39,67,48,.04)]">
                <p className="text-xs font-semibold text-[#1e5d4c]">1. Radiometria & SCL</p>
                <p className="mt-1 text-[11px] text-[#718078] leading-relaxed">
                  Conversão DN → reflectância única, exclusão de NoData, nuvens e sombras (SCL 20 m).
                </p>
              </div>
              <div className="rounded-2xl border border-[#dfe7df] bg-white p-4 shadow-[0_8px_30px_rgba(39,67,48,.04)]">
                <p className="text-xs font-semibold text-[#1e5d4c]">2. Polígonos & GeoJSON</p>
                <p className="mt-1 text-[11px] text-[#718078] leading-relaxed">
                  Regras espectrais e filtro de objetos (≥ 1 ha) com cálculo geodésico em hectares.
                </p>
              </div>
              <div className="rounded-2xl border border-[#dfe7df] bg-white p-4 shadow-[0_8px_30px_rgba(39,67,48,.04)]">
                <p className="text-xs font-semibold text-[#1e5d4c]">3. Assistente Gemini</p>
                <p className="mt-1 text-[11px] text-[#718078] leading-relaxed">
                  Respostas ancoradas nas métricas reais processadas e transparentes sobre limitações.
                </p>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5">
            <div className="rounded-2xl border border-[#dfe7df] bg-white p-6 sm:p-8 shadow-[0_8px_30px_rgba(39,67,48,.06)]">
              <h2 className="text-lg font-semibold text-[#23322d]">Acessar workspace</h2>
              <p className="mt-1 text-xs text-[#718078]">
                Autenticação validada no backend com isolamento de análises por usuário.
              </p>

              {authError && (
                <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  <AlertCircle className="size-4 shrink-0 mt-0.5" />
                  <span>{authError}</span>
                </div>
              )}

              <div className="mt-6 space-y-4">
                <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#dfe7df] bg-[#fbfcfa] p-6 text-center">
                  <p className="text-xs text-[#52675a] max-w-xs leading-relaxed">
                    Entre com sua conta Google para acessar o mapa interativo, análises de talhões e assistente inteligente.
                  </p>
                  <div className="pt-1">
                    <GoogleLogin
                      onSuccess={(cred) => handleGoogleSuccess(cred.credential)}
                      onError={() =>
                        setAuthError(
                          'Falha ou cancelamento na autenticação Google. Tente novamente.',
                        )
                      }
                      theme="outline"
                      size="large"
                      shape="pill"
                      text="continue_with"
                    />
                  </div>
                  <span className="text-[10px] text-[#8b9992]">
                    Autenticação oficial via Google OAuth 2.0
                  </span>
                </div>
              </div>

              <div className="mt-6 border-t border-[#e8ede8] pt-4 text-[11px] text-[#8b9992] space-y-1">
                <div>
                  • Cota por usuário: {config?.limites.analises_por_dia ?? 15} análises/dia · upload máx.{' '}
                  {config?.limites.upload_mb ?? 40} MB
                </div>
                <div>• Retenção automática de dados: {config?.limites.retencao_horas ?? 24}h</div>
              </div>
            </div>
          </div>
        </div>

        <footer className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 pb-6 text-[11px] text-[#8b9992] md:px-7">
          <span>Contains modified Copernicus Sentinel data · 2024–2025</span>
          <span>Global Watch · Plataforma Geoespacial de Monitoramento Agrícola</span>
        </footer>
      </main>
    )
  }

  // ========================================================================= WORKSPACE AUTENTICADO
  const res = current?.result ?? null
  const stem = current ? current.filename.replace(/\.[^.]+$/, '') : 'analise'
  const initials = (user.name || user.email || 'GW')
    .split(' ')
    .map((s) => s[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  const analisesPct = usage
    ? Math.min(100, Math.round((usage.analises / Math.max(usage.analises_limite, 1)) * 100))
    : 0
  const chatPct = usage
    ? Math.min(100, Math.round((usage.mensagens / Math.max(usage.mensagens_limite, 1)) * 100))
    : 0

  const validPct = res
    ? `${((res.area_valida_ha / Math.max(res.area_total_ha, 0.01)) * 100).toFixed(1).replace('.', ',')}%`
    : '—'
  const ndviCand = res?.indices_candidatas?.ndvi

  return (
    <main className="min-h-screen bg-[#f5f7f4] text-[#23322d]">
      {/* HEADER SUPERIOR */}
      <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b border-[#dfe7df] bg-[#fbfcfa]/95 px-4 backdrop-blur md:px-7">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-[#1e5d4c] text-white">
            <Globe2 className="size-5" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight">GLOBAL WATCH</p>
            <p className="hidden text-[10px] font-medium uppercase tracking-[.18em] text-[#82918a] sm:block">
              Geospatial intelligence
            </p>
          </div>
        </div>

        <div className="hidden items-center gap-2 text-xs text-[#718078] md:flex">
          <span className="flex items-center gap-1.5 rounded-full bg-[#edf5ec] px-3 py-1.5 text-[#3c7655]">
            <span className="size-1.5 rounded-full bg-[#4d9a65]" /> Sistema operacional
          </span>
          <span className="rounded-full border border-[#dfe7df] bg-white px-3 py-1.5">
            Protocolo Sentinel-2 · 10 m
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setShowMethodModal(!showMethodModal)}
            className="hidden sm:inline-flex items-center gap-1.5 rounded-xl border border-[#dfe7df] bg-white px-3 py-1.5 text-xs font-medium text-[#52675a] hover:bg-[#f2f7f1] transition cursor-pointer"
          >
            <CircleHelp className="size-3.5 text-[#1e5d4c]" />
            Método & Limitações
          </button>
          <div className="hidden h-7 w-px bg-[#dfe7df] sm:block" />
          <div className="flex items-center gap-2">
            {user.picture ? (
              <img src={user.picture} alt="" className="size-8 rounded-full" />
            ) : (
              <div className="flex size-8 items-center justify-center rounded-full bg-[#d7e5d2] text-xs font-semibold text-[#35644d]">
                {initials}
              </div>
            )}
            <div className="hidden text-right sm:block">
              <p className="text-xs font-medium leading-tight">{user.name || user.email}</p>
              <p className="text-[10px] text-[#8b9992]">{user.email}</p>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="ml-1 rounded-lg p-2 text-[#718078] hover:bg-[#edf3ec] hover:text-[#23322d] transition cursor-pointer"
              title="Sair (Logout)"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Banners globais de processamento e erro */}
      {processing && (
        <div className="mx-auto max-w-[1600px] px-4 pt-4 md:px-7">
          <div className="flex items-center gap-2.5 rounded-2xl border border-[#bdd2b8] bg-[#eaf4e9] px-4 py-3 text-xs font-medium text-[#2c6a4f] shadow-xs">
            <Loader2 className="size-4 animate-spin text-[#1e5d4c]" />
            <span>{processingLabel}</span>
          </div>
        </div>
      )}

      {errorBanner && (
        <div className="mx-auto max-w-[1600px] px-4 pt-4 md:px-7">
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 shadow-xs">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4 shrink-0 text-red-600" />
              <span>{errorBanner}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="rounded-lg bg-red-100 px-2.5 py-1 text-[11px] font-medium hover:bg-red-200 cursor-pointer"
            >
              Fechar
            </button>
          </div>
        </div>
      )}

      {/* GRID PRINCIPAL DE 3 COLUNAS */}
      <div className="mx-auto grid max-w-[1600px] grid-cols-1 gap-5 p-4 md:p-7 xl:grid-cols-[270px_minmax(500px,1fr)_360px]">
        {/* SIDEBAR ESQUERDA */}
        <aside className="hidden rounded-2xl border border-[#dfe7df] bg-white p-4 xl:flex xl:flex-col shadow-[0_8px_30px_rgba(39,67,48,.03)]">
          <p className="mb-3 px-2 text-[10px] font-bold uppercase tracking-[.18em] text-[#9aa69f]">
            Workspace
          </p>
          <nav className="flex flex-col gap-1">
            <NavItem
              icon={MapIcon}
              label="Visão geral & Mapa"
              active={!showMethodModal}
              onClick={() => setShowMethodModal(false)}
            />
            <NavItem
              icon={Upload}
              label="Enviar Nova Imagem"
              onClick={() => uploadSectionRef.current?.scrollIntoView({ behavior: 'smooth' })}
            />
            <NavItem
              icon={Database}
              label={`Minhas análises (${history.length})`}
              onClick={() => historySectionRef.current?.scrollIntoView({ behavior: 'smooth' })}
            />
            <NavItem
              icon={BarChart3}
              label="Método & Limitações"
              active={showMethodModal}
              onClick={() => setShowMethodModal(!showMethodModal)}
            />
          </nav>

          <div className="my-5 h-px bg-[#edf0ed]" />

          <p className="mb-3 px-2 text-[10px] font-bold uppercase tracking-[.18em] text-[#9aa69f]">
            Sua cota hoje
          </p>
          <div className="rounded-xl bg-[#f2f7f1] p-3.5">
            <div className="mb-2 flex justify-between text-xs">
              <span className="text-[#62736a]">Análises</span>
              <b>
                {usage?.analises ?? 0} / {usage?.analises_limite ?? 15}
              </b>
            </div>
            <div className="h-1.5 rounded-full bg-[#dce8d9]">
              <div
                className="h-full rounded-full bg-[#5d9562] transition-all"
                style={{ width: `${analisesPct}%` }}
              />
            </div>

            <div className="mt-3.5 flex justify-between text-xs">
              <span className="text-[#62736a]">Mensagens IA</span>
              <b>
                {usage?.mensagens ?? 0} / {usage?.mensagens_limite ?? 60}
              </b>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-[#dce8d9]">
              <div
                className="h-full rounded-full bg-[#d19b54] transition-all"
                style={{ width: `${chatPct}%` }}
              />
            </div>
          </div>

          {res && (
            <>
              <div className="my-5 h-px bg-[#edf0ed]" />
              <p className="mb-2.5 px-2 text-[10px] font-bold uppercase tracking-[.18em] text-[#9aa69f]">
                Exportar cena ativa
              </p>
              <div className="space-y-1.5">
                <button
                  type="button"
                  disabled={downloadingFile !== null}
                  onClick={() =>
                    handleProtectedDownload(
                      'imagem_com_poligonos.png',
                      `${stem}_imagem_com_poligonos.png`,
                    )
                  }
                  className="flex w-full items-center gap-2 rounded-xl bg-[#1e5d4c] px-3 py-2 text-xs font-medium text-white hover:bg-[#164b3d] transition disabled:opacity-50 cursor-pointer"
                >
                  <FileImage className="size-3.5" />
                  Imagem com Polígonos (.png)
                </button>
                <button
                  type="button"
                  disabled={downloadingFile !== null}
                  onClick={() =>
                    handleProtectedDownload(
                      'areas_potenciais_cafe.geojson',
                      `${stem}_areas_potenciais_cafe.geojson`,
                    )
                  }
                  className="flex w-full items-center gap-2 rounded-xl border border-[#dfe7df] bg-[#fbfcfa] px-3 py-2 text-xs font-medium text-[#23322d] hover:bg-[#edf5ec] transition disabled:opacity-50 cursor-pointer"
                >
                  <Download className="size-3.5 text-[#1e5d4c]" />
                  Polígonos dos Talhões (.geojson)
                </button>
                <button
                  type="button"
                  disabled={downloadingFile !== null}
                  onClick={() =>
                    handleProtectedDownload('classificacao.tif', `${stem}_classificacao.tif`)
                  }
                  className="flex w-full items-center gap-2 rounded-xl border border-[#dfe7df] bg-[#fbfcfa] px-3 py-2 text-xs font-medium text-[#23322d] hover:bg-[#edf5ec] transition disabled:opacity-50 cursor-pointer"
                >
                  <FileText className="size-3.5 text-[#5e8561]" />
                  Mapa Classificado (.tif)
                </button>
              </div>
            </>
          )}

          <div className="mt-auto flex flex-col gap-1 pt-6 border-t border-[#edf0ed]">
            <button
              type="button"
              onClick={() => {
                setShowAdvanced(true)
                uploadSectionRef.current?.scrollIntoView({ behavior: 'smooth' })
              }}
              className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-[#718078] hover:bg-[#f5f8f4] cursor-pointer"
            >
              <Settings2 className="size-4" /> Parâmetros do método
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-[#718078] hover:bg-red-50 hover:text-red-700 cursor-pointer"
            >
              <LogOut className="size-4" /> Sair da conta
            </button>
          </div>
        </aside>

        {/* COLUNA CENTRAL */}
        <section className="min-w-0">
          {/* Saudação e botão Nova análise */}
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wider text-[#76907d]">
                MONITORAMENTO ORBITAL · SUL DE MINAS GERAIS
              </p>
              <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
                Olá, {(user.name || user.email).split(' ')[0]}{' '}
                <span className="text-[#82a26e]">.</span>
              </h1>
              <p className="mt-1 text-sm text-[#77857e]">
                Acompanhe a identificação espectral de áreas potenciais de café e converse com a IA.
              </p>
            </div>
            <button
              type="button"
              onClick={() => uploadSectionRef.current?.scrollIntoView({ behavior: 'smooth' })}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-xl bg-[#1e5d4c] px-4 py-2.5 text-xs font-semibold text-white shadow-xs hover:bg-[#164b3d] transition cursor-pointer"
            >
              <Plus className="size-4" /> Mapear nova área
            </button>
          </div>

          {/* 4 Cards de Métricas Principais */}
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric
              icon={Mountain}
              label="Café Potencial Estimado"
              value={res ? `${res.candidatas.area_total_ha.toFixed(2).replace('.', ',')} ha` : '—'}
              trend={
                res ? `${res.candidatas.percentual_area_valida}% da área útil` : 'aguardando seleção'
              }
            />
            <Metric
              icon={Crosshair}
              label="Talhões Mapeados"
              value={res ? String(res.candidatas.quantidade_poligonos) : '—'}
              trend={
                res && res.candidatas.maior_poligono_ha
                  ? `maior talhão: ${res.candidatas.maior_poligono_ha.toFixed(1).replace('.', ',')} ha`
                  : 'nesta área'
              }
            />
            <Metric
              icon={Gauge}
              label="Vigor Foliar (NDVI Médio)"
              value={ndviCand ? String(ndviCand.media).replace('.', ',') : '—'}
              trend={ndviCand ? `faixa: 0,50 a 0,76` : 'estação seca'}
            />
            <Metric
              icon={Cloud}
              label="Área Útil Analisada"
              value={validPct}
              trend={res ? `${res.area_valida_ha.toFixed(0)} ha sem nuvens` : 'satélite'}
            />
          </div>

          {/* Card Principal do Mapa Interativo */}
          <div className="overflow-hidden rounded-2xl border border-[#dfe7df] bg-white shadow-[0_8px_30px_rgba(39,67,48,.05)] isolate">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e8ede8] p-4">
              <div className="flex items-center gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-lg bg-[#e8f1e4] text-[#4c7d55]">
                  <Layers3 className="size-4" />
                </div>
                <div>
                  <p className="text-sm font-semibold">
                    {res ? res.arquivo : 'Nenhuma cena selecionada'}
                  </p>
                  <p className="text-[11px] text-[#8b9992]">
                    {res
                      ? `Sentinel-2 · ${(res.data_imagem || 'data não informada').slice(0, 10)} · recorte ${res.area_total_ha.toFixed(2).replace('.', ',')} ha`
                      : 'Clique em uma cena pronta abaixo ou envie um GeoTIFF'}
                  </p>
                </div>
              </div>

              {res && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="flex items-center gap-1 rounded-full bg-[#eaf4e9] px-2.5 py-1 text-[10px] font-semibold text-[#53815c]">
                    <Check className="size-3" /> Processado ({res.tempo_processamento_s}s)
                  </span>
                  <button
                    type="button"
                    disabled={downloadingFile !== null}
                    onClick={() =>
                      handleProtectedDownload(
                        'imagem_com_poligonos.png',
                        `${stem}_imagem_com_poligonos.png`,
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-lg bg-[#1e5d4c] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-[#164b3d] transition disabled:opacity-50 cursor-pointer"
                  >
                    <FileImage className="size-3.5" /> Baixar PNG
                  </button>
                  <button
                    type="button"
                    disabled={downloadingFile !== null}
                    onClick={() =>
                      handleProtectedDownload(
                        'areas_potenciais_cafe.geojson',
                        `${stem}_areas_potenciais_cafe.geojson`,
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-[#dfe7df] bg-[#fbfcfa] px-2.5 py-1.5 text-[11px] font-semibold text-[#23322d] hover:bg-[#edf5ec] transition disabled:opacity-50 cursor-pointer"
                  >
                    <Download className="size-3.5 text-[#1e5d4c]" /> GeoJSON
                  </button>
                </div>
              )}
            </div>

            {/* Mapa Leaflet Real */}
            <MapView
              analysis={current}
              selectedPolygonId={selectedPolygonId}
              onSelectPolygon={setSelectedPolygonId}
              onOpenSample={(sampleId) => {
                const s = config?.amostras.find((a) => a.id === sampleId)
                handleRunSample(sampleId, s?.titulo || 'Guaxupé / MG')
              }}
            />

            {/* Rodapé de metadados do mapa */}
            <div className="grid grid-cols-2 divide-x divide-[#e8ede8] border-t border-[#e8ede8] sm:grid-cols-4">
              <Info
                label="Área potencial (ha)"
                value={
                  res ? `${res.candidatas.area_total_ha.toFixed(2).replace('.', ',')} ha` : '—'
                }
                accent
              />
              <Info
                label="Polígonos gerados"
                value={res ? String(res.candidatas.quantidade_poligonos) : '—'}
              />
              <Info
                label="CRS / resolução"
                value={res ? `${res.imagem.crs} · ${res.imagem.pixel_size_m} m` : '—'}
              />
              <Info
                label="Data de aquisição"
                value={res ? (res.data_imagem || '—').slice(0, 10) : '—'}
              />
            </div>

            {/* Barra de seleção rápida dos maiores talhões */}
            {res && res.poligonos_resumo.length > 0 && (
              <div className="flex items-center gap-1.5 overflow-x-auto border-t border-[#e8ede8] bg-[#fbfcfa] px-4 py-2.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[#8b9992] shrink-0 mr-1">
                  Focar talhão:
                </span>
                {res.poligonos_resumo.slice(0, 12).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() =>
                      setSelectedPolygonId(selectedPolygonId === p.id ? null : p.id)
                    }
                    className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-medium transition cursor-pointer ${
                      selectedPolygonId === p.id
                        ? 'border-[#1e5d4c] bg-[#1e5d4c] text-white'
                        : 'border-[#dbe7d9] bg-white text-[#52675a] hover:bg-[#edf5eb]'
                    }`}
                  >
                    {p.id} · {p.area_ha.toFixed(2).replace('.', ',')} ha
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Cenas Prontas + Upload de GeoTIFF */}
          <div ref={uploadSectionRef} className="mt-5 grid gap-5 lg:grid-cols-2">
            {/* Card 1: Cenas prontas */}
            <div className="rounded-2xl border border-[#dfe7df] bg-white p-5 shadow-[0_8px_30px_rgba(39,67,48,.03)]">
              <SectionTitle
                icon={Sparkles}
                title="Cenas de Satélite Disponíveis"
                action="Sentinel-2 L2A"
              />
              <p className="mb-3 text-[11px] text-[#78877e]">
                Selecione uma das imagens abaixo para carregar os talhões de café no mapa ou baixe o arquivo bruto para testar o envio.
              </p>
              <div className="flex flex-col gap-3">
                {config?.amostras.map((scene) => (
                  <div
                    key={scene.id}
                    className="rounded-xl border border-[#dfe7df] bg-white p-3 hover:border-[#bdd2b8] transition"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center rounded-md bg-[#edf5ec] px-2 py-0.5 text-[10px] font-semibold text-[#1e5d4c]">
                        {scene.tag || 'Sentinel-2 L2A'}
                      </span>
                      <span className="text-[10px] text-[#78877e]">{scene.data}</span>
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-[#23322d]">
                          {scene.titulo}
                        </p>
                        <p className="mt-0.5 text-[11px] text-[#697a70] line-clamp-2">
                          {scene.descricao}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={processing}
                        onClick={() => handleRunSample(scene.id, scene.titulo)}
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[#1e5d4c] px-3 text-xs font-semibold text-white hover:bg-[#16483a] transition disabled:opacity-50 cursor-pointer shadow-xs"
                      >
                        <Play className="size-3 fill-white text-white" />
                        Carregar no Mapa
                      </button>
                    </div>

                    <div className="mt-2 flex items-center justify-between border-t border-[#edf0ed] pt-2 text-[10px]">
                      <span className="text-[#8d9b93]">{scene.regiao}</span>
                      <a
                        href={api.sampleDownloadUrl(scene.id, 'image')}
                        className="font-medium text-[#3b6b44] hover:underline"
                        title="Baixar arquivo original para testar na caixa de envio ao lado"
                      >
                        Baixar .tif original
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Card 2: Upload de GeoTIFF */}
            <div className="rounded-2xl border border-[#dfe7df] bg-white p-5 shadow-[0_8px_30px_rgba(39,67,48,.03)]">
              <SectionTitle
                icon={Upload}
                title="Mapear Nova Imagem da Fazenda"
                action={`Máx. ${config?.limites.upload_mb ?? 40} MB`}
              />

              <input
                ref={fileInputRef}
                type="file"
                accept=".tif,.tiff,image/tiff"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] || null
                  setImageFile(f)
                }}
              />
              <input
                ref={sclInputRef}
                type="file"
                accept=".tif,.tiff,image/tiff"
                className="hidden"
                onChange={(e) => setSclFile(e.target.files?.[0] || null)}
              />

              <div
                onClick={() => !processing && fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  if (processing) return
                  const f = e.dataTransfer.files?.[0]
                  if (f) setImageFile(f)
                }}
                className={`flex min-h-[132px] cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-[#b9cbb8] bg-[#f7faf6] p-4 text-center transition hover:border-[#5e9367] hover:bg-[#f1f8ef] ${
                  processing ? 'pointer-events-none opacity-60' : ''
                }`}
              >
                <div className="mb-2 flex size-9 items-center justify-center rounded-full bg-white text-[#5e9367] shadow-xs">
                  {processing ? (
                    <Loader2 className="size-4 animate-spin text-[#1e5d4c]" />
                  ) : (
                    <Upload className="size-4" />
                  )}
                </div>
                <p className="text-xs font-semibold text-[#23322d]">
                  {imageFile
                    ? `Imagem selecionada: ${imageFile.name}`
                    : 'Arraste a imagem de satélite (.tif) ou clique para escolher'}
                </p>
                <p className="mt-1 text-[10px] text-[#8a9a90]">
                  Arquivo GeoTIFF de 4 bandas (Azul, Verde, Vermelho e Infravermelho)
                  {sclFile ? ` · Máscara: ${sclFile.name}` : ''}
                </p>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-1 text-[11px] font-medium text-[#5e8067] hover:underline cursor-pointer"
                >
                  Ajustes técnicos avançados
                  <ChevronDown
                    className={`size-3 transition ${showAdvanced ? 'rotate-180' : ''}`}
                  />
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => sclInputRef.current?.click()}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#dfe7df] bg-[#fbfcfa] px-2.5 text-[11px] font-medium text-[#52675a] hover:bg-[#edf5ec] transition cursor-pointer"
                  >
                    <Paperclip className="size-3" />
                    {sclFile ? 'Trocar SCL' : 'Máscara SCL (.tif)'}
                  </button>

                  <button
                    type="button"
                    disabled={processing || !imageFile}
                    onClick={() => handleUploadFile()}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#1e5d4c] px-3.5 text-[11px] font-semibold text-white hover:bg-[#164b3d] transition disabled:opacity-40 cursor-pointer"
                  >
                    Mapear Cafezais
                  </button>
                </div>
              </div>

              {showAdvanced && (
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 border-t border-[#e8ede8] pt-3 text-[11px] text-[#697a70]">
                  <label>
                    NDVI mínimo café
                    <input
                      type="number"
                      step="0.01"
                      min="0.26"
                      max="0.7"
                      value={ndviMin}
                      onChange={(e) => setNdviMin(parseFloat(e.target.value))}
                      className="mt-1 w-full rounded-lg border border-[#dfe7df] bg-[#fbfcfa] px-2 py-1 text-[#23322d]"
                    />
                  </label>
                  <label>
                    NDVI mata densa
                    <input
                      type="number"
                      step="0.01"
                      min="0.6"
                      max="0.95"
                      value={ndviDense}
                      onChange={(e) => setNdviDense(parseFloat(e.target.value))}
                      className="mt-1 w-full rounded-lg border border-[#dfe7df] bg-[#fbfcfa] px-2 py-1 text-[#23322d]"
                    />
                  </label>
                  <label>
                    Vermelho mín. (B04)
                    <input
                      type="number"
                      step="0.005"
                      min="0.01"
                      max="0.2"
                      value={redMin}
                      onChange={(e) => setRedMin(parseFloat(e.target.value))}
                      className="mt-1 w-full rounded-lg border border-[#dfe7df] bg-[#fbfcfa] px-2 py-1 text-[#23322d]"
                    />
                  </label>
                  <label>
                    Brilho visível máx.
                    <input
                      type="number"
                      step="0.005"
                      min="0.03"
                      max="0.25"
                      value={visMax}
                      onChange={(e) => setVisMax(parseFloat(e.target.value))}
                      className="mt-1 w-full rounded-lg border border-[#dfe7df] bg-[#fbfcfa] px-2 py-1 text-[#23322d]"
                    />
                  </label>
                  <label>
                    Área mínima (ha)
                    <input
                      type="number"
                      step="0.25"
                      min="0.25"
                      max="50"
                      value={minAreaHa}
                      onChange={(e) => setMinAreaHa(parseFloat(e.target.value))}
                      className="mt-1 w-full rounded-lg border border-[#dfe7df] bg-[#fbfcfa] px-2 py-1 text-[#23322d]"
                    />
                  </label>
                  <label>
                    Data (AAAA-MM-DD)
                    <input
                      type="text"
                      placeholder="Opcional"
                      value={acqDate}
                      onChange={(e) => setAcqDate(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#dfe7df] bg-[#fbfcfa] px-2 py-1 text-[#23322d]"
                    />
                  </label>
                </div>
              )}
            </div>
          </div>

          {/* Tabela de Histórico de Análises */}
          <div
            ref={historySectionRef}
            className="mt-5 rounded-2xl border border-[#dfe7df] bg-white p-5 shadow-[0_8px_30px_rgba(39,67,48,.03)]"
          >
            <SectionTitle
              icon={AreaChart}
              title={`Histórico de análises (${history.length})`}
              action="Isolado por usuário"
            />
            {history.length === 0 ? (
              <p className="py-6 text-center text-xs text-[#8b9992]">
                Você ainda não processou nenhuma cena nesta sessão. Clique em &ldquo;Abrir&rdquo; em uma cena pronta acima.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-xs">
                  <thead className="border-b border-[#e8ede8] text-[10px] uppercase tracking-wider text-[#9aa69f]">
                    <tr>
                      <th className="pb-3 font-medium">Arquivo / cena</th>
                      <th className="pb-3 font-medium">Data da imagem</th>
                      <th className="pb-3 font-medium">Área potencial</th>
                      <th className="pb-3 font-medium">Polígonos</th>
                      <th className="pb-3 text-right font-medium">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((row) => {
                      const isCurrent = current?.id === row.id
                      return (
                        <tr
                          key={row.id}
                          onClick={() => handleSelectHistory(row.id)}
                          className={`border-b border-[#edf0ed] last:border-0 cursor-pointer transition ${
                            isCurrent ? 'bg-[#f2f7f1]' : 'hover:bg-[#fbfcfa]'
                          }`}
                        >
                          <td className="py-3 font-medium text-[#23322d]">
                            <span className="mr-2 inline-flex size-6 items-center justify-center rounded bg-[#edf4ea] text-[#5e8561]">
                              <FileText className="size-3" />
                            </span>
                            {row.filename}
                          </td>
                          <td className="py-3 text-[#78877e]">
                            {(row.data_imagem || '—').slice(0, 10)}
                          </td>
                          <td className="py-3 font-semibold text-[#2c6a4f]">
                            {row.area_candidata_ha != null
                              ? `${row.area_candidata_ha.toFixed(2).replace('.', ',')} ha`
                              : '—'}
                          </td>
                          <td className="py-3 text-[#78877e]">{row.poligonos ?? '—'}</td>
                          <td className="py-3 text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleSelectHistory(row.id)}
                                className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-[#1e5d4c] hover:bg-[#eaf3e8] cursor-pointer"
                              >
                                {isCurrent ? 'Ativa' : 'Abrir'}
                              </button>
                              <button
                                type="button"
                                disabled={deletingId === row.id}
                                onClick={(e) => handleDeleteAnalysis(row.id, e)}
                                className="rounded-lg p-1.5 text-[#8b9992] hover:bg-red-50 hover:text-red-600 transition disabled:opacity-50 cursor-pointer"
                                title="Excluir análise"
                              >
                                {deletingId === row.id ? (
                                  <Loader2 className="size-3.5 animate-spin text-red-600" />
                                ) : (
                                  <Trash2 className="size-3.5" />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Modal de Metodologia e Critérios Agronômicos */}
          {showMethodModal && (
            <div
              role="dialog"
              aria-modal="true"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4"
              onClick={() => setShowMethodModal(false)}
            >
              <div
                className="w-full max-w-xl rounded-2xl border border-[#dfe7df] bg-white p-6 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-3 border-b border-[#edf0ed] pb-4">
                  <div className="flex items-center gap-2.5">
                    <div className="flex size-9 items-center justify-center rounded-xl bg-[#edf5ec] text-[#1e5d4c]">
                      <ShieldCheck className="size-5" />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-[#23322d]">
                        Como funciona o mapeamento
                      </h3>
                      <p className="text-xs text-[#78877e]">
                        Critérios técnicos de sensoriamento remoto aplicados
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowMethodModal(false)}
                    className="rounded-lg p-1.5 text-[#78877e] hover:bg-[#edf0ed] hover:text-[#23322d] transition cursor-pointer"
                  >
                    <X className="size-4" />
                  </button>
                </div>

                <div className="mt-5 space-y-3 text-xs text-[#52675a]">
                  <div className="rounded-xl border border-[#edf0ed] bg-[#fbfcfa] p-3.5">
                    <p className="font-semibold text-[#1e5d4c]">
                      🌱 Assinatura espectral na estação seca
                    </p>
                    <p className="mt-1 leading-relaxed">
                      Entre julho e agosto no Sul de Minas, o cafeeiro adulto mantém sua copa verde ativa enquanto pastagens secam. O espaçamento entre linhas e as sombras internas das plantas geram uma resposta de luz característica que ajuda o satélite a distinguir os cafezais de matas nativas e de outras lavouras.
                    </p>
                  </div>

                  <div className="rounded-xl border border-[#edf0ed] bg-[#fbfcfa] p-3.5">
                    <p className="font-semibold text-[#1e5d4c]">
                      🚜 Filtro de talhões comerciais
                    </p>
                    <p className="mt-1 leading-relaxed">
                      Nuvens, rios e matas fechadas são eliminados pelo filtro de qualidade. Para evitar ruídos ou manchas isoladas que não sejam lavouras de produção, são mapeados talhões a partir de <strong>1 hectare</strong>, alinhado às recomendações da Embrapa Café.
                    </p>
                  </div>

                  <div className="rounded-xl border border-[#edf0ed] bg-[#fbfcfa] p-3.5">
                    <p className="font-semibold text-[#1e5d4c]">
                      📋 Uso responsável das informações
                    </p>
                    <p className="mt-1 leading-relaxed">
                      Os contornos gerados representam <strong>áreas com alta probabilidade de café</strong> detectadas via satélite. Os arquivos GeoJSON baixados servem como base para conferência por agrônomos e validação com GPS em campo.
                    </p>
                  </div>
                </div>

                <div className="mt-6 flex justify-end border-t border-[#edf0ed] pt-4">
                  <button
                    type="button"
                    onClick={() => setShowMethodModal(false)}
                    className="rounded-xl bg-[#1e5d4c] px-4 py-2 text-xs font-semibold text-white hover:bg-[#16483a] transition cursor-pointer shadow-xs"
                  >
                    Fechar
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* SIDEBAR DIREITA: Chatbot IA + Índices Espectrais + Interpretação Responsável */}
        <aside className="flex min-w-0 flex-col gap-5">
          <ChatPanel
            analysis={current}
            iaConfigurada={Boolean(config?.ia_configurada)}
            onQuotaChange={() => refreshMeAndHistory(false)}
          />

          <div className="rounded-2xl border border-[#dfe7df] bg-white p-5 shadow-[0_8px_30px_rgba(39,67,48,.03)]">
            <SectionTitle
              icon={BarChart3}
              title="Índices espectrais"
              action={res ? 'Candidatas vs Cena' : '4 índices'}
            />
            <div className="grid grid-cols-2 gap-2.5">
              {(['ndvi', 'savi', 'gndvi', 'ndwi'] as const).map((k) => {
                const stat = res?.indices_candidatas?.[k] ?? res?.indices?.[k]
                const sceneStat = res?.indices?.[k]
                return (
                  <div key={k} className="rounded-xl bg-[#f7f9f6] p-3">
                    <p className="text-[10px] font-semibold uppercase text-[#72847a]">{k}</p>
                    <p className="mt-1 text-lg font-semibold tracking-tight text-[#23322d]">
                      {stat ? String(stat.media).replace('.', ',') : '—'}
                    </p>
                    <p className="mt-0.5 text-[9px] text-[#8b9992]">
                      {stat
                        ? `P10 — P90: ${String(stat.p10).replace('.', ',')} a ${String(stat.p90).replace('.', ',')}`
                        : 'Selecione uma cena'}
                    </p>
                    {sceneStat && (
                      <p className="mt-0.5 text-[9px] text-[#5e8561]">
                        Cena geral: {String(sceneStat.media).replace('.', ',')}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="rounded-2xl border border-[#dfe7df] bg-[#f5f8f3] p-4">
            <div className="flex gap-3">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[#648868]" />
              <div>
                <p className="text-xs font-semibold text-[#49694f]">Interpretação responsável</p>
                <p className="mt-1 text-[11px] leading-relaxed text-[#718477]">
                  Áreas potenciais — não validadas em campo. Índices de vegetação isolados não comprovam a presença de café e não há gabarito de campo no kit para cálculo de acurácia.
                </p>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <footer className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 pb-7 text-[10px] text-[#9aa69f] md:px-7">
        <span>
          {res?.atribuicao || 'Contains modified Copernicus Sentinel data (2024–2025)'} · Sentinel-2 L2A
        </span>
        <span className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowMethodModal(!showMethodModal)}
            className="flex items-center gap-1 hover:text-[#1e5d4c] cursor-pointer"
          >
            <CircleHelp className="size-3" /> Método e limitações
          </button>
          <span>Retenção de dados: {config?.limites.retencao_horas ?? 24}h</span>
        </span>
      </footer>
    </main>
  )
}

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof MapIcon
  label: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-xs font-medium transition cursor-pointer ${
        active ? 'bg-[#eaf3e8] text-[#2c6a4f]' : 'text-[#77867d] hover:bg-[#f5f8f4]'
      }`}
    >
      <Icon className="size-4" />
      {label}
    </button>
  )
}

function Metric({
  icon: Icon,
  label,
  value,
  trend,
}: {
  icon: typeof Mountain
  label: string
  value: string
  trend: string
}) {
  return (
    <div className="rounded-2xl border border-[#dfe7df] bg-white p-3.5 shadow-[0_8px_30px_rgba(39,67,48,.03)]">
      <div className="mb-2 flex items-center justify-between gap-1">
        <Icon className="size-4 text-[#70936f] shrink-0" />
        <span className="text-[9px] text-[#78937c] truncate">{trend}</span>
      </div>
      <p className="text-xl font-semibold tracking-tight text-[#23322d]">{value}</p>
      <p className="mt-1 text-[10px] text-[#87958d]">{label}</p>
    </div>
  )
}

function Info({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="p-3.5">
      <p className="text-[10px] text-[#8b9992]">{label}</p>
      <p className={`mt-1 text-sm font-semibold ${accent ? 'text-[#43804d]' : 'text-[#23322d]'}`}>
        {value}
      </p>
    </div>
  )
}

function SectionTitle({
  icon: Icon,
  title,
  action,
}: {
  icon: typeof AreaChart
  title: string
  action: string
}) {
  return (
    <div className="mb-2.5 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-[#6d916d]" />
        <h2 className="text-sm font-semibold text-[#23322d]">{title}</h2>
      </div>
      <span className="text-[11px] font-medium text-[#5f8567]">{action}</span>
    </div>
  )
}

export default App
