export type StepStatus =
  | 'PENDING'
  | 'AWAITING_APPROVAL'
  | 'RUNNING'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'RECOVERING'
  | 'CANCELLED'

export type RunStatus =
  | 'AWAITING_APPROVAL'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'COMPLETED_WITH_ISSUES'
  | 'FAILED'
  | 'CANCELLED'

export type Risk = 'READ_ONLY' | 'ROUTINE' | 'SENSITIVE'
export type Assurance = 'PROPOSED' | 'AUTHORIZED' | 'ACCEPTED' | 'VERIFIED' | 'UNKNOWN' | 'FAILED'

export interface Evidence {
  kind: 'ack' | 'state_read' | 'verification' | 'diagnosis' | 'precheck' | 'approval' | 'note'
  source: string
  summary: string
  data: Record<string, unknown>
  at: string
}

export interface RecoveryOption {
  id: string
  strategy: 'retry' | 'release_hold_and_reapply' | 'skip'
  label: string
  explanation: string
  risk: Risk
  recommended: boolean
}

export interface Step {
  id: string
  run_id: string
  index: number
  title: string
  rationale: string
  action: 'read_device' | 'set_device' | 'create_reminder' | 'update_preference'
  target: string
  params: Record<string, unknown>
  expected: Record<string, unknown>
  risk: Risk
  status: StepStatus
  assurance: Assurance
  attempts: number
  max_attempts: number
  idempotency_key: string
  result: Record<string, unknown> | null
  evidence: Evidence[]
  error: string | null
  recovery_options: RecoveryOption[]
  recovery_log: Record<string, unknown>[]
  provenance: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

export interface Run {
  id: string
  session_id: string
  utterance: string
  intent: string
  summary: string
  routine_id: string | null
  planner: string
  planner_detail: string
  status: RunStatus
  spoken_response: string
  final_report: string | null
  created_at: string
  updated_at: string
  approved_at: string | null
  finished_at: string | null
  steps: Step[]
}

export interface Message {
  id: number
  session_id: string
  role: 'user' | 'assistant'
  text: string
  run_id: string | null
  meta: Record<string, unknown>
  at: string
}

export interface AuraEvent {
  seq: number | null
  run_id: string | null
  type: string
  data: Record<string, any>
  at: string
}

export interface Device {
  device_id: string
  name: string
  room: string
  type: 'light' | 'thermostat' | 'lock' | 'plug'
  state: Record<string, any> | null
  reachable: boolean
  last_changed_at?: string
  error?: string
}

export interface Preference {
  key: string
  value: unknown
  label: string
  category: string
  unit: string | null
  updated_at: string
  source: string
}

export interface Routine {
  id: string
  name: string
  description: string
  triggers: string[]
  steps: Record<string, any>[]
  updated_at: string
}

export interface Reminder {
  reminder_id: string
  title: string
  due: string | null
  note: string | null
  category: string
  created_at: string
}

export interface Health {
  ok: boolean
  simulation: boolean
  notice: string
  planner: string
  local_planner_label: string
  mcp: {
    url: string
    transport: string
    connected: boolean
    tools: number
    protocol_version: string | null
    server: string | null
    error: string | null
  }
}
