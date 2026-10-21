import type { Device, RunStatus, StepStatus } from './types'

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

export function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Good night'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export function deviceSummary(d: Device): string {
  if (!d.reachable || !d.state) return 'Not responding'
  const s = d.state
  switch (d.type) {
    case 'thermostat':
      return `${s.setpoint_f}°F${s.hold && s.hold !== 'none' ? ' · energy-saver hold' : ''}`
    case 'lock':
      return s.locked ? 'Locked' : 'Unlocked'
    case 'light':
      return s.power === 'on' ? `On · ${s.brightness}%` : 'Off'
    default:
      return s.power === 'on' ? 'On' : 'Off'
  }
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  AWAITING_APPROVAL: 'Awaiting approval',
  RUNNING: 'Running',
  PAUSED: 'Needs you',
  COMPLETED: 'Verified',
  COMPLETED_WITH_ISSUES: 'Done with issues',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
}

export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  PENDING: 'Pending',
  AWAITING_APPROVAL: 'Needs confirmation',
  RUNNING: 'Running',
  VERIFYING: 'Verifying',
  VERIFIED: 'Verified',
  FAILED: 'Failed',
  UNKNOWN: 'Unknown',
  RECOVERING: 'Recovering',
  CANCELLED: 'Skipped',
}

export type Tone = 'verified' | 'recover' | 'failed' | 'unknown' | 'lav' | 'mute'

export function runTone(s: RunStatus): Tone {
  switch (s) {
    case 'COMPLETED':
      return 'verified'
    case 'COMPLETED_WITH_ISSUES':
    case 'PAUSED':
      return 'recover'
    case 'FAILED':
      return 'failed'
    case 'CANCELLED':
      return 'mute'
    default:
      return 'lav'
  }
}

export function stepTone(s: StepStatus): Tone {
  switch (s) {
    case 'VERIFIED':
      return 'verified'
    case 'FAILED':
      return 'failed'
    case 'UNKNOWN':
      return 'unknown'
    case 'RECOVERING':
    case 'AWAITING_APPROVAL':
      return 'recover'
    case 'CANCELLED':
    case 'PENDING':
      return 'mute'
    default:
      return 'lav'
  }
}

export const TONE_CLASSES: Record<Tone, string> = {
  verified: 'text-verified bg-verified/10 ring-verified/30',
  recover: 'text-recover bg-recover/10 ring-recover/30',
  failed: 'text-failed bg-failed/10 ring-failed/30',
  unknown: 'text-unknown bg-unknown/10 ring-unknown/30',
  lav: 'text-lav-300 bg-lav-400/10 ring-lav-400/30',
  mute: 'text-ink-mute bg-white/5 ring-white/10',
}
