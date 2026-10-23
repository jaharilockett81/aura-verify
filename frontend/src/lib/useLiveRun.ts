import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { useAuraEvents } from './aura'
import type { Run } from './types'

/** Keeps one run fresh from the server-sent event stream (coalescing bursts into a single fetch). */
export function useLiveRun(runId: string | null | undefined) {
  const [run, setRun] = useState<Run | null>(null)
  const timer = useRef<number | null>(null)
  const load = useCallback(() => {
    if (!runId) return
    api.run(runId).then(setRun).catch(() => undefined)
  }, [runId])
  useEffect(() => {
    setRun(null)
    load()
  }, [load])
  useAuraEvents((e) => {
    if (!runId || e.run_id !== runId) return
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(load, 60)
  })
  return run
}
