import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { Brain, FlaskConical, History, Home, Activity } from 'lucide-react'
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
      <div className="text-[17px] font-semibold tracking-tight">
        AURA <span className="font-normal text-ink-soft">Verify</span>
      </div>
    </div>
  )
}

function Pill({ dot, children, title, className }: { dot?: string; children: ReactNode; title?: string; className?: string }) {
  return (
    <span
      className={cx('inline-flex h-7 items-center gap-1.5 rounded-full bg-white/[0.06] px-3 text-[12px] font-medium text-ink-soft', className)}
      title={title}
    >
      {dot && <span className={cx('size-1.5 rounded-full', dot)} />}
      {children}
    </span>
  )
}

function StatusPills() {
  const { health, healthError, streamConnected } = useAura()
  const mcp = health?.mcp
  const planner = health?.planner ?? ''
  const isBedrock = planner.startsWith('bedrock')
  return (
    <div className="flex flex-wrap items-center gap-2">
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
        {isBedrock ? 'Planner · Amazon Bedrock' : 'Planner · local rules (no LLM)'}
      </Pill>
      <Pill dot="bg-recover" title="All devices are simulated">
        Simulated home
      </Pill>
      {!streamConnected && !healthError && <Pill className="text-recover">Live updates reconnecting…</Pill>}
    </div>
  )
}

/** iOS-style switch for spoken replies. */
function VoiceToggle() {
  const { voiceReplies, setVoiceReplies } = useAura()
  return (
    <button
      role="switch"
      aria-checked={voiceReplies}
      aria-label="Voice replies"
      onClick={() => setVoiceReplies(!voiceReplies)}
      title="Read AURA's replies aloud (browser speech synthesis)"
      className="inline-flex h-8 items-center gap-2 rounded-full pl-1 pr-2 text-[12px] font-medium text-ink-soft hover:text-ink"
    >
      <span className={cx('relative h-[22px] w-[38px] rounded-full transition-colors', voiceReplies ? 'bg-verified' : 'bg-white/[0.16]')}>
        <span
          className={cx(
            'absolute left-0 top-[2px] size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.4)] transition-transform',
            voiceReplies ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </span>
      <span className="hidden sm:inline">Voice replies</span>
    </button>
  )
}

function RailTip({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <span
      className={cx(
        'pointer-events-none absolute left-full ml-3 whitespace-nowrap rounded-[10px] bg-night-700 px-2.5 py-1.5 text-xs font-medium opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
        tone ?? 'text-ink',
      )}
    >
      {children}
    </span>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const { toasts, setDemoOpen } = useAura()
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-night-800 focus:px-3 focus:py-2">
        Skip to content
      </a>

      {/* Floating sidebar rail (desktop) */}
      <aside className="fixed left-5 top-1/2 z-30 hidden -translate-y-1/2 lg:block">
        <div className="material flex flex-col items-center gap-1 rounded-[26px] p-1.5 shadow-[0_20px_40px_-20px_rgba(0,0,0,0.8)]">
          <nav className="flex flex-col items-center gap-1" aria-label="Main">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                aria-label={label}
                title={label}
                className={({ isActive }) =>
                  cx(
                    'group relative grid size-11 place-items-center rounded-[18px] transition-colors',
                    isActive ? 'bg-white/[0.12] text-ink' : 'text-ink-mute hover:bg-white/[0.06] hover:text-ink',
                  )
                }
              >
                <Icon className="size-5" strokeWidth={1.75} aria-hidden />
                <RailTip>{label}</RailTip>
              </NavLink>
            ))}
          </nav>
          <span className="my-1 h-px w-6 bg-white/10" aria-hidden />
          <button
            onClick={() => setDemoOpen(true)}
            aria-label="Demo controls"
            title="Demo controls (simulated faults)"
            className="group relative grid size-11 place-items-center rounded-[18px] text-recover/85 transition-colors hover:bg-recover/10 hover:text-recover"
          >
            <FlaskConical className="size-5" strokeWidth={1.75} aria-hidden />
            <RailTip tone="text-recover">Demo controls</RailTip>
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="material sticky top-0 z-20 border-x-0 border-t-0 px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <Logo />
            <div className="flex items-center gap-2">
              <div className="hidden lg:block">
                <StatusPills />
              </div>
              <VoiceToggle />
              <button
                onClick={() => setDemoOpen(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-recover/12 px-3 text-[12px] font-medium text-recover hover:bg-recover/18 lg:hidden"
              >
                <FlaskConical className="size-3.5" /> Demo
              </button>
            </div>
          </div>
          <div className="mt-2.5 lg:hidden">
            <StatusPills />
          </div>
        </header>

        <div className="flex-1 lg:pl-24">
          <main id="main" className="mx-auto w-full max-w-6xl px-4 pb-28 pt-8 sm:px-6 lg:pb-10">
            {children}
          </main>
        </div>

        <footer className="px-6 pb-24 pt-4 text-center text-[11px] text-ink-mute/80 lg:pb-5 lg:pl-24">
          AURA Verify is an independent hackathon simulation, not an official Amazon or Alexa product. Devices are
          simulated; no real hardware is controlled and no messages are sent.
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
              cx(
                'flex flex-col items-center gap-1 rounded-xl py-1 text-[10px] font-medium',
                isActive ? 'text-lav-300' : 'text-ink-mute',
              )
            }
          >
            <Icon className="size-[22px]" strokeWidth={1.75} aria-hidden />
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
              'material pointer-events-auto animate-rise rounded-full px-4 py-2.5 text-sm font-medium shadow-[0_16px_40px_-16px_rgba(0,0,0,0.8)]',
              t.tone === 'error' && 'text-failed',
              t.tone === 'success' && 'text-verified',
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
