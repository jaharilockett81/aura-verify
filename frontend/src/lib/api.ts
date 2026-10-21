import type { Device, Health, Message, Preference, Reminder, Routine, Run, AuraEvent } from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    throw new ApiError(0, "Can't reach the AURA server. Is it running? (python -m aura.main serve)")
  }
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

const post = <T,>(path: string, body?: unknown) =>
  req<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const api = {
  health: () => req<Health>('/api/health'),
  newSession: () => post<{ session_id: string }>('/api/sessions'),
  messages: (sid: string) => req<{ messages: Message[] }>(`/api/sessions/${sid}/messages`),
  chat: (sessionId: string | null, text: string) =>
    post<{ session_id: string; message: Message; run: Run | null }>('/api/chat', { session_id: sessionId, text }),
  runs: (status?: string) => req<{ runs: Run[] }>(`/api/runs${status ? `?status=${status}` : ''}`),
  run: (id: string) => req<Run>(`/api/runs/${id}`),
  runEvents: (id: string) => req<{ events: AuraEvent[] }>(`/api/runs/${id}/events`),
  approve: (id: string) => post<Run>(`/api/runs/${id}/approve`),
  cancel: (id: string) => post<Run>(`/api/runs/${id}/cancel`),
  decide: (id: string, stepId: string, approve: boolean) =>
    post<Run>(`/api/runs/${id}/steps/${stepId}/decision`, { approve }),
  recover: (id: string, stepId: string, optionId: string) =>
    post<Run>(`/api/runs/${id}/steps/${stepId}/recovery`, { option_id: optionId }),
  activity: () => req<{ events: AuraEvent[] }>('/api/activity'),
  devices: () => req<{ devices: Device[]; faults: Record<string, Record<string, unknown>> }>('/api/devices'),
  memory: () =>
    req<{ preferences: Preference[]; routines: Routine[]; reminders: Reminder[]; open_issues: any[] }>(
      '/api/memory',
    ),
  setPreference: (key: string, value: unknown) =>
    req<Preference>(`/api/memory/preferences/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  resetPreference: (key: string) => post<Preference>(`/api/memory/preferences/${key}/reset`),
  deleteReminder: (id: string) => req<{ deleted: string }>(`/api/memory/reminders/${id}`, { method: 'DELETE' }),
  forget: () => post<{ ok: boolean; message: string }>('/api/memory/forget'),
  faults: () =>
    req<{ active: Record<string, Record<string, unknown>>; kinds: Record<string, string> }>('/api/demo/faults'),
  injectFault: (device_id: string, kind: string) => post('/api/demo/faults', { device_id, kind }),
  clearFaults: () => req('/api/demo/faults', { method: 'DELETE' }),
  resetDevices: () => post('/api/demo/reset'),
  mcpTools: () =>
    req<{ tools: { name: string; description: string; read_only: boolean }[]; protocol_version: string }>(
      '/api/mcp/tools',
    ),
}
