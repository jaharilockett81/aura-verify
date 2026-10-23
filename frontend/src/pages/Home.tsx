import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BriefcaseBusiness, ChevronRight, House, Moon, Thermometer, Zap } from 'lucide-react'
import { CenteredAssistant, useConversation } from '../components/Assistant'
import type { Chip } from '../components/Assistant'
import { DeviceGrid } from '../components/Devices'
import { StatusIcon, cx } from '../components/ui'
import { api } from '../lib/api'
import { useAura, useAuraEvents } from '../lib/aura'
import { RUN_STATUS_LABEL, greeting, timeAgo } from '../lib/format'
import type { Run } from '../lib/types'

export default function Home() {
  const convo = useConversation()
  const { toast } = useAura()
  const [name, setName] = useState<string>('')
  const [recent, setRecent] = useState<Run[]>([])
  const [issues, setIssues] = useState<any[]>([])
  const [busyDemo, setBusyDemo] = useState(false)
  const [allDevices, setAllDevices] = useState(false)

  const load = useCallback(() => {
    api.memory().then((m) => {
      setIssues(m.open_issues)
      setName(String(m.preferences.find((p) => p.key === 'user_name')?.value ?? ''))
    }).catch(() => undefined)
    api.runs().then((r) => setRecent(r.runs.slice(0, 3))).catch(() => undefined)
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
    { label: 'Bedtime', icon: Moon, tint: 'bg-[#f6dfe9]/80', onClick: () => convo.send('Get everything prepared for bedtime.') },
    { label: 'Leaving home', icon: House, tint: 'bg-[#dcebf6]/80', iconColor: 'text-[#3f6f8c]', onClick: () => convo.send('Make sure the apartment is ready before I leave.') },
    { label: 'Overnight shift', icon: BriefcaseBusiness, tint: 'bg-[#e6e2f1]/80', iconColor: 'text-[#6c64a0]', onClick: () => convo.send('Alexa, prepare the house before my overnight shift.') },
    { label: 'Check thermostat', icon: Thermometer, tint: 'bg-[#f3e3ea]/80', iconColor: 'text-[#c0607c]', onClick: () => convo.send("What's the thermostat at?") },
  ]

  const failureCard = (
    <button
      type="button"
      onClick={failureDemo}
      disabled={busyDemo || convo.thinking}
      aria-label="Run failure demo"
      title="Signature demo: resets the simulated home, puts the thermostat into an energy-saver hold, then plans your overnight routine. The hub will say OK to 72°F; watch AURA notice it did not happen."
      className="flex w-full items-center gap-3.5 rounded-[20px] border border-white/80 bg-gradient-to-r from-[#fbe3e2]/90 via-[#fdeadd]/90 to-[#fef1d9]/90 px-3.5 py-3.5 text-left shadow-[0_10px_28px_-16px_rgba(200,120,110,0.55)] transition active:scale-[0.99] disabled:opacity-60"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-[#f9d0d8] shadow-[0_4px_10px_-6px_rgba(217,91,112,0.6)]">
        <Zap className="size-[22px] text-failed" strokeWidth={1.6} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-ink">{busyDemo ? 'Starting failure demo…' : 'Run failure demo'}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-ink-soft">See how AURA detects and recovers from device issues.</span>
      </span>
      <ChevronRight className="size-5 shrink-0 text-ink-soft" aria-hidden />
    </button>
  )

  return (
    <div className="mx-auto w-full max-w-[440px] pb-6">
      <CenteredAssistant
        convo={convo}
        greeting={
          <>
            {greeting()},<br />
            {name || 'there'}.
          </>
        }
        subtitle="Your home, thoughtfully looked after."
        chips={chips}
        extra={failureCard}
      />

      <section aria-labelledby="home-title" className="mt-7">
        <div className="mb-3 flex items-baseline justify-between px-1">
          <h2 id="home-title" className="text-[16px] font-semibold tracking-tight">
            Household status
          </h2>
          <button onClick={() => setAllDevices(!allDevices)} className="text-[13px] font-medium text-ink-soft hover:text-ink">
            {allDevices ? 'Show less' : 'See all'}
          </button>
        </div>
        <DeviceGrid all={allDevices} />
      </section>

      <section aria-labelledby="activity-title" className="mt-7">
        <div className="mb-3 flex items-baseline justify-between px-1">
          <h2 id="activity-title" className="text-[16px] font-semibold tracking-tight">
            Recent activity
          </h2>
          <Link to="/history" className="text-[13px] font-medium text-ink-soft hover:text-ink">
            See all
          </Link>
        </div>
        <div className="card group-list overflow-hidden">
          {issues.length > 0 && (
            <Link to={`/runs/${issues[0].run_id}`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-white/40">
              <StatusIcon status="FAILED" className="size-7" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">
                  {issues.length} unresolved issue{issues.length > 1 ? 's' : ''}: {issues[0].title}
                </span>
                <span className="block text-[12px] text-ink-mute">{issues[0].status.toLowerCase()}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-ink-mute" />
            </Link>
          )}
          {recent.length === 0 && issues.length === 0 ? (
            <p className="px-4 py-4 text-[14px] text-ink-soft">Nothing yet. Try one of the actions above.</p>
          ) : (
            recent.map((r) => (
              <Link key={r.id} to={`/runs/${r.id}`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-white/40">
                <RunDot status={r.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">
                    {RUN_STATUS_LABEL[r.status]}: {r.summary.replace(/^Run routine: /, '')}
                  </span>
                  <span className="block truncate text-[12px] text-ink-mute">{timeAgo(r.created_at)}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-ink-mute" />
              </Link>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

function RunDot({ status }: { status: Run['status'] }) {
  const map: Record<string, string> = {
    COMPLETED: 'VERIFIED',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
    COMPLETED_WITH_ISSUES: 'RECOVERING',
    PAUSED: 'AWAITING_APPROVAL',
    AWAITING_APPROVAL: 'AWAITING_APPROVAL',
    RUNNING: 'RUNNING',
  }
  return (
    <span className={cx('grid size-7 shrink-0 place-items-center rounded-full', status === 'COMPLETED' ? 'bg-forest' : 'bg-white/80')}>
      <StatusIcon status={map[status] as any} className={cx('size-[18px]', status === 'COMPLETED' && '!text-white')} />
    </span>
  )
}
