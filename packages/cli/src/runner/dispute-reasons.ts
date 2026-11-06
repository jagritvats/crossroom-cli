/** Why a runner signed no receipt (the relay reads them; runner/receipts.ts sends them). */
export const DISPUTE_REASONS = ['commitment_mismatch', 'head_mismatch', 'history_changed', 'unsigned_write', 'forged_write', 'malformed_record'] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];
