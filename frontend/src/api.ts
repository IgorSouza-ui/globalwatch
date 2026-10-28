export const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

export interface SampleInfo {
  id: string
  titulo: string
  rotulo?: string
  tag?: string
  descricao: string
  regiao: string
  data: string
  item_stac: string
  filename: string
}

export interface PublicConfig {
  google_login: boolean
  dev_login: boolean
  ia_configurada: boolean
  limites: {
    upload_mb: number
    max_pixels: number
    analises_por_dia: number
    mensagens_chat_por_dia: number
    analises_armazenadas: number
    retencao_horas: number
  }
  amostras: SampleInfo[]
}

export interface UserProfile {
  id: string
  email: string
  name?: string | null
  picture?: string | null
}

export interface UsageToday {
  analises: number
  analises_limite: number
  mensagens: number
  mensagens_limite: number
}

export interface IndexStats {
  media: number
  p10: number
  mediana: number
  p90: number
}

export interface ClassArea {
  classe: number
  key: string
  nome: string
  cor: string
  pixels: number
  area_ha: number
  percentual: number
}

export interface PolygonProps {
  id: string
  classe: string
  status: string
  area_ha: number
  perimetro_m: number
  compacidade: number | null
  ndvi_medio: number
  savi_medio: number
  gndvi_medio: number
  vermelho_medio: number
  pixels: number
  centro_lat: number
  centro_lon: number
}

export interface AnalysisResult {
  arquivo: string
  imagem: {
    crs: string
    width: number
    height: number
    pixel_size_m: number
    bounds_native: number[]
    band_map: Record<string, number>
    radiometry: string
    acquisition: string | null
    source_item: string | null
    attribution: string | null
    warnings: string[]
  }
  data_imagem: string | null
  limites_latlon: [[number, number], [number, number]]
  limites_overlay: [[number, number], [number, number]]
  area_total_ha: number
  area_valida_ha: number
  scl_utilizada: boolean
  indices: Record<string, IndexStats | null>
  indices_candidatas: Record<string, IndexStats | null>
  classes: ClassArea[]
  candidatas: {
    quantidade_poligonos: number
    area_total_ha: number
    area_pixels_ha: number
    percentual_area_valida: number
    maior_poligono_ha: number
  }
  diagnostico: {
    pixels_excluidos_scl?: number
    pixels_excluidos_heuristica_nuvem?: number
    objetos_brutos: number
    objetos_removidos: {
      area_minima: number
      ndvi_medio_fora_da_faixa: number
    }
    objetos_mantidos: number
  }
  poligonos_resumo: PolygonProps[]
  parametros: {
    ndvi_min: number
    ndvi_dense: number
    red_min: number
    vis_max: number
    ndvi_soil: number
    ndwi_water: number
    dense_buffer_px: number
    min_area_ha: number
    obj_ndvi_min: number
    obj_ndvi_max: number
  }
  metodo: {
    resumo: string
    indices: string[]
    mascara: string
  }
  limitacoes: string[]
  arquivos: Record<string, string>
  atribuicao: string
  tempo_processamento_s: number
}

export interface AnalysisRecord {
  id: string
  filename: string
  created_at: number
  status: string
  error?: string | null
  result?: AnalysisResult | null
}

export interface AnalysisListItem {
  id: string
  filename: string
  created_at: number
  status: string
  error?: string | null
  data_imagem?: string | null
  area_candidata_ha?: number | null
  poligonos?: number | null
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  created_at?: number
  origem?: string
}

const TOKEN_KEY = 'gw_cafe_token'

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setStoredToken(token: string | null): void {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token)
  } else {
    localStorage.removeItem(TOKEN_KEY)
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredToken()
  const headers = new Headers(init.headers || {})
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  const resp = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (resp.status === 401) {
    setStoredToken(null)
  }
  if (!resp.ok) {
    let msg = `Erro HTTP ${resp.status}`
    try {
      const body = await resp.json()
      if (body?.detail) {
        msg = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
      }
    } catch {
      // ignora erro de parse
    }
    throw new Error(msg)
  }
  return resp.json() as Promise<T>
}

export const api = {
  getConfig: () => request<PublicConfig>('/api/config'),

  loginGoogle: (credential: string) =>
    request<{ token: string; user: UserProfile }>('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    }),

  loginDev: (name: string) =>
    request<{ token: string; user: UserProfile }>('/api/auth/dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () => request<{ user: UserProfile; uso_hoje: UsageToday }>('/api/me'),

  listAnalyses: () => request<AnalysisListItem[]>('/api/analyses'),

  getAnalysis: (id: string) => request<AnalysisRecord>(`/api/analyses/${id}`),

  deleteAnalysis: (id: string) =>
    request<{ ok: boolean }>(`/api/analyses/${id}`, { method: 'DELETE' }),

  runSample: (sampleId: string) =>
    request<AnalysisRecord>(`/api/analyses/sample/${sampleId}`, { method: 'POST' }),

  uploadAnalysis: (formData: FormData) =>
    request<AnalysisRecord>('/api/analyses', {
      method: 'POST',
      body: formData,
    }),

  getChat: (id: string) => request<ChatMessage[]>(`/api/analyses/${id}/chat`),

  sendChat: (id: string, message: string) =>
    request<{ role: 'assistant'; content: string; origem: string; restantes_hoje: number }>(
      `/api/analyses/${id}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      },
    ),

  async fetchProtectedBlob(analysisId: string, filename: string): Promise<Blob> {
    const token = getStoredToken()
    const resp = await fetch(`${API_BASE}/api/analyses/${analysisId}/files/${filename}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!resp.ok) {
      throw new Error(`Falha ao baixar ${filename} (HTTP ${resp.status})`)
    }
    return resp.blob()
  },

  sampleDownloadUrl(sampleId: string, kind: 'image' | 'scl'): string {
    return `${API_BASE}/api/samples/${sampleId}/${kind}`
  },
}
