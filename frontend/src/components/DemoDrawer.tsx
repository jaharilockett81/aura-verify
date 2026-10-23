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
        className={cx('absolute inset-0 bg-black/50 transition-opacity duration-300', demoOpen ? 'opacity-100' : 'opacity-0')}
        onClick={() => setDemoOpen(false)}
      />
      {/* Bottom sheet on phones, centered modal sheet on larger screens */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="demo-title"
        className={cx(
          'absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col rounded-t-[28px] bg-night-850 shadow-[0_-20px_60px_-20px_rgba(0,0,0,0.8)] ring-1 ring-white/8 transition-all duration-300 ease-out',
          'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[82vh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:rounded-[28px]',
          demoOpen ? 'translate-y-0 opacity-100 sm:-translate-y-1/2' : 'translate-y-full sm:-translate-y-[46%] sm:opacity-0',
        )}
      >
        <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-white/20 sm:hidden" aria-hidden />
        <div className="flex items-start justify-between gap-3 px-6 pb-4 pt-4 sm:pt-6">
          <div>
            <h2 id="demo-title" className="flex items-center gap-2 text-[20px] font-semibold tracking-tight">
              <span className="grid size-8 place-items-center rounded-[10px] bg-recover/15 text-recover">
                <FlaskConical className="size-[18px]" strokeWidth={1.75} />
              </span>
              Demo controls
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              Simulate real-world failures in the device simulator. These controls are not part of the assistant and
              AURA is not told about them: it has to discover problems through verification.
            </p>
          </div>
          <button onClick={() => setDemoOpen(false)} className="grid size-8 shrink-0 place-items-center rounded-full bg-white/[0.08] text-ink-soft hover:bg-white/[0.14] hover:text-ink" aria-label="Close demo controls">
            <X className="size-4" />
          </button>
        </div>

        <div className="scroll-thin flex-1 overflow-y-auto px-4 pb-2">
          <div className="px-2 pb-2 text-[13px] font-medium uppercase tracking-[0.06em] text-ink-mute">Simulated devices</div>
          <ul className="card group-list overflow-hidden">
            {devices.map((d) => {
              const active = faults[d.device_id] ?? {}
              return (
                <li key={d.device_id} className="px-4 py-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[15px] font-medium">{d.name}</div>
                      <div className="truncate text-[13px] text-ink-mute">{deviceSummary(d)}</div>
                    </div>
                    {Object.keys(active).length > 0 && <Badge tone="recover">Fault active</Badge>}
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-2">
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
                </li>
              )
            })}
          </ul>
        </div>

        <div className="grid grid-cols-2 gap-2 px-6 pb-[max(env(safe-area-inset-bottom),24px)] pt-4">
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
