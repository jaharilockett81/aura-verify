import { cx } from './ui'

export type OrbState = 'idle' | 'listening' | 'thinking' | 'working' | 'attention'

/** AURA's presence indicator, a calm cousin of the Echo light ring. Colour encodes state, not decoration. */
export function Orb({ state, size = 56 }: { state: OrbState; size?: number }) {
  const ring =
    state === 'attention'
      ? 'from-recover via-recover-deep to-recover'
      : state === 'listening'
        ? 'from-verified via-lav-300 to-verified'
        : 'from-lav-300 via-verified to-lav-500'
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`AURA is ${state === 'idle' ? 'ready' : state}`}
    >
      <div
        className={cx(
          'absolute inset-0 rounded-full bg-gradient-to-tr opacity-90 blur-[1px]',
          ring,
          state === 'idle' ? 'animate-breathe' : 'animate-spin-slow',
        )}
      />
      <div className="absolute inset-[3px] rounded-full bg-night-900" />
      <div
        className={cx(
          'absolute inset-[22%] rounded-full bg-gradient-to-br transition-all',
          state === 'attention' ? 'from-recover/70 to-recover-deep/40' : 'from-lav-300/60 to-verified/30',
          (state === 'listening' || state === 'thinking') && 'animate-pulse',
        )}
      />
    </div>
  )
}
