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
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset whitespace-nowrap',
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
  primary: 'bg-lav-300 text-night-950 hover:bg-lav-200 shadow-[0_1px_2px_rgba(0,0,0,0.3)]',
  secondary: 'bg-white/[0.09] text-ink hover:bg-white/[0.13]',
  ghost: 'text-ink-soft hover:text-ink hover:bg-white/[0.06]',
  danger: 'bg-failed/14 text-failed hover:bg-failed/22',
  warn: 'bg-recover text-night-950 hover:brightness-105 shadow-[0_1px_2px_rgba(0,0,0,0.3)]',
  verified: 'bg-verified/14 text-verified hover:bg-verified/22',
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
        'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold transition-all duration-150 active:scale-[0.97] disabled:opacity-45 disabled:pointer-events-none cursor-pointer',
        size === 'sm' && 'h-8 px-3.5 text-xs',
        size === 'md' && 'h-10 px-4 text-sm',
        size === 'lg' && 'h-12 px-6 text-[15px]',
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
      <h2 id={id} className="px-1 text-[13px] font-medium uppercase tracking-[0.06em] text-ink-mute">
        {children}
      </h2>
      {action}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="card px-4 py-8 text-center text-sm text-ink-mute">{children}</p>
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-2xl bg-failed/10 px-3.5 py-2.5 text-sm text-failed">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

/** iOS-style segmented control. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  label: string
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx('inline-flex w-full rounded-[12px] bg-white/[0.07] p-0.5 sm:w-auto', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'h-8 flex-1 rounded-[10px] px-4 text-[13px] font-medium transition-all sm:flex-none',
            value === o.value ? 'bg-night-500/80 text-ink shadow-[0_2px_6px_rgba(0,0,0,0.35)]' : 'text-ink-soft hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
