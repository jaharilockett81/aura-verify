import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { BedDouble, ChevronRight, DoorOpen, MoonStar, Play, Zap } from 'lucide-react'
import { Assistant, useConversation } from '../components/Assistant'
import { DeviceGrid } from '../components/Devices'
import { Badge, Button, Empty, SectionTitle } from '../components/ui'
import { api } from '../lib/api'
import { useAura, useAuraEvents } from '../lib/aura'
import { RUN_STATUS_LABEL, greeting, runTone, timeAgo } from '../lib/format'
import type { Routine, Run } from '../lib/types'

const ROUTINE_ICONS: Record<string, typeof MoonStar> = {
  overnight_shift: MoonStar,
  bedtime: BedDouble,
  leaving_home: DoorOpen,
}
const ROUTINE_UTTERANCE: Record<string, string> = {
  overnight_shift: 'Alexa, prepare the house before my overnight shift.',
  bedtime: 'Get everything prepared for bedtime.',
  leaving_home: 'Make sure the apartment is ready before I leave.',
}

export default function Home() {
  const convo = useConversation()
  const { toast } = useAura()
  const navigate = useNavigate()
  const [name, setName] = useState<string>('')
  const [routines, setRoutines] = useState<Routine[]>([])
  const [recent, setRecent] = useState<Run[]>([])
  const [issues, setIssues] = useState<any[]>([])
  const [busyDemo, setBusyDemo] = useState(false)

  const load = useCallback(() => {
    api.memory().then((m) => {
      setRoutines(m.routines)
      setIssues(m.open_issues)
      setName(String(m.preferences.find((p) => p.key === 'user_name')?.value ?? ''))
    }).catch(() => undefined)
    api.runs().then((r) => setRecent(r.runs.slice(0, 5))).catch(() => undefined)
  }, [])
  useEffect(load, [load])
  useAuraEvents((e) => {
    if (e.type === 'run.finished' || e.type === 'run.created' || e.type === 'recovery.proposed') load()
  })

  async function signatureDemo() {
    setBusyDemo(true)
    try {
      await api.resetDevices()
      await api.injectFault('thermostat', 'energy_saver_hold')
      toast('Demo control: simulated home reset; thermostat put into an energy-saver hold. AURA is not told.', 'info')
      await convo.send('Alexa, prepare the house before my overnight shift.')
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusyDemo(false)
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-ink-mute">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          <h1 className="font-display text-4xl leading-tight sm:text-5xl">
            {greeting()}
            {name && (
              <>
                , <span className="italic text-lav-300">{name}</span>
              </>
            )}
            .
          </h1>
          <p className="mt-1 max-w-xl text-ink-soft">
            I don't just act. I check that it actually happened, and tell you when it didn't.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Assistant convo={convo} />

        <div className="space-y-6">
          <section className="card relative overflow-hidden p-5" aria-labelledby="sig-title">
            <div className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full bg-recover/10 blur-2xl" />
            <div className="flex items-center gap-2">
              <Zap className="size-4 text-recover" aria-hidden />
              <h2 id="sig-title" className="text-sm font-bold">
                Signature demo: catch a silent failure
              </h2>
            </div>
            <p className="mt-2 text-sm text-ink-soft">
              Resets the simulated home, puts the thermostat into an energy-saver hold, then plans your overnight
              routine. The hub will say "OK" to 72°F. Watch AURA notice it didn't happen.
            </p>
            <Button variant="warn" className="mt-4 w-full" onClick={signatureDemo} busy={busyDemo}>
              <Play className="size-4" /> Run the thermostat failure demo
            </Button>
          </section>

          <section aria-labelledby="routines-title">
            <SectionTitle id="routines-title">Quick-start routines</SectionTitle>
            <div className="space-y-2">
              {routines.map((r) => {
                const Icon = ROUTINE_ICONS[r.id] ?? Play
                return (
                  <button
                    key={r.id}
                    onClick={() => convo.send(ROUTINE_UTTERANCE[r.id] ?? `Run my ${r.name} routine`)}
                    className="card group flex w-full items-center gap-3 p-3.5 text-left transition hover:border-lav-400/30"
                  >
                    <span className="grid size-10 place-items-center rounded-xl bg-lav-400/12 text-lav-300">
                      <Icon className="size-5" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">{r.name}</span>
                      <span className="block truncate text-xs text-ink-mute">
                        {r.steps.length} steps · {r.description}
                      </span>
                    </span>
                    <ChevronRight className="size-4 text-ink-mute transition group-hover:translate-x-0.5 group-hover:text-lav-300" />
                  </button>
                )
              })}
            </div>
          </section>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="card p-5" aria-labelledby="home-title">
          <SectionTitle id="home-title" action={<Badge tone="mute">simulated</Badge>}>
            Household status
          </SectionTitle>
          <DeviceGrid />
        </section>

        <section className="card p-5" aria-labelledby="activity-title">
          <SectionTitle
            id="activity-title"
            action={
              <Link to="/history" className="text-xs font-semibold text-lav-300 hover:text-lav-200">
                All history
              </Link>
            }
          >
            Recent activity
          </SectionTitle>
          {issues.length > 0 && (
            <div className="mb-3 rounded-xl bg-recover/8 p-3 ring-1 ring-recover/20">
              <div className="text-xs font-bold text-recover">AURA remembers {issues.length} unresolved issue{issues.length > 1 ? 's' : ''}</div>
              <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">
                {issues.slice(0, 3).map((i) => (
                  <li key={i.step_id}>
                    <Link to={`/runs/${i.run_id}`} className="hover:text-ink">
                      {i.title} · {i.status.toLowerCase()}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {recent.length === 0 ? (
            <Empty>No routines yet. Try one of the quick starts.</Empty>
          ) : (
            <ul className="divide-y divide-white/6">
              {recent.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => navigate(`/runs/${r.id}`)}
                    className="flex w-full items-center gap-3 py-2.5 text-left hover:text-lav-200"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{r.summary}</span>
                      <span className="block truncate text-xs text-ink-mute">“{r.utterance}” · {timeAgo(r.created_at)}</span>
                    </span>
                    <Badge tone={runTone(r.status)}>{RUN_STATUS_LABEL[r.status]}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
