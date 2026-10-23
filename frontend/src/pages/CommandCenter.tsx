import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Info, ShieldCheck, Square, Volume2 } from 'lucide-react'
import { useDevices } from '../components/Devices'
import { AuraOrb, useOrbState } from '../components/Orb'
import { ProgressCard, RunReport, StepCard, ToolLog } from '../components/RunView'
import { Badge, Button, Empty, ErrorNote, Segmented, cx } from '../components/ui'
import { api } from '../lib/api'
import { useAura, useAuraEvents } from '../lib/aura'
import { RUN_STATUS_LABEL, clock, runTone } from '../lib/format'
import { speak } from '../lib/speech'
import type { AuraEvent, Run } from '../lib/types'

export default function CommandCenter() {
  const { runId } = useParams()
  const navigate = useNavigate()
  const { toast } = useAura()
  const [run, setRun] = useState<Run | null>(null)
  const [events, setEvents] = useState<AuraEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [noRuns, setNoRuns] = useState(false)
  const [panel, setPanel] = useState<'steps' | 'log'>('steps')
  const refetch = useRef<number | null>(null)
  const { devices } = useDevices()
  const orbState = useOrbState(run, {})
  const names = Object.fromEntries(devices.map((d) => [d.device_id, d.device_id === 'front_door' ? 'Front door' : d.name]))

  // /command without an id shows the most recent run.
  useEffect(() => {
    if (runId) return
    api.runs().then((r) => {
      if (r.runs[0]) navigate(`/runs/${r.runs[0].id}`, { replace: true })
      else setNoRuns(true)
    }).catch((e) => setError(e.message))
  }, [runId, navigate])

  const load = useCallback(() => {
    if (!runId) return
    api.run(runId).then((r) => {
      setRun(r)
      setError(null)
    }).catch((e) => setError(e.message))
    api.runEvents(runId).then((e) => setEvents(e.events)).catch(() => undefined)
  }, [runId])

  useEffect(() => {
    setRun(null)
    setEvents([])
    load()
  }, [load])

  useAuraEvents((e) => {
    if (e.run_id !== runId || e.seq === null) return
    if (e.type === 'tool.call') setEvents((prev) => (prev.some((p) => p.seq === e.seq) ? prev : [...prev, e]))
    // Coalesce bursts of step/evidence events into one refetch.
    if (refetch.current) window.clearTimeout(refetch.current)
    refetch.current = window.setTimeout(() => {
      api.run(runId!).then(setRun).catch(() => undefined)
    }, 60)
  })

  async function act(key: string, fn: () => Promise<Run>) {
    setBusy(key)
    try {
      setRun(await fn())
    } catch (e: any) {
      toast(e.message, 'error')
      load()
    } finally {
      setBusy(null)
    }
  }

  const title = (
    <div className="px-1">
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight">Command Center</h1>
      <p className="mt-0.5 text-[15px] text-ink">From plan to verified results.</p>
    </div>
  )

  if (noRuns)
    return (
      <div className="mx-auto max-w-[560px] space-y-6">
        {title}
        <Empty>
          No workflows yet. Head to <Link className="font-medium text-lav-300 underline" to="/">Home</Link> and ask AURA to run a routine.
        </Empty>
      </div>
    )
  if (error) return <ErrorNote>{error}</ErrorNote>
  if (!run) return <div className="py-20 text-center text-ink-mute">Loading workflow…</div>

  const finished = ['COMPLETED', 'COMPLETED_WITH_ISSUES', 'FAILED', 'CANCELLED'].includes(run.status)
  const verified = run.steps.filter((s) => s.status === 'VERIFIED').length
  const attention = (s: Run['steps'][number]) => s.recovery_options.length > 0 || s.status === 'AWAITING_APPROVAL'
  // Steps that need the user float to the top, as in the reference layout; the rest keep plan order.
  const ordered = [...run.steps.filter(attention), ...run.steps.filter((s) => !attention(s))]
  const deviceCount = new Set(run.steps.filter((s) => s.target.startsWith('device:')).map((s) => s.target)).size
  const stepName = (t: string, action: string) =>
    action === 'create_reminder' ? 'Reminder' : action === 'update_preference' ? 'Memory' : names[t.replace(/^device:/, '')] ?? t.replace(/^device:/, '')

  const orbLabel: Record<string, string> = {
    idle: 'Idle',
    processing: 'Working',
    approval: 'Waiting for your confirmation. Nothing unapproved has run.',
    verified: 'Verified',
    failure: 'Needs attention',
    recovering: 'Recovering',
    listening: 'Listening',
  }

  return (
    <div className="mx-auto max-w-[1280px] space-y-5">
      <div className="flex items-center gap-4 px-1">
        <AuraOrb state={orbState} size={56} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight lg:text-[32px]">Command Center</h1>
          <p className="mt-0.5 text-[15px] text-ink lg:text-[16px]">From plan to verified results.</p>
        </div>
        <span className="hidden text-[13px] text-ink-mute lg:block">{orbLabel[orbState]}</span>
      </div>
      <p className="sr-only" aria-live="polite">
        {RUN_STATUS_LABEL[run.status]}. {verified} of {run.steps.length} steps verified.
      </p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-2 px-1 text-[12px] text-ink-mute lg:text-[13px]">
          <Badge tone={runTone(run.status)}>{RUN_STATUS_LABEL[run.status]}</Badge>
          <span>
            {verified}/{run.steps.length} verified
          </span>
          <span>·</span>
          <span>started {clock(run.created_at)}</span>
          {finished && run.final_report && (
            <button onClick={() => speak(run.final_report!)} className="ml-auto inline-flex items-center gap-1 font-medium text-lav-300 hover:text-lav-200">
              <Volume2 className="size-3.5" /> Read aloud
            </button>
          )}
        </div>

        {run.status === 'AWAITING_APPROVAL' && (
          <Button variant="primary" size="lg" className="w-full" busy={busy === 'approve'} onClick={() => act('approve', () => api.approve(run.id))}>
            <ShieldCheck className="size-5" /> Approve & run
          </Button>
        )}

        {run.status === 'AWAITING_APPROVAL' && (
          <div className="animate-rise rounded-[18px] bg-[#dcebf5]/80 p-4 text-[14px] text-ink-soft">
            Plan preview. Nothing has run yet. Review the steps, then approve. Sensitive steps will still ask you
            individually.
          </div>
        )}

        <ProgressCard
          run={run}
          devices={deviceCount}
          action={
            !finished && (
              <button
                disabled={busy === 'cancel'}
                onClick={() => act('cancel', () => api.cancel(run.id))}
                aria-label={run.status === 'AWAITING_APPROVAL' ? 'Cancel plan' : 'Stop'}
                title={run.status === 'AWAITING_APPROVAL' ? 'Cancel plan' : 'Stop the workflow'}
                className="pressable grid size-8 place-items-center rounded-full bg-white/80 text-ink-soft shadow-[0_1px_4px_rgba(23,52,61,0.12)] hover:text-ink disabled:opacity-50"
              >
                <Square className="size-3.5" />
              </button>
            )
          }
        />

        <RunReport run={run} />

        <div className="lg:hidden">
          <Segmented
            label="Command Center view"
            value={panel}
            onChange={setPanel}
            options={[
              { value: 'steps', label: `Steps · ${run.steps.length}` },
              { value: 'log', label: `MCP log · ${events.filter((e) => e.type === 'tool.call').length}` },
            ]}
          />
        </div>

        <ol className={cx('space-y-3', panel === 'log' && 'hidden lg:block')} aria-label="Steps">
          {ordered.map((s) => (
            <StepCard
              key={s.id}
              step={s}
              deviceName={stepName(s.target, s.action)}
              busy={busy}
              onDecide={(approve) => act(`decide:${s.id}:${approve}`, () => api.decide(run.id, s.id, approve))}
              onRecover={(opt) => act(`recover:${s.id}:${opt}`, () => api.recover(run.id, s.id, opt))}
            />
          ))}
        </ol>

        <p className="flex items-start gap-2 px-1 text-[12px] leading-relaxed text-ink-mute lg:text-[13px]" title={run.planner_detail}>
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Plan by {run.planner_detail}. Risk levels come from AURA's policy, not the planner. A step is
            <span className="font-semibold text-verified-deep"> Verified</span> only when an independent state read
            matches; a service acknowledgement alone is shown as <span className="font-semibold text-lav-300">Accepted</span>.
          </span>
        </p>
      </div>

      <div className={cx('lg:sticky lg:top-6 lg:self-start', panel === 'steps' && 'hidden lg:block')}>
        <ToolLog events={events} steps={run.steps} className="lg:max-h-[calc(100vh-120px)]" />
      </div>
      </div>
    </div>
  )
}
