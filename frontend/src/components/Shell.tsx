import { useState } from 'react'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { Activity, Clock3, Database, FlaskConical, House, Settings, X } from 'lucide-react'
import { useAura } from '../lib/aura'
import { cx } from './ui'
import { DemoDrawer } from './DemoDrawer'

const NAV = [
  { to: '/', label: 'Home', icon: House, end: true },
  { to: '/command', label: 'Command Center', icon: Activity },
  { to: '/memory', label: 'Memory', icon: Database },
  { to: '/history', label: 'History', icon: Clock3 },
]

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="block size-7 rounded-full p-[3px]" style={{ background: 'conic-gradient(from 200deg, #f2b5c9, #b4ddf2, #9fd8c0, #c9c4d9, #f2b5c9)' }} aria-hidden>
        <span className="block size-full rounded-full bg-[#f9f7f6]" />
      </span>
      <span className="text-[16px] font-semibold tracking-tight">AURA Verify</span>
    </div>
  )
}

function Pill({ dot, children, title, className }: { dot?: string; children: ReactNode; title?: string; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex h-7 items-center gap-1.5 rounded-full border border-white/80 bg-white/55 px-3 text-[12px] font-medium text-ink-soft backdrop-blur-xl',
        className,
      )}
      title={title}
    >
      {children}
      {dot && <span className={cx('size-1.5 rounded-full', dot)} />}
    </span>
  )
}

function SimulatedPill() {
  return (
    <Pill dot="bg-verified" className="!bg-[#e4efe5]/85 !text-ink" title="All devices are simulated. No real hardware is controlled.">
      Simulated home
    </Pill>
  )
}

/** MCP connection and planner mode: always disclosed. */
function SystemPills({ className }: { className?: string }) {
  const { health, healthError, streamConnected } = useAura()
  const mcp = health?.mcp
  const planner = health?.planner ?? ''
  const isBedrock = planner.startsWith('bedrock')
  return (
    <div className={cx('flex flex-wrap items-center gap-2', className)}>
      <Pill
        dot={mcp?.connected ? 'bg-verified' : 'bg-failed'}
        className={cx(!mcp?.connected && 'text-failed')}
        title={mcp?.connected ? `${mcp.url}` : (mcp?.error ?? healthError ?? 'Checking…')}
      >
        {healthError
          ? 'Server offline'
          : mcp?.connected
            ? `MCP · ${mcp.transport === 'streamable-http' ? 'Streamable HTTP' : mcp.transport} · ${mcp.protocol_version ?? ''} · ${mcp.tools} tools`
            : 'MCP disconnected'}
      </Pill>
      <Pill dot={isBedrock ? 'bg-lav-300' : 'bg-ink-mute'} title={planner}>
        {isBedrock ? 'Planner · Amazon Bedrock (local fallback)' : 'Planner · local rules (no LLM)'}
      </Pill>
      {!streamConnected && !healthError && <Pill className="text-recover-deep">Live updates reconnecting…</Pill>}
    </div>
  )
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cx('relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors', on ? 'bg-forest' : 'bg-[#d8dee2]')}
    >
      <span
        className={cx(
          'absolute left-0 top-[2px] size-[27px] rounded-full bg-white shadow-[0_2px_5px_rgba(0,0,0,0.2)] transition-transform',
          on ? 'translate-x-[22px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  )
}

function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { voiceReplies, setVoiceReplies, setDemoOpen } = useAura()
  return (
    <div className={cx('fixed inset-0 z-40 transition-[visibility] duration-300', open ? 'pointer-events-auto visible' : 'pointer-events-none invisible')} aria-hidden={!open}>
      <div className={cx('absolute inset-0 bg-[#17343d]/20 transition-opacity', open ? 'opacity-100' : 'opacity-0')} onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className={cx(
          'glass-strong absolute inset-x-0 bottom-0 rounded-t-[28px] p-5 pb-[max(env(safe-area-inset-bottom),24px)] transition-all duration-300',
          'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:rounded-[28px]',
          open ? 'translate-y-0 opacity-100 sm:-translate-y-1/2' : 'translate-y-full sm:-translate-y-[46%] sm:opacity-0',
        )}
      >
        <div className="mx-auto -mt-2 mb-3 h-1.5 w-10 rounded-full bg-ink/15 sm:hidden" aria-hidden />
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[20px] font-semibold tracking-tight">Settings</h2>
          <button onClick={onClose} aria-label="Close settings" className="grid size-8 place-items-center rounded-full bg-ink/[0.06] text-ink-soft hover:bg-ink/10">
            <X className="size-4" />
          </button>
        </div>
        <div className="card group-list overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block text-[15px]">Voice replies</span>
              <span className="block text-[12px] text-ink-mute">Read AURA's replies aloud (browser speech synthesis)</span>
            </span>
            <Switch on={voiceReplies} onChange={setVoiceReplies} label="Voice replies" />
          </div>
          <button
            onClick={() => {
              onClose()
              setDemoOpen(true)
            }}
            className="flex w-full items-center gap-3 px-4 py-3 text-left text-[15px] text-recover-deep hover:bg-white/50"
          >
            <FlaskConical className="size-4" /> Open demo controls
          </button>
        </div>
        <p className="mb-2 mt-5 px-1 text-[13px] font-medium text-ink-mute">System</p>
        <SystemPills />
      </div>
    </div>
  )
}

function RailButton({ label, onClick, children, tone }: { label: string; onClick: () => void; children: ReactNode; tone?: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cx('grid size-11 place-items-center rounded-[14px] transition-colors hover:bg-white/60', tone ?? 'text-ink-soft hover:text-ink')}
    >
      {children}
    </button>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const { toasts, setDemoOpen } = useAura()
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>

      {/* Slim vertical navigation rail (desktop) */}
      <aside className="material sticky top-0 hidden h-screen w-[72px] shrink-0 flex-col items-center gap-2 border-y-0 border-l-0 py-5 lg:flex">
        <nav className="flex flex-col items-center gap-2" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              aria-label={label}
              title={label}
              className={({ isActive }) =>
                cx(
                  'grid size-11 place-items-center rounded-[14px] transition-colors',
                  isActive ? 'bg-white text-ink shadow-[0_4px_12px_-6px_rgba(23,52,61,0.35)]' : 'text-ink-soft hover:bg-white/60 hover:text-ink',
                )
              }
            >
              <Icon className="size-[21px]" strokeWidth={1.6} aria-hidden />
            </NavLink>
          ))}
        </nav>
        <span className="my-1 h-px w-6 bg-ink/10" aria-hidden />
        <RailButton label="Demo controls" onClick={() => setDemoOpen(true)} tone="text-recover-deep">
          <FlaskConical className="size-[21px]" strokeWidth={1.6} aria-hidden />
        </RailButton>
        <RailButton label="Settings" onClick={() => setSettingsOpen(true)}>
          <Settings className="size-[21px]" strokeWidth={1.6} aria-hidden />
        </RailButton>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="px-4 pb-2 pt-4 sm:px-8">
          <div className="flex items-center justify-between gap-3">
            <Logo />
            <div className="flex items-center gap-2">
              <SystemPills className="hidden xl:flex" />
              <SimulatedPill />
              <button
                onClick={() => setSettingsOpen(true)}
                aria-label="Settings"
                className="grid size-8 place-items-center rounded-full border border-white/80 bg-white/55 text-ink-soft backdrop-blur-xl lg:hidden"
              >
                <Settings className="size-4" strokeWidth={1.75} />
              </button>
            </div>
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-4 sm:px-8 lg:pb-10">
          {children}
        </main>

        <footer className="space-y-3 px-6 pb-28 pt-4 text-center lg:pb-6">
          <SystemPills className="justify-center xl:hidden" />
          <p className="text-[11px] text-ink-mute">
            AURA Verify is an independent hackathon simulation, not an official Amazon or Alexa product. Devices are
            simulated; no real hardware is controlled and no messages are sent.
          </p>
        </footer>
      </div>

      <nav
        className="material fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-x-0 border-b-0 px-2 pb-[max(env(safe-area-inset-bottom),8px)] pt-2 lg:hidden"
        aria-label="Main"
      >
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cx('flex flex-col items-center gap-1 rounded-xl py-1 text-[10px] font-medium', isActive ? 'text-forest' : 'text-ink-mute')
            }
          >
            <Icon className="size-[22px]" strokeWidth={1.6} aria-hidden />
            {label === 'Command Center' ? 'Live' : label}
          </NavLink>
        ))}
      </nav>

      <DemoDrawer />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              'glass-strong pointer-events-auto animate-rise rounded-full px-4 py-2.5 text-sm font-medium',
              t.tone === 'error' && 'text-[#c4475d]',
              t.tone === 'success' && 'text-verified-deep',
              t.tone === 'info' && 'text-ink',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
