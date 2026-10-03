import type { JWTPayload } from './index.ts'

/** Admin-controlled native timeline retirement policy. Client metadata is self-reported. */
export interface AppClientPolicy {
  enabled: boolean
  deprecated_version_codes: number[]
  block_unversioned: boolean
  update_message: string
}

/** Rolling, authenticated timeline-observation counts; unavailable counts are not measurements. */
export interface AppClientCounts {
  observed_users: number
  active_1d: number
  active_7d: number
  active_30d: number
}

/** Exact distinct accounts since the stable migration epoch, not installs or IP counts. */
export interface AppClientStats {
  available: boolean
  measurement_started_at: string | null
  totals: AppClientCounts & { versioned_users: number; unversioned_users: number }
  versions: Array<AppClientCounts & { version_code: number | null; latest_users: number }>
}

/** One observed account/version pair, or one latest pair per account for the all filter. */
export interface AppClientUsers {
  users: Array<{ id: number; username: string; display_name: string | null; version_code: number | null; first_seen_at: string; last_seen_at: string }>
  pagination: { page: number; limit: number; total: number; totalPages: number }
}

/** Request-local, fresh native timeline authentication, including a memoized rejection. */
export interface AppClientVariables {
  user: JWTPayload
  appClientSession?: JWTPayload | null
}
