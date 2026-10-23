import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BedDouble, BriefcaseBusiness, ChevronRight, House, Sparkles } from 'lucide-react'
import { Glyph, kindForStep } from '../components/Devices'
import { Badge, Empty, ErrorNote, cx } from '../components/ui'
import { api } from '../lib/api'
import { useAuraEvents } from '../lib/aura'
import { RUN_STATUS_LABEL, STEP_STATUS_LABEL, clock, hm, runTone, stepTone } from '../lib/format'
import type { Run, RunStatus, Step } from '../lib/types'

/** Client-side outcome filters; every run status still belongs to one of them. */
const FILTERS: { label: string; statuses?: RunStatus[] }[] = [
  { label: 'All' },
  { label: 'Verified', statuses: ['COMPLETED'] },
  { label: 'With issues', statuses: ['COMPLETED_WITH_ISSUES', 'FAILED', 'CANCELLED'] },
  { label: 'Needs you', statuses: ['PAUSED', 'AWAITING_APPROVAL'] },
]

const ROUTINE_ICON: Record<string, typeof House> = { bedtime: BedDouble, leaving_home: House, overnight_shift: BriefcaseBusiness }

function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function observed(step: Step) {
  const ver = [...step.evidence].reverse().find((e) => e.kind === 'verification')
  return (ver?.data as any)?.observed as Record<string, unknown> | undefined
}

function StepEntry({ step }: { step: Step }) {
  const [open, setOpen] = useState(false)
  const recovered = step.recovery_log.some((l: any) => l.event === 'recovered')
  const failedOnce = step.evidence.some((e) => e.kind === 'verification' && (e.data as any)?.verdict === 'MISMATCH')
  const firstMismatch = step.evidence.find((e) => e.kind === 'verification' && (e.data as any)?.verdict === 'MISMATCH')
  const key = Object.keys(step.expected)[0]
  const obs = (firstMismatch?.data as any)?.observed ?? observed(step)
  const at = step.finished_at ?? step.updated_at
  const tone = recovered ? 'recover' : stepTone(step.status)
  const label = recovered ? 'Recovered' : STEP_STATUS_LABEL[step.status]
  return (
    <li>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition hover:bg-white/40">
        <Glyph kind={kindForStep(step)} size={36} className="!shadow-none !bg-transparent" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[14px] font-medium">{step.title}</span>
            <span className="shrink-0 text-[11px] text-ink-mute">{hm(at)}</span>
          </span>
          {failedOnce && key && obs && (
            <span className="mt-0.5 block text-[12px] text-ink-soft">
              Expected: <span className="font-medium text-[#3f86b8]">{String(step.expected[key])}</span> · Observed:{' '}
              <span className="font-medium text-failed">{String(obs[key])}</span>
            </span>
          )}
          <span className="mt-1.5 block">
            <Badge tone={tone}>{label}</Badge>
          </span>
        </span>
        <ChevronRight className={cx('mt-1 size-4 shrink-0 text-ink-mute transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <ol className="space-y-1.5 px-4 pb-3.5 pl-[64px]" aria-label={`Evidence for ${step.title}`}>
          {step.evidence.map((e, i) => (
            <li key={i} className="text-[12px] leading-snug text-ink-soft">
              <span className="font-semibold text-ink">{e.kind.replace('_', ' ')}</span>{' '}
              <span className="font-mono text-[10px] text-ink-mute">{e.source} · {clock(e.at)}</span>
              <br />
              {e.summary}
            </li>
          ))}
        </ol>
      )}
    </li>
  )
}

export default function History() {
  const [filter, setFilter] = useState(0)
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const load = useCallback(() => {
    api.runs().then((r) => setRuns(r.runs)).catch((e) => setError(e.message))
  }, [])
  useEffect(load, [load])
  useAuraEvents((e) => {
    if (e.type === 'run.finished' || e.type === 'run.created' || e.type === 'run.status') load()
  })

  const statuses = FILTERS[filter].statuses
  const shown = (runs ?? []).filter((r) => !statuses || statuses.includes(r.status))
  const groups: { day: string; runs: Run[] }[] = []
  for (const r of shown) {
    const day = dayLabel(r.created_at)
    const g = groups.at(-1)
    if (g && g.day === day) g.runs.push(r)
    else groups.push({ day, runs: [r] })
  }

  return (
    <div className="mx-auto max-w-[560px] space-y-6">
      <div className="px-1">
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight">History</h1>
        <p className="mt-0.5 text-[15px] text-ink">Every action, with its evidence.</p>
      </div>

      <div className="no-scrollbar -mx-1 overflow-x-auto px-1">
        <div className="inline-flex gap-1" role="tablist" aria-label="Filter by outcome">
          {FILTERS.map((f, i) => (
            <button
              key={f.label}
              role="tab"
              aria-selected={filter === i}
              onClick={() => setFilter(i)}
              className={cx(
                'h-8 whitespace-nowrap rounded-full px-4 text-[13px] font-medium transition-all',
                filter === i ? 'bg-forest text-white shadow-[0_4px_12px_-6px_rgba(46,122,85,0.8)]' : 'bg-white/60 text-ink-soft hover:bg-white/85 hover:text-ink',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {runs && shown.length === 0 && <Empty>No runs match this filter.</Empty>}

      {groups.map((g) => (
        <section key={g.day} aria-label={g.day} className="space-y-2">
          <h2 className="px-1 text-[17px] font-semibold tracking-tight">{g.day}</h2>
          {g.runs.map((r) => {
            const Icon = (r.routine_id && ROUTINE_ICON[r.routine_id]) || Sparkles
            return (
              <ul key={r.id} className="card group-list overflow-hidden">
                <li>
                  <button onClick={() => navigate(`/runs/${r.id}`)} className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition hover:bg-white/40">
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#e6e2f1]" aria-hidden>
                      <Icon className="size-5 text-[#6c64a0]" strokeWidth={1.6} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[14px] font-semibold">{r.summary}</span>
                        <span className="shrink-0 text-[11px] text-ink-mute">{hm(r.created_at)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[12px] text-ink-mute">“{r.utterance}”</span>
                      <span className="mt-1.5 flex flex-wrap gap-1.5">
                        <Badge tone={runTone(r.status)}>{RUN_STATUS_LABEL[r.status]}</Badge>
                        <Badge tone="mute">{r.planner === 'bedrock' ? 'Bedrock' : 'Local rules'}</Badge>
                      </span>
                    </span>
                    <ChevronRight className="mt-1 size-4 shrink-0 text-ink-mute" aria-hidden />
                  </button>
                </li>
                {r.steps
                  .filter((s) => s.status !== 'PENDING')
                  .map((s) => (
                    <StepEntry key={s.id} step={s} />
                  ))}
              </ul>
            )
          })}
        </section>
      ))}
    </div>
  )
}
