import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUp, Mic, MicOff, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react'
import { api } from '../lib/api'
import { useAura, useAuraEvents } from '../lib/aura'
import { speak, useSpeechInput } from '../lib/speech'
import type { Message, Run } from '../lib/types'
import { RUN_STATUS_LABEL, runTone } from '../lib/format'
import { Orb } from './Orb'
import type { OrbState } from './Orb'
import { Badge, Button, ErrorNote, StatusIcon, cx } from './ui'

export const SUGGESTIONS = [
  'Alexa, prepare the house before my overnight shift.',
  'Get everything prepared for bedtime.',
  'Actually, I prefer my bedtime temperature at 70 degrees.',
  "What's the thermostat at?",
]

export function useConversation() {
  const { sessionId, ensureSession, newSession, voiceReplies, toast } = useAura()
  const [messages, setMessages] = useState<Message[]>([])
  const [thinking, setThinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const spokenUpTo = useRef<number>(Number.MAX_SAFE_INTEGER)

  const load = useCallback(async (sid: string) => {
    try {
      const { messages } = await api.messages(sid)
      setMessages(messages)
      if (spokenUpTo.current === Number.MAX_SAFE_INTEGER) spokenUpTo.current = messages.at(-1)?.id ?? 0
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    if (sessionId) load(sessionId)
    else setMessages([])
  }, [sessionId, load])

  useAuraEvents((e) => {
    if (e.type === 'message' && e.data.session_id === sessionId) {
      setMessages((prev) => (prev.some((m) => m.id === e.data.id) ? prev : [...prev, e.data as Message]))
    }
  })

  useEffect(() => {
    const last = messages.at(-1)
    if (voiceReplies && last && last.role === 'assistant' && last.id > spokenUpTo.current) {
      spokenUpTo.current = last.id
      speak(last.text)
    } else if (last && last.id > spokenUpTo.current) {
      spokenUpTo.current = last.id
    }
  }, [messages, voiceReplies])

  const send = useCallback(
    async (text: string): Promise<Run | null> => {
      const trimmed = text.trim()
      if (!trimmed) return null
      setError(null)
      setThinking(true)
      try {
        const sid = await ensureSession()
        const res = await api.chat(sid, trimmed)
        await load(res.session_id)
        return res.run
      } catch (e: any) {
        setError(e.message)
        toast(e.message, 'error')
        return null
      } finally {
        setThinking(false)
      }
    },
    [ensureSession, load, toast],
  )

  const reset = useCallback(async () => {
    window.speechSynthesis?.cancel()
    await newSession()
    setMessages([])
    toast('New session started. Your saved memory carries over; the conversation does not.', 'info')
  }, [newSession, toast])

  return { messages, thinking, error, send, reset, sessionId }
}

function PlanCard({ runId }: { runId: string }) {
  const [run, setRun] = useState<Run | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const navigate = useNavigate()
  const { toast } = useAura()

  const load = useCallback(() => {
    api.run(runId).then(setRun).catch(() => undefined)
  }, [runId])
  useEffect(load, [load])
  useAuraEvents((e) => {
    if (e.run_id === runId && (e.type === 'run.status' || e.type === 'run.finished' || e.type === 'step.status')) load()
  })

  if (!run) return null
  const awaiting = run.status === 'AWAITING_APPROVAL'
  const sensitive = run.steps.filter((s) => s.risk === 'SENSITIVE').length

  async function approve() {
    setBusy('approve')
    try {
      await api.approve(runId)
      navigate(`/runs/${runId}`)
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(null)
    }
  }
  async function cancel() {
    setBusy('cancel')
    try {
      setRun(await api.cancel(runId))
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-2 animate-rise rounded-2xl border border-lav-400/20 bg-night-800/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-bold">{run.summary}</div>
        <Badge tone={runTone(run.status)}>{RUN_STATUS_LABEL[run.status]}</Badge>
      </div>
      {awaiting && (
        <p className="mt-1 text-xs text-ink-mute">
          Plan preview: nothing has run yet.{' '}
          {sensitive > 0 && `${sensitive} step${sensitive > 1 ? 's' : ''} will ask for separate confirmation.`}
        </p>
      )}
      <ol className="mt-3 space-y-1.5">
        {run.steps.map((s) => (
          <li key={s.id} className="flex items-start gap-2 text-sm">
            <StatusIcon status={s.status} className="mt-0.5 size-4" />
            <div className="min-w-0 flex-1">
              <span className="text-ink">{s.title}</span>
              {s.risk === 'SENSITIVE' && (
                <Badge tone="recover" className="ml-2 align-middle">
                  Confirm
                </Badge>
              )}
              {s.provenance && <div className="truncate text-[11px] text-lav-300/80">{s.provenance}</div>}
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {awaiting ? (
          <>
            <Button variant="primary" onClick={approve} busy={busy === 'approve'}>
              <ShieldCheck className="size-4" /> Approve & run
            </Button>
            <Button variant="ghost" onClick={cancel} busy={busy === 'cancel'}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => navigate(`/runs/${runId}`)}>
            Open live view
          </Button>
        )}
        <span className="ml-auto text-[11px] text-ink-mute" title={run.planner_detail}>
          {run.planner === 'bedrock' ? 'Planned by Amazon Bedrock' : 'Planned by local rules (no LLM)'}
        </span>
      </div>
    </div>
  )
}

export function Assistant({ convo }: { convo: ReturnType<typeof useConversation> }) {
  const { messages, thinking, error, send, reset } = convo
  const [text, setText] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const voice = useSpeechInput((t) => {
    setText('')
    send(t)
  })

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [messages, thinking])

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const orbState: OrbState = voice.listening
    ? 'listening'
    : thinking
      ? 'thinking'
      : lastAssistant?.meta?.recovery
        ? 'attention'
        : 'idle'

  function submit(e?: React.FormEvent) {
    e?.preventDefault()
    const t = text
    setText('')
    send(t)
  }

  return (
    <section className="card flex min-h-[480px] flex-col overflow-hidden" aria-labelledby="assistant-title">
      <div className="flex items-center gap-4 border-b border-white/6 p-5">
        <Orb state={orbState} />
        <div className="min-w-0 flex-1">
          <h2 id="assistant-title" className="font-bold">
            Talk to AURA
          </h2>
          <p className="text-xs text-ink-mute">
            {voice.listening
              ? voice.interim || 'Listening…'
              : thinking
                ? 'Planning…'
                : 'Say or type a request. You approve plans before anything runs.'}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={reset} title="Start a new conversation. Saved memory is kept.">
          <RefreshCw className="size-3.5" /> New session
        </Button>
      </div>

      <div ref={scroller} className="scroll-thin flex-1 space-y-4 overflow-y-auto p-5" aria-live="polite">
        {messages.length === 0 && !thinking && (
          <div className="flex h-full flex-col items-center justify-center gap-4 py-6 text-center">
            <Sparkles className="size-6 text-lav-300" aria-hidden />
            <p className="max-w-sm text-sm text-ink-soft">Try one of these:</p>
            <div className="flex max-w-lg flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full bg-white/5 px-3.5 py-2 text-left text-xs text-ink-soft ring-1 ring-white/10 transition hover:bg-lav-400/10 hover:text-lav-200 hover:ring-lav-400/30"
                >
                  “{s}”
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={cx('flex animate-rise', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className={cx('max-w-[92%]', m.role === 'user' ? 'items-end' : 'items-start')}>
              <div
                className={cx(
                  'rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed',
                  m.role === 'user'
                    ? 'rounded-br-md bg-lav-400/18 text-lav-200 ring-1 ring-lav-400/25'
                    : m.meta?.recovery
                      ? 'rounded-bl-md bg-recover/10 text-ink ring-1 ring-recover/30'
                      : m.meta?.final && m.meta?.status === 'COMPLETED'
                        ? 'rounded-bl-md bg-verified/8 text-ink ring-1 ring-verified/25'
                        : 'rounded-bl-md bg-white/5 text-ink ring-1 ring-white/8',
                )}
              >
                {m.text}
              </div>
              {m.role === 'assistant' && m.run_id && m.meta?.run_id === m.run_id && <PlanCard runId={m.run_id} />}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="flex gap-1.5 px-2" aria-label="AURA is thinking">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-2 animate-bounce rounded-full bg-lav-300/70" style={{ animationDelay: `${i * 120}ms` }} />
            ))}
          </div>
        )}
      </div>

      <form onSubmit={submit} className="border-t border-white/6 p-4">
        {(error || voice.error) && <div className="mb-3"><ErrorNote>{voice.error ?? error}</ErrorNote></div>}
        <div className="flex items-center gap-2 rounded-2xl bg-night-950/60 p-1.5 ring-1 ring-white/10 focus-within:ring-lav-400/40">
          <button
            type="button"
            onClick={voice.listening ? voice.stop : voice.start}
            disabled={!voice.supported || thinking}
            className={cx(
              'grid size-10 shrink-0 place-items-center rounded-xl transition',
              voice.listening ? 'bg-verified/20 text-verified' : 'text-ink-soft hover:bg-white/8 hover:text-ink',
              !voice.supported && 'cursor-not-allowed opacity-40',
            )}
            aria-label={voice.listening ? 'Stop listening' : 'Speak a request'}
            title={voice.supported ? 'Speak a request' : "Voice input isn't supported in this browser. Type instead."}
          >
            {voice.listening ? <MicOff className="size-5" /> : <Mic className="size-5" />}
          </button>
          <label htmlFor="ask" className="sr-only">
            Ask AURA
          </label>
          <input
            id="ask"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="“Alexa, get everything ready for bedtime”"
            maxLength={500}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent px-2 py-2 text-[15px] text-ink placeholder:text-ink-mute/70 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!text.trim() || thinking}
            className="grid size-10 shrink-0 place-items-center rounded-xl bg-lav-300 text-night-950 transition hover:bg-lav-200 disabled:opacity-30"
            aria-label="Send"
          >
            <ArrowUp className="size-5" />
          </button>
        </div>
      </form>
    </section>
  )
}
