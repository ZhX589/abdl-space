import type { Env } from './index.ts'

/** Dedicated stock bindings; deployment attestations are opt-in, never client settings. */
export type SponsorStockEnv = Env & {
	AFDIAN_USER_ID?: string
	AFDIAN_API_TOKEN?: string
	SPONSOR_CODE_KEY?: string
	AFDIAN_STOCK_POOL_VERIFIED?: string
	AFDIAN_STOCK_APPEND_VERIFIED?: string
}

/** Only safe metadata is exposed; pool contents and credentials never leave the adapter. */
export interface StockSetting {
	plan_id: string
	enabled: boolean
	verified: boolean
	low_water: number
	target_stock: number
	batch_size: number
	check_interval_seconds: number
	last_stock: number | null
	product_stock: number | null
	observed_line_count: number | null
	last_checked_at: number | null
	next_check_at: number | null
	last_error: string | null
	paused: boolean
	verification_status: 'unchecked' | 'read_verified' | 'write_verified' | 'failed'
	verification_message: string
	can_refill: boolean
	can_enable: boolean
}

/** A sending or unknown batch is never retried, even after its lease expires. */
export type StockBatchState = 'prepared' | 'sending' | 'confirmed' | 'unknown' | 'rejected'

/** Public batch metadata, deliberately excluding encrypted and plaintext code material. */
export interface StockBatch {
	id: string
	plan_id: string
	code_batch_id: string | null
	state: StockBatchState
	count: number
	created_at: number
	last_error: string | null
}
