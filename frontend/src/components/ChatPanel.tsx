import { Bot, Loader2, Send, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { api, type AnalysisRecord, type ChatMessage } from '../api'

interface ChatPanelProps {
  analysis: AnalysisRecord | null
  iaConfigurada: boolean
  onQuotaChange?: () => void
}

const SUGGESTIONS = [
  'Quais os maiores talhões?',
  'Como o método separa café de mata e pasto?',
  'Quais são as limitações?',
  'Compare NDVI, SAVI e GNDVI',
]

export function ChatPanel({ analysis, iaConfigurada, onQuotaChange }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastSource, setLastSource] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let active = true
    setMessages([])
    setError(null)
    setLastSource(null)
    if (!analysis || analysis.status !== 'done') return

    setLoadingHistory(true)
    api
      .getChat(analysis.id)
      .then((msgs) => {
        if (active) setMessages(msgs)
      })
      .catch((err: Error) => {
        if (active) setError(err.message)
      })
      .finally(() => {
        if (active) setLoadingHistory(false)
      })
    return () => {
      active = false
    }
  }, [analysis])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  async function handleSend(text?: string) {
    const q = (text ?? input).trim()
    if (!q || !analysis || sending) return
    setInput('')
    setError(null)
    setMessages((prev) => [...prev, { role: 'user', content: q }])
    setSending(true)
    try {
      const res = await api.sendChat(analysis.id, q)
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: res.content, origem: res.origem },
      ])
      setLastSource(res.origem)
      onQuotaChange?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao consultar o assistente.')
    } finally {
      setSending(false)
    }
  }

  const isGemini = lastSource ? lastSource.startsWith('gemini') : iaConfigurada

  return (
    <div className="flex min-h-[520px] max-h-[620px] flex-col overflow-hidden rounded-2xl border border-[#dfe7df] bg-white shadow-[0_8px_30px_rgba(39,67,48,.04)]">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between border-b border-[#e8ede8] p-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#eaf2e6] text-[#4b8959]">
            <Bot className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#23322d] truncate">Assistente geoespacial</p>
            <p className="flex items-center gap-1.5 text-[10px] text-[#799083]">
              <span
                className={`size-1.5 rounded-full ${
                  isGemini ? 'bg-[#62a46a]' : 'bg-[#d19b54]'
                }`}
              />
              {isGemini ? 'Gemini · análise contextual' : 'Modo determinístico · dados reais'}
            </p>
          </div>
        </div>
        {analysis && (
          <span className="rounded-full bg-[#f2f7f1] px-2.5 py-1 text-[10px] font-medium text-[#4c7d55] truncate max-w-[120px]">
            {analysis.filename}
          </span>
        )}
      </div>

      {/* Corpo de mensagens */}
      <div className="flex-1 space-y-3.5 overflow-y-auto p-4">
        {!analysis || analysis.status !== 'done' ? (
          <div className="rounded-xl bg-[#f1f6ef] p-4 text-xs leading-relaxed text-[#52675a]">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-[#568060]">
              <Sparkles className="size-3" /> AGUARDANDO CENA
            </div>
            Selecione uma das cenas Sentinel-2 prontas ou envie um arquivo GeoTIFF para que o assistente apresente os números da classificação e responda perguntas.
          </div>
        ) : loadingHistory ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-[#718078]">
            <Loader2 className="size-4 animate-spin text-[#1e5d4c]" />
            Carregando insight da cena...
          </div>
        ) : (
          <>
            {messages.map((m, idx) => (
              <div
                key={idx}
                className={
                  m.role === 'user'
                    ? 'ml-auto max-w-[90%] rounded-xl rounded-tr-sm bg-[#1e5d4c] p-3 text-xs leading-relaxed text-white shadow-xs'
                    : 'max-w-[95%] rounded-xl rounded-tl-sm bg-[#f1f6ef] p-3 text-xs leading-relaxed text-[#2d3f36]'
                }
              >
                {idx === 0 && m.role === 'assistant' && (
                  <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#568060]">
                    <Sparkles className="size-3" /> INSIGHT DA CENA
                  </div>
                )}
                <div className="[&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_li]:my-0.5 [&_strong]:font-semibold">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
              </div>
            ))}

            {sending && (
              <div className="flex items-center gap-2 text-xs text-[#68796e] pl-1">
                <Loader2 className="size-3.5 animate-spin text-[#1e5d4c]" />
                Consultando métricas e geometrias...
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                {error}
              </div>
            )}

            <div className="flex flex-wrap gap-1.5 pt-1">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={sending}
                  onClick={() => handleSend(s)}
                  className="rounded-full border border-[#dbe7d9] bg-white px-2.5 py-1.5 text-[10px] text-[#66806b] transition hover:bg-[#edf5eb] disabled:opacity-50 cursor-pointer"
                >
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Barra de input */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          handleSend()
        }}
        className="border-t border-[#e8ede8] p-3"
      >
        <div className="flex items-center gap-2 rounded-xl border border-[#dfe7df] bg-[#fbfcfa] px-3 py-2 focus-within:border-[#1e5d4c]">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!analysis || sending}
            maxLength={1000}
            placeholder={
              analysis ? 'Pergunte sobre hectares, método ou limitações…' : 'Abra uma cena primeiro…'
            }
            className="min-w-0 flex-1 bg-transparent text-xs text-[#23322d] outline-none placeholder:text-[#9ba8a0] disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!analysis || sending || !input.trim()}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#1e5d4c] text-white hover:bg-[#164b3d] transition disabled:opacity-40 cursor-pointer"
            title="Enviar pergunta"
          >
            <Send className="size-3.5" />
          </button>
        </div>
      </form>
    </div>
  )
}
