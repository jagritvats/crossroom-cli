/**
 * Where a write's signature travels: names both the relay and the
 * runner that signs (runner/receipts.ts) use. Imports nothing, so the `crossroom` command carries
 * the names and none of the relay.
 */
/** The key a write's signature travels under in a `tools/call`'s `_meta`. */
export const WRITE_SIG_META = 'parley/write-signature';
/** The header a write's signature travels in on the seat's HTTP surfaces: base64url of its JSON. */
export const WRITE_SIG_HEADER = 'x-parley-write-signature';
