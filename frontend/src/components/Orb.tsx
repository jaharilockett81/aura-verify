import { cx } from './ui'

export type OrbState = 'idle' | 'listening' | 'thinking' | 'working' | 'attention'

/** AURA's presence: a pearlescent sphere that breathes quietly. Its halo changes with state. */
export function Orb({ state, size = 160 }: { state: OrbState; size?: number }) {
  const halo =
    state === 'attention'
      ? 'rgba(240, 180, 120, 0.55)'
      : state === 'listening'
        ? 'rgba(140, 210, 180, 0.6)'
        : state === 'thinking' || state === 'working'
          ? 'rgba(180, 200, 240, 0.55)'
          : 'rgba(255, 255, 255, 0)'
  return (
    <div className="relative shrink-0" style={{ width: size, height: size * 1.12 }} role="img" aria-label={`AURA is ${state === 'idle' ? 'ready' : state}`}>
      <div
        className={cx('orb absolute inset-x-0 top-0 transition-shadow duration-700', state === 'idle' ? 'animate-breathe' : 'animate-pulse')}
        style={{ width: size, height: size, outline: `${Math.round(size / 14)}px solid ${halo}`, outlineOffset: 2 }}
      />
      {/* soft contact shadow */}
      <div
        className="absolute left-1/2 -translate-x-1/2 rounded-[50%] bg-[#8a7f92]/25 blur-md"
        style={{ width: size * 0.62, height: size * 0.09, top: size * 1.02 }}
      />
    </div>
  )
}
