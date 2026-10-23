import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Info, ShieldCheck, Square, Volume2 } from 'lucide-react'
import { Pipeline, RunReport, StepCard, ToolLog } from '../components/RunView'
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

  if (noRuns)
    return (
      <div className="mx-auto max-w-lg py-16">
        <Empty>
          No workflows yet. Head to <Link className="text-lav-300 underline" to="/">Home</Link> and ask AURA to run a routine.
        </Empty>
      </div>
    )
  if (error) return <ErrorNote>{error}</ErrorNote>
  if (!run) return <div className="py-20 text-center text-ink-mute">Loading workflow…</div>

  const finished = ['COMPLETED', 'COMPLETED_WITH_ISSUES', 'FAILED', 'CANCELLED'].includes(run.status)
  const verified = run.steps.filter((s) => s.status === 'VERIFIED').length

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-ink-mute">Command Center</p>
            <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-tight sm:text-[32px]">“{run.utterance}”</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-ink-mute">
              <Badge tone={runTone(run.status)}>{RUN_STATUS_LABEL[run.status]}</Badge>
              <span>{run.summary}</span>
              <span>·</span>
              <span>
                {verified}/{run.steps.length} verified
              </span>
              <span>·</span>
              <span>started {clock(run.created_at)}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {run.status === 'AWAITING_APPROVAL' && (
              <Button variant="primary" size="lg" busy={busy === 'approve'} onClick={() => act('approve', () => api.approve(run.id))}>
                <ShieldCheck className="size-5" /> Approve & run
              </Button>
            )}
            {!finished && (
              <Button variant="ghost" busy={busy === 'cancel'} onClick={() => act('cancel', () => api.cancel(run.id))}>
                <Square className="size-4" /> {run.status === 'AWAITING_APPROVAL' ? 'Cancel plan' : 'Stop'}
              </Button>
            )}
            {finished && run.final_report && (
              <Button variant="ghost" onClick={() => speak(run.final_report!)}>
                <Volume2 className="size-4" /> Read summary aloud
              </Button>
            )}
          </div>
        </div>
        <Pipeline run={run} />
        <p className="flex items-start gap-2 px-1 text-[12px] leading-relaxed text-ink-mute" title={run.planner_detail}>
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Plan by {run.planner_detail}. Risk levels come from AURA's policy, not the planner. A step is
            <span className="font-semibold text-verified"> Verified</span> only when an independent state read
            matches; a service acknowledgement alone is shown as <span className="font-semibold text-lav-300">Accepted</span>.
          </span>
        </p>
      </header>

      {run.status === 'AWAITING_APPROVAL' && (
        <div className="rounded-[18px] bg-lav-300/[0.08] p-4 text-sm text-ink-soft">
          Plan preview. Nothing has run yet. Review the steps, then approve. Sensitive steps will still ask you
          individually.
        </div>
      )}

      <RunReport run={run} />

      <div className="xl:hidden">
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

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <ol className={cx('space-y-3', panel === 'log' && 'hidden xl:block')} aria-label="Steps">
          {run.steps.map((s) => (
            <StepCard
              key={s.id}
              step={s}
              busy={busy}
              onDecide={(approve) => act(`decide:${s.id}:${approve}`, () => api.decide(run.id, s.id, approve))}
              onRecover={(opt) => act(`recover:${s.id}:${opt}`, () => api.recover(run.id, s.id, opt))}
            />
          ))}
        </ol>
        <div className={cx('xl:sticky xl:top-24 xl:self-start', panel === 'steps' && 'hidden xl:block')}>
          <ToolLog events={events} steps={run.steps} />
        </div>
      </div>
    </div>
  )
}
