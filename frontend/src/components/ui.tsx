import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-semibold ring-1 ring-inset whitespace-nowrap transition-colors duration-300',
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
  primary: 'bg-forest text-white hover:bg-[#286b4a] shadow-[0_6px_16px_-8px_rgba(46,122,85,0.7)]',
  secondary: 'bg-white/80 text-ink ring-1 ring-inset ring-white hover:bg-white shadow-[0_2px_8px_-4px_rgba(23,52,61,0.18)]',
  ghost: 'text-ink-soft hover:text-ink hover:bg-white/60',
  danger: 'bg-[#fadbe2] text-[#c4475d] hover:bg-[#f7cdd6]',
  warn: 'bg-[#f3c8a0] text-[#6b3e17] hover:bg-[#efbd8f]',
  verified: 'bg-[#d9eee0] text-verified-deep hover:bg-[#cce7d6]',
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
        'pressable inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold disabled:opacity-45 disabled:pointer-events-none cursor-pointer',
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
      <h2 id={id} className="px-1 text-[17px] font-semibold tracking-tight text-ink">
        {children}
      </h2>
      {action}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="card px-4 py-8 text-center text-sm text-ink-soft">{children}</p>
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-2xl bg-[#fadbe2]/90 px-3.5 py-2.5 text-sm text-[#c4475d]">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

/** iOS-style segmented control with a sliding selection indicator. Arrow keys move the selection. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  kind = 'radio',
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  label: string
  className?: string
  kind?: 'radio' | 'tabs'
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const [box, setBox] = useState<{ x: number; w: number } | null>(null)
  const idx = Math.max(0, options.findIndex((o) => o.value === value))
  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[idx]
      if (el) setBox({ x: el.offsetLeft, w: el.offsetWidth })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [idx, options.length, options.map((o) => o.label).join('|')])

  function onKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = (idx + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length
    onChange(options[next].value)
    refs.current[next]?.focus()
  }

  return (
    <div
      role={kind === 'tabs' ? 'tablist' : 'radiogroup'}
      aria-label={label}
      onKeyDown={onKey}
      className={cx('relative inline-flex w-full rounded-full border border-white/80 bg-white/45 p-1 backdrop-blur-xl sm:w-auto', className)}
    >
      {box && (
        <span
          aria-hidden
          className="absolute top-1 bottom-1 rounded-full bg-forest shadow-[0_4px_12px_-6px_rgba(46,122,85,0.8)] transition-[transform,width] duration-300 ease-[var(--ease-spring)]"
          style={{ transform: `translateX(${box.x - 4}px)`, width: box.w, left: 4 }}
        />
      )}
      {options.map((o, i) => {
        const on = value === o.value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            role={kind === 'tabs' ? 'tab' : 'radio'}
            aria-checked={kind === 'radio' ? on : undefined}
            aria-selected={kind === 'tabs' ? on : undefined}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cx(
              'relative z-10 h-8 flex-1 whitespace-nowrap rounded-full px-4 text-[14px] font-medium transition-colors duration-200 sm:flex-none',
              on ? 'text-white' : 'text-ink-soft hover:text-ink',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Smoothly expanding region. Content mounts on first open so collapsed rows stay light. */
export function Expander({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) setMounted(true)
  }, [open])
  return (
    <div className={cx('expander', className)} data-open={open ? 'true' : 'false'} aria-hidden={!open}>
      <div>{mounted && children}</div>
    </div>
  )
}
