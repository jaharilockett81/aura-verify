import { useCallback, useEffect, useState } from 'react'
import { FlaskConical, RotateCcw, X, Wrench } from 'lucide-react'
import { api } from '../lib/api'
import { useAura, useAuraEvents } from '../lib/aura'
import { deviceSummary } from '../lib/format'
import type { Device } from '../lib/types'
import { Badge, Button, cx } from './ui'

const FAULT_LABELS: Record<string, string> = {
  energy_saver_hold: 'Energy-saver hold',
  unreachable: 'Go offline',
  drop_next_command: 'Drop next command',
}

/** Fault injection for demos and judging. Clearly separate from the assistant itself. */
export function DemoDrawer() {
  const { demoOpen, setDemoOpen, toast } = useAura()
  const [devices, setDevices] = useState<Device[]>([])
  const [faults, setFaults] = useState<Record<string, Record<string, unknown>>>({})
  const [kinds, setKinds] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    api.devices().then((d) => {
      setDevices(d.devices)
      setFaults(d.faults)
    }).catch(() => undefined)
    api.faults().then((f) => setKinds(f.kinds)).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (demoOpen) load()
  }, [demoOpen, load])

  useAuraEvents((e) => {
    if (demoOpen && (e.type === 'tool.call' || e.type === 'run.finished')) load()
  })

  useEffect(() => {
    if (!demoOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDemoOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [demoOpen, setDemoOpen])

  async function act(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key)
    try {
      await fn()
      toast(ok, 'success')
      load()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(null)
    }
  }

  const applicable = (d: Device, kind: string) => kind !== 'energy_saver_hold' || d.type === 'thermostat'

  return (
    <div className={cx('fixed inset-0 z-40', demoOpen ? 'pointer-events-auto' : 'pointer-events-none')} aria-hidden={!demoOpen}>
      <div
        className={cx('absolute inset-0 bg-night-950/60 backdrop-blur-sm transition-opacity', demoOpen ? 'opacity-100' : 'opacity-0')}
        onClick={() => setDemoOpen(false)}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="demo-title"
        className={cx(
          'absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-recover/20 bg-night-850 shadow-2xl transition-transform duration-300',
          demoOpen ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/8 p-5">
          <div>
            <h2 id="demo-title" className="flex items-center gap-2 text-lg font-bold text-recover">
              <FlaskConical className="size-5" /> Demo controls
            </h2>
            <p className="mt-1 text-sm text-ink-soft">
              Simulate real-world failures in the device simulator. These controls are not part of the assistant and
              AURA is not told about them: it has to discover problems through verification.
            </p>
          </div>
          <button onClick={() => setDemoOpen(false)} className="rounded-lg p-1.5 text-ink-mute hover:bg-white/8 hover:text-ink" aria-label="Close demo controls">
            <X className="size-5" />
          </button>
        </div>

        <div className="scroll-thin flex-1 space-y-3 overflow-y-auto p-5">
          {devices.map((d) => {
            const active = faults[d.device_id] ?? {}
            return (
              <div key={d.device_id} className="card p-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold">{d.name}</div>
                    <div className="text-xs text-ink-mute">{deviceSummary(d)}</div>
                  </div>
                  {Object.keys(active).length > 0 && <Badge tone="recover">Fault active</Badge>}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.keys(kinds)
                    .filter((k) => applicable(d, k))
                    .map((k) => (
                      <Button
                        key={k}
                        size="sm"
                        variant={active[k] ? 'warn' : 'secondary'}
                        busy={busy === `${d.device_id}:${k}`}
                        title={kinds[k]}
                        onClick={() =>
                          act(`${d.device_id}:${k}`, () => api.injectFault(d.device_id, k), `${FAULT_LABELS[k]} → ${d.name}`)
                        }
                      >
                        {FAULT_LABELS[k] ?? k}
                      </Button>
                    ))}
                </div>
              </div>
            )
          })}
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-white/8 p-5">
          <Button busy={busy === 'clear'} onClick={() => act('clear', api.clearFaults, 'All faults cleared')}>
            <Wrench className="size-4" /> Clear all faults
          </Button>
          <Button busy={busy === 'reset'} onClick={() => act('reset', api.resetDevices, 'Devices restored to demo state')}>
            <RotateCcw className="size-4" /> Reset devices
          </Button>
        </div>
      </aside>
    </div>
  )
}
