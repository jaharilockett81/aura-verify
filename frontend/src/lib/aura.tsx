import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './api'
import type { AuraEvent, Health } from './types'

type Listener = (e: AuraEvent) => void
type Toast = { id: number; text: string; tone: 'info' | 'error' | 'success' }

interface AuraCtx {
  health: Health | null
  healthError: string | null
  refreshHealth: () => void
  sessionId: string | null
  newSession: () => Promise<string>
  ensureSession: () => Promise<string>
  setSessionId: (id: string) => void
  subscribe: (fn: Listener) => () => void
  streamConnected: boolean
  voiceReplies: boolean
  setVoiceReplies: (v: boolean) => void
  toasts: Toast[]
  toast: (text: string, tone?: Toast['tone']) => void
  demoOpen: boolean
  setDemoOpen: (v: boolean) => void
}

const Ctx = createContext<AuraCtx | null>(null)

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: session lasts for this tab only */
  }
}

export function AuraProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [sessionId, setSid] = useState<string | null>(() => readLocal('aura.session'))
  const [streamConnected, setStreamConnected] = useState(false)
  const [voiceReplies, setVoice] = useState(() => readLocal('aura.voice') === '1')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [demoOpen, setDemoOpen] = useState(false)
  const listeners = useRef(new Set<Listener>())

  const refreshHealth = useCallback(() => {
    api
      .health()
      .then((h) => {
        setHealth(h)
        setHealthError(null)
      })
      .catch((e) => setHealthError(e.message))
  }, [])

  useEffect(() => {
    refreshHealth()
    const t = setInterval(refreshHealth, 20000)
    return () => clearInterval(t)
  }, [refreshHealth])

  useEffect(() => {
    const es = new EventSource('/api/stream')
    es.onopen = () => setStreamConnected(true)
    es.onerror = () => setStreamConnected(false)
    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as AuraEvent
        listeners.current.forEach((fn) => fn(event))
      } catch {
        /* ignore malformed */
      }
    }
    return () => es.close()
  }, [])

  const setSessionId = useCallback((id: string) => {
    setSid(id)
    writeLocal('aura.session', id)
  }, [])

  const newSession = useCallback(async () => {
    const { session_id } = await api.newSession()
    setSessionId(session_id)
    return session_id
  }, [setSessionId])

  const ensureSession = useCallback(async () => sessionId ?? newSession(), [sessionId, newSession])

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn)
    return () => {
      listeners.current.delete(fn)
    }
  }, [])

  const setVoiceReplies = useCallback((v: boolean) => {
    setVoice(v)
    writeLocal('aura.voice', v ? '1' : '0')
    if (!v && 'speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [])

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000)
  }, [])

  const value = useMemo(
    () => ({
      health,
      healthError,
      refreshHealth,
      sessionId,
      newSession,
      ensureSession,
      setSessionId,
      subscribe,
      streamConnected,
      voiceReplies,
      setVoiceReplies,
      toasts,
      toast,
      demoOpen,
      setDemoOpen,
    }),
    [health, healthError, refreshHealth, sessionId, newSession, ensureSession, setSessionId, subscribe,
      streamConnected, voiceReplies, setVoiceReplies, toasts, toast, demoOpen],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAura() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAura outside provider')
  return ctx
}

/** Subscribe to live events; the handler may change between renders. */
export function useAuraEvents(handler: (e: AuraEvent) => void) {
  const { subscribe } = useAura()
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe])
}
