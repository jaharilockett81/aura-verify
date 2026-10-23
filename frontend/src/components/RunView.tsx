import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertCircle,
  BadgeCheck,
  BedDouble,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  ClipboardList,
  Eye,
  Fingerprint,
  Hand,
  House,
  Loader2,
  Microscope,
  PenLine,
  ScrollText,
  ShieldAlert,
  Sparkles,
  Stethoscope,
} from 'lucide-react'
import type { AuraEvent, Evidence, Run, Step } from '../lib/types'
import { STEP_STATUS_LABEL, clock, hm, stepTone } from '../lib/format'
import { Glyph, kindForStep } from './Devices'
import { Badge, Button, cx } from './ui'

// ----- progress timeline ----------------------------------------------------------------------------------
type Phase = 'done' | 'active' | 'attention' | 'idle' | 'skipped'

function phases(run: Run) {
  const finished = ['COMPLETED', 'COMPLETED_WITH_ISSUES', 'FAILED', 'CANCELLED'].includes(run.status)
  const any = (f: (s: Step) => boolean) => run.steps.some(f)
  const needsApproval = run.status === 'AWAITING_APPROVAL'
  const sensitiveWait = any((s) => s.status === 'AWAITING_APPROVAL')
  const recovering = any((s) => s.status === 'RECOVERING' || s.recovery_options.length > 0)
  const recovered = any((s) => s.recovery_log.length > 0)
  const executing = any((s) => s.status === 'RUNNING')
  const verifying = any((s) => s.status === 'VERIFYING')
  const allSettled = run.steps.every((s) => !['PENDING', 'RUNNING', 'VERIFYING', 'RECOVERING', 'AWAITING_APPROVAL'].includes(s.status))
  const verified = run.steps.filter((s) => s.status === 'VERIFIED').length
  const lastAt = (f: (s: Step) => boolean) =>
    run.steps.filter(f).map((s) => s.finished_at ?? s.updated_at).sort().at(-1) ?? null

  const items: { label: string; detail?: string; phase: Phase; at: string | null }[] = [
    { label: 'Plan generated', detail: `${run.steps.length} steps`, phase: 'done', at: run.created_at },
    {
      label: 'User approved',
      detail: needsApproval ? 'Waiting for your approval' : sensitiveWait ? 'A sensitive step needs your confirmation' : undefined,
      phase: needsApproval || sensitiveWait ? 'attention' : run.approved_at ? 'done' : run.status === 'CANCELLED' ? 'skipped' : 'idle',
      at: run.approved_at,
    },
    {
      label: 'Execute commands',
      detail: executing ? 'Sending commands to devices…' : undefined,
      phase: executing ? 'active' : !run.approved_at ? 'idle' : allSettled || finished || recovering || sensitiveWait || run.status === 'PAUSED' ? 'done' : 'active',
      at: run.approved_at ? lastAt((s) => s.evidence.some((e) => e.kind === 'ack')) : null,
    },
    {
      label: 'Verify results',
      detail: run.approved_at ? `${verified} of ${run.steps.length} confirmed by state reads` : undefined,
      phase: verifying ? 'active' : recovering ? 'attention' : run.approved_at && allSettled ? 'done' : 'idle',
      at: run.approved_at ? lastAt((s) => s.status === 'VERIFIED') : null,
    },
  ]
  if (recovering || recovered)
    items.push({
      label: 'Recover',
      detail: recovering ? 'A step needs recovery' : 'Recovered and re-verified',
      phase: recovering ? 'attention' : 'done',
      at: recovered ? lastAt((s) => s.recovery_log.length > 0) : null,
    })
  items.push({ label: 'Complete', detail: finished ? undefined : undefined, phase: finished ? (run.status === 'CANCELLED' ? 'skipped' : 'done') : 'idle', at: run.finished_at })
  return items
}

const ROUTINE_ICON: Record<string, typeof House> = { bedtime: BedDouble, leaving_home: House, overnight_shift: BriefcaseBusiness }

export function ProgressCard({ run, devices, action }: { run: Run; devices: number; action?: ReactNode }) {
  const items = phases(run)
  const Icon = (run.routine_id && ROUTINE_ICON[run.routine_id]) || Sparkles
  return (
    <section className="glass-strong rounded-[22px] p-4 sm:p-5" aria-label="Workflow progress">
      <div className="flex items-center gap-3.5">
        <span className="grid size-12 shrink-0 place-items-center rounded-[14px] bg-[#e6e2f1]">
          <Icon className="size-6 text-[#6c64a0]" strokeWidth={1.6} aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[17px] font-semibold tracking-tight">{run.summary.replace(/^Run routine: /, '')}{run.routine_id ? ' routine' : ''}</div>
          <div className="text-[13px] text-ink-mute">
            {devices} device{devices === 1 ? '' : 's'} · {run.planner === 'bedrock' ? 'planned by Amazon Bedrock' : 'planned by local rules'}
          </div>
        </div>
        {action && <div className="ml-auto self-start">{action}</div>}
      </div>
      <p className="mt-3 text-[13px] italic leading-snug text-ink-soft">“{run.utterance}”</p>
      <ol className="mt-4 space-y-0" aria-label="Workflow stages">
        {items.map((it, i) => (
          <li key={it.label} className="relative flex gap-3.5 pb-4 last:pb-0" aria-current={it.phase === 'active' || it.phase === 'attention' ? 'step' : undefined}>
            {i < items.length - 1 && (
              <span className={cx('absolute left-[11px] top-6 h-[calc(100%-20px)] w-[2px] rounded-full', it.phase === 'done' ? 'bg-forest/70' : 'bg-ink/10')} aria-hidden />
            )}
            <PhaseDot phase={it.phase} />
            <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className={cx('text-[15px] font-medium', it.phase === 'idle' || it.phase === 'skipped' ? 'text-ink-mute' : 'text-ink', it.phase === 'skipped' && 'line-through')}>
                  {it.label}
                </div>
                {it.detail && <div className={cx('text-[12px]', it.phase === 'attention' ? 'text-recover-deep' : 'text-ink-mute')}>{it.detail}</div>}
              </div>
              {it.at && <span className="shrink-0 text-[12px] text-ink-mute">{hm(it.at)}</span>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function PhaseDot({ phase }: { phase: Phase }) {
  if (phase === 'done')
    return (
      <span className="relative z-10 grid size-6 shrink-0 place-items-center rounded-full bg-forest">
        <Check className="size-3.5 text-white" strokeWidth={3} />
      </span>
    )
  if (phase === 'active')
    return (
      <span className="relative z-10 grid size-6 shrink-0 place-items-center rounded-full bg-white">
        <Loader2 className="size-5 animate-spin text-[#6e93ae]" strokeWidth={2} />
      </span>
    )
  if (phase === 'attention')
    return (
      <span className="relative z-10 grid size-6 shrink-0 place-items-center rounded-full bg-[#f3c8a0]">
        <AlertCircle className="size-4 text-[#8a4f20]" strokeWidth={2} />
      </span>
    )
  return <span className="relative z-10 size-6 shrink-0 rounded-full border-2 border-ink/15 bg-white/60" />
}

// ----- evidence --------------------------------------------------------------------------------------------
const EVIDENCE_META: Record<Evidence['kind'], { icon: typeof Eye; label: string; tone: string }> = {
  note: { icon: PenLine, label: 'Note', tone: 'text-ink-mute' },
  approval: { icon: Hand, label: 'Authorization', tone: 'text-lav-300' },
  precheck: { icon: Eye, label: 'Pre-check', tone: 'text-ink-soft' },
  ack: { icon: ClipboardList, label: 'Service ack', tone: 'text-lav-300' },
  state_read: { icon: Eye, label: 'State read', tone: 'text-verified-deep' },
  verification: { icon: Microscope, label: 'Verification', tone: 'text-verified-deep' },
  diagnosis: { icon: Stethoscope, label: 'Diagnosis', tone: 'text-recover-deep' },
}

function EvidenceItem({ ev }: { ev: Evidence }) {
  const [open, setOpen] = useState(false)
  const meta = EVIDENCE_META[ev.kind]
  const Icon = meta.icon
  const mismatch = ev.kind === 'verification' && (ev.data as any)?.verdict === 'MISMATCH'
  const hasData = ev.data && Object.keys(ev.data).length > 0
  return (
    <li className="relative pl-8">
      <span className="absolute left-0 top-0 grid size-6 place-items-center rounded-full bg-white shadow-[0_1px_3px_rgba(23,52,61,0.15)]">
        <Icon className={cx('size-3.5', mismatch ? 'text-failed' : meta.tone)} aria-hidden />
      </span>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={cx('text-[12px] font-semibold', mismatch ? 'text-failed' : meta.tone)}>{meta.label}</span>
        <span className="font-mono text-[10px] text-ink-mute">{ev.source} · {clock(ev.at)}</span>
      </div>
      <p className="text-[13px] leading-snug text-ink-soft">{ev.summary}</p>
      {hasData && (
        <button onClick={() => setOpen(!open)} className="mt-0.5 text-[12px] font-medium text-lav-300 hover:text-lav-200" aria-expanded={open}>
          {open ? 'Hide raw evidence' : 'Inspect raw evidence'}
        </button>
      )}
      {open && (
        <pre className="scroll-thin mt-1.5 max-h-56 overflow-auto rounded-xl bg-white/70 p-3 font-mono text-[11px] leading-relaxed text-ink-soft">
          {JSON.stringify(ev.data, null, 2)}
        </pre>
      )}
    </li>
  )
}

function observedFor(step: Step) {
  const ver = [...step.evidence].reverse().find((e) => e.kind === 'verification')
  return (ver?.data as any)?.observed as Record<string, unknown> | undefined
}

const UNIT: Record<string, string> = { setpoint_f: '°F', brightness: '%' }
function fmtVal(k: string, v: unknown) {
  if (v === undefined || v === null) return '—'
  if (typeof v === 'boolean') return k === 'locked' ? (v ? 'Locked' : 'Unlocked') : v ? 'On' : 'Off'
  return `${v}${UNIT[k] ?? ''}`
}

/** Expected vs observed panels, straight from the verification evidence. */
function ExpectedObserved({ step, big }: { step: Step; big?: boolean }) {
  const observed = observedFor(step)
  if (!observed || step.action === 'read_device') return null
  const keys = Object.keys(step.expected)
  if (keys.length === 0) return null
  const k = keys.find((x) => String(step.expected[x]) !== String(observed[x])) ?? keys[0]
  const exp = step.expected[k]
  const obs = observed[k]
  const match = String(exp) === String(obs)
  return (
    <div className="grid grid-cols-2 gap-3" aria-label="Expected versus observed">
      <div className="rounded-[16px] bg-white/80 px-4 py-3.5 shadow-[0_2px_8px_-6px_rgba(23,52,61,0.3)]">
        <div className="text-[13px] text-ink-soft">Expected</div>
        <div className={cx('font-semibold tracking-tight text-[#3f86b8]', big ? 'mt-1 text-[28px]' : 'text-[20px]')}>{fmtVal(k, exp)}</div>
      </div>
      <div className="rounded-[16px] bg-white/80 px-4 py-3.5 shadow-[0_2px_8px_-6px_rgba(23,52,61,0.3)]">
        <div className="text-[13px] text-ink-soft">Observed</div>
        <div className={cx('font-semibold tracking-tight', match ? 'text-verified-deep' : 'text-failed', big ? 'mt-1 text-[28px]' : 'text-[20px]')}>
          {fmtVal(k, obs)}
        </div>
      </div>
      {keys.length > 1 && (
        <div className="col-span-2 font-mono text-[11px] text-ink-mute">
          {keys.map((x) => `${x}: ${String(step.expected[x])} → ${String(observed[x] ?? '—')}`).join(' · ')}
        </div>
      )}
    </div>
  )
}

// ----- step card --------------------------------------------------------------------------------------------
export function StepCard({
  step,
  deviceName,
  onDecide,
  onRecover,
  busy,
}: {
  step: Step
  deviceName: string
  onDecide: (approve: boolean) => void
  onRecover: (optionId: string) => void
  busy: string | null
}) {
  const recovery = step.recovery_options.length > 0
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? false
  const tone = stepTone(step.status)
  const riskReason = step.evidence.find((e) => e.source === 'policy' && e.kind === 'note')?.summary.replace(/^Risk \w+: /, '')
  const recommended = step.recovery_options.find((o) => o.recommended) ?? step.recovery_options[0]
  const others = step.recovery_options.filter((o) => o !== recommended)
  const diagnosis = [...step.evidence].reverse().find((e) => e.kind === 'diagnosis')
  const at = step.finished_at ?? (step.status !== 'PENDING' ? step.updated_at : null)
  const recovered = step.recovery_log.some((l: any) => l.event === 'recovered')

  return (
    <li
      className={cx('card animate-rise overflow-hidden', recovery && 'glass-strong', step.status === 'AWAITING_APPROVAL' && 'glass-strong')}
      role={recovery ? 'region' : undefined}
      aria-label={recovery ? 'Recovery options' : undefined}
    >
      <button onClick={() => setOpen(!expanded)} className="flex w-full items-start gap-3.5 p-4 text-left" aria-expanded={expanded}>
        <Glyph kind={kindForStep(step)} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span className="text-[15px] font-semibold tracking-tight">{deviceName}</span>
            <Badge tone={recovery ? 'failed' : tone}>{recovery ? (step.status === 'UNKNOWN' ? 'Unconfirmed' : 'Verification failed') : STEP_STATUS_LABEL[step.status]}</Badge>
          </div>
          <div className="mt-0.5 flex items-start justify-between gap-2">
            <span className="text-[13px] text-ink-soft">{step.title}</span>
            {at && <span className="shrink-0 text-[12px] text-ink-mute">{hm(at)}</span>}
          </div>
          {(step.risk !== 'ROUTINE' || step.attempts > 1 || recovered) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {step.risk === 'SENSITIVE' && <Badge tone="recover"><ShieldAlert className="size-3" /> Sensitive</Badge>}
              {step.risk === 'READ_ONLY' && <Badge tone="mute">Read-only</Badge>}
              {step.attempts > 1 && <Badge tone="lav">Attempt {step.attempts}/{step.max_attempts}</Badge>}
              {recovered && <Badge tone="recover">Recovered</Badge>}
            </div>
          )}
        </div>
      </button>

      {step.status === 'AWAITING_APPROVAL' && (
        <div className="mx-4 mb-4 rounded-[16px] bg-[#fdebd8]/80 p-4">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-recover-deep">
            <Hand className="size-4" /> This step needs your confirmation
          </div>
          <p className="mt-1 text-[13px] text-ink-soft">{riskReason}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => onDecide(true)} busy={busy === `decide:${step.id}:true`}>
              Confirm: {step.title.toLowerCase()}
            </Button>
            <Button variant="secondary" onClick={() => onDecide(false)} busy={busy === `decide:${step.id}:false`}>
              Skip this step
            </Button>
          </div>
        </div>
      )}

      {recovery && (
        <div className="space-y-3 px-4 pb-4">
          <ExpectedObserved step={step} big />
          <div className="flex items-start gap-3 rounded-[16px] bg-white/80 p-3.5 shadow-[0_2px_8px_-6px_rgba(23,52,61,0.3)]">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#fadbe2]">
              <AlertCircle className="size-4 text-failed" strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1 text-[13px] leading-snug">
              <p className="text-ink">{step.error}</p>
              {diagnosis && <p className="mt-1 text-ink-soft"><span className="font-semibold text-recover-deep">Why: </span>{diagnosis.summary}</p>}
            </div>
          </div>
          {recommended && (
            <p className="px-1 text-[13px] leading-snug text-ink-soft">
              <span className="font-semibold text-ink">AURA recommends: {recommended.label}.</span> {recommended.explanation}
              {recommended.risk === 'SENSITIVE' && ' Needs your approval.'}
            </p>
          )}
          <div className="flex gap-3">
            <Button variant="secondary" size="lg" className="flex-1" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
              {expanded ? 'Hide evidence' : 'View evidence'}
            </Button>
            {recommended && (
              <Button variant="primary" size="lg" className="flex-1" disabled={!!busy} busy={busy === `recover:${step.id}:${recommended.id}`} onClick={() => onRecover(recommended.id)} title={recommended.label}>
                Allow recovery
              </Button>
            )}
          </div>
          {others.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[12px] text-ink-mute">
              Other options:
              {others.map((o) => (
                <button key={o.id} disabled={!!busy} onClick={() => onRecover(o.id)} title={o.explanation} className="font-medium text-lav-300 hover:text-lav-200 disabled:opacity-50">
                  {o.label}
                </button>
              ))}
            </div>
          )}
          <p className="px-1 text-[11px] text-ink-mute">Attempts used: {step.attempts} of {step.max_attempts}. AURA will not retry beyond this.</p>
        </div>
      )}

      {expanded && (
        <div className="space-y-3 border-t border-ink/[0.07] bg-white/30 px-4 pb-4 pt-3.5">
          {step.rationale && <p className="text-[13px] text-ink-soft">{step.rationale}</p>}
          {step.provenance && (
            <p className="flex items-start gap-2 text-[12px] text-ink-soft">
              <Fingerprint className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {step.provenance}
            </p>
          )}
          {!recovery && <ExpectedObserved step={step} />}
          {step.error && !recovery && (
            <p className={cx('text-[13px]', step.status === 'VERIFIED' ? 'text-ink-mute' : 'text-failed')}>{step.error}</p>
          )}
          <ol className="relative space-y-3 before:absolute before:bottom-1 before:left-3 before:top-1 before:w-px before:bg-ink/10">
            {step.evidence.map((ev, i) => (
              <EvidenceItem key={i} ev={ev} />
            ))}
          </ol>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-ink-mute">
            <span>assurance {step.assurance.toLowerCase()}</span>
            <span>step {step.id}</span>
            <span>target {step.target}</span>
            <span title="Each attempt derives a fresh key from this one; a reused key is never re-applied">idempotency {step.idempotency_key}</span>
          </div>
        </div>
      )}
      {!recovery && (
        <button onClick={() => setOpen(!expanded)} className="flex w-full items-center justify-center gap-1 border-t border-ink/[0.06] py-1.5 text-[11px] font-medium text-ink-mute hover:text-ink" aria-label={expanded ? 'Hide evidence' : 'Show evidence'}>
          {expanded ? 'Hide evidence' : 'Evidence'} <ChevronDown className={cx('size-3 transition-transform', expanded && 'rotate-180')} />
        </button>
      )}
    </li>
  )
}

// ----- tool log -----------------------------------------------------------------------------------------------
export function ToolLog({ events, steps }: { events: AuraEvent[]; steps: Step[] }) {
  const calls = events.filter((e) => e.type === 'tool.call')
  const [openSeq, setOpenSeq] = useState<number | null>(null)
  const titles = Object.fromEntries(steps.map((s) => [s.id, s.title]))
  const proto = calls.at(-1)?.data.protocol_version
  const transport = calls.at(-1)?.data.transport
  return (
    <section className="card flex max-h-[720px] flex-col overflow-hidden" aria-labelledby="toollog-title">
      <div className="border-b border-ink/[0.07] p-4">
        <h2 id="toollog-title" className="flex items-center gap-2 text-[15px] font-semibold">
          <ScrollText className="size-4 text-ink-soft" /> MCP tool activity
        </h2>
        <p className="mt-0.5 text-[12px] text-ink-mute">
          Every household effect is a real MCP tools/call
          {transport && ` over ${transport === 'streamable-http' ? 'Streamable HTTP' : transport}`}
          {proto && ` · protocol ${proto}`}
        </p>
      </div>
      <ol className="scroll-thin flex-1 space-y-0.5 overflow-y-auto p-2" aria-live="polite">
        {calls.length === 0 && <li className="p-3 text-[12px] text-ink-mute">No tool calls yet.</li>}
        {calls.map((c) => {
          const d = c.data
          const verdict = d.result?.verdict as string | undefined
          const open = openSeq === c.seq
          return (
            <li key={c.seq}>
              <button
                onClick={() => setOpenSeq(open ? null : c.seq)}
                className="flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left hover:bg-white/60"
                aria-expanded={open}
              >
                <span className={cx('size-1.5 shrink-0 rounded-full', !d.ok ? 'bg-failed' : verdict === 'MISMATCH' ? 'bg-failed' : verdict === 'UNKNOWN' ? 'bg-unknown' : d.tool === 'set_device_state' || d.tool === 'retry_failed_action' ? 'bg-lav-500' : 'bg-verified')} />
                <span className="font-mono text-[12px] text-ink">{d.tool}</span>
                {verdict && (
                  <span className={cx('font-mono text-[10px] font-bold', verdict === 'VERIFIED' ? 'text-verified-deep' : verdict === 'MISMATCH' ? 'text-failed' : 'text-unknown')}>
                    {verdict}
                  </span>
                )}
                {d.tool === 'set_device_state' && d.ok && <span className="font-mono text-[10px] text-lav-300">ACK</span>}
                {!d.ok && <span className="font-mono text-[10px] font-bold text-failed">ERROR</span>}
                <span className="ml-auto font-mono text-[10px] text-ink-mute">{d.duration_ms}ms</span>
              </button>
              {open && (
                <div className="mx-2 mb-2 space-y-1 rounded-xl bg-white/75 p-3 font-mono text-[11px]">
                  {d.step_id && <div className="text-ink-mute">for: {titles[d.step_id] ?? d.step_id}</div>}
                  <div className="text-lav-300">→ {JSON.stringify(d.arguments)}</div>
                  <pre className="scroll-thin max-h-48 overflow-auto whitespace-pre-wrap text-ink-soft">
                    ← {d.ok ? JSON.stringify(d.result, null, 1) : d.error}
                  </pre>
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export function RunReport({ run }: { run: Run }) {
  if (!run.final_report) return null
  const good = run.status === 'COMPLETED'
  return (
    <div className={cx('card flex items-start gap-3 p-4', good ? 'bg-[#e4f2e8]/80' : 'bg-[#fdf0e2]/80')}>
      <BadgeCheck className={cx('mt-0.5 size-5 shrink-0', good ? 'text-verified-deep' : 'text-recover-deep')} aria-hidden />
      <div>
        <div className={cx('text-[15px] font-semibold', good ? 'text-verified-deep' : 'text-recover-deep')}>
          {good ? 'Everything verified' : run.status === 'CANCELLED' ? 'Cancelled' : 'Finished, with issues'}
        </div>
        <p className="text-[13px] leading-snug text-ink-soft">{run.final_report}</p>
      </div>
    </div>
  )
}
