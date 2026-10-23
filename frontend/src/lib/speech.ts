import { useCallback, useEffect, useRef, useState } from 'react'

// Minimal typing for the (still prefixed in Chromium/Safari) Web Speech API.
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: any) => void) | null
  onerror: ((e: any) => void) | null
  onend: (() => void) | null
}

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as any
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function useSpeechInput(onFinal: (text: string) => void) {
  const supported = typeof window !== 'undefined' && recognitionCtor() !== null
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<SpeechRecognitionLike | null>(null)
  const cb = useRef(onFinal)
  cb.current = onFinal

  const stop = useCallback(() => {
    rec.current?.stop()
  }, [])

  const start = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor) return
    setError(null)
    setInterim('')
    const r = new Ctor()
    r.lang = 'en-US'
    r.interimResults = true
    r.continuous = false
    r.onresult = (e: any) => {
      let finalText = ''
      let partial = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript
        if (e.results[i].isFinal) finalText += t
        else partial += t
      }
      setInterim(partial)
      if (finalText.trim()) cb.current(finalText.trim())
    }
    r.onerror = (e: any) => {
      setError(
        e.error === 'not-allowed'
          ? 'Microphone permission was denied. You can type instead.'
          : `Voice input stopped (${e.error}). You can type instead.`,
      )
    }
    r.onend = () => {
      setListening(false)
      setInterim('')
    }
    rec.current = r
    r.start()
    setListening(true)
  }, [])

  useEffect(() => () => rec.current?.abort(), [])

  return { supported, listening, interim, error, start, stop }
}

export function speak(text: string) {
  void speakAsync(text)
}

/** Speak with browser speech synthesis. Resolves true only if the browser actually started speaking. */
export function speakAsync(text: string, { interrupt = true }: { interrupt?: boolean } = {}): Promise<boolean> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true
        resolve(ok)
      }
    }
    if (interrupt) window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.02
    u.pitch = 1
    u.onstart = () => done(true)
    u.onerror = () => done(false)
    window.speechSynthesis.speak(u)
    // No voices, muted tab or a blocked autoplay policy: report "not spoken" rather than assume it was.
    window.setTimeout(() => done(false), 2500)
  })
}

// Speech recognisers often hear "Aura" as "Ora" or "Aurora". Map those to the wake word so "Aura" alone gets
// "Yes, <name>?" and "Ora, lock the door" still reaches the planner as a request to AURA.
const WAKE = /^\s*(?:(hey|ok|okay)\s+)?(?:aura|ora|aurora|oura)\b[\s,.!?:;-]*/i

export function normalizeWake(text: string): string {
  return text.replace(WAKE, (_m, lead) => (lead ? `${lead} Aura, ` : 'Aura, ')).replace(/^(.*?Aura), $/i, '$1')
}

/** The command after the wake word ("" when only the wake word was said), or null if there's no wake word. */
export function afterWakeWord(text: string): string | null {
  const m = text.match(WAKE)
  return m ? text.slice(m[0].length).trim() : null
}

/** Resolve once the browser has finished speaking (or after `maxMs`), so the mic doesn't hear AURA itself. */
export function speechFinished(maxMs = 6000): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return resolve()
    const started = Date.now()
    const tick = () => {
      if (!window.speechSynthesis.speaking || Date.now() - started > maxMs) resolve()
      else window.setTimeout(tick, 120)
    }
    window.setTimeout(tick, 150)
  })
}

/**
 * Hands-free mode: keeps a continuous recogniser open while `enabled` and calls `onWake` when a phrase starts with
 * the wake word, with the rest of the phrase ("" for "Aura" alone). Chrome ends continuous recognition after a
 * silence, so it restarts itself; it stops for good on a permission error.
 */
export function useWakeWord(enabled: boolean, onWake: (command: string) => void) {
  const supported = typeof window !== 'undefined' && recognitionCtor() !== null
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cb = useRef(onWake)
  cb.current = onWake

  useEffect(() => {
    const Ctor = recognitionCtor()
    if (!enabled || !Ctor) return
    let stopped = false
    let rec: SpeechRecognitionLike | null = null
    let restart: number | undefined
    const begin = () => {
      if (stopped) return
      const r = new Ctor()
      r.lang = 'en-US'
      r.interimResults = false
      r.continuous = true
      r.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (!e.results[i].isFinal) continue
          const command = afterWakeWord(e.results[i][0].transcript)
          if (command !== null) {
            stopped = true
            r.abort()
            setActive(false)
            cb.current(command)
            return
          }
        }
      }
      r.onerror = (e: any) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          stopped = true
          setError('Microphone permission was denied, so AURA can\'t listen for "Aura". You can still type or use the mic button.')
        }
      }
      r.onend = () => {
        setActive(false)
        if (!stopped) restart = window.setTimeout(begin, 300)
      }
      rec = r
      try {
        r.start()
        setActive(true)
        setError(null)
      } catch {
        restart = window.setTimeout(begin, 1000)
      }
    }
    begin()
    return () => {
      stopped = true
      window.clearTimeout(restart)
      rec?.abort()
      setActive(false)
    }
  }, [enabled])

  return { supported, active, error }
}
