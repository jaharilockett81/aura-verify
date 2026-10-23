import { cx } from './ui'

export type OrbState = 'idle' | 'listening' | 'thinking' | 'working' | 'attention'

/** AURA's presence indicator: a softly lit sphere. Colour encodes state, not decoration. */
export function Orb({ state, size = 56 }: { state: OrbState; size?: number }) {
  const tint =
    state === 'attention'
      ? 'rgba(242,188,87,0.9)'
      : state === 'listening'
        ? 'rgba(70,209,194,0.9)'
        : 'rgba(124,201,255,0.85)'
  return (
    <div
      className={cx('relative shrink-0 rounded-full', state === 'idle' ? 'animate-breathe' : (state === 'listening' || state === 'thinking') && 'animate-pulse')}
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 32% 28%, rgba(255,255,255,0.85), ${tint} 22%, rgba(142,162,255,0.55) 58%, rgba(17,24,39,0.9) 100%)`,
        boxShadow: '0 10px 30px -12px rgba(0,0,0,0.7), inset 0 -6px 14px rgba(11,16,32,0.55)',
      }}
      role="img"
      aria-label={`AURA is ${state === 'idle' ? 'ready' : state}`}
    />
  )
}
