import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, BellOff, CheckCircle2, Pause, Play, ShieldCheck, Timer as TimerIcon, Wrench, X } from 'lucide-react'
import { api } from '../lib/api'
import { useAura, useAuraEvents } from '../lib/aura'
import { clock } from '../lib/format'
import type { Tone } from '../lib/format'
import { speakAsync } from '../lib/speech'
import type { Delivery, Reminder, ReminderOutcome, Timer } from '../lib/types'
import { Badge, Button, cx } from './ui'

// ----- labels --------------------------------------------------------------------------------------------
export const OUTCOME: Record<ReminderOutcome, { label: string; tone: Tone; hint: string }> = {
  OPEN: { label: 'Open', tone: 'mute', hint: 'Not done yet.' },
  USER_CONFIRMED: { label: 'Confirmed by you', tone: 'lav', hint: 'You said it was done. AURA can’t observe this task.' },
  VERIFIED: { label: 'Verified', tone: 'verified', hint: 'An independent device read confirmed it.' },
  MISMATCH: { label: 'Not done', tone: 'failed', hint: 'An independent device read shows it isn’t done.' },
  UNKNOWN: { label: 'Couldn’t check', tone: 'unknown', hint: 'The device couldn’t be read.' },
  RECOVERING: { label: 'Fix pending', tone: 'recover', hint: 'A fix is planned and waiting on its run.' },
  DISMISSED: { label: 'Dismissed', tone: 'mute', hint: 'Closed without marking it done.' },
}

export const DELIVERY: Record<Delivery['status'], { label: string; tone: Tone }> = {
  NOT_DUE: { label: 'Not due yet', tone: 'mute' },
  NO_ALERT: { label: 'No alert (no time set)', tone: 'mute' },
  PENDING: { label: 'Alert sent to tab', tone: 'lav' },
  DELIVERED_IN_APP: { label: 'Shown in app', tone: 'verified' },
  UNCONFIRMED: { label: 'Alert unconfirmed', tone: 'recover' },
  NOT_DELIVERED: { label: 'Missed: app closed', tone: 'failed' },
}

// ----- data hooks ------------------------------------------------------------------------------------------
export function useReminders() {
  const [reminders, setReminders] = useState<Reminder[]>([])
  const load = useCallback(() => {
    api.reminders().then((r) => setReminders(r.reminders)).catch(() => undefined)
  }, [])
  useEffect(load, [load])
  useAuraEvents((e) => {
    if (e.type.startsWith('reminder.') || e.type === 'run.finished') load()
  })
  return { reminders, reload: load }
}

export function useTimers() {
  const [timers, setTimers] = useState<Timer[]>([])
  const [now, setNow] = useState(() => Date.now())
  const load = useCallback(() => {
    api.timers().then((r) => setTimers(r.timers)).catch(() => undefined)
  }, [])
  useEffect(load, [load])
  useAuraEvents((e) => {
    if (e.type.startsWith('timer.') || e.type === 'run.finished' || e.type === 'tool.call') load()
  })
  const anyRunning = timers.some((t) => t.status === 'running')
  useEffect(() => {
    if (!anyRunning) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [anyRunning])
  return { timers, reload: load, now }
}

/** Remaining seconds: counted down locally from the server's end time, never invented. */
export function remaining(t: Timer, now: number) {
  if (t.status === 'running' && t.ends_at) return Math.max(0, (Date.parse(t.ends_at) - now) / 1000)
  return t.remaining_s
}

export function mmss(seconds: number) {
  const s = Math.ceil(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

// ----- evidence history ------------------------------------------------------------------------------------
export function HistoryList({ entries, label }: { entries: { at: string; summary: string; source?: string; kind?: string }[]; label: string }) {
  return (
    <ol className="space-y-2" aria-label={label}>
      {entries.map((h, i) => (
        <li key={i} className="flex gap-2.5 text-[12px] leading-snug lg:text-[13px]">
          <span
            className={cx(
              'mt-1.5 size-1.5 shrink-0 rounded-full',
              h.kind === 'verification' ? 'bg-verified' : h.kind === 'user' ? 'bg-lav-500' : h.kind === 'demo' ? 'bg-recover' : 'bg-ink-mute',
            )}
            aria-hidden
          />
          <span className="min-w-0 flex-1 text-ink-soft">
            <span className="font-mono text-[10px] text-ink-mute">
              {clock(h.at)}
              {h.source ? ` · ${h.source}` : ''}
            </span>
            <br />
            {h.summary}
          </span>
        </li>
      ))}
    </ol>
  )
}

// ----- the alert stack (shown on every page) --------------------------------------------------------------
type Alert = { kind: 'reminder'; id: string; missed: boolean } | { kind: 'timer'; id: string; missed: boolean }

/**
 * Reminders that come due and timers that finish while a tab is open. The tab confirms to the server that it
 * showed (and, with voice replies on, actually started speaking) the alert; anything missed while AURA was closed
 * is shown as missed, not as delivered.
 */
export function AlertCenter() {
  const { voiceReplies, sessionId, ensureSession, toast } = useAura()
  const navigate = useNavigate()
  const { reminders } = useReminders()
  const { timers } = useTimers()
  const [alerts, setAlerts] = useState<Alert[]>([])
  const spokenOutcome = useRef(new Map<string, string>())
  const voice = useRef(voiceReplies)
  voice.current = voiceReplies

  const announce = useCallback(async (text: string) => (voice.current ? speakAsync(text, { interrupt: false }) : false), [])

  // On load: anything still open from before (missed while closed, or awaiting this tab's confirmation).
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || (!reminders.length && !timers.length)) return
    seeded.current = true
    const open: Alert[] = []
    for (const r of reminders) {
      if (r.status !== 'due') continue
      open.push({ kind: 'reminder', id: r.reminder_id, missed: r.delivery.status === 'NOT_DELIVERED' })
      if (r.delivery.status === 'PENDING' || r.delivery.status === 'UNCONFIRMED') void api.reminderDelivered(r.reminder_id, false)
    }
    for (const t of timers) {
      if (t.status !== 'finished') continue
      if (t.delivery.status === 'PENDING' || t.delivery.status === 'UNCONFIRMED') {
        open.push({ kind: 'timer', id: t.timer_id, missed: false })
        void api.timerDelivered(t.timer_id, false)
      }
    }
    if (open.length) setAlerts((a) => [...a, ...open.filter((o) => !a.some((x) => x.id === o.id))])
  }, [reminders, timers])

  useAuraEvents((e) => {
    if (e.type === 'reminder.due') {
      const r = e.data as unknown as Reminder
      setAlerts((a) => (a.some((x) => x.id === r.reminder_id) ? a : [...a, { kind: 'reminder', id: r.reminder_id, missed: false }]))
      void (async () => {
        const spoken = await announce(`Reminder: ${r.title}.`)
        await api.reminderDelivered(r.reminder_id, spoken).catch(() => undefined)
      })()
    }
    if (e.type === 'reminder.updated') {
      // Speak a verification result once, exactly as recorded in the reminder's evidence.
      const r = e.data as unknown as Reminder
      const last = [...r.history].reverse().find((h) => h.kind === 'verification')
      if (last && alerts.some((a) => a.id === r.reminder_id) && spokenOutcome.current.get(r.reminder_id) !== last.at) {
        spokenOutcome.current.set(r.reminder_id, last.at)
        void announce(last.summary.replace(/\(MCP verify_action\) /, ''))
      }
    }
    if (e.type === 'timer.finished') {
      const t = e.data as unknown as Timer
      setAlerts((a) => (a.some((x) => x.id === t.timer_id) ? a : [...a, { kind: 'timer', id: t.timer_id, missed: false }]))
      void (async () => {
        const spoken = await announce(`Your ${t.label === 'Timer' ? '' : `${t.label.toLowerCase()} `}timer is done.`)
        await api.timerDelivered(t.timer_id, spoken).catch(() => undefined)
      })()
    }
  })

  const close = (id: string) => setAlerts((a) => a.filter((x) => x.id !== id))
  async function act(id: string, fn: () => Promise<unknown>, closeAfter = true) {
    try {
      await fn()
      if (closeAfter) close(id)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  if (!alerts.length) return null
  return (
    <div className="pointer-events-none fixed inset-x-3 top-3 z-50 flex flex-col items-end gap-2.5 sm:inset-x-auto sm:right-5 sm:top-[68px] sm:w-[380px]">
      {alerts.map((a) => {
        if (a.kind === 'timer') {
          const t = timers.find((x) => x.timer_id === a.id)
          if (!t) return null
          return (
            <section key={a.id} role="alert" aria-label={`${t.label} timer finished`} className="glass-strong pointer-events-auto w-full animate-pop rounded-[22px] p-4">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[#ece8f4] text-[#6c64a0]" aria-hidden>
                  <TimerIcon className="size-5" strokeWidth={1.7} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold">{t.label === 'Timer' ? 'Timer' : `${t.label} timer`} is done</p>
                  <p className="mt-0.5 text-[12px] text-ink-mute">{mmss(t.duration_s)} timer · {DELIVERY[t.delivery.status]?.label}</p>
                </div>
                <button onClick={() => close(a.id)} aria-label="Dismiss timer alert" className="grid size-7 place-items-center rounded-full text-ink-mute hover:bg-white/70">
                  <X className="size-4" />
                </button>
              </div>
            </section>
          )
        }
        const r = reminders.find((x) => x.reminder_id === a.id)
        if (!r) return null
        const outcome = OUTCOME[r.outcome]
        const lastCheck = [...r.history].reverse().find((h) => h.kind === 'verification')
        const fixable = r.check && (r.outcome === 'MISMATCH' || r.outcome === 'UNKNOWN')
        return (
          <section key={a.id} role="alert" aria-label={`Reminder: ${r.title}`} className="glass-strong pointer-events-auto w-full animate-pop rounded-[22px] p-4">
            <div className="flex items-start gap-3">
              <span className={cx('grid size-10 shrink-0 place-items-center rounded-full', a.missed ? 'bg-[#fadbe2] text-[#c4475d]' : 'bg-[#fbe2cb] text-recover-deep')} aria-hidden>
                {a.missed ? <BellOff className="size-5" strokeWidth={1.7} /> : <Bell className="size-5" strokeWidth={1.7} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-medium text-ink-mute">{a.missed ? `Missed reminder · due ${r.due}` : `Reminder · ${r.due ?? 'now'}`}</p>
                <p className="text-[16px] font-semibold leading-snug">{r.title}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {r.check && <Badge tone={outcome.tone}>{outcome.label}</Badge>}
                  <Badge tone={DELIVERY[r.delivery.status]?.tone ?? 'mute'}>{DELIVERY[r.delivery.status]?.label ?? r.delivery.status}</Badge>
                </div>
                {lastCheck && <p className="mt-2 text-[13px] leading-snug text-ink-soft">{lastCheck.summary}</p>}
                {!r.check && <p className="mt-2 text-[12px] text-ink-mute">AURA can’t observe this task, so “Done” is recorded as confirmed by you.</p>}
              </div>
              <button onClick={() => close(a.id)} aria-label="Hide reminder" className="grid size-7 place-items-center rounded-full text-ink-mute hover:bg-white/70">
                <X className="size-4" />
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {fixable && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    act(a.id, async () => {
                      const sid = sessionId ?? (await ensureSession())
                      const res = await api.reminderFix(r.reminder_id, sid)
                      navigate(`/runs/${res.run.id}`)
                    })
                  }
                >
                  <Wrench className="size-3.5" /> Plan a fix
                </Button>
              )}
              {r.status !== 'closed' && (
                <Button size="sm" variant={fixable ? 'secondary' : 'primary'} onClick={() => act(a.id, () => api.reminderDone(r.reminder_id), !r.check)}>
                  {r.check ? <ShieldCheck className="size-3.5" /> : <CheckCircle2 className="size-3.5" />} {r.check ? 'I did it, check' : 'Done'}
                </Button>
              )}
              {r.status !== 'closed' && (
                <Button size="sm" variant="ghost" onClick={() => act(a.id, () => api.reminderSnooze(r.reminder_id, 10))}>
                  Snooze 10 min
                </Button>
              )}
              {r.status !== 'closed' ? (
                <Button size="sm" variant="ghost" onClick={() => act(a.id, () => api.reminderDismiss(r.reminder_id))}>
                  Dismiss
                </Button>
              ) : (
                <Button size="sm" variant="verified" onClick={() => close(a.id)}>
                  OK
                </Button>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

// ----- timers card (Home) ----------------------------------------------------------------------------------
export function TimersCard() {
  const { timers, now, reload } = useTimers()
  const { toast } = useAura()
  const [busy, setBusy] = useState<string | null>(null)
  const recentCutoff = Date.now() - 30 * 60 * 1000
  const shown = timers.filter((t) => ['created', 'running', 'paused'].includes(t.status) || (t.status === 'finished' && Date.parse(t.updated_at) > recentCutoff))
  async function op(t: Timer, o: 'start' | 'pause' | 'resume' | 'cancel') {
    setBusy(`${t.timer_id}:${o}`)
    try {
      const res = await api.timerOp(t.timer_id, o)
      if (res.verdict !== 'VERIFIED') toast(`The ${t.label} timer didn't read back as expected (${res.verdict}).`, 'error')
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(null)
    }
  }
  return (
    <section aria-labelledby="timers-title">
      <div className="mb-2.5 flex items-baseline justify-between px-1">
        <h2 id="timers-title" className="text-[17px] font-semibold tracking-tight lg:text-[20px]">Timers</h2>
        <span className="text-[12px] text-ink-mute">Local to AURA</span>
      </div>
      {shown.length === 0 ? (
        <p className="card rounded-[18px] px-4 py-3.5 text-[14px] text-ink-soft">No timers. Try “Set a pasta timer for 8 minutes.”</p>
      ) : (
        <ul className="card group-list overflow-hidden rounded-[18px]" aria-label="Timers">
          {shown.map((t) => {
            const left = remaining(t, now)
            const pct = t.duration_s ? Math.min(100, (1 - left / t.duration_s) * 100) : 0
            return (
              <li key={t.timer_id} className="flex animate-rise items-center gap-3 px-4 py-3" aria-label={`${t.label} timer, ${t.status}`}>
                <span className="relative grid size-10 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(#2e7a55 ${pct}%, rgba(23,52,61,0.08) 0)` }} aria-hidden>
                  <span className="grid size-8 place-items-center rounded-full bg-white">
                    <TimerIcon className="size-4 text-ink-soft" strokeWidth={1.7} />
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium leading-tight lg:text-[15px]">{t.label}</span>
                  <span className="mt-0.5 block text-[12px] text-ink-mute">
                    {t.status === 'finished'
                      ? `Finished · ${DELIVERY[t.delivery.status]?.label ?? ''}`
                      : t.status === 'created'
                        ? 'Not started'
                        : t.status === 'paused'
                          ? 'Paused'
                          : 'Running'}
                  </span>
                </span>
                <span className={cx('font-mono text-[17px] tabular-nums', t.status === 'paused' && 'text-ink-mute')} aria-label={`${Math.ceil(left)} seconds left`}>
                  {mmss(left)}
                </span>
                <span className="flex gap-1">
                  {t.status === 'created' && (
                    <IconBtn label={`Start ${t.label} timer`} busy={busy === `${t.timer_id}:start`} onClick={() => op(t, 'start')}>
                      <Play className="size-4" />
                    </IconBtn>
                  )}
                  {t.status === 'running' && (
                    <IconBtn label={`Pause ${t.label} timer`} busy={busy === `${t.timer_id}:pause`} onClick={() => op(t, 'pause')}>
                      <Pause className="size-4" />
                    </IconBtn>
                  )}
                  {t.status === 'paused' && (
                    <IconBtn label={`Resume ${t.label} timer`} busy={busy === `${t.timer_id}:resume`} onClick={() => op(t, 'resume')}>
                      <Play className="size-4" />
                    </IconBtn>
                  )}
                  {['created', 'running', 'paused'].includes(t.status) && (
                    <IconBtn label={`Cancel ${t.label} timer`} busy={busy === `${t.timer_id}:cancel`} onClick={() => op(t, 'cancel')}>
                      <X className="size-4" />
                    </IconBtn>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function IconBtn({ label, onClick, busy, children }: { label: string; onClick: () => void; busy?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
      className="pressable grid size-8 place-items-center rounded-full bg-white/85 text-ink-soft shadow-[0_1px_4px_rgba(23,52,61,0.12)] hover:text-ink disabled:opacity-50"
    >
      {children}
    </button>
  )
}
