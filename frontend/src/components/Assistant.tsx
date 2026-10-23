import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUp, Loader2, Mic, MicOff, RefreshCw, ShieldCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api } from '../lib/api'
import { useAura, useAuraEvents } from '../lib/aura'
import { normalizeWake, speakAsync, speechFinished, useSpeechInput, useWakeWord } from '../lib/speech'
import type { Message, Run } from '../lib/types'
import { RUN_STATUS_LABEL, runTone } from '../lib/format'
import { AuraOrb, useOrbState } from './Orb'
import type { OrbState } from './Orb'
import { useLiveRun } from '../lib/useLiveRun'
import { useMediaQuery } from '../lib/useMediaQuery'
import { Badge, Button, ErrorNote, ReminderWhen, StatusIcon, cx } from './ui'

export function useConversation() {
  const { sessionId, ensureSession, newSession, toast } = useAura()
  const [messages, setMessages] = useState<Message[]>([])
  const [thinking, setThinking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (sid: string) => {
    try {
      const { messages } = await api.messages(sid)
      setMessages(messages)
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  // Tracks the session synchronously: a fast run can finish (and stream its reply) before React
  // re-renders with a newly created session id.
  const sessionRef = useRef<string | null>(sessionId)
  useEffect(() => {
    sessionRef.current = sessionId
    if (sessionId) load(sessionId)
    else setMessages([])
  }, [sessionId, load])

  useAuraEvents((e) => {
    const sid = sessionRef.current
    if (e.type === 'message' && sid && e.data.session_id === sid) {
      setMessages((prev) => (prev.some((m) => m.id === e.data.id) ? prev : [...prev, e.data as Message]))
    }
    // Belt and braces: re-read the transcript when any run finishes, in case an event was missed.
    if (e.type === 'run.finished' && sid) load(sid)
  })

  const send = useCallback(
    async (text: string, opts?: { source: 'voice'; transcript: string }): Promise<Message | null> => {
      const trimmed = text.trim()
      if (!trimmed) return null
      setError(null)
      setThinking(true)
      try {
        const sid = await ensureSession()
        sessionRef.current = sid
        const res = await api.chat(sid, trimmed, opts)
        await load(res.session_id)
        return res.message
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
              <ReminderWhen step={s} />
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
          Planned by local rules (no LLM)
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
  const list = useRef<HTMLDivElement>(null)
  // Follow the newest message unless the reader has scrolled up to read something older.
  const pinned = useRef(true)
  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    end.current?.scrollIntoView({ behavior, block: 'end' })
  }, [])
  useEffect(() => {
    pinned.current = true
    scrollToEnd('smooth')
  }, [messages, thinking, scrollToEnd])
  useEffect(() => {
    const atEnd = () => {
      const el = end.current
      if (!el) return true
      // The end marker's scroll-margin reserves room for the sticky input bar, so "at the end" means the
      // marker sits within that margin of the viewport bottom.
      const margin = parseFloat(getComputedStyle(el).scrollMarginBottom) || 0
      return el.getBoundingClientRect().bottom <= window.innerHeight - margin + 48
    }
    const onScroll = () => {
      if (atEnd()) pinned.current = true
    }
    // Only the reader scrolling up releases the pin. Layout shifts (the typing dots disappearing, the orb
    // shrinking) also move the scroll position, so scroll direction alone can't tell them apart.
    const release = () => {
      window.setTimeout(() => {
        if (!atEnd()) pinned.current = false
      }, 50)
    }
    const onWheel = (e: WheelEvent) => e.deltaY < 0 && release()
    const onKey = (e: KeyboardEvent) => ['ArrowUp', 'PageUp', 'Home'].includes(e.key) && release()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('touchmove', release, { passive: true })
    window.addEventListener('keydown', onKey)
    // Plan cards load after their message renders and grow the transcript; keep the newest content in view.
    const ro = new ResizeObserver(() => pinned.current && scrollToEnd('auto'))
    if (list.current) ro.observe(list.current)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('touchmove', release)
      window.removeEventListener('keydown', onKey)
      ro.disconnect()
    }
  }, [scrollToEnd])
  return (
    <div ref={list} className="space-y-3" aria-live="polite" aria-label="Conversation">
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
      {/* Scroll margin = sticky input bar (56/64 px) + its offset from the viewport bottom + breathing room. */}
      <div ref={end} data-testid="transcript-end" className="scroll-mb-[176px] lg:scroll-mb-[112px]" />
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
  const { handsFree, voiceReplies } = useAura()
  const [text, setText] = useState('')
  // While a spoken request is in flight (and while AURA answers the wake word), hands-free listening pauses.
  const [wakeBusy, setWakeBusy] = useState(false)
  async function sendVoice(t: string) {
    setWakeBusy(true)
    try {
      const reply = await send(normalizeWake(t), { source: 'voice', transcript: t })
      if (reply?.meta?.listen || reply?.meta?.intent === 'clarify') {
        // "Yes, Jahari?" or a question back ("What should I remind you about?"): say it (the provider already does
        // when voice replies are on), then listen for the answer so a spoken conversation can carry on.
        if (!voiceReplies) await speakAsync(reply.text, { interrupt: false })
        await speechFinished()
        voice.start()
      }
    } finally {
      setWakeBusy(false)
    }
  }
  const voice = useSpeechInput((t) => {
    setText('')
    void sendVoice(t)
  })
  const wake = useWakeWord(handsFree && !voice.listening && !thinking && !wakeBusy, (command) => {
    void sendVoice(command ? `Aura, ${command}` : 'Aura')
  })
  const empty = messages.length === 0 && !thinking

  // The orb follows the latest workflow in this conversation, live from the event stream.
  const lastRunId = [...messages].reverse().find((m) => m.run_id)?.run_id ?? null
  const liveRun = useLiveRun(lastRunId)
  const orbState: OrbState = useOrbState(liveRun, { listening: voice.listening, thinking })
  const desktop = useMediaQuery('(min-width: 1024px)')

  function submit(e?: React.FormEvent) {
    e?.preventDefault()
    const t = text
    setText('')
    send(t)
  }

  return (
    <section aria-label="Talk to AURA" className="flex w-full flex-col items-center">
      <div className="flex flex-col items-center text-center">
        <h1 className="text-[29px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink sm:text-[32px] lg:text-[42px]">{greeting}</h1>
        <p className="mt-2.5 max-w-[15rem] text-[15px] leading-snug text-ink lg:max-w-none lg:text-[18px] lg:text-ink-soft">{subtitle}</p>
        <div className={cx('transition-all duration-500', empty ? 'mt-6 mb-4' : 'mt-4 mb-3')}>
          <AuraOrb state={orbState} size={empty ? (desktop ? 176 : 156) : desktop ? 112 : 92} />
        </div>
        <p className="sr-only" aria-live="polite">{orbState === 'idle' ? '' : orbState}</p>
      </div>

      {!empty && (
        <div className="mb-5 w-full">
          <Transcript messages={messages} thinking={thinking} />
        </div>
      )}

      <form onSubmit={submit} className={cx('w-full', !empty && 'sticky bottom-24 z-10 lg:bottom-6')}>
        {(error || voice.error || wake.error) && <div className="mb-3"><ErrorNote>{voice.error ?? wake.error ?? error}</ErrorNote></div>}
        <div
          className={cx(
            'glass-strong flex h-[56px] items-center gap-1 rounded-full pl-2 pr-1.5 transition-[box-shadow,transform,background-color] duration-[240ms] ease-[var(--ease-ios)] lg:h-16 lg:pl-2.5 lg:pr-2',
            voice.listening ? 'ring-2 ring-[#9fd8c0]' : 'focus-within:-translate-y-px focus-within:bg-white/90 focus-within:shadow-[0_0_0_4px_rgba(242,181,201,0.35),0_18px_40px_-18px_rgba(23,52,61,0.35)]',
          )}
        >
          <button
            type="button"
            onClick={voice.listening ? voice.stop : voice.start}
            disabled={!voice.supported || thinking}
            className={cx(
              'grid size-10 shrink-0 place-items-center rounded-full transition duration-150 active:scale-90 lg:size-11',
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
            className="min-w-0 flex-1 bg-transparent px-1.5 py-2 text-[14px] text-ink placeholder:text-[13px] placeholder:text-ink-soft focus:outline-none lg:text-[16px] lg:placeholder:text-[16px]"
          />
          <button
            type="submit"
            disabled={!text.trim() || thinking}
            className="grid size-[42px] shrink-0 place-items-center rounded-full bg-gradient-to-b from-[#f4a3b6] to-[#ec8aa3] text-white shadow-[0_6px_14px_-6px_rgba(220,110,140,0.8)] transition duration-150 hover:brightness-105 active:scale-90 disabled:opacity-55 lg:size-12"
            aria-label="Send"
            aria-busy={thinking}
          >
            {thinking ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <ArrowUp className="size-5" strokeWidth={2} />}
          </button>
        </div>
        {handsFree && wake.supported && (
          <p className="mt-2 text-center text-[12px] text-ink-mute" aria-live="polite">
            {wake.active ? 'Hands-free: say "Aura" to start' : voice.listening ? 'Listening for your request…' : 'Hands-free paused'}
          </p>
        )}
      </form>

      <div className="mt-4 grid w-full grid-cols-2 gap-2.5 px-1 lg:mt-5 lg:grid-cols-4 lg:gap-3 lg:px-0" aria-label="Quick actions">
        {chips.map(({ label, icon: Icon, onClick, title, tint, iconColor, busy }) => (
          <button
            key={label}
            type="button"
            onClick={onClick}
            disabled={busy || thinking}
            title={title}
            className={cx(
              'pressable flex h-[46px] items-center justify-center gap-2.5 rounded-[16px] border border-white/80 px-3 text-left text-[13px] font-medium text-ink shadow-[0_6px_18px_-12px_rgba(23,52,61,0.3)] backdrop-blur-xl hover:-translate-y-px disabled:opacity-50 lg:h-[52px] lg:text-[15px]',
              tint ?? 'bg-white/60',
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
