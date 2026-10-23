import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, ChevronRight, Download, Pencil, Play, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react'
import { Badge, Button, Empty, ErrorNote, SectionTitle } from '../components/ui'
import { api } from '../lib/api'
import { useAura, useAuraEvents } from '../lib/aura'
import { timeAgo } from '../lib/format'
import type { Preference, Reminder, Routine } from '../lib/types'

const ROUTINE_UTTERANCE: Record<string, string> = {
  overnight_shift: 'Alexa, prepare the house before my overnight shift.',
  bedtime: 'Get everything prepared for bedtime.',
  leaving_home: 'Make sure the apartment is ready before I leave.',
}

function PrefRow({ pref, onSaved }: { pref: Preference; onSaved: () => void }) {
  const { toast } = useAura()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(String(pref.value))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const numeric = typeof pref.value === 'number'
  const unit = pref.unit && pref.unit !== 'time' ? pref.unit : ''

  useEffect(() => setValue(String(pref.value)), [pref.value])

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
      onSaved()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[15px]">{pref.label}</div>
          <div className="truncate text-[12px] text-ink-mute">
            Updated {timeAgo(pref.updated_at)} · by {pref.source} · <span className="font-mono">{pref.key}</span>
          </div>
        </div>
        {editing ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              save()
            }}
          >
            <label className="sr-only" htmlFor={`pref-${pref.key}`}>{pref.label}</label>
            <input
              id={`pref-${pref.key}`}
              autoFocus
              type={numeric ? 'number' : pref.unit === 'time' ? 'time' : 'text'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-8 w-32 rounded-[10px] bg-white/[0.08] px-3 text-sm focus:outline-none focus:ring-2 focus:ring-lav-300/50"
            />
            <Button size="sm" variant="primary" type="submit" busy={busy}>Save</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => { setEditing(false); setValue(String(pref.value)); setError(null) }}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-0.5">
            <span className="mr-2 text-[17px] tabular-nums text-ink-soft">
              {String(pref.value)}
              {unit && <span className="text-ink-mute">{unit}</span>}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label={`Edit ${pref.label}`}>
              <Pencil className="size-3.5" />
            </Button>
            <Button size="sm" variant="ghost" onClick={reset} busy={busy} aria-label={`Reset ${pref.label} to default`} title="Reset to default">
              <RotateCcw className="size-3.5" />
            </Button>
          </div>
        )}
      </div>
      {error && <div className="mt-2"><ErrorNote>{error}</ErrorNote></div>}
    </li>
  )
}

function RoutineCard({ routine, prefs }: { routine: Routine; prefs: Preference[] }) {
  const navigate = useNavigate()
  const { ensureSession, toast } = useAura()
  const [busy, setBusy] = useState(false)
  const byKey = Object.fromEntries(prefs.map((p) => [p.key, p]))
  const render = (t: string) =>
    t.split(/(\{pref:[a-z_]+\})/g).map((part, i) => {
      const m = part.match(/^\{pref:([a-z_]+)\}$/)
      if (!m) return <span key={i}>{part}</span>
      return (
        <span key={i} className="rounded-md bg-lav-300/12 px-1.5 py-px font-medium text-lav-300" title={`From memory: ${m[1]}`}>
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
    <div className="card overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-4">
        <div>
          <div className="text-[17px] font-semibold tracking-tight">{routine.name}</div>
          <p className="text-[13px] text-ink-mute">{routine.description}</p>
        </div>
        <Button size="sm" onClick={run} busy={busy}>
          <Play className="size-3.5" /> Plan it
        </Button>
      </div>
      <ol className="group-list border-t border-white/[0.08] text-[15px] text-ink-soft">
        {routine.steps.map((s, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white/[0.08] text-[12px] font-medium text-ink-mute">{i + 1}</span>
            <span>{render(s.title)}</span>
          </li>
        ))}
      </ol>
      <p className="border-t border-white/[0.08] px-4 py-3 text-[12px] leading-relaxed text-ink-mute">
        Triggers: {routine.triggers.map((t) => `“${t}”`).join(', ')}. Highlighted values are filled from your
        preferences each time the routine is planned.
      </p>
    </div>
  )
}

export default function Memory() {
  const { toast } = useAura()
  const [prefs, setPrefs] = useState<Preference[]>([])
  const [routines, setRoutines] = useState<Routine[]>([])
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [error, setError] = useState<string | null>(null)
  const [confirmForget, setConfirmForget] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api.memory().then((m) => {
      setPrefs(m.preferences)
      setRoutines(m.routines)
      setReminders(m.reminders)
    }).catch((e) => setError(e.message))
  }, [])
  useEffect(load, [load])
  useAuraEvents((e) => {
    if (e.type === 'run.finished') load()
  })

  const categories = [...new Set(prefs.map((p) => p.category))]

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
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="px-1">
        <h1 className="text-[34px] font-bold leading-tight tracking-tight">Memory</h1>
        <p className="mt-1 text-[17px] text-ink-soft">What AURA remembers about your home.</p>
        <p className="mt-1 max-w-2xl text-[13px] text-ink-mute">
          Structured memory, not chat history. Edit anything here; routines pick up changes the next time they're
          planned, in any session.
        </p>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section className="space-y-6" aria-labelledby="prefs-title">
          <h2 id="prefs-title" className="sr-only">Preferences</h2>
          {categories.map((c) => (
            <div key={c}>
              <SectionTitle>{c}</SectionTitle>
              <ul className="card group-list overflow-hidden">
                {prefs.filter((p) => p.category === c).map((p) => (
                  <PrefRow key={p.key} pref={p} onSaved={load} />
                ))}
              </ul>
            </div>
          ))}
        </section>

        <div className="space-y-8">
          <section aria-labelledby="routines-title">
            <SectionTitle id="routines-title">Routines</SectionTitle>
            <div className="space-y-4">
              {routines.map((r) => (
                <RoutineCard key={r.id} routine={r} prefs={prefs} />
              ))}
            </div>
          </section>

          <section aria-labelledby="rem-title">
            <SectionTitle id="rem-title" action={<Badge tone="mute">Simulated delivery</Badge>}>
              Reminders
            </SectionTitle>
            {reminders.length === 0 ? (
              <Empty>No reminders yet.</Empty>
            ) : (
              <ul className="card group-list overflow-hidden">
                {reminders.map((r) => (
                  <li key={r.reminder_id} className="flex items-center gap-3 px-4 py-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-failed/80 text-white">
                      <Bell className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px]">{r.title}{r.due && <span className="text-ink-mute"> · {r.due}</span>}</div>
                      <div className="truncate text-[12px] text-ink-mute">{r.note}</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => removeReminder(r.reminder_id)} aria-label={`Delete reminder ${r.title}`}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="privacy-title">
            <SectionTitle id="privacy-title">Privacy</SectionTitle>
            <div className="card group-list overflow-hidden">
              <div className="flex items-start gap-3 px-4 py-3.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-verified/80 text-night-950">
                  <ShieldCheck className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 text-[15px]">
                  Stored locally
                  <p className="mt-0.5 text-[12px] leading-relaxed text-ink-mute">
                    Memory and history live in a SQLite file on the machine running AURA. When Amazon Bedrock planning
                    is enabled, your request text plus the device list, routine names and preferences needed to plan
                    are sent to Bedrock in your AWS account. In local mode nothing leaves this machine.
                  </p>
                </div>
              </div>
              <a href="/api/memory/export" download className="flex items-center gap-3 px-4 py-3 text-[15px] text-lav-300 hover:bg-white/[0.04]">
                <Download className="size-4" /> Export my data
                <ChevronRight className="ml-auto size-4 text-ink-mute/70" />
              </a>
              {!confirmForget ? (
                <button onClick={() => setConfirmForget(true)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-[15px] text-failed hover:bg-white/[0.04]">
                  <Trash2 className="size-4" /> Forget everything
                </button>
              ) : (
                <div className="space-y-3 bg-failed/[0.06] px-4 py-3.5" role="alertdialog" aria-label="Confirm forget">
                  <p className="text-[13px] text-failed">Delete preferences, routines, reminders and history?</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="danger" onClick={forget} busy={busy}>Yes, delete</Button>
                    <Button size="sm" variant="secondary" onClick={() => setConfirmForget(false)}>Keep</Button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
