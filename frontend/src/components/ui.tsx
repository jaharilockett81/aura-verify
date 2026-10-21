import type { ButtonHTMLAttributes, ReactNode } from 'react'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  Hand,
  Loader2,
  RotateCcw,
  ScanEye,
  XCircle,
} from 'lucide-react'
import type { StepStatus } from '../lib/types'
import { TONE_CLASSES } from '../lib/format'
import type { Tone } from '../lib/format'

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ')
}

export function Badge({ tone = 'mute', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide ring-1 ring-inset whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warn' | 'verified'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-gradient-to-b from-lav-300 to-lav-400 text-night-950 hover:from-lav-200 hover:to-lav-300 shadow-[0_6px_24px_-8px_rgba(167,139,250,0.7)]',
  secondary: 'bg-white/6 text-ink ring-1 ring-inset ring-white/10 hover:bg-white/10',
  ghost: 'text-ink-soft hover:text-ink hover:bg-white/6',
  danger: 'bg-failed/15 text-failed ring-1 ring-inset ring-failed/30 hover:bg-failed/25',
  warn: 'bg-gradient-to-b from-recover to-recover-deep text-night-950 hover:brightness-110 shadow-[0_6px_24px_-10px_rgba(251,191,36,0.8)]',
  verified: 'bg-verified/15 text-verified ring-1 ring-inset ring-verified/30 hover:bg-verified/25',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  busy,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none cursor-pointer',
        size === 'sm' && 'px-3 py-1.5 text-xs',
        size === 'md' && 'px-4 py-2 text-sm',
        size === 'lg' && 'px-5 py-3 text-base',
        VARIANTS[variant],
        className,
      )}
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

export function StatusIcon({ status, className }: { status: StepStatus; className?: string }) {
  const c = cx('size-5 shrink-0', className)
  switch (status) {
    case 'VERIFIED':
      return <CheckCircle2 className={cx(c, 'text-verified')} aria-label="Verified" />
    case 'FAILED':
      return <XCircle className={cx(c, 'text-failed')} aria-label="Failed" />
    case 'UNKNOWN':
      return <CircleHelp className={cx(c, 'text-unknown')} aria-label="Unknown" />
    case 'RUNNING':
      return <Loader2 className={cx(c, 'text-lav-300 animate-spin')} aria-label="Running" />
    case 'VERIFYING':
      return <ScanEye className={cx(c, 'text-verified animate-pulse')} aria-label="Verifying" />
    case 'RECOVERING':
      return <RotateCcw className={cx(c, 'text-recover animate-spin-slow')} aria-label="Recovering" />
    case 'AWAITING_APPROVAL':
      return <Hand className={cx(c, 'text-recover')} aria-label="Needs confirmation" />
    case 'CANCELLED':
      return <Ban className={cx(c, 'text-ink-mute')} aria-label="Skipped" />
    default:
      return <CircleDashed className={cx(c, 'text-ink-mute')} aria-label="Pending" />
  }
}

export function SectionTitle({ children, action, id }: { children: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 id={id} className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-mute">
        {children}
      </h2>
      {action}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-ink-mute">{children}</p>
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-xl bg-failed/10 px-3 py-2 text-sm text-failed ring-1 ring-failed/25">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}
