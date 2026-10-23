import { useCallback, useEffect, useState } from 'react'
import { AudioWaveform, Bell, Lightbulb, Lock, LockOpen, Sparkles, Thermometer, WifiOff } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api } from '../lib/api'
import { useAuraEvents } from '../lib/aura'
import { deviceSummary } from '../lib/format'
import type { Device, Step } from '../lib/types'
import { Badge, cx } from './ui'

/** Pastel icon chip per device kind, as in the reference. */
const KIND: Record<string, { icon: LucideIcon; tint: string; color: string }> = {
  thermostat: { icon: Thermometer, tint: 'bg-white/90', color: 'text-ink' },
  lock: { icon: Lock, tint: 'bg-white/90', color: 'text-[#c9814a]' },
  unlock: { icon: LockOpen, tint: 'bg-white/90', color: 'text-[#c9814a]' },
  light: { icon: Lightbulb, tint: 'bg-white/90', color: 'text-ink' },
  lamp: { icon: Lightbulb, tint: 'bg-white/90', color: 'text-ink' },
  plug: { icon: AudioWaveform, tint: 'bg-white/90', color: 'text-[#5a5fa8]' },
  reminder: { icon: Bell, tint: 'bg-[#ece8f4]', color: 'text-[#7c6fa6]' },
  memory: { icon: Sparkles, tint: 'bg-[#e3efe5]', color: 'text-verified-deep' },
  offline: { icon: WifiOff, tint: 'bg-mist', color: 'text-unknown' },
}

export function kindForDevice(id: string, type?: string, locked?: boolean) {
  if (type === 'lock' || id === 'front_door') return locked === false ? 'unlock' : 'lock'
  if (type === 'thermostat' || id === 'thermostat') return 'thermostat'
  if (type === 'plug' || id === 'white_noise') return 'plug'
  if (id === 'bedroom_lights') return 'lamp'
  return 'light'
}

export function kindForStep(step: Step) {
  if (step.action === 'create_reminder') return 'reminder'
  if (step.action === 'update_preference') return 'memory'
  return kindForDevice(step.target.replace(/^device:/, ''))
}

export function Glyph({ kind, size = 40, className }: { kind: string; size?: number; className?: string }) {
  const k = KIND[kind] ?? KIND.light
  const Icon = k.icon
  return (
    <span
      className={cx('grid shrink-0 place-items-center rounded-full shadow-[0_2px_6px_-3px_rgba(23,52,61,0.2)]', k.tint, className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Icon className={k.color} style={{ width: size * 0.48, height: size * 0.48 }} strokeWidth={1.6} />
    </span>
  )
}

export function useDevices() {
  const [devices, setDevices] = useState<Device[]>([])
  const [faults, setFaults] = useState<Record<string, Record<string, unknown>>>({})
  const load = useCallback(() => {
    api.devices().then((d) => {
      setDevices(d.devices)
      setFaults(d.faults)
    }).catch(() => undefined)
  }, [])
  useEffect(() => {
    load()
    const t = setInterval(load, 4000) // simulator settles asynchronously; keep the dashboard honest
    return () => clearInterval(t)
  }, [load])
  useAuraEvents((e) => {
    if (e.type === 'tool.call' || e.type === 'run.finished') load()
  })
  return { devices, faults }
}

const PRIMARY = ['bedroom_lights', 'thermostat', 'front_door', 'white_noise']

/** Two-column household status grid. Values are live simulator state. */
export function DeviceGrid({ all }: { all: boolean }) {
  const { devices, faults } = useDevices()
  const shown = all ? devices : PRIMARY.map((id) => devices.find((d) => d.device_id === id)).filter((d): d is Device => !!d)
  return (
    <ul className="grid grid-cols-2 gap-2.5">
      {shown.map((d) => {
        const faulty = !!faults[d.device_id]
        const name = d.device_id === 'front_door' ? 'Front door' : d.name
        return (
          <li key={d.device_id} className="card flex min-h-[64px] animate-rise items-center gap-2.5 rounded-[18px] px-3 py-2.5 transition-shadow duration-200 hover:shadow-[0_12px_30px_-16px_rgba(23,52,61,0.35)] lg:min-h-[76px] lg:gap-3 lg:px-4">
            <Glyph kind={d.reachable ? kindForDevice(d.device_id, d.type, d.state?.locked) : 'offline'} size={38} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium leading-tight lg:text-[16px]">{name}</span>
              <span className={cx('mt-1 block text-[12px] leading-tight transition-colors lg:text-[14px]', d.reachable ? 'text-ink-soft' : 'text-unknown')}>
                {deviceSummary(d)}
              </span>
              {faulty && <Badge tone="recover" className="mt-1">sim fault</Badge>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
