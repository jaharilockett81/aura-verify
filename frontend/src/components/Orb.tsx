import { useEffect, useState } from 'react'
import type { Run } from '../lib/types'

export type OrbState = 'idle' | 'listening' | 'processing' | 'approval' | 'verified' | 'failure' | 'recovering'

const LABEL: Record<OrbState, string> = {
  idle: 'AURA is ready',
  listening: 'AURA is listening',
  processing: 'AURA is working',
  approval: 'AURA is waiting for your approval',
  verified: 'Verified',
  failure: 'AURA found a problem',
  recovering: 'AURA is recovering a failed step',
}

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  })
  useEffect(() => {
    let mq: MediaQueryList
    try {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    } catch {
      return
    }
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

/**
 * Maps real application state onto the orb. Nothing here is simulated for show:
 * listening comes from the speech recognizer, processing from an in-flight request or a
 * running step, and verified only from a run the engine finished as COMPLETED.
 */
export function deriveOrbState(run: Run | null, opts: { listening?: boolean; thinking?: boolean; now?: number }): OrbState {
  if (opts.listening) return 'listening'
  if (opts.thinking) return 'processing'
  if (!run) return 'idle'
  const steps = run.steps
  if (steps.some((s) => s.status === 'RECOVERING')) return 'recovering'
  if (steps.some((s) => s.recovery_options.length > 0)) return 'failure'
  if (run.status === 'AWAITING_APPROVAL' || steps.some((s) => s.status === 'AWAITING_APPROVAL')) return 'approval'
  if (run.status === 'RUNNING' || steps.some((s) => s.status === 'RUNNING' || s.status === 'VERIFYING')) return 'processing'
  const recent = run.finished_at && (opts.now ?? Date.now()) - new Date(run.finished_at).getTime() < 6000
  if (recent && run.status === 'COMPLETED') return 'verified'
  if (recent && (run.status === 'FAILED' || run.status === 'COMPLETED_WITH_ISSUES')) return 'failure'
  return 'idle'
}

/** Re-evaluates time-boxed states (the short "verified" glow) without new events. */
export function useOrbState(run: Run | null, opts: { listening?: boolean; thinking?: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  const state = deriveOrbState(run, { ...opts, now })
  useEffect(() => {
    if (!run?.finished_at) return
    const left = 6000 - (Date.now() - new Date(run.finished_at).getTime())
    if (left <= 0) return
    const t = setTimeout(() => setNow(Date.now()), left + 50)
    return () => clearTimeout(t)
  }, [run?.finished_at])
  return state
}

/** AURA's presence: a pearlescent, slowly flowing sphere whose motion and tint follow real state. */
export function AuraOrb({ state, size = 160, reducedMotion }: { state: OrbState; size?: number; reducedMotion?: boolean }) {
  const systemReduced = usePrefersReducedMotion()
  const reduced = reducedMotion ?? systemReduced
  return (
    <div
      className="aura-orb shrink-0"
      data-state={state}
      data-reduced={reduced ? 'true' : 'false'}
      style={{ width: size, height: size * 1.14 }}
      role="img"
      aria-label={LABEL[state]}
    >
      <div className="relative" style={{ width: size, height: size }}>
        <span className="aura-orb__halo" aria-hidden />
        {state === 'listening' && !reduced && (
          <>
            <span className="aura-orb__ripple" aria-hidden />
            <span className="aura-orb__ripple" aria-hidden />
            <span className="aura-orb__ripple" aria-hidden />
          </>
        )}
        <span className="aura-orb__body" aria-hidden>
          <span className="aura-orb__flow">
            <span className="aura-orb__blob aura-orb__blob--pink" />
            <span className="aura-orb__blob aura-orb__blob--sage" />
          </span>
          <span className="aura-orb__flow aura-orb__flow--b">
            <span className="aura-orb__blob aura-orb__blob--blue" />
            <span className="aura-orb__blob aura-orb__blob--lav" />
          </span>
          <span className="aura-orb__tint" />
          <span className="aura-orb__shine" />
        </span>
        {state === 'verified' && !reduced && <span key="confirm" className="aura-orb__confirm" aria-hidden />}
      </div>
      <span className="aura-orb__floor" style={{ width: size * 0.6, height: size * 0.1, top: size * 1.02 }} aria-hidden />
    </div>
  )
}

/** Back-compat alias. */
export const Orb = AuraOrb
