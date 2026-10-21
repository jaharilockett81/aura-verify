import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { Badge, Empty, ErrorNote, StatusIcon, cx } from '../components/ui'
import { api } from '../lib/api'
import { useAuraEvents } from '../lib/aura'
import { RUN_STATUS_LABEL, runTone, timeAgo } from '../lib/format'
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

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-mute">Execution history</p>
        <h1 className="font-display text-4xl">Every action, with its evidence.</h1>
        <p className="mt-1 text-ink-soft">Stored in the local execution ledger. Open a run to inspect evidence and recovery details.</p>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter by outcome">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            role="tab"
            aria-selected={filter === f.status}
            onClick={() => setFilter(f.status)}
            className={cx(
              'rounded-full px-3.5 py-1.5 text-xs font-semibold ring-1 transition',
              filter === f.status ? 'bg-lav-400/15 text-lav-200 ring-lav-400/40' : 'text-ink-soft ring-white/10 hover:bg-white/5',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {runs && runs.length === 0 && <Empty>No runs match this filter.</Empty>}

      <ul className="space-y-2.5">
        {runs?.map((r) => {
          const recovered = r.steps.filter((s) => s.recovery_log.some((l: any) => l.event === 'recovered')).length
          return (
            <li key={r.id}>
              <button onClick={() => navigate(`/runs/${r.id}`)} className="card group flex w-full items-center gap-4 p-4 text-left transition hover:border-lav-400/30">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{r.summary}</span>
                    <Badge tone={runTone(r.status)}>{RUN_STATUS_LABEL[r.status]}</Badge>
                    {recovered > 0 && <Badge tone="recover">{recovered} recovered</Badge>}
                    <Badge tone="mute">{r.planner === 'bedrock' ? 'Bedrock' : 'Local rules'}</Badge>
                  </div>
                  <p className="mt-0.5 truncate text-sm text-ink-mute">“{r.utterance}” · {timeAgo(r.created_at)}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Step outcomes">
                    {r.steps.map((s) => (
                      <span key={s.id} title={`${s.title}: ${s.status}`}>
                        <StatusIcon status={s.status} className="size-4" />
                      </span>
                    ))}
                  </div>
                  {r.final_report && <p className="mt-2 line-clamp-2 text-xs text-ink-soft">{r.final_report}</p>}
                </div>
                <ChevronRight className="size-5 shrink-0 text-ink-mute group-hover:text-lav-300" />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
