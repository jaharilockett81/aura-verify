import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, BedDouble, FlaskConical, Wrench, BriefcaseBusiness, CalendarClock, ChevronRight, Clock, Download, House, MessageSquareText, MoonStar, PawPrint, RotateCcw, ShieldCheck, Sun, Thermometer, Trash2, UserRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Badge, Button, ErrorNote, Expander, Segmented, SectionTitle, cx } from '../components/ui'
import { api } from '../lib/api'
import { useAura, useAuraEvents } from '../lib/aura'
import { DELIVERY, HistoryList, OUTCOME } from '../components/Alerts'
import { timeAgo } from '../lib/format'
import type { Preference, Reminder, Routine } from '../lib/types'

const ROUTINE_UTTERANCE: Record<string, string> = {
  overnight_shift: 'Alexa, prepare the house before my overnight shift.',
  bedtime: 'Get everything prepared for bedtime.',
  leaving_home: 'Make sure the apartment is ready before I leave.',
}

const PREF_ICON: Record<string, [LucideIcon, string]> = {
  bedtime_temperature_f: [Thermometer, 'text-[#d06a86]'],
  away_temperature_f: [Thermometer, 'text-[#d06a86]'],
  bedtime_light_level: [Sun, 'text-[#d9a24a]'],
  pet_feeding_time: [Clock, 'text-[#c9814a]'],
  pet_name: [PawPrint, 'text-[#c9814a]'],
  user_name: [UserRound, 'text-[#c9814a]'],
  overnight_shift_start: [CalendarClock, 'text-[#3f6f8c]'],
  overnight_shift_end: [CalendarClock, 'text-[#3f6f8c]'],
  quiet_hours: [MoonStar, 'text-[#6c64a0]'],
}

function RowIcon({ k }: { k: string }) {
  const [Icon, color] = PREF_ICON[k] ?? [Sun, 'text-ink-soft']
  return (
    <span className="grid size-9 shrink-0 place-items-center" aria-hidden>
      <Icon className={cx('size-[22px]', color)} strokeWidth={1.5} />
    </span>
  )
}

function fmt(pref: Preference) {
  const unit = pref.unit && pref.unit !== 'time' ? pref.unit : ''
  return { value: String(pref.value), unit }
}

function PrefRow({ pref, onSaved }: { pref: Preference; onSaved: () => void }) {
  const { toast } = useAura()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(String(pref.value))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const numeric = typeof pref.value === 'number'
  const { value: shown, unit } = fmt(pref)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => setValue(String(pref.value)), [pref.value])
  useEffect(() => {
    if (!editing) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(t)
  }, [editing])
  const cancel = () => {
    setEditing(false)
    setValue(String(pref.value))
    setError(null)
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await api.setPreference(pref.key, numeric ? Number(value) : value)
      setEditing(false)
      toast(`Saved: ${pref.label}`, 'success')
      onSaved()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  async function reset() {
    setBusy(true)
    try {
      await api.resetPreference(pref.key)
      toast(`Reset to default: ${pref.label}`, 'info')
      setEditing(false)
      onSaved()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => (editing ? cancel() : setEditing(true))}
        aria-label={`Edit ${pref.label}`}
        aria-expanded={editing}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-white/40 active:bg-white/60 lg:py-4"
      >
        <RowIcon k={pref.key} />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium leading-tight lg:text-[16px]">{pref.label}</span>
          <span className="mt-1 block truncate text-[12px] text-ink-soft" title={pref.key}>
            {pref.source === 'seed' ? 'Default setting' : `Set by ${pref.source}`}
          </span>
          <span className="block text-[12px] text-ink-mute">Updated {timeAgo(pref.updated_at)}</span>
        </span>
        <span className="shrink-0 text-[15px] font-medium tabular-nums text-ink lg:text-[16px]">
          {shown}
          {unit}
        </span>
        <ChevronRight className={cx('size-4 shrink-0 text-ink-mute transition-transform duration-200', editing && 'rotate-90')} aria-hidden />
      </button>
      <Expander open={editing}>
        <form
          className="flex flex-wrap items-center gap-2 px-4 pb-3.5 pl-16"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <label className="sr-only" htmlFor={`pref-${pref.key}`}>{pref.label}</label>
          <input
            id={`pref-${pref.key}`}
            ref={inputRef}
            type={numeric ? 'number' : pref.unit === 'time' ? 'time' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-9 w-32 rounded-[10px] border border-white bg-white/85 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#f2b5c9]"
          />
          <Button size="sm" variant="primary" type="submit" busy={busy}>Save</Button>
          <Button size="sm" variant="ghost" type="button" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={reset} busy={busy} aria-label={`Reset ${pref.label} to default`} title="Reset to default">
            <RotateCcw className="size-3.5" /> Default
          </Button>
          {error && <div className="w-full"><ErrorNote>{error}</ErrorNote></div>}
        </form>
      </Expander>
    </li>
  )
}

const ROUTINE_ICON: Record<string, [LucideIcon, string]> = {
  bedtime: [BedDouble, 'text-[#6c64a0]'],
  leaving_home: [House, 'text-[#3f6f8c]'],
  overnight_shift: [BriefcaseBusiness, 'text-[#3f6f8c]'],
}

function RoutineRow({ routine, prefs }: { routine: Routine; prefs: Preference[] }) {
  const navigate = useNavigate()
  const { ensureSession, toast } = useAura()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const byKey = Object.fromEntries(prefs.map((p) => [p.key, p]))
  const [Icon, color] = ROUTINE_ICON[routine.id] ?? [Sun, 'text-ink-soft']
  const render = (t: string) =>
    t.split(/(\{pref:[a-z_]+\})/g).map((part, i) => {
      const m = part.match(/^\{pref:([a-z_]+)\}$/)
      if (!m) return <span key={i}>{part}</span>
      return (
        <span key={i} className="rounded-md bg-[#dcebf5] px-1.5 py-px font-medium text-lav-200" title={`From memory: ${m[1]}`}>
          {String(byKey[m[1]]?.value ?? m[1])}
        </span>
      )
    })

  async function run() {
    setBusy(true)
    try {
      const sid = await ensureSession()
      const res = await api.chat(sid, ROUTINE_UTTERANCE[routine.id] ?? `Run my ${routine.name} routine`)
      if (res.run) navigate(`/runs/${res.run.id}`)
      else toast(res.message.text, 'info')
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-3.5">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${routine.name} steps`} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className="grid size-9 shrink-0 place-items-center" aria-hidden>
            <Icon className={cx('size-[22px]', color)} strokeWidth={1.5} />
          </span>
          <span className="min-w-0">
            <span className="block text-[15px] font-medium leading-tight lg:text-[16px]">{routine.name}</span>
            <span className="mt-0.5 block text-[12px] text-ink-mute">{routine.steps.length} steps</span>
            <span className="block truncate text-[12px] text-ink-soft">{routine.description}</span>
          </span>
        </button>
        <button
          onClick={run}
          disabled={busy}
          className="pressable h-7 shrink-0 rounded-full bg-white/85 px-3.5 text-[12px] font-medium text-ink shadow-[0_1px_4px_rgba(23,52,61,0.12)] hover:bg-white disabled:opacity-50"
          aria-label={`Plan ${routine.name}`}
        >
          {busy ? 'Planning…' : 'Plan'}
        </button>
      </div>
      <Expander open={open}>
        <div className="px-4 pb-4 pl-16">
          <ol className="space-y-1.5 text-[13px] text-ink-soft">
            {routine.steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-4 shrink-0 text-right text-ink-mute">{i + 1}.</span>
                <span>{render(s.title)}</span>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-mute">
            Triggers: {routine.triggers.map((t) => `“${t}”`).join(', ')}. Highlighted values are filled from your
            preferences each time the routine is planned.
          </p>
        </div>
      </Expander>
    </div>
  )
}

function ReminderRow({ reminder: r, onChanged, onDelete }: { reminder: Reminder; onChanged: () => void; onDelete: () => void }) {
  const { toast, sessionId, ensureSession } = useAura()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const outcome = OUTCOME[r.outcome]
  const delivery = DELIVERY[r.delivery.status]
  const fixable = !!r.check && (r.outcome === 'MISMATCH' || r.outcome === 'UNKNOWN')
  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key)
    try {
      await fn()
      onChanged()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(null)
    }
  }
  const when = r.due ? `${r.due}${r.due_at ? ` · ${new Date(r.due_at).toLocaleDateString(undefined, { weekday: 'short' })}` : ''}` : 'No time set'
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`Reminder ${r.title}`}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-white/40"
      >
        <span className="grid size-9 shrink-0 place-items-center" aria-hidden>
          <Bell className="size-[22px] text-[#7c6fa6]" strokeWidth={1.5} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium lg:text-[16px]">
            {r.title}
            <span className="font-normal text-ink-mute"> · {when}</span>
          </span>
          <span className="mt-1 flex flex-wrap gap-1.5">
            {(r.check || r.outcome !== 'OPEN') && <Badge tone={outcome.tone}>{outcome.label}</Badge>}
            <Badge tone={delivery?.tone ?? 'mute'}>{delivery?.label ?? r.delivery.status}</Badge>
            {r.check && r.outcome === 'OPEN' && <Badge tone="lav">Checked by device</Badge>}
          </span>
        </span>
        <ChevronRight className={cx('size-4 shrink-0 text-ink-mute transition-transform duration-200', open && 'rotate-90')} aria-hidden />
      </button>
      <Expander open={open}>
        <div className="space-y-3 px-4 pb-4 pl-16">
          <p className="text-[12px] text-ink-mute">
            {outcome.hint} {r.delivery.detail ?? ''}
          </p>
          <HistoryList entries={r.history} label={`Evidence for ${r.title}`} />
          <div className="flex flex-wrap gap-2">
            {fixable && (
              <Button size="sm" variant="primary" busy={busy === 'fix'} onClick={() => act('fix', async () => {
                const sid = sessionId ?? (await ensureSession())
                const res = await api.reminderFix(r.reminder_id, sid)
                navigate(`/runs/${res.run.id}`)
              })}>
                <Wrench className="size-3.5" /> Plan a fix
              </Button>
            )}
            {r.status === 'due' && (
              <Button size="sm" variant="secondary" busy={busy === 'done'} onClick={() => act('done', () => api.reminderDone(r.reminder_id))}>
                {r.check ? 'I did it, check' : 'Done'}
              </Button>
            )}
            {(r.status === 'due' || r.status === 'scheduled') && (
              <Button size="sm" variant="ghost" busy={busy === 'snooze'} onClick={() => act('snooze', () => api.reminderSnooze(r.reminder_id, 10))}>
                Snooze 10 min
              </Button>
            )}
            {r.status !== 'closed' && (
              <Button size="sm" variant="ghost" busy={busy === 'dismiss'} onClick={() => act('dismiss', () => api.reminderDismiss(r.reminder_id))}>
                Dismiss
              </Button>
            )}
            {(r.status === 'scheduled' || r.status === 'unscheduled') && (
              <Button size="sm" variant="warn" busy={busy === 'fire'} onClick={() => act('fire', () => api.fireReminder(r.reminder_id))} title="Demo control: make this reminder due now">
                <FlaskConical className="size-3.5" /> Make due now (demo)
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onDelete} aria-label={`Delete reminder ${r.title}`}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
      </Expander>
    </li>
  )
}

type Filter = 'all' | 'prefs' | 'routines' | 'people'
const PEOPLE = ['Profile', 'Pet care']

export default function Memory() {
  const { toast } = useAura()
  const [prefs, setPrefs] = useState<Preference[]>([])
  const [routines, setRoutines] = useState<Routine[]>([])
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [error, setError] = useState<string | null>(null)
  const [confirmForget, setConfirmForget] = useState(false)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')

  const load = useCallback(() => {
    api.memory().then((m) => {
      setPrefs(m.preferences)
      setRoutines(m.routines)
      setReminders(m.reminders)
    }).catch((e) => setError(e.message))
  }, [])
  useEffect(load, [load])
  useAuraEvents((e) => {
    if (e.type === 'run.finished' || e.type.startsWith('reminder.')) load()
  })

  const prefCategories = [...new Set(prefs.map((p) => p.category))].filter((c) => !PEOPLE.includes(c)).sort((a, b) => (a === 'Comfort' ? -1 : b === 'Comfort' ? 1 : 0))
  const people = prefs.filter((p) => PEOPLE.includes(p.category)).sort((a, b) => PEOPLE.indexOf(a.category) - PEOPLE.indexOf(b.category))
  const saved = prefs.filter((p) => p.source !== 'seed').sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const show = (f: Filter) => filter === 'all' || filter === f

  async function forget() {
    setBusy(true)
    try {
      const res = await api.forget()
      toast(res.message, 'success')
      setConfirmForget(false)
      load()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function removeReminder(id: string) {
    try {
      await api.deleteReminder(id)
      load()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <div className="mx-auto max-w-[560px] space-y-6 lg:max-w-[1080px]">
      <div className="px-1">
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight lg:text-[32px]">Memory</h1>
        <p className="mt-0.5 text-[15px] text-ink lg:text-[16px]">What AURA remembers about your home.</p>
      </div>

      <Segmented
        className="lg:max-w-[520px]"
        label="Filter memory"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'prefs', label: 'Preferences' },
          { value: 'routines', label: 'Routines' },
          { value: 'people', label: 'People' },
        ]}
      />
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className={cx('grid grid-cols-1 items-start gap-6', filter === 'all' && 'lg:grid-cols-2')}>
      <div className="min-w-0 space-y-6">
      {show('prefs') &&
        prefCategories.slice(0, 1).map((c) => (
          <section key={c} aria-label={c}>
            <SectionTitle>{c}</SectionTitle>
            <ul className="card group-list overflow-hidden">
              {prefs.filter((p) => p.category === c).map((p) => (
                <PrefRow key={p.key} pref={p} onSaved={load} />
              ))}
            </ul>
          </section>
        ))}

      {show('routines') && (
        <section aria-labelledby="routines-title">
          <SectionTitle id="routines-title">Routines</SectionTitle>
          <div className="card group-list overflow-hidden">
            {routines.map((r) => (
              <RoutineRow key={r.id} routine={r} prefs={prefs} />
            ))}
          </div>
        </section>
      )}

      {show('people') && people.length > 0 && (
        <section aria-label="People and pets">
          <SectionTitle>People &amp; pets</SectionTitle>
          <ul className="card group-list overflow-hidden">
            {people.map((p) => (
              <PrefRow key={p.key} pref={p} onSaved={load} />
            ))}
          </ul>
        </section>
      )}

      {show('prefs') &&
        prefCategories.slice(1).map((c) => (
          <section key={c} aria-label={c}>
            <SectionTitle>{c}</SectionTitle>
            <ul className="card group-list overflow-hidden">
              {prefs.filter((p) => p.category === c).map((p) => (
                <PrefRow key={p.key} pref={p} onSaved={load} />
              ))}
            </ul>
          </section>
        ))}

      </div>
      <div className="min-w-0 space-y-6">
      {show('prefs') && (
        <section aria-label="Saved by AURA">
          <SectionTitle>Saved by AURA</SectionTitle>
          {saved.length === 0 ? (
            <p className="card px-4 py-4 text-[14px] text-ink-soft">
              Nothing yet. Tell AURA a preference, like “I prefer my bedtime temperature at 70 degrees.”
            </p>
          ) : (
            <div className="card group-list overflow-hidden">
              {saved.map((p) => {
                const { value, unit } = fmt(p)
                return (
                  <div key={p.key} className="flex items-center gap-3 px-4 py-3.5">
                    <span className="grid size-9 shrink-0 place-items-center" aria-hidden>
                      <MessageSquareText className="size-[22px] text-verified-deep" strokeWidth={1.5} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] leading-snug">
                        {p.label}: {value}
                        {unit}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-ink-mute">
                        Saved {timeAgo(p.updated_at)} · by {p.source}
                      </span>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}

      {filter === 'all' && (
        <section aria-labelledby="rem-title">
          <SectionTitle id="rem-title" action={<Badge tone="mute">Alerts only in an open AURA tab</Badge>}>
            Reminders
          </SectionTitle>
          {reminders.length === 0 ? (
            <p className="card px-4 py-4 text-[14px] text-ink-soft">No reminders yet. Try “Remind me to lock the front door at 10 pm.”</p>
          ) : (
            <ul className="card group-list overflow-hidden">
              {reminders.map((r) => (
                <ReminderRow key={r.reminder_id} reminder={r} onChanged={load} onDelete={() => removeReminder(r.reminder_id)} />
              ))}
            </ul>
          )}
        </section>
      )}

      {filter === 'all' && (
        <section aria-labelledby="privacy-title">
          <SectionTitle id="privacy-title">Privacy</SectionTitle>
          <div className="card group-list overflow-hidden">
            <div className="flex items-start gap-3 px-4 py-3.5">
              <span className="grid size-9 shrink-0 place-items-center" aria-hidden>
                <ShieldCheck className="size-[22px] text-verified-deep" strokeWidth={1.5} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-medium">Stored locally</div>
                <p className="mt-0.5 text-[12px] leading-relaxed text-ink-mute">
                  Memory and history live in a SQLite file on the machine running AURA. When Amazon Bedrock planning is
                  enabled, your request text plus the device list, routine names and preferences needed to plan are
                  sent to Bedrock in your AWS account. In local mode nothing leaves this machine.
                </p>
              </div>
            </div>
            <a href="/api/memory/export" download className="flex items-center gap-3 px-4 py-3.5 text-[15px] font-medium text-lav-300 hover:bg-white/40">
              <span className="grid size-9 place-items-center"><Download className="size-5" strokeWidth={1.5} /></span> Export my data
              <ChevronRight className="ml-auto size-4 text-ink-mute" />
            </a>
            {!confirmForget ? (
              <button onClick={() => setConfirmForget(true)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-[15px] font-medium text-failed hover:bg-white/40">
                <span className="grid size-9 place-items-center"><Trash2 className="size-5" strokeWidth={1.5} /></span> Forget everything
              </button>
            ) : (
              <div className="space-y-3 bg-[#fadbe2]/50 px-4 py-3.5" role="alertdialog" aria-label="Confirm forget">
                <p className="text-[13px] text-[#c4475d]">Delete preferences, routines, reminders and history?</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="danger" onClick={forget} busy={busy}>Yes, delete</Button>
                  <Button size="sm" variant="secondary" onClick={() => setConfirmForget(false)}>Keep</Button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
      </div>
      </div>
    </div>
  )
}
