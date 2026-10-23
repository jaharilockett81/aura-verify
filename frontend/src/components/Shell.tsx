import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { Brain, FlaskConical, History, Home, Activity, Volume2, VolumeX } from 'lucide-react'
import { useAura } from '../lib/aura'
import { cx } from './ui'
import { DemoDrawer } from './DemoDrawer'

const NAV = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/command', label: 'Command Center', icon: Activity },
  { to: '/memory', label: 'Memory', icon: Brain },
  { to: '/history', label: 'History', icon: History },
]

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/favicon.svg" alt="" className="size-7" />
      <div className="leading-tight">
        <div className="font-display text-[20px] tracking-wide">AURA <span className="italic text-lav-300">Verify</span></div>
      </div>
    </div>
  )
}

function StatusPills() {
  const { health, healthError, streamConnected } = useAura()
  const mcp = health?.mcp
  const planner = health?.planner ?? ''
  const isBedrock = planner.startsWith('bedrock')
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium">
      <span
        className={cx(
          'inline-flex items-center gap-1.5 rounded-full bg-white/[0.03] px-2.5 py-1 ring-1 ring-inset ring-white/8',
          mcp?.connected ? 'text-ink-soft' : 'text-failed ring-failed/25',
        )}
        title={mcp?.connected ? `${mcp.url}` : (mcp?.error ?? healthError ?? 'Checking…')}
      >
        <span className={cx('size-1.5 rounded-full', mcp?.connected ? 'bg-verified' : 'bg-failed')} />
        {healthError
          ? 'Server offline'
          : mcp?.connected
            ? `MCP · ${mcp.transport === 'streamable-http' ? 'Streamable HTTP' : mcp.transport} · ${mcp.protocol_version ?? ''} · ${mcp.tools} tools`
            : 'MCP disconnected'}
      </span>
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.03] px-2.5 py-1 text-ink-soft ring-1 ring-inset ring-white/8"
        title={planner}
      >
        <span className={cx('size-1.5 rounded-full', isBedrock ? 'bg-lav-300' : 'bg-ink-mute')} />
        {isBedrock ? 'Planner · Amazon Bedrock' : 'Planner · local rules (no LLM)'}
      </span>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-recover/[0.06] px-2.5 py-1 text-recover/90 ring-1 ring-inset ring-recover/20" title="All devices are simulated">
        Simulated home
      </span>
      {!streamConnected && !healthError && (
        <span className="rounded-full bg-recover/10 px-2.5 py-1 text-recover ring-1 ring-inset ring-recover/25">
          Live updates reconnecting…
        </span>
      )}
    </div>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const { toasts, voiceReplies, setVoiceReplies, setDemoOpen } = useAura()
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-night-800 focus:px-3 focus:py-2">
        Skip to content
      </a>

      {/* Floating icon rail (desktop) */}
      <aside className="fixed left-5 top-1/2 z-30 hidden -translate-y-1/2 lg:block">
        <div className="flex flex-col items-center gap-1.5 rounded-full bg-night-850/70 p-1.5 shadow-2xl shadow-black/40 ring-1 ring-white/8 backdrop-blur-xl">
          <nav className="flex flex-col items-center gap-1.5" aria-label="Main">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                aria-label={label}
                title={label}
                className={({ isActive }) =>
                  cx(
                    'group relative grid size-11 place-items-center rounded-full transition-colors',
                    isActive ? 'bg-lav-400/18 text-lav-200 ring-1 ring-lav-300/25' : 'text-ink-mute hover:bg-white/6 hover:text-ink',
                  )
                }
              >
                <Icon className="size-[19px]" aria-hidden />
                <span className="pointer-events-none absolute left-full ml-3 whitespace-nowrap rounded-lg bg-night-800 px-2.5 py-1 text-xs font-semibold text-ink opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  {label}
                </span>
              </NavLink>
            ))}
          </nav>
          <span className="my-1 h-px w-6 bg-white/10" aria-hidden />
          <button
            onClick={() => setDemoOpen(true)}
            aria-label="Demo controls"
            title="Demo controls (simulated faults)"
            className="group relative grid size-11 place-items-center rounded-full text-recover/80 transition-colors hover:bg-recover/10 hover:text-recover"
          >
            <FlaskConical className="size-[19px]" aria-hidden />
            <span className="pointer-events-none absolute left-full ml-3 whitespace-nowrap rounded-lg bg-night-800 px-2.5 py-1 text-xs font-semibold text-recover opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              Demo controls
            </span>
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-24">
        <header className="sticky top-0 z-20 bg-gradient-to-b from-night-950/85 to-transparent px-4 pb-4 pt-3 backdrop-blur-[2px] sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <Logo />
            <div className="flex items-center gap-2">
              <div className="hidden lg:block">
                <StatusPills />
              </div>
              <button
                onClick={() => setVoiceReplies(!voiceReplies)}
                className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold text-ink-soft ring-1 ring-white/8 hover:bg-white/6 hover:text-ink"
                aria-pressed={voiceReplies}
                title="Read AURA's replies aloud (browser speech synthesis)"
              >
                {voiceReplies ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
                <span className="hidden sm:inline">{voiceReplies ? 'Voice on' : 'Voice off'}</span>
              </button>
              <button
                onClick={() => setDemoOpen(true)}
                className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold text-recover ring-1 ring-recover/20 hover:bg-recover/8 lg:hidden"
              >
                <FlaskConical className="size-3.5" /> Demo
              </button>
            </div>
          </div>
          <div className="mt-2 lg:hidden">
            <StatusPills />
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-28 pt-4 sm:px-6 lg:pb-10">
          {children}
        </main>

        <footer className="px-6 pb-24 pt-4 text-center text-[11px] text-ink-mute/80 lg:pb-5">
          AURA Verify is an independent hackathon simulation, not an official Amazon or Alexa product. Devices are
          simulated; no real hardware is controlled and no messages are sent.
        </footer>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-white/8 bg-night-900/95 px-2 pb-[max(env(safe-area-inset-bottom),8px)] pt-2 backdrop-blur-md lg:hidden"
        aria-label="Main"
      >
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cx(
                'flex flex-col items-center gap-1 rounded-xl py-1.5 text-[10px] font-semibold',
                isActive ? 'text-lav-200' : 'text-ink-mute',
              )
            }
          >
            <Icon className="size-5" aria-hidden />
            {label === 'Command Center' ? 'Live' : label}
          </NavLink>
        ))}
      </nav>

      <DemoDrawer />

      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto animate-rise rounded-xl px-4 py-2.5 text-sm font-medium shadow-xl ring-1',
              t.tone === 'error' && 'bg-night-800 text-failed ring-failed/30',
              t.tone === 'success' && 'bg-night-800 text-verified ring-verified/30',
              t.tone === 'info' && 'bg-night-800 text-ink ring-white/10',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
