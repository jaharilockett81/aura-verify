import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUp, Mic, MicOff, RefreshCw, ShieldCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api } from '../lib/api'
import { useAura, useAuraEvents } from '../lib/aura'
import { speak, useSpeechInput } from '../lib/speech'
import type { Message, Run } from '../lib/types'
import { RUN_STATUS_LABEL, runTone } from '../lib/format'
import { Orb } from './Orb'
import type { OrbState } from './Orb'
import { Badge, Button, ErrorNote, StatusIcon, cx } from './ui'

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
    <div className="card mt-3 animate-rise p-5">
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

export interface Chip {
  label: string
  icon: LucideIcon
  onClick: () => void
  title?: string
  tint?: string
  iconColor?: string
  busy?: boolean
}

function Transcript({ messages, thinking }: { messages: Message[]; thinking: boolean }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages, thinking])
  return (
    <div className="space-y-3" aria-live="polite" aria-label="Conversation">
      {messages.map((m) => (
        <div key={m.id} className={cx('flex animate-rise', m.role === 'user' ? 'justify-end' : 'justify-start')}>
          <div className="max-w-[92%]">
            <div
              data-role={m.role}
              className={cx(
                'rounded-[22px] px-4 py-2.5 text-[15px] leading-relaxed shadow-[0_4px_14px_-8px_rgba(23,52,61,0.25)]',
                m.role === 'user'
                  ? 'rounded-br-md bg-[#dcebf5]/95 text-ink'
                  : m.meta?.recovery
                    ? 'rounded-bl-md bg-[#fbe2cb]/90 text-ink'
                    : m.meta?.final && m.meta?.status === 'COMPLETED'
                      ? 'rounded-bl-md bg-[#d9eee0]/90 text-ink'
                      : 'rounded-bl-md bg-white/80 text-ink',
              )}
            >
              {m.text}
            </div>
            {m.role === 'assistant' && m.run_id && m.meta?.run_id === m.run_id && <PlanCard runId={m.run_id} />}
          </div>
        </div>
      ))}
      {thinking && (
        <div className="flex gap-1.5 px-4 py-2" aria-label="AURA is thinking">
          {[0, 1, 2].map((i) => (
            <span key={i} className="size-1.5 animate-bounce rounded-full bg-ink-mute" style={{ animationDelay: `${i * 120}ms` }} />
          ))}
        </div>
      )}
      <div ref={end} />
    </div>
  )
}

/** Home assistant: greeting, orb, one input bar, two-column quick actions, then any extra content. */
export function CenteredAssistant({
  convo,
  greeting,
  subtitle,
  chips,
  extra,
}: {
  convo: ReturnType<typeof useConversation>
  greeting: React.ReactNode
  subtitle: React.ReactNode
  chips: Chip[]
  extra?: React.ReactNode
}) {
  const { messages, thinking, error, send, reset } = convo
  const [text, setText] = useState('')
  const voice = useSpeechInput((t) => {
    setText('')
    send(t)
  })
  const empty = messages.length === 0 && !thinking

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
    <section aria-label="Talk to AURA" className="flex w-full flex-col items-center">
      <div className="flex flex-col items-center text-center">
        <h1 className="text-[29px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink sm:text-[32px]">{greeting}</h1>
        <p className="mt-2.5 max-w-[15rem] text-[15px] leading-snug text-ink">{subtitle}</p>
        <div className={cx('transition-all duration-500', empty ? 'mt-7 mb-5' : 'mt-5 mb-4')}>
          <Orb state={orbState} size={empty ? 156 : 92} />
        </div>
      </div>

      {!empty && (
        <div className="mb-5 w-full">
          <Transcript messages={messages} thinking={thinking} />
        </div>
      )}

      <form onSubmit={submit} className={cx('w-full', !empty && 'sticky bottom-24 z-10 lg:bottom-6')}>
        {(error || voice.error) && <div className="mb-3"><ErrorNote>{voice.error ?? error}</ErrorNote></div>}
        <div
          className={cx(
            'glass-strong flex h-[56px] items-center gap-1 rounded-full pl-2 pr-1.5 transition-all',
            voice.listening ? 'ring-2 ring-[#9fd8c0]' : 'focus-within:ring-2 focus-within:ring-[#f2b5c9]/70',
          )}
        >
          <button
            type="button"
            onClick={voice.listening ? voice.stop : voice.start}
            disabled={!voice.supported || thinking}
            className={cx(
              'grid size-10 shrink-0 place-items-center rounded-full transition',
              voice.listening ? 'bg-[#d9eee0] text-verified-deep' : 'bg-white/90 text-ink shadow-[0_1px_4px_rgba(23,52,61,0.12)] hover:bg-white',
              !voice.supported && 'cursor-not-allowed opacity-40',
            )}
            aria-label={voice.listening ? 'Stop listening' : 'Speak a request'}
            title={voice.supported ? 'Speak a request' : "Voice input isn't supported in this browser. Type instead."}
          >
            {voice.listening ? <MicOff className="size-5" strokeWidth={1.75} /> : <Mic className="size-5" strokeWidth={1.75} />}
          </button>
          <label htmlFor="ask" className="sr-only">
            Ask AURA
          </label>
          <input
            id="ask"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={voice.listening ? voice.interim || 'Listening…' : 'Ask AURA anything about your home...'}
            maxLength={500}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent px-1.5 py-2 text-[14px] text-ink placeholder:text-[13px] placeholder:text-ink-soft focus:outline-none"
          />
          <button
            type="submit"
            disabled={!text.trim() || thinking}
            className="grid size-[42px] shrink-0 place-items-center rounded-full bg-gradient-to-b from-[#f4a3b6] to-[#ec8aa3] text-white shadow-[0_6px_14px_-6px_rgba(220,110,140,0.8)] transition hover:brightness-105 disabled:opacity-60"
            aria-label="Send"
          >
            <ArrowUp className="size-5" strokeWidth={2} />
          </button>
        </div>
      </form>

      <div className="mt-4 grid w-full grid-cols-2 gap-2.5 px-1" aria-label="Quick actions">
        {chips.map(({ label, icon: Icon, onClick, title, tint, iconColor, busy }) => (
          <button
            key={label}
            type="button"
            onClick={onClick}
            disabled={busy || thinking}
            title={title}
            className={cx(
              'flex h-[46px] items-center justify-center gap-2.5 rounded-[16px] border border-white/80 px-3 text-left text-[13px] font-medium text-ink shadow-[0_6px_18px_-12px_rgba(23,52,61,0.3)] backdrop-blur-xl transition active:scale-[0.98] disabled:opacity-50',
              tint ?? 'bg-white/60',
              'hover:brightness-[1.02]',
            )}
          >
            <Icon className={cx('size-[18px] shrink-0', iconColor ?? 'text-ink')} strokeWidth={1.6} aria-hidden />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>

      {!empty && (
        <button
          type="button"
          onClick={reset}
          title="Start a new conversation. Saved memory is kept."
          className="mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-soft hover:bg-white/50 hover:text-ink"
        >
          <RefreshCw className="size-3.5" aria-hidden /> New session
        </button>
      )}

      {extra && <div className="mt-4 w-full">{extra}</div>}
    </section>
  )
}
