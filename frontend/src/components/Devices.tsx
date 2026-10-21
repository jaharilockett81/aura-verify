import { useCallback, useEffect, useState } from 'react'
import { Lamp, Lightbulb, Lock, LockOpen, Thermometer, Waves, WifiOff } from 'lucide-react'
import { api } from '../lib/api'
import { useAuraEvents } from '../lib/aura'
import { deviceSummary } from '../lib/format'
import type { Device } from '../lib/types'
import { Badge, cx } from './ui'

function DeviceIcon({ d }: { d: Device }) {
  const on = d.state?.power === 'on'
  const c = 'size-5'
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

export function DeviceGrid() {
  const { devices, faults } = useDevices()
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {devices.map((d) => {
        const faulty = !!faults[d.device_id]
        return (
          <div
            key={d.device_id}
            className={cx(
              'rounded-2xl bg-night-950/40 p-3 ring-1 transition-colors',
              faulty ? 'ring-recover/30' : 'ring-white/6',
            )}
          >
            <div className="flex items-center justify-between">
              <DeviceIcon d={d} />
              {faulty && <Badge tone="recover">sim fault</Badge>}
            </div>
            <div className="mt-2 truncate text-[13px] font-semibold">{d.name}</div>
            <div className={cx('text-xs', d.reachable ? 'text-ink-soft' : 'text-unknown')}>{deviceSummary(d)}</div>
          </div>
        )
      })}
    </div>
  )
}
