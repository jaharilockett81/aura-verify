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
