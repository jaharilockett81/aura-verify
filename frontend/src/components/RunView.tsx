import { useState } from 'react'
import {
  BadgeCheck,
  ChevronDown,
  ClipboardList,
  Eye,
  Fingerprint,
  Hand,
  Microscope,
  PenLine,
  ScrollText,
  ShieldAlert,
  Stethoscope,
  Wrench,
} from 'lucide-react'
import type { AuraEvent, Evidence, Run, Step } from '../lib/types'
import { STEP_STATUS_LABEL, clock, stepTone } from '../lib/format'
import { Badge, Button, StatusIcon, cx } from './ui'

// ----- pipeline ---------------------------------------------------------------------------------------
const STAGES = ['Intent', 'Plan', 'Authorize', 'Execute', 'Verify', 'Recover', 'Remember'] as const
type StageState = 'done' | 'active' | 'attention' | 'idle' | 'skipped'

function stageStates(run: Run): StageState[] {
  const finished = ['COMPLETED', 'COMPLETED_WITH_ISSUES', 'FAILED', 'CANCELLED'].includes(run.status)
  const any = (f: (s: Step) => boolean) => run.steps.some(f)
  const needsApproval = run.status === 'AWAITING_APPROVAL' || any((s) => s.status === 'AWAITING_APPROVAL')
  const recovering = any((s) => s.status === 'RECOVERING' || s.recovery_options.length > 0)
  const recovered = any((s) => s.recovery_log.length > 0)
  return [
    'done',
    'done',
    needsApproval ? 'attention' : run.approved_at ? 'done' : run.status === 'CANCELLED' ? 'skipped' : 'idle',
    any((s) => s.status === 'RUNNING') ? 'active' : finished || run.steps.every((s) => s.status !== 'PENDING') ? 'done' : run.approved_at ? 'active' : 'idle',
    any((s) => s.status === 'VERIFYING') ? 'active' : any((s) => s.status === 'VERIFIED') ? 'done' : 'idle',
    recovering ? 'attention' : recovered ? 'done' : finished ? 'skipped' : 'idle',
    finished ? 'done' : 'idle',
  ]
}

export function Pipeline({ run }: { run: Run }) {
  const states = stageStates(run)
  return (
    <ol className="scroll-thin flex w-full gap-1 overflow-x-auto rounded-full bg-white/[0.05] p-1" aria-label="Workflow stages">
      {STAGES.map((stage, i) => {
        const st = states[i]
        return (
          <li key={stage} className="min-w-[84px] flex-1">
            <span
              className={cx(
                'flex h-8 items-center justify-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors',
                st === 'done' && 'text-ink',
                st === 'active' && 'bg-white/[0.12] text-ink shadow-[0_1px_2px_rgba(0,0,0,0.3)]',
                st === 'attention' && 'bg-recover/14 text-recover',
                st === 'idle' && 'text-ink-mute',
                st === 'skipped' && 'text-ink-mute/50 line-through decoration-1',
              )}
              aria-current={st === 'active' || st === 'attention' ? 'step' : undefined}
            >
              <span
                className={cx(
                  'size-1.5 shrink-0 rounded-full',
                  st === 'done' ? 'bg-verified' : st === 'active' ? 'animate-pulse bg-lav-300' : st === 'attention' ? 'bg-recover' : 'bg-white/20',
                )}
                aria-hidden
              />
              {stage}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

// ----- assurance ladder ----------------------------------------------------------------------------------
const LADDER = ['PROPOSED', 'AUTHORIZED', 'ACCEPTED', 'VERIFIED'] as const

export function AssuranceLadder({ step }: { step: Step }) {
  const a = step.assurance
  const level = a === 'FAILED' || a === 'UNKNOWN' ? 2 : LADDER.indexOf(a as (typeof LADDER)[number])
  const final = a === 'FAILED' ? 'Failed' : a === 'UNKNOWN' ? 'Unknown' : 'Verified'
  const labels = ['Proposed', 'Authorized', step.action === 'read_device' ? 'Read' : 'Accepted', final]
  return (
    <div className="flex items-center gap-1" aria-label={`Assurance: ${a.toLowerCase()}`}>
      {labels.map((label, i) => {
        const reached = i <= level || (i === 3 && (a === 'FAILED' || a === 'UNKNOWN'))
        const color =
          i === 3 && a === 'FAILED'
            ? 'bg-failed text-failed'
            : i === 3 && a === 'UNKNOWN'
              ? 'bg-unknown text-unknown'
              : reached
                ? i === 3
                  ? 'bg-verified text-verified'
                  : 'bg-lav-300 text-lav-300'
                : 'bg-white/12 text-ink-mute'
        return (
          <div key={label} className="flex items-center gap-1">
            <span className={cx('h-[3px] w-5 rounded-full sm:w-6', color.split(' ')[0])} />
            <span className={cx('hidden text-[11px] font-medium md:inline', reached ? color.split(' ')[1] : 'text-ink-mute/60')}>
              {label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ----- evidence --------------------------------------------------------------------------------------------
const EVIDENCE_META: Record<Evidence['kind'], { icon: typeof Eye; label: string; tone: string }> = {
  note: { icon: PenLine, label: 'Note', tone: 'text-ink-mute' },
  approval: { icon: Hand, label: 'Authorization', tone: 'text-lav-300' },
  precheck: { icon: Eye, label: 'Pre-check', tone: 'text-ink-soft' },
  ack: { icon: ClipboardList, label: 'Service ack', tone: 'text-lav-300' },
  state_read: { icon: Eye, label: 'State read', tone: 'text-verified' },
  verification: { icon: Microscope, label: 'Verification', tone: 'text-verified' },
  diagnosis: { icon: Stethoscope, label: 'Diagnosis', tone: 'text-recover' },
}

function EvidenceItem({ ev }: { ev: Evidence }) {
  const [open, setOpen] = useState(false)
  const meta = EVIDENCE_META[ev.kind]
  const Icon = meta.icon
  const mismatch = ev.kind === 'verification' && (ev.data as any)?.verdict === 'MISMATCH'
  const hasData = ev.data && Object.keys(ev.data).length > 0
  return (
    <li className="relative pl-7">
      <span className="absolute left-0 top-0.5 grid size-5 place-items-center rounded-full bg-night-800 ring-1 ring-white/10">
        <Icon className={cx('size-3', mismatch ? 'text-failed' : meta.tone)} aria-hidden />
      </span>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={cx('text-[12px] font-semibold', mismatch ? 'text-failed' : meta.tone)}>{meta.label}</span>
        <span className="font-mono text-[10px] text-ink-mute">{ev.source} · {clock(ev.at)}</span>
      </div>
      <p className="text-sm text-ink-soft">{ev.summary}</p>
      {hasData && (
        <button onClick={() => setOpen(!open)} className="mt-0.5 text-[11px] font-semibold text-lav-300/80 hover:text-lav-200" aria-expanded={open}>
          {open ? 'Hide raw evidence' : 'Inspect raw evidence'}
        </button>
      )}
      {open && (
        <pre className="scroll-thin mt-1.5 max-h-56 overflow-auto rounded-xl bg-black/25 p-3 font-mono text-[11px] leading-relaxed text-ink-soft ring-1 ring-white/6">
          {JSON.stringify(ev.data, null, 2)}
        </pre>
      )}
    </li>
  )
}

function ExpectedObserved({ step }: { step: Step }) {
  const ver = [...step.evidence].reverse().find((e) => e.kind === 'verification')
  const observed = (ver?.data as any)?.observed
  if (!ver || !observed || step.action === 'read_device') return null
  const keys = Object.keys(step.expected)
  if (keys.length === 0) return null
  return (
    <div className="grid grid-cols-[auto_1fr_1fr] gap-x-4 gap-y-1.5 rounded-2xl bg-black/20 p-3.5 text-xs">
      <span />
      <span className="font-medium text-ink-mute">Expected</span>
      <span className="font-medium text-ink-mute">Observed (independent read)</span>
      {keys.map((k) => {
        const exp = String(step.expected[k])
        const obs = observed[k] === undefined ? '—' : String(observed[k])
        const match = exp === obs
        return (
          <div key={k} className="contents">
            <span className="font-mono text-ink-mute">{k}</span>
            <span className="font-mono text-ink">{exp}</span>
            <span className={cx('font-mono font-bold', match ? 'text-verified' : 'text-failed')}>
              {obs} {match ? '✓' : '✗'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ----- step card --------------------------------------------------------------------------------------------
export function StepCard({
  step,
  onDecide,
  onRecover,
  busy,
}: {
  step: Step
  onDecide: (approve: boolean) => void
  onRecover: (optionId: string) => void
  busy: string | null
}) {
  const active = ['RUNNING', 'VERIFYING', 'RECOVERING', 'AWAITING_APPROVAL'].includes(step.status) || step.recovery_options.length > 0
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? (active || step.status === 'FAILED' || step.status === 'UNKNOWN')
  const tone = stepTone(step.status)
  const riskReason = step.evidence.find((e) => e.source === 'policy' && e.kind === 'note')?.summary.replace(/^Risk \w+: /, '')

  return (
    <li
      className={cx(
        'card animate-rise overflow-hidden transition-all',
        step.recovery_options.length > 0 && 'border-recover/35',
        step.status === 'AWAITING_APPROVAL' && 'border-recover/30',
        (step.status === 'RUNNING' || step.status === 'VERIFYING') && 'border-lav-300/30',
      )}
    >
      <button onClick={() => setOpen(!expanded)} className="flex w-full items-start gap-3 p-4 text-left sm:p-5" aria-expanded={expanded}>
        <StatusIcon status={step.status} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[16px] font-semibold tracking-tight">{step.title}</span>
            <Badge tone={tone}>{STEP_STATUS_LABEL[step.status]}</Badge>
            {step.risk === 'SENSITIVE' && <Badge tone="recover"><ShieldAlert className="size-3" /> Sensitive</Badge>}
            {step.risk === 'READ_ONLY' && <Badge tone="mute">Read-only</Badge>}
            {step.attempts > 1 && <Badge tone="lav">Attempt {step.attempts}/{step.max_attempts}</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-ink-mute">{step.rationale}</p>
          <div className="mt-2">
            <AssuranceLadder step={step} />
          </div>
        </div>
        <ChevronDown className={cx('mt-1 size-4 shrink-0 text-ink-mute transition-transform', expanded && 'rotate-180')} aria-hidden />
      </button>

      {step.status === 'AWAITING_APPROVAL' && (
        <div className="mx-4 mb-4 rounded-2xl bg-recover/[0.08] p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-recover">
            <Hand className="size-4" /> This step needs your confirmation
          </div>
          <p className="mt-1 text-sm text-ink-soft">{riskReason}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="warn" onClick={() => onDecide(true)} busy={busy === `decide:${step.id}:true`}>
              Confirm: {step.title.toLowerCase()}
            </Button>
            <Button variant="ghost" onClick={() => onDecide(false)} busy={busy === `decide:${step.id}:false`}>
              Skip this step
            </Button>
          </div>
        </div>
      )}

      {step.recovery_options.length > 0 && (
        <div className="mx-4 mb-4 rounded-2xl bg-recover/[0.08] p-4" role="region" aria-label="Recovery options">
          <div className="flex items-center gap-2 text-sm font-semibold text-recover">
            <Wrench className="size-4" /> {step.status === 'UNKNOWN' ? "Couldn't confirm this step" : 'Verification failed'}
          </div>
          <p className="mt-1 text-sm text-ink">{step.error}</p>
          {(() => {
            const d = [...step.evidence].reverse().find((e) => e.kind === 'diagnosis')
            return d ? <p className="mt-2 text-sm text-ink-soft"><span className="font-semibold text-recover">Why: </span>{d.summary}</p> : null
          })()}
          <div className="mt-3 grid gap-2">
            {step.recovery_options.map((o) => (
              <button
                key={o.id}
                onClick={() => onRecover(o.id)}
                disabled={!!busy}
                className={cx(
                  'flex items-start gap-3 rounded-[16px] p-3.5 text-left ring-1 ring-inset transition active:scale-[0.99] disabled:opacity-50',
                  o.recommended ? 'bg-recover/14 ring-recover/35 hover:bg-recover/20' : 'bg-white/[0.05] ring-transparent hover:bg-white/[0.09]',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {o.label}
                    {o.recommended && <Badge tone="recover">Recommended</Badge>}
                    {o.risk === 'SENSITIVE' && <Badge tone="mute">Your approval</Badge>}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-soft">{o.explanation}</span>
                </span>
                {busy === `recover:${step.id}:${o.id}` && <span className="text-xs text-ink-mute">Working…</span>}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-ink-mute">Attempts used: {step.attempts} of {step.max_attempts}. AURA will not retry beyond this.</p>
        </div>
      )}

      {expanded && (
        <div className="space-y-3 border-t border-white/[0.06] px-4 pb-4 pt-3.5 sm:px-5">
          {step.provenance && (
            <p className="flex items-start gap-2 text-xs text-ink-soft">
              <Fingerprint className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {step.provenance}
            </p>
          )}
          <ExpectedObserved step={step} />
          {step.error && step.recovery_options.length === 0 && (
            <p className={cx('text-sm', step.status === 'VERIFIED' ? 'text-ink-mute' : 'text-failed')}>{step.error}</p>
          )}
          <ol className="relative space-y-3 before:absolute before:bottom-1 before:left-2.5 before:top-1 before:w-px before:bg-white/8">
            {step.evidence.map((ev, i) => (
              <EvidenceItem key={i} ev={ev} />
            ))}
          </ol>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-ink-mute">
            <span>step {step.id}</span>
            <span>target {step.target}</span>
            <span title="Each attempt derives a fresh key from this one; a reused key is never re-applied">idempotency {step.idempotency_key}</span>
          </div>
        </div>
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
      <div className="border-b border-white/[0.06] p-4">
        <h2 id="toollog-title" className="flex items-center gap-2 text-[15px] font-semibold">
          <ScrollText className="size-4 text-ink-soft" /> MCP tool activity
        </h2>
        <p className="mt-0.5 text-[11px] text-ink-mute">
          Every household effect is a real MCP tools/call
          {transport && ` over ${transport === 'streamable-http' ? 'Streamable HTTP' : transport}`}
          {proto && ` · protocol ${proto}`}
        </p>
      </div>
      <ol className="scroll-thin flex-1 space-y-1 overflow-y-auto p-2" aria-live="polite">
        {calls.length === 0 && <li className="p-3 text-xs text-ink-mute">No tool calls yet.</li>}
        {calls.map((c) => {
          const d = c.data
          const verdict = d.result?.verdict as string | undefined
          const open = openSeq === c.seq
          return (
            <li key={c.seq} className="animate-rise">
              <button
                onClick={() => setOpenSeq(open ? null : c.seq)}
                className="flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left hover:bg-white/[0.05]"
                aria-expanded={open}
              >
                <span className={cx('size-1.5 shrink-0 rounded-full', !d.ok ? 'bg-failed' : verdict === 'MISMATCH' ? 'bg-failed' : verdict === 'UNKNOWN' ? 'bg-unknown' : d.tool === 'set_device_state' || d.tool === 'retry_failed_action' ? 'bg-lav-300' : 'bg-verified')} />
                <span className="font-mono text-[12px] text-ink">{d.tool}</span>
                {verdict && (
                  <span className={cx('font-mono text-[10px] font-bold', verdict === 'VERIFIED' ? 'text-verified' : verdict === 'MISMATCH' ? 'text-failed' : 'text-unknown')}>
                    {verdict}
                  </span>
                )}
                {d.tool === 'set_device_state' && d.ok && <span className="font-mono text-[10px] text-lav-300">ACK</span>}
                {!d.ok && <span className="font-mono text-[10px] font-bold text-failed">ERROR</span>}
                <span className="ml-auto font-mono text-[10px] text-ink-mute">{d.duration_ms}ms</span>
              </button>
              {open && (
                <div className="mx-2 mb-2 space-y-1 rounded-xl bg-black/25 p-3 font-mono text-[11px]">
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
    <div className={cx('card flex items-start gap-3 p-4 sm:p-5', good ? 'border-verified/25' : 'border-recover/25')}>
      <BadgeCheck className={cx('mt-0.5 size-5 shrink-0', good ? 'text-verified' : 'text-recover')} aria-hidden />
      <div>
        <div className={cx('text-[15px] font-semibold', good ? 'text-verified' : 'text-recover')}>
          {good ? 'Everything verified' : run.status === 'CANCELLED' ? 'Cancelled' : 'Finished, with issues'}
        </div>
        <p className="text-sm text-ink-soft">{run.final_report}</p>
      </div>
    </div>
  )
}
