import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Ban, CheckCircle2, ChevronRight, Loader2, XCircle } from 'lucide-react'
import { Badge, Empty, ErrorNote, StatusIcon, cx } from '../components/ui'
import { api } from '../lib/api'
import { useAuraEvents } from '../lib/aura'
import { RUN_STATUS_LABEL, runTone } from '../lib/format'
import type { Run, RunStatus } from '../lib/types'

const FILTERS: { label: string; status?: RunStatus }[] = [
  { label: 'All' },
  { label: 'Verified', status: 'COMPLETED' },
  { label: 'With issues', status: 'COMPLETED_WITH_ISSUES' },
  { label: 'Failed', status: 'FAILED' },
  { label: 'Needs you', status: 'PAUSED' },
  { label: 'Cancelled', status: 'CANCELLED' },
]

export default function History() {
  const [filter, setFilter] = useState<RunStatus | undefined>()
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const load = useCallback(() => {
    api.runs(filter).then((r) => setRuns(r.runs)).catch((e) => setError(e.message))
  }, [filter])
  useEffect(load, [load])
  useAuraEvents((e) => {
    if (e.type === 'run.finished' || e.type === 'run.created' || e.type === 'run.status') load()
  })

  // Group by calendar day, like an activity feed.
  const groups: { day: string; runs: Run[] }[] = []
  for (const r of runs ?? []) {
    const day = dayLabel(r.created_at)
    const g = groups.at(-1)
    if (g && g.day === day) g.runs.push(r)
    else groups.push({ day, runs: [r] })
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="px-1">
        <h1 className="text-[34px] font-bold leading-tight tracking-tight">History</h1>
        <p className="mt-1 text-[17px] text-ink-soft">Every action, with its evidence.</p>
        <p className="mt-1 text-[13px] text-ink-mute">Stored in the local execution ledger. Open a run to inspect evidence and recovery details.</p>
      </div>

      <div className="scroll-thin -mx-1 overflow-x-auto px-1">
        <div className="inline-flex min-w-full rounded-[12px] bg-white/[0.07] p-0.5 sm:min-w-0" role="tablist" aria-label="Filter by outcome">
          {FILTERS.map((f) => (
            <button
              key={f.label}
              role="tab"
              aria-selected={filter === f.status}
              onClick={() => setFilter(f.status)}
              className={cx(
                'h-8 flex-1 whitespace-nowrap rounded-[10px] px-3.5 text-[13px] font-medium transition-all sm:flex-none',
                filter === f.status ? 'bg-night-500/80 text-ink shadow-[0_2px_6px_rgba(0,0,0,0.35)]' : 'text-ink-soft hover:text-ink',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {runs && runs.length === 0 && <Empty>No runs match this filter.</Empty>}

      {groups.map((g) => (
        <section key={g.day} aria-label={g.day}>
          <h2 className="mb-2 px-1 text-[13px] font-medium uppercase tracking-[0.06em] text-ink-mute">{g.day}</h2>
          <ul className="card group-list overflow-hidden">
            {g.runs.map((r) => {
              const recovered = r.steps.filter((s) => s.recovery_log.some((l: any) => l.event === 'recovered')).length
              const tone = runTone(r.status)
              return (
                <li key={r.id}>
                  <button onClick={() => navigate(`/runs/${r.id}`)} className="flex w-full items-start gap-3.5 px-4 py-3.5 text-left transition hover:bg-white/[0.04]">
                    <span
                      className={cx(
                        'mt-0.5 grid size-9 shrink-0 place-items-center rounded-[11px]',
                        tone === 'verified' ? 'bg-verified/14' : tone === 'failed' ? 'bg-failed/14' : tone === 'recover' ? 'bg-recover/14' : 'bg-white/[0.08]',
                      )}
                    >
                      <RunIcon status={r.status} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-[15px] font-semibold">{r.summary}</span>
                        <span className="shrink-0 text-[13px] text-ink-mute">{new Date(r.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                      </div>
                      <p className="truncate text-[13px] text-ink-mute">“{r.utterance}”</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Badge tone={tone}>{RUN_STATUS_LABEL[r.status]}</Badge>
                        {recovered > 0 && <Badge tone="recover">{recovered} recovered</Badge>}
                        <Badge tone="mute">{r.planner === 'bedrock' ? 'Bedrock' : 'Local rules'}</Badge>
                        <span className="ml-1 flex flex-wrap gap-1" aria-label="Step outcomes">
                          {r.steps.map((s) => (
                            <span key={s.id} title={`${s.title}: ${s.status}`}>
                              <StatusIcon status={s.status} className="size-3.5" />
                            </span>
                          ))}
                        </span>
                      </div>
                      {r.final_report && <p className="mt-2 line-clamp-2 text-[13px] leading-snug text-ink-soft">{r.final_report}</p>}
                    </div>
                    <ChevronRight className="mt-2 size-4 shrink-0 text-ink-mute/70" />
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

function RunIcon({ status }: { status: RunStatus }) {
  const c = 'size-[18px]'
  if (status === 'COMPLETED') return <CheckCircle2 className={cx(c, 'text-verified')} strokeWidth={1.75} />
  if (status === 'FAILED') return <XCircle className={cx(c, 'text-failed')} strokeWidth={1.75} />
  if (status === 'COMPLETED_WITH_ISSUES' || status === 'PAUSED' || status === 'AWAITING_APPROVAL')
    return <AlertTriangle className={cx(c, 'text-recover')} strokeWidth={1.75} />
  if (status === 'CANCELLED') return <Ban className={cx(c, 'text-ink-mute')} strokeWidth={1.75} />
  return <Loader2 className={cx(c, 'animate-spin text-lav-300')} strokeWidth={1.75} />
}

function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}
