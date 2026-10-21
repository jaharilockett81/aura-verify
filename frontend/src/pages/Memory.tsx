import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Download, Pencil, Play, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react'
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
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{pref.label}</div>
          <div className="text-[11px] text-ink-mute">
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
              className="w-32 rounded-lg bg-night-950/70 px-3 py-1.5 text-sm ring-1 ring-white/15 focus:outline-none focus:ring-lav-400/50"
            />
            <Button size="sm" variant="primary" type="submit" busy={busy}>Save</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => { setEditing(false); setValue(String(pref.value)); setError(null) }}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-1">
            <span className="mr-2 font-display text-2xl text-lav-200">
              {String(pref.value)}
              {unit && <span className="text-base text-ink-mute">{unit}</span>}
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
        <span key={i} className="rounded bg-lav-400/15 px-1 font-semibold text-lav-200" title={`From memory: ${m[1]}`}>
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
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-bold">{routine.name}</div>
          <p className="text-xs text-ink-mute">{routine.description}</p>
        </div>
        <Button size="sm" onClick={run} busy={busy}>
          <Play className="size-3.5" /> Plan it
        </Button>
      </div>
      <ol className="mt-3 space-y-1 text-sm text-ink-soft">
        {routine.steps.map((s, i) => (
          <li key={i} className="flex gap-2">
            <span className="w-4 shrink-0 text-right text-xs text-ink-mute">{i + 1}.</span>
            <span>{render(s.title)}</span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[11px] text-ink-mute">
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
    <div className="space-y-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-mute">Memory & preferences</p>
        <h1 className="font-display text-4xl">What AURA remembers about your home.</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Structured memory, not chat history. Edit anything here; routines pick up changes the next time they're
          planned, in any session.
        </p>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="card p-5" aria-labelledby="prefs-title">
          <SectionTitle id="prefs-title">Preferences</SectionTitle>
          {categories.map((c) => (
            <div key={c} className="mb-2">
              <div className="mt-2 text-xs font-bold text-lav-300">{c}</div>
              <ul className="divide-y divide-white/6">
                {prefs.filter((p) => p.category === c).map((p) => (
                  <PrefRow key={p.key} pref={p} onSaved={load} />
                ))}
              </ul>
            </div>
          ))}
        </section>

        <div className="space-y-6">
          <section aria-labelledby="routines-title">
            <SectionTitle id="routines-title">Routines</SectionTitle>
            <div className="space-y-3">
              {routines.map((r) => (
                <RoutineCard key={r.id} routine={r} prefs={prefs} />
              ))}
            </div>
          </section>

          <section className="card p-5" aria-labelledby="rem-title">
            <SectionTitle id="rem-title" action={<Badge tone="mute">simulated delivery</Badge>}>
              Reminders
            </SectionTitle>
            {reminders.length === 0 ? (
              <Empty>No reminders yet.</Empty>
            ) : (
              <ul className="divide-y divide-white/6">
                {reminders.map((r) => (
                  <li key={r.reminder_id} className="flex items-center gap-3 py-2.5">
                    <Bell className="size-4 text-lav-300" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">{r.title}{r.due && <span className="font-normal text-ink-mute"> · {r.due}</span>}</div>
                      <div className="truncate text-[11px] text-ink-mute">{r.note}</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => removeReminder(r.reminder_id)} aria-label={`Delete reminder ${r.title}`}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <section className="card p-5" aria-labelledby="privacy-title">
        <SectionTitle id="privacy-title">Privacy controls</SectionTitle>
        <div className="flex flex-wrap items-start gap-6">
          <div className="min-w-0 flex-1 space-y-1 text-sm text-ink-soft">
            <p className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-verified" aria-hidden />
              Memory and history are stored locally in a SQLite file on the machine running AURA.
            </p>
            <p className="pl-6 text-xs text-ink-mute">
              When Amazon Bedrock planning is enabled, your request text plus the device list, routine names and
              preferences needed to plan are sent to Bedrock in your AWS account. In local mode nothing leaves this
              machine.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href="/api/memory/export" download className="inline-flex items-center gap-2 rounded-xl bg-white/6 px-4 py-2 text-sm font-semibold ring-1 ring-inset ring-white/10 hover:bg-white/10">
              <Download className="size-4" /> Export my data
            </a>
            {!confirmForget ? (
              <Button variant="danger" onClick={() => setConfirmForget(true)}>
                <Trash2 className="size-4" /> Forget everything
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-failed/10 p-2 ring-1 ring-failed/30" role="alertdialog" aria-label="Confirm forget">
                <span className="px-1 text-xs text-failed">Delete preferences, routines, reminders and history?</span>
                <Button size="sm" variant="danger" onClick={forget} busy={busy}>Yes, delete</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmForget(false)}>Keep</Button>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
