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
  tone?: 'default' | 'warn'
  busy?: boolean
}

function Transcript({ messages, thinking }: { messages: Message[]; thinking: boolean }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages, thinking])
  return (
    <div className="space-y-4" aria-live="polite" aria-label="Conversation">
      {messages.map((m) => (
        <div key={m.id} className={cx('flex animate-rise', m.role === 'user' ? 'justify-end' : 'justify-start')}>
          <div className="max-w-[92%]">
            <div
              data-role={m.role}
              className={cx(
                'rounded-3xl px-4 py-2.5 text-[15px] leading-relaxed',
                m.role === 'user'
                  ? 'rounded-br-md bg-lav-300 text-night-950'
                  : m.meta?.recovery
                    ? 'rounded-bl-md bg-recover/12 text-ink'
                    : m.meta?.final && m.meta?.status === 'COMPLETED'
                      ? 'rounded-bl-md bg-verified/10 text-ink'
                      : 'rounded-bl-md bg-white/[0.07] text-ink',
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

/** Centered, Alexa+-inspired assistant: greeting, transcript, one input bar, action chips. */
export function CenteredAssistant({
  convo,
  greeting,
  chips,
}: {
  convo: ReturnType<typeof useConversation>
  greeting: React.ReactNode
  chips: Chip[]
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
    <section
      aria-label="Talk to AURA"
      className={cx(
        'mx-auto flex w-full max-w-2xl flex-col items-center transition-all duration-500',
        empty ? 'min-h-[calc(100vh-15rem)] justify-center' : 'pt-4',
      )}
    >
      <div className={cx('flex flex-col items-center text-center transition-all', empty ? 'gap-6' : 'gap-3')}>
        <Orb state={orbState} size={empty ? 64 : 40} />
        <h1 className={cx('font-display font-normal leading-[1.08] tracking-[-0.01em] text-ink', empty ? 'text-[44px] sm:text-[56px]' : 'text-[28px] sm:text-[32px]')}>
          {greeting}
        </h1>
        {empty && (
          <p className="max-w-md text-[15px] leading-relaxed text-ink-mute">
            Every action is checked against the device&apos;s actual state. You approve plans before anything runs.
          </p>
        )}
      </div>

      {!empty && (
        <div className="mt-8 w-full">
          <Transcript messages={messages} thinking={thinking} />
        </div>
      )}

      <form onSubmit={submit} className={cx('w-full', empty ? 'mt-10' : 'sticky bottom-20 z-10 mt-6 lg:bottom-6')}>
        {(error || voice.error) && <div className="mb-3"><ErrorNote>{voice.error ?? error}</ErrorNote></div>}
        <div
          className={cx(
            'material flex h-16 items-center gap-2 rounded-full p-2 pl-2.5 transition-all',
            'shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_20px_40px_-20px_rgba(0,0,0,0.75)]',
            voice.listening ? 'ring-2 ring-verified/40' : 'focus-within:border-white/20',
          )}
        >
          <button
            type="button"
            onClick={voice.listening ? voice.stop : voice.start}
            disabled={!voice.supported || thinking}
            className={cx(
              'grid size-11 shrink-0 place-items-center rounded-full transition',
              voice.listening ? 'bg-verified/20 text-verified' : 'bg-white/[0.07] text-ink-soft hover:bg-white/[0.12] hover:text-ink',
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
            placeholder={voice.listening ? voice.interim || 'Listening…' : 'Ask AURA'}
            maxLength={500}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent px-1 py-2.5 text-[17px] text-ink placeholder:text-ink-mute focus:outline-none"
          />
          <button
            type="submit"
            disabled={!text.trim() || thinking}
            className="grid size-11 shrink-0 place-items-center rounded-full bg-lav-300 text-night-950 transition hover:bg-lav-200 disabled:bg-white/[0.07] disabled:text-ink-mute"
            aria-label="Send"
          >
            <ArrowUp className="size-5" />
          </button>
        </div>
      </form>

      <div className="mt-5 flex w-full flex-wrap items-center justify-center gap-2" aria-label="Quick actions">
        {chips.map(({ label, icon: Icon, onClick, title, tone, busy }) => (
          <button
            key={label}
            type="button"
            onClick={onClick}
            disabled={busy || thinking}
            title={title}
            className={cx(
              'inline-flex h-9 items-center gap-2 rounded-full px-4 text-[13px] font-medium transition active:scale-[0.97] disabled:opacity-50',
              tone === 'warn'
                ? 'bg-recover/12 text-recover hover:bg-recover/18'
                : 'bg-white/[0.07] text-ink-soft hover:bg-white/[0.11] hover:text-ink',
            )}
          >
            <Icon className="size-4" strokeWidth={1.75} aria-hidden />
            {label}
          </button>
        ))}
        {!empty && (
          <button
            type="button"
            onClick={reset}
            title="Start a new conversation. Saved memory is kept."
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-ink-mute hover:text-ink"
          >
            <RefreshCw className="size-3.5" aria-hidden /> New session
          </button>
        )}
      </div>
    </section>
  )
}
