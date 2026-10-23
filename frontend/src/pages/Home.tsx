import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BedDouble, DoorOpen, MoonStar, Thermometer, Zap } from 'lucide-react'
import { CenteredAssistant, useConversation } from '../components/Assistant'
import type { Chip } from '../components/Assistant'
import { DeviceStrip } from '../components/Devices'
import { Badge } from '../components/ui'
import { api } from '../lib/api'
import { useAura, useAuraEvents } from '../lib/aura'
import { RUN_STATUS_LABEL, greeting, runTone, timeAgo } from '../lib/format'
import type { Run } from '../lib/types'

export default function Home() {
  const convo = useConversation()
  const { toast } = useAura()
  const [name, setName] = useState<string>('')
  const [recent, setRecent] = useState<Run[]>([])
  const [issues, setIssues] = useState<any[]>([])
  const [busyDemo, setBusyDemo] = useState(false)

  const load = useCallback(() => {
    api.memory().then((m) => {
      setIssues(m.open_issues)
      setName(String(m.preferences.find((p) => p.key === 'user_name')?.value ?? ''))
    }).catch(() => undefined)
    api.runs().then((r) => setRecent(r.runs.slice(0, 4))).catch(() => undefined)
  }, [])
  useEffect(load, [load])
  useAuraEvents((e) => {
    if (e.type === 'run.finished' || e.type === 'run.created' || e.type === 'recovery.proposed') load()
  })

  async function failureDemo() {
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

  const chips: Chip[] = [
    { label: 'Bedtime', icon: BedDouble, onClick: () => convo.send('Get everything prepared for bedtime.') },
    { label: 'Leaving home', icon: DoorOpen, onClick: () => convo.send('Make sure the apartment is ready before I leave.') },
    { label: 'Overnight shift', icon: MoonStar, onClick: () => convo.send('Alexa, prepare the house before my overnight shift.') },
    { label: 'Check thermostat', icon: Thermometer, onClick: () => convo.send("What's the thermostat at?") },
    {
      label: 'Run failure demo',
      icon: Zap,
      tone: 'warn',
      busy: busyDemo,
      onClick: failureDemo,
      title:
        'Signature demo: resets the simulated home, puts the thermostat into an energy-saver hold, then plans your overnight routine. The hub will say OK to 72°F; watch AURA notice it did not happen.',
    },
  ]

  const greetingText = (
    <>
      {greeting()}
      {name && (
        <>
          , <span className="italic text-lav-300">{name}</span>
        </>
      )}
      . <span className="block text-ink-soft">How can I help?</span>
    </>
  )

  return (
    <div className="pb-6">
      <CenteredAssistant convo={convo} greeting={greetingText} chips={chips} />

      <div className="mx-auto mt-16 grid w-full max-w-4xl grid-cols-1 gap-8 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <section aria-labelledby="home-title">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="home-title" className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-mute">
              Household status
            </h2>
            <Badge tone="mute">simulated</Badge>
          </div>
          <DeviceStrip />
        </section>

        <section aria-labelledby="activity-title">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="activity-title" className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-mute">
              Recent activity
            </h2>
            <Link to="/history" className="text-xs font-semibold text-lav-300 hover:text-lav-200">
              All history
            </Link>
          </div>
          {issues.length > 0 && (
            <Link
              to={`/runs/${issues[0].run_id}`}
              className="mb-2 block rounded-2xl bg-recover/8 px-3.5 py-2.5 text-xs ring-1 ring-recover/20 hover:bg-recover/12"
            >
              <span className="font-bold text-recover">
                {issues.length} unresolved issue{issues.length > 1 ? 's' : ''}
              </span>
              <span className="text-ink-soft"> · {issues[0].title} ({issues[0].status.toLowerCase()})</span>
            </Link>
          )}
          {recent.length === 0 ? (
            <p className="rounded-2xl px-3.5 py-3 text-sm text-ink-mute ring-1 ring-white/6">
              Nothing yet. Try a chip above.
            </p>
          ) : (
            <ul className="space-y-1">
              {recent.map((r) => (
                <li key={r.id}>
                  <Link
                    to={`/runs/${r.id}`}
                    className="flex items-center gap-3 rounded-2xl px-3.5 py-2.5 transition hover:bg-white/[0.04]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{r.summary}</span>
                      <span className="block truncate text-xs text-ink-mute">{timeAgo(r.created_at)}</span>
                    </span>
                    <Badge tone={runTone(r.status)}>{RUN_STATUS_LABEL[r.status]}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
