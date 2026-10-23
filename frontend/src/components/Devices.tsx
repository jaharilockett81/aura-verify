import { useCallback, useEffect, useState } from 'react'
import { Lamp, Lightbulb, Lock, LockOpen, Thermometer, Waves, WifiOff } from 'lucide-react'
import { api } from '../lib/api'
import { useAuraEvents } from '../lib/aura'
import { deviceSummary } from '../lib/format'
import type { Device } from '../lib/types'
import { Badge, cx } from './ui'

function DeviceIcon({ d }: { d: Device }) {
  const on = d.state?.power === 'on'
  const c = 'size-[18px]'
  if (!d.reachable) return <WifiOff className={cx(c, 'text-unknown')} />
  switch (d.type) {
    case 'thermostat':
      return <Thermometer className={cx(c, d.state?.hold === 'energy_saver' ? 'text-recover' : 'text-lav-300')} />
    case 'lock':
      return d.state?.locked ? <Lock className={cx(c, 'text-verified')} /> : <LockOpen className={cx(c, 'text-ink-soft')} />
    case 'light':
      return d.device_id === 'bedroom_lights' ? (
        <Lamp className={cx(c, on ? 'text-recover' : 'text-ink-mute')} />
      ) : (
        <Lightbulb className={cx(c, on ? 'text-recover' : 'text-ink-mute')} />
      )
    default:
      return <Waves className={cx(c, on ? 'text-lav-300' : 'text-ink-mute')} />
  }
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

export function DeviceStrip() {
  const { devices, faults } = useDevices()
  return (
    <ul className="grid grid-cols-1 gap-1 rounded-3xl bg-white/[0.025] p-1.5 ring-1 ring-white/6 sm:grid-cols-2">
      {devices.map((d) => {
        const faulty = !!faults[d.device_id]
        return (
          <li key={d.device_id} className="flex items-center gap-3 rounded-2xl px-3 py-2.5">
            <span className={cx('grid size-9 shrink-0 place-items-center rounded-full bg-night-950/50 ring-1', faulty ? 'ring-recover/40' : 'ring-white/8')}>
              <DeviceIcon d={d} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold">{d.name}</span>
              <span className={cx('block truncate text-xs', d.reachable ? 'text-ink-soft' : 'text-unknown')}>
                {deviceSummary(d)}
              </span>
            </span>
            {faulty && <Badge tone="recover">sim fault</Badge>}
          </li>
        )
      })}
    </ul>
  )
}
