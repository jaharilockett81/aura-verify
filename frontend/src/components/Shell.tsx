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
      <img src="/favicon.svg" alt="" className="size-8" />
      <div className="leading-tight">
        <div className="font-display text-[22px] tracking-wide">AURA <span className="italic text-lav-300">Verify</span></div>
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
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ring-1 ring-inset',
          mcp?.connected ? 'text-verified ring-verified/25 bg-verified/8' : 'text-failed ring-failed/25 bg-failed/8',
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
        className="inline-flex items-center gap-1.5 rounded-full bg-lav-400/8 px-2.5 py-1 text-lav-300 ring-1 ring-inset ring-lav-400/25"
        title={planner}
      >
        {isBedrock ? 'Planner · Amazon Bedrock' : 'Planner · local rules (no LLM)'}
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
      <div className="flex flex-1">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-white/6 px-4 py-6 lg:flex">
          <Logo />
          <nav className="mt-10 flex flex-col gap-1" aria-label="Main">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cx(
                    'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors',
                    isActive ? 'bg-lav-400/12 text-lav-200' : 'text-ink-soft hover:bg-white/5 hover:text-ink',
                  )
                }
              >
                <Icon className="size-[18px]" aria-hidden />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto space-y-2">
            <button
              onClick={() => setDemoOpen(true)}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-recover/90 hover:bg-recover/8"
            >
              <FlaskConical className="size-[18px]" aria-hidden /> Demo controls
            </button>
            <p className="px-3 text-[11px] leading-relaxed text-ink-mute">
              Independent hackathon project. Simulated devices. Not an Amazon product.
            </p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 border-b border-white/6 bg-night-900/80 px-4 py-3 backdrop-blur-md sm:px-6">
            <div className="flex items-center justify-between gap-3">
              <div className="lg:hidden">
                <Logo />
              </div>
              <div className="hidden lg:block">
                <StatusPills />
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setVoiceReplies(!voiceReplies)}
                  className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold text-ink-soft hover:bg-white/6 hover:text-ink"
                  aria-pressed={voiceReplies}
                  title="Read AURA's replies aloud (browser speech synthesis)"
                >
                  {voiceReplies ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
                  <span className="hidden sm:inline">{voiceReplies ? 'Voice replies on' : 'Voice replies off'}</span>
                </button>
                <button
                  onClick={() => setDemoOpen(true)}
                  className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold text-recover hover:bg-recover/8 lg:hidden"
                >
                  <FlaskConical className="size-4" /> Demo
                </button>
              </div>
            </div>
            <div className="mt-2 lg:hidden">
              <StatusPills />
            </div>
          </header>

          <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-28 pt-6 sm:px-6 lg:pb-10">
            {children}
          </main>

          <footer className="hidden border-t border-white/6 px-6 py-3 text-center text-[11px] text-ink-mute lg:block">
            AURA Verify is a simulation built for the Amazon Build, Ship, Shape Developer Hackathon. It is not an
            official Amazon or Alexa product. No real devices are controlled and no messages are sent.
          </footer>
        </div>
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
