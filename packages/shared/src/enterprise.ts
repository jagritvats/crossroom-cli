/**
 * What crosses the line between the Apache-2.0 server and `ee/` (`@parley/ee`, FSL-1.1-ALv2):
 * the licence, the key providers, and the wire words of SCIM, SAML, legal hold, compliance access,
 * the audit export, federation and the shard router.
 *
 * Both sides import these, and neither imports the other: the server reaches `ee/` only through a
 * dynamic import, and `ee/` never imports the server. So every type a
 * module in `ee/` implements, and every constant both sides must spell alike, lives here.
 *
 * Pure: no zod and no Node import.
 */
import type { LicenceFields, SigAlg } from './chain.js';
// The digest a SAML subject is kept as (`samlSubject`). Pure, like everything in chain.ts.
import { sha256Hex } from './chain.js';

// ---------------------------------------------------------------- the licence

/**
 * The features a licence names, which are also these features' flags on the server.
 * Everything else, chain v2, receipts, co-signing, anchoring, connections and end-to-end projects
 * among it, is Apache and needs no licence.
 */
export const EE_FEATURES = ['saml', 'scim', 'kms', 'legalHold', 'compliance', 'siemPush', 'federation', 'shardRouter'] as const;
export type EeFeature = (typeof EE_FEATURES)[number];
export const isEeFeature = (f: unknown): f is EeFeature => typeof f === 'string' && (EE_FEATURES as readonly string[]).includes(f);

/**
 * A path to the licence document, read by the server at the first use of a feature of `ee/`, and
 * again every `LICENCE_RECHECK_MS` after, so a renewal, a file mounted late and a licence's own dates
 * take effect without a restart.
 */
export const LICENCE_FILE_ENV = 'PARLEY_LICENCE_FILE';
export const LICENCE_RECHECK_MS = 10 * 60_000;
/**
 * The hosted instance runs under Crossroom's own licence: `PARLEY_HOSTED_LICENCE=parley`, set in its
 * compose file. Every feature, no expiry, no file.
 */
export const HOSTED_LICENCE_ENV = 'PARLEY_HOSTED_LICENCE';
export const HOSTED_LICENCE_VALUE = 'parley';
/** After `not_after`, this long before new connections and peerings are refused. Nothing else ever is. */
export const LICENCE_GRACE_DAYS = 30;

/**
 * Where a licence that verified stands. `grace` and `expired` refuse only what is new (a connection,
 * a peering) once grace is over: never a security control, never anyone's own data. A licence
 * before its `not_before` is not one of these: it is `ok: false`, so nothing new runs under it early,
 * and the loader checks it again as time passes (a renewal installed ahead of its date).
 */
export type LicenceState = 'valid' | 'grace' | 'expired';

export type LicenceVerdict =
  | { ok: true; licence: LicenceFields; state: LicenceState; hosted: boolean }
  /**
   * `reason` is the verifier's own words: a bad signature, an unknown key, another relay's licence,
   * a licence not valid until a date still to come.
   */
  | { ok: false; reason: string };

/** What the licence verifier in `ee/` is given besides the document. */
export interface LicenceCheck {
  /** This relay's public URL: a licence names the relay it is for. */
  relay: string;
  /** Milliseconds since the epoch, for the dates. */
  now: number;
}

/**
 * What a caller asks `ee/` for, through the server's loader of it.
 * A licence that lapses, goes missing or stops verifying never disables a control already in force,
 * and `ee/` itself performs some (a SCIM deprovision, a SAML sign-in), so a route asks by use:
 * - `'licensed'`: anything new. `ee/`'s modules only under a licence that verifies (or the hosted
 *   one), and otherwise null, with `ee/` not even imported where no licence is configured.
 * - `'in-force'`: what keeps a configuration that already exists working, or winds it down. `ee/`'s
 *   modules whatever the licence says, activated under its verdict, `ok: false` included (no licence,
 *   a file that cannot be read, one that does not verify). A route that only makes something new
 *   asks `'licensed'`; one that may keep or wind down what exists asks `'in-force'`. Either way a
 *   module makes nothing new unless `licensedFor` says so (below), so under a verdict that is not
 *   `ok` it serves only what this list names, refusing the rest as new:
 *   - SCIM, with a token the organisation already has: deprovisioning (`active=false` by PATCH or
 *     PUT, deleting a User, removing a member from a Group) and the reads an IdP makes to find whom;
 *     and an admin listing and revoking the tokens. Provisioning, reactivating and minting are new.
 *   - SAML, for an organisation with a `saml_configs` row: the start, the ACS and the metadata;
 *     reading the settings, turning enforcement off and removing the configuration. Uploading
 *     metadata and turning enforcement on are new.
 *   - Legal hold: listing and releasing. Compliance access: reading it and turning it off. The audit
 *     sinks: listing and removing one, and the push to a sink already configured. Setting a hold,
 *     turning compliance access on and adding a sink are new.
 *   - KMS: reading the provider, and moving an organisation's key back to the local one. Opening a
 *     key a provider wrapped is the server's key-provider lookup's, which no
 *     verdict gates. Moving a key to a provider is new.
 *   - Federation: discovery, and every request from or to a peer already pinned. Pinning one is new.
 *   - The shard router: routing the shards and organisations its directory already names. Adding a
 *     shard and moving an organisation are new.
 */
export type EnterpriseUse = 'licensed' | 'in-force';

/**
 * Whether a module of `ee/` may make something new for `feature` under the verdict it was activated
 * with: a licence that verifies and names the feature (the hosted one names every feature), and for
 * federation, whose new thing is a peering, not past its grace. Every module
 * asks this before anything new, under either use; what is in force (EnterpriseUse) asks nothing.
 */
export const licensedFor = (licence: LicenceVerdict, feature: EeFeature): boolean =>
  licence.ok && licence.licence.features.includes(feature) && !(feature === 'federation' && licence.state === 'expired');

// ---------------------------------------------------------------- key providers

export type KeyProviderId = 'local' | 'vault-transit' | 'aws-kms' | 'gcp-kms' | 'azure-kv';
export const KEY_PROVIDERS: readonly KeyProviderId[] = ['local', 'vault-transit', 'aws-kms', 'gcp-kms', 'azure-kv'];
/** What a wrapped key is for: the instance's root, an organisation's key, a project's. */
export type KeyPurpose = 'instance' | 'org-key' | 'project-key';

/**
 * What a key is wrapped for, bound into the wrap so it opens nowhere else. `ref` names the
 * thing wrapped and its version, as the chain's AADs do (`orgKeyAad`, `projectKeyAad` in the server's sealing):
 * `<org>|<version>` for an organisation's key, `<org>|<project>|<version>` for a project's.
 */
export interface KeyContext {
  org: string;
  purpose: KeyPurpose;
  ref: string;
}

/** A key as a provider wrapped it: which provider, which of its keys, and the wrap itself. */
export interface WrappedKey {
  provider: KeyProviderId;
  /** The provider's own name for its key: `env:PARLEY_INSTANCE_KEY`, a Vault transit key, an ARN. */
  keyRef: string;
  /** The wrap: `kw1.` for the local provider, byte for byte what `orgs.key_wrapped` already holds. */
  blob: string;
}

/**
 * A signing key, wherever it is held (minutes v2, a co-signature, anchoring). Async, since a KMS
 * signs over the network. `sign` takes the statement's UTF-8 and answers the raw signature:
 * Ed25519's 64 bytes, or ECDSA P-256 over SHA-256 as r || s (IEEE P1363), never DER, which a
 * provider that answers DER converts.
 */
export interface SignerV2 {
  readonly alg: SigAlg;
  /** The public key, base64url: Ed25519 raw 32 bytes, P-256 the uncompressed point. */
  readonly publicKey: string;
  /** What a person compares (sha256 of the key, 16 hex digits in fours, as minutes v1's fingerprint). */
  readonly fingerprint: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * The root of the key chain for one organisation. Called once per organisation key, the
 * answer cached in memory with a TTL and zeroed after, and never at boot or in the sweep.
 * `unwrap` of a key a provider wrapped is never refused for want of a licence or a flag: refusing
 * would lock an organisation out of its own data. Configuring one is what is licensed.
 */
export interface KeyProvider {
  readonly id: KeyProviderId;
  wrap(dek: Uint8Array, ctx: KeyContext): Promise<WrappedKey>;
  unwrap(w: WrappedKey, ctx: KeyContext): Promise<Uint8Array>;
  /** A signing key held by the provider, where it supports Ed25519 or P-256. */
  signer?(keyRef: string): Promise<SignerV2>;
  /** Whether the provider answers, in Crossroom's words: never a credential, never the provider's own text. */
  health(): Promise<{ ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------- SCIM 2.0

/** An organisation's SCIM bearer token starts with this, and is kept only as its hash. */
export const SCIM_TOKEN_PREFIX = 'scim_';
export const SCIM_MEDIA_TYPE = 'application/scim+json';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
/** Every refusal of a SCIM bearer token: unknown, revoked, another organisation's, or none. */
export const SCIM_REFUSED = 'A SCIM bearer token of this organisation is required.';
/** A SCIM error body (RFC 7644 §3.12): `status` is a string there, by the RFC's own choice. */
export const scimError = (status: number, detail: string) => ({ schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail });

// Below: what the module of `ee/` and the server's host of it (EeHost.scim) say to
// each other, and the admin's views of an organisation's SCIM settings.

/** Where an IdP points its SCIM client: this path under the relay's public URL. */
export const SCIM_BASE_PATH = '/scim/v2';

/**
 * What SCIM answers, 403, to anything new while the licence does not cover SCIM (EnterpriseUse): under
 * the `'in-force'` use it still takes the IdP's deprovisioning, and the reads that find whom.
 */
export const SCIM_NOT_LICENSED =
  "This Crossroom's licence does not cover SCIM provisioning now, so it takes deprovisioning only: a user deactivated or deleted, a member taken out of a group.";

/** An owner's membership is never changed through SCIM: another owner changes it, in Crossroom (409). */
export const SCIM_OWNER_UNTOUCHED = "An owner of the organisation is never suspended or given a role through SCIM: another owner changes an owner's membership in Crossroom.";

/** How much SCIM takes, per value, per organisation and per page. */
export const SCIM_LIMITS = {
  userName: 256,
  externalId: 256,
  displayName: 256,
  namePart: 256,
  emails: 10,
  email: 320,
  emailType: 32,
  groupName: 256,
  /** Members of one SCIM group. */
  groupMembers: 5000,
  /** SCIM users of one organisation, deactivated ones included. */
  users: 5000,
  /** SCIM groups of one organisation: each is one of its teams. */
  groups: 200,
  /** Resources in one page of a list. */
  pageMax: 200,
  /** Live SCIM tokens of one organisation. */
  tokens: 5,
  /** A token's label, the admin's own words for it. */
  label: 80,
} as const;

/** The parts of a SCIM user's name Crossroom keeps (RFC 7643 §4.1.1). */
export interface ScimName {
  formatted?: string;
  givenName?: string;
  familyName?: string;
}
export interface ScimEmail {
  value: string;
  type?: string;
  primary?: boolean;
}

/**
 * A SCIM User as the module of `ee/` hands it to the host: what Crossroom keeps of what an IdP sends,
 * and nothing else. A password, a phone number, an address or a manager is dropped where it arrives.
 */
export interface ScimUserData {
  userName: string;
  externalId: string | null;
  displayName: string | null;
  name: ScimName | null;
  emails: ScimEmail[];
  active: boolean;
}
/** A SCIM User as the host keeps it: its data, Crossroom's id for it and its dates. */
export interface ScimUserRecord extends ScimUserData {
  id: string;
  created: string;
  lastModified: string;
  /** Moves on every change (`meta.version`). */
  version: number;
}
/** A SCIM Group: its name, the IdP's id for it, and the ids of its members, SCIM users of this organisation. */
export interface ScimGroupData {
  displayName: string;
  externalId: string | null;
  members: string[];
}
export interface ScimGroupRecord extends ScimGroupData {
  id: string;
  created: string;
  lastModified: string;
  version: number;
}

/** RFC 7644 §3.12's `scimType`s that Crossroom answers. */
export type ScimErrorType = 'invalidFilter' | 'tooMany' | 'uniqueness' | 'mutability' | 'invalidSyntax' | 'invalidPath' | 'noTarget' | 'invalidValue';
/** What a host write answers: done, or refused with the SCIM error the module answers the IdP. */
export type ScimWrite<T> = { ok: true; value: T } | { ok: false; status: number; scimType?: ScimErrorType; detail: string };
/** What a list is narrowed by (`filter=<key> eq "<value>"`), compared as RFC 7643 says (userName case-insensitively). */
export type ScimUserKey = 'id' | 'userName' | 'externalId' | 'displayName';
export type ScimGroupKey = 'id' | 'externalId' | 'displayName';
export interface ScimPage<T> {
  /** How many match, across every page. */
  total: number;
  items: T[];
}
export interface ScimQuery<K> {
  where?: { key: K; value: string };
  /** From 0. */
  offset: number;
  limit: number;
}

/**
 * What SCIM's module of `ee/` is lent for one call (`EeHost.scim`): one organisation's
 * provisioned users and groups, as the bearer token that called found them, and nothing of any other
 * organisation's. Lent only once the token checked out, and every write checks the token again, so
 * one revoked while the call ran writes nothing (410). The host does what a write means for the
 * organisation's people (a membership suspended or lifted, a team's roster, a role from a group) in
 * the server's own tables, so a licence that lapses never undoes a suspension: the module only
 * says what the IdP asked for, and whether it may.
 */
export interface ScimDirectory {
  readonly orgId: string;
  /** The verdict `ee/` was activated under, which the module asks `licensedFor(licence, 'scim')` of. */
  readonly licence: LicenceVerdict;
  users(q: ScimQuery<ScimUserKey>): ScimPage<ScimUserRecord>;
  user(id: string): ScimUserRecord | null;
  createUser(data: ScimUserData): ScimWrite<ScimUserRecord>;
  replaceUser(id: string, data: ScimUserData): ScimWrite<ScimUserRecord>;
  deleteUser(id: string): ScimWrite<true>;
  groups(q: ScimQuery<ScimGroupKey>): ScimPage<ScimGroupRecord>;
  group(id: string): ScimGroupRecord | null;
  createGroup(data: ScimGroupData): ScimWrite<ScimGroupRecord>;
  replaceGroup(id: string, data: ScimGroupData): ScimWrite<ScimGroupRecord>;
  deleteGroup(id: string): ScimWrite<true>;
}

/** An organisation role a SCIM group can give its members (`scim_groups.role`): never an owner's. */
export type ScimGroupRole = 'admin' | 'member' | 'auditor';
export const SCIM_GROUP_ROLES: readonly ScimGroupRole[] = ['admin', 'member', 'auditor'];

/** `POST /api/orgs/:o/scim/tokens`. */
export interface ScimTokenInput {
  label?: string;
}
/** `PUT /api/orgs/:o/scim/groups/:id`: the role the group gives its members, or none. */
export interface ScimGroupRoleInput {
  role: ScimGroupRole | null;
}
/** A SCIM token as an admin sees it: never the token, which is shown once. */
export interface ScimTokenView {
  id: string;
  label: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface ScimGroupView {
  id: string;
  displayName: string;
  /** The team it is, or null for one whose team was deleted. */
  teamId: string | null;
  teamName: string | null;
  role: ScimGroupRole | null;
  members: number;
}
/** `GET /api/orgs/:o/scim`, an owner's or admin's: what the organisation has, whatever the licence says. */
export interface ScimSettingsView {
  /** The SCIM base URL to give the IdP. */
  endpoint: string;
  /** Whether a token can be minted here now: the licence covers SCIM, and the organisation has room for one. */
  canMint: boolean;
  tokens: ScimTokenView[];
  groups: ScimGroupView[];
  users: { total: number; active: number; linked: number };
}
/** What minting answers, once: the token itself, and its view. */
export interface ScimTokenMinted {
  token: string;
  view: ScimTokenView;
}

// ---------------------------------------------------------------- SAML

/**
 * The one route exempt from the server's origin check: an identity provider posts its
 * assertion from its own origin. SP-initiated only, so an assertion without a RelayState Crossroom
 * issued (`saml_requests`) is refused, IdP-initiated ones included.
 */
export const SAML_ACS_PATH = '/auth/saml/acs';
/** A sign-in that failed lands here: one constant sentence, never what the IdP said. */
export const SAML_FAILED = "That sign-in did not complete. Start it again from your organisation's sign-in page.";

/**
 * The cookie that binds a SAML sign-in to the browser that started it (login CSRF). The start sets
 * a random value and its request row keeps only the digest (`saml_requests.browser_binding_hash`);
 * the ACS reads and clears it whatever happens, and refuses a post whose cookie does not hash to the
 * row its RelayState names. Without it, anyone could start a sign-in in their own browser at an
 * organisation whose IdP they run and have another browser post the IdP's answer, which passes every
 * other check: that browser would be signed in to the starter's account, and what it then made or
 * added would land there. The start, like the OIDC one, also refuses a browser another site sent.
 *
 * `__Host-`, Secure, HttpOnly, `Path=/`, for the request's lifetime, and `SameSite=None`: the IdP
 * posts to the ACS from its own site, and a Lax cookie (the OIDC flow's `BINDING_COOKIE`, whose
 * callback is a GET) never rides a cross-site POST. Any site's POST may carry it, which binds nothing
 * to that site: the post must still hold the answer to this browser's own request.
 */
export const SAML_BINDING_COOKIE = '__Host-parley_saml';

/**
 * The identity a SAML sign-in finds or makes an account by, as `(iss, sub)` is OIDC's
 * (`sso_identities`): the configuration that verified the assertion (its organisation and
 * its `saml_configs.id`, which the server mints and keeps across re-uploads) and the subject's
 * NameID. Never the IdP's entity id: the metadata is uploaded and never fetched, so an entity id is
 * whatever the uploading admin typed, and any account can make an organisation and upload another
 * IdP's entity id beside a certificate of its own. Keyed on it, that organisation's assertions for
 * the other IdP's NameIDs signed in to the accounts the other organisation's members made. OIDC's
 * issuer is checked against discovery fetched from the issuer itself, and is an https URL
 * (`issuerProblem`), which `saml:` never begins, so neither protocol reaches the other's accounts.
 */
export const samlIdentity = (verifiedBy: { orgId: string; id: string }, nameId: string): { issuer: string; subject: string } => ({
  issuer: `saml:${verifiedBy.orgId}:${verifiedBy.id}`,
  subject: nameId,
});

// The rest of this section is the SAML service provider's.

/**
 * What `samlIdentity` is given for a NameID: its digest, never the NameID itself. A NameID
 * is often an email address (`…:nameid-format:emailAddress`), and the directory keeps no address
 * for an account (the server's `sso_identities`). The digest is as good a key: the identity is
 * still the configuration that verified the assertion and exactly the NameID it named, compared
 * whole (a comment inside it, which canonicalisation drops, never shortens it to a prefix). SCIM,
 * or anything else that ever needs to find a SAML identity, derives it the same way.
 */
export const samlSubject = (nameId: string): string => `nameid:${sha256Hex(`parley/saml/nameid/v1|${nameId}`)}`;

/** How long a sign-in may take from its start to the IdP's answer, an OIDC flow's ten minutes (`FLOW_MINUTES`). */
export const SAML_REQUEST_MINUTES = 10;

/**
 * The `Set-Cookie` line of `SAML_BINDING_COOKIE`: a value to set it for one request's lifetime, null
 * to clear it. `__Host-`, so Secure, `Path=/` and no Domain; `SameSite=None`, so the IdP's
 * cross-site POST carries it.
 */
export const samlBindingCookie = (value: string | null) =>
  `${SAML_BINDING_COOKIE}=${value ?? ''}; Max-Age=${value ? SAML_REQUEST_MINUTES * 60 : 0}; Path=/; HttpOnly; Secure; SameSite=None`;

/** An organisation's SAML paths: the start, Crossroom's metadata for its IdP, the settings, and linking an account. */
export const samlStartPath = (orgId: string) => `/auth/saml/${orgId}/start`;
export const samlMetadataPath = (orgId: string) => `/auth/saml/${orgId}/metadata`;
export const samlSettingsPath = (orgId: string) => `/api/orgs/${orgId}/saml`;
export const samlLinkPath = (orgId: string) => `/api/orgs/${orgId}/saml/link`;

/** One of the IdP's signing certificates as the settings show it: public, from the uploaded metadata. */
export interface SamlCertificateView {
  /** SHA-256 of the certificate, upper-case hex pairs joined by colons, as IdPs print fingerprints. */
  sha256: string;
  subject: string;
  notBefore: string;
  notAfter: string;
}

/** An organisation's SAML configuration as its owners and admins see it. Nothing in it is secret. */
export interface SamlConfigView {
  /** The server's, minted at the first upload and kept across re-uploads (certificate rollover). */
  id: string;
  idpEntityId: string;
  idpSsoUrl: string;
  certificates: SamlCertificateView[];
  domains: string[];
  /** Whether the organisation's members (not its owners) must have come through this IdP within a day. */
  enforce: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Crossroom's side, to give the IdP: the same for every organisation but its id. */
export interface SamlServiceProviderView {
  entityId: string;
  acsUrl: string;
  metadataUrl: string;
  /** Where a sign-in starts. Crossroom's own page or the address bar only: another site's link is refused. */
  signInUrl: string;
}

/** `GET /api/orgs/:o/saml`, and what every `PUT` answers. */
export interface SamlSettingsView {
  config: SamlConfigView | null;
  sp: SamlServiceProviderView;
  /**
   * Whether this instance's licence lets SAML set anything new up here (`licensedFor`): uploading
   * metadata, changing the domains, turning enforcement on. Without it the configuration still signs
   * people in, and can still be wound down: enforcement off, or removed.
   */
  canSetUp: boolean;
  /**
   * Whether this build's SAML has been run against a real identity provider (`SAML_VERIFIED_AGAINST`
   * in `ee/`'s SAML module names which). False until it has: the tests post offline fixtures that
   * node-saml's own signer made, which prove the checks, not that a given IdP's responses pass them.
   */
  verified: boolean;
}

/**
 * `PUT /api/orgs/:o/saml`. One of `metadata` (the IdP's own document) or `idp` (its three parts,
 * typed in) to set up or replace the IdP; `domains` and `enforce` alone to change only those;
 * `remove` alone to remove it all. What is left out stays as it was.
 */
export interface SamlConfigInput {
  metadata?: string;
  idp?: { entityId: string; ssoUrl: string; certificates: string[] };
  domains?: string[];
  enforce?: boolean;
  remove?: true;
}

/** `POST /api/orgs/:o/saml/link` (a member's own signed-in browser): `return` is a path on this site. */
export interface SamlLinkInput {
  return?: string;
}
/** Where the browser goes next: the IdP, with Crossroom's request. The page opens it. */
export interface SamlLinkResult {
  url: string;
}

/** The settings' refusals, said only to an owner or admin of the organisation. */
export const SAML_NEEDS_LICENCE =
  "This Crossroom's licence does not cover setting SAML up. Sign-in through the configuration already here keeps working, and it can still be turned off or removed.";
export const SAML_NO_CONFIG = 'This organisation has no SAML identity provider yet. Upload its metadata first.';
export const SAML_ENFORCE_NEEDS_DOMAINS = 'Enforcing sign-in needs at least one domain listed, and every listed domain verified by its DNS record first.';
export const SAML_ENFORCE_NEEDS_PROOF =
  'Sign in through this identity provider yourself before enforcing it (link your account from these settings), so a provider that does not work cannot lock the members out.';
/**
 * Enforcing SAML while the organisation's OpenID Connect sign-in is enforced: one way in is held to
 * at a time, so a member asked to confirm who they are is told which one (`SSO_REQUIRED`'s link).
 */
export const SAML_ENFORCE_OTHER =
  "This organisation already requires its OpenID Connect provider. Stop requiring that one first, in the organisation's settings, then require this one.";
/** A metadata document or certificate that cannot be used, with what is wrong with it: an admin's own upload, so its fault is named. */
export const samlBadMetadata = (what: string) => `That metadata cannot be used: ${what}.`;

/** Why a sign-in failed, counted and logged on the server and never shown: the browser sees `SIGNIN_FAILED_PATH`. */
export type SamlFailReason =
  | 'cross_site'
  | 'rate'
  | 'not_configured'
  | 'busy'
  | 'no_binding'
  | 'no_request'
  | 'config_changed'
  | 'malformed'
  | 'doctype'
  | 'algorithm'
  | 'structure'
  | 'signature'
  | 'status'
  | 'in_response_to'
  | 'destination'
  | 'issuer'
  | 'audience'
  | 'recipient'
  | 'time'
  | 'name_id'
  | 'replay'
  | 'sign_in';

/** A configuration as the server stores it (`saml_configs`), certificates as PEM. */
export interface SamlStoredConfig {
  id: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCerts: string[];
  spEntityId: string;
  domains: string[];
  enforce: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What `SamlHost.save` keeps: the configuration's every part but its id and dates, which the server keeps. */
export type SamlSaving = Omit<SamlStoredConfig, 'id' | 'createdAt' | 'updatedAt'>;

/** A sign-in in progress as the ACS gets it back: what it must answer, and for which configuration. */
export interface SamlPendingRequest {
  requestId: string;
  configId: string;
  /** When the start wrote it, in milliseconds. */
  createdAt: number;
}

/**
 * What the server lends SAML for one call (`EeHost.saml`), over one organisation's own rows: its
 * `saml_configs`, `saml_requests` and `saml_assertions`, the directory's mirror of its enforcement,
 * and the one sign-in its consumed request allows. Never a Core, a session id or a key: the session
 * a sign-in makes is set on the response by the server, and SAML sees none of it.
 *
 * The route resolved the organisation, and for the settings and the link checked the caller (an
 * owner or admin, or a member's own browser); each write asks again that the caller still is who
 * they were, and throws if not, which the route answers 410.
 */
export interface SamlHost {
  readonly orgId: string;
  /** `licensedFor(verdict, 'saml')`: whether anything new may be set up under the verdict `ee/` runs under. */
  readonly licensed: boolean;
  /** The account a settings or link call is made by, or null on the public routes. */
  readonly caller: { accountId: string } | null;
  config(): SamlStoredConfig | null;
  /** Save the configuration, its id kept when there is one, audited; turning enforcement on ends the calls let in without a proof. */
  save(next: SamlSaving): SamlStoredConfig;
  /** Remove it and everything it holds: its requests, its replay cache, its members' proofs. Audited. False when there was none. */
  remove(): boolean;
  /** Which of these domains the organisation proved by DNS. */
  verifiedDomains(domains: readonly string[]): string[];
  /** Whether the caller's own credential holds a live proof from this configuration. */
  callerHoldsProof(configId: string): boolean;
  /** Whether the organisation enforces another way in (its OpenID Connect provider), which enforcing SAML must wait for. */
  otherEnforced(): boolean;
  /** Sign-ins in progress for the organisation. */
  liveRequests(): number;
  /** Keep a sign-in in progress. `link` ties it to the caller's account and browser session. */
  insertRequest(r: { relayStateHash: string; requestId: string; configId: string; bindingHash: string; returnTo: string; link: boolean }): void;
  /** The request a RelayState and a binding cookie name, consumed once, unexpired; null for anything else. */
  consumeRequest(relayStateHash: string, bindingHash: string): SamlPendingRequest | null;
  /** Keep an assertion's id until `expiresAt`: false when it was already kept, which is a replay. */
  rememberAssertion(assertionHash: string, expiresAt: number): boolean;
  /**
   * Sign in, or link, as the identity `samlIdentity({orgId, id}, subject)` of the request this call
   * consumed (only after `consumeRequest` answered one): where to send the browser, or why not.
   */
  signIn(subject: string): { ok: true; location: string } | { ok: false; reason: string };
  /** Count a failed sign-in, by reason. */
  fail(reason: SamlFailReason): void;
}

// ---------------------------------------------------------------- legal hold and compliance access

export type HoldScope = 'org' | 'project' | 'room';
/** What deleting something under a hold answers, 409, wherever the deletion was asked for. */
export const UNDER_LEGAL_HOLD = 'This is under a legal hold, so it cannot be deleted until the hold is released. It still ends as usual.';

/**
 * The holder compliance access reads a room through, wrapped under the organisation's key, read only.
 * The server admits it as a key holder only where it lists `compliance` among its holder kinds,
 * since it is the one change that widens who can read a room.
 */
export const complianceHolder = (orgId: string) => `compliance:${orgId}` as const;

export interface ComplianceStatus {
  on: boolean;
  requestedBy: string | null;
  approvedBy: string | null;
  since: string | null;
}

// ---------------------------------------------------------------- the audit export

/** JSON Lines, one entry per line, content-free, pulled by an auditor or pushed to a SIEM. */
export const AUDIT_EXPORT_FORMAT = 'parley.audit.v1';
export interface AuditExportRecord {
  id: string;
  at: string;
  org: string;
  actor: string;
  action: string;
  /** A room is named by its keyed digest (`auditTarget`), never its id. */
  target: string;
  result: string;
  policy: string | null;
  chain_head: string;
  sig_status: 'signed' | 'unsigned';
}
export type AuditSinkKind = 'hec' | 'https' | 'syslog';
/** At most this many entries per pull. */
export const AUDIT_EXPORT_LIMIT_MAX = 1000;

// ---------------------------------------------------------------- legal hold and compliance access
// Legal hold, compliance access and the SIEM push, as the modules of `ee/` and the server's hosts
// of them (`EeHost.holds`, `EeHost.compliance`, `EeHost.siem`) say them. What is in force (a hold
// standing, compliance access shown, a hold released, compliance access turned off, a sink paused
// or removed) is the server's own code and needs no module: only what is new comes here.

/** A legal hold's id: `hold_` and 22 random characters, as every organisation id. */
export const HOLD_ID = /^hold_[A-Za-z0-9_-]{22}$/;
/** The longest reason a hold keeps (sealed under the organisation's key, shown to its owners and admins). */
export const HOLD_REASON_MAX = 500;
/** Live holds an organisation may have at once. */
export const HOLDS_MAX = 200;
/** Only an organisation's owners and admins set, list and release its holds. */
export const HOLDS_ADMINS_ONLY = 'Only an owner or an admin of this organisation can see, set or release its legal holds.';
/** Setting a hold where no licence covers legal hold: new, so refused (403). Holds already set stay in force. */
export const HOLDS_NOT_LICENSED =
  'Setting a legal hold needs a Crossroom licence that covers legal hold. Holds already set stay in force and can still be released.';
/** A hold on a project or room that is not this organisation's, whether it exists elsewhere or nowhere: 404. */
export const HOLD_TARGET_GONE = 'No such project or room in this organisation.';
/** Releasing a hold that is not this organisation's, does not exist, or was released already: 404. */
export const HOLD_GONE = 'No such legal hold in this organisation, or it was released already.';
export const HOLDS_FULL = `This organisation has ${HOLDS_MAX} legal holds standing. Release one before setting another.`;

/** A hold as an owner or admin sees it. `ref` is the organisation, project or room it names; null once a released hold's room is gone. */
export interface HoldView {
  id: string;
  scope: HoldScope;
  ref: string | null;
  /** Opened from `reason_sealed`; null where it does not open. */
  reason: string | null;
  setBy: string;
  setAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
}
export interface HoldsView {
  holds: HoldView[];
  /** Whether a new hold may be set here (`licensedFor(verdict, 'legalHold')`). Releasing never waits for it. */
  licensed: boolean;
}
/** `POST /api/orgs/:o/holds`. `ref` is the project's or room's id; for `org` it is the organisation's own, or absent. */
export interface HoldInput {
  scope: HoldScope;
  ref?: string;
  reason: string;
}

/**
 * What the holds module of `ee/` is lent to set one hold (`EeHost.holds`): the organisation's own
 * rows, for a caller the route has already found to be its owner or admin. Never a Core or a key.
 */
export interface HoldsHost {
  readonly orgId: string;
  readonly licence: LicenceVerdict;
  /** Whether `ref` is a project of this organisation (`project`), or a room made in one (`room`). */
  covers(scope: 'project' | 'room', ref: string): boolean;
  /** Holds of this organisation not released. */
  liveHolds(): number;
  /**
   * Set it: the reason sealed under the organisation's key, the hold audited in the same
   * transaction. Asks again first that the caller still is an owner or admin, and throws when not
   * (the route answers 410).
   */
  set(input: { scope: HoldScope; ref: string; reason: string }): HoldView;
}

export type ComplianceState = 'off' | 'requested' | 'on';
/** `GET /api/orgs/:o/compliance`: the state, who asked and who approved, and what it covers. */
export interface ComplianceView extends ComplianceStatus {
  state: ComplianceState;
  requestedAt: string | null;
  approvedAt: string | null;
  /** Rooms whose key the compliance holder holds now (`room_keys`), the same rooms that show it. */
  rooms: number;
  /** Whether compliance access may be turned on here (`licensedFor(verdict, 'compliance')`). Turning it off never waits for it. */
  licensed: boolean;
  /** Whether the caller may approve the request standing: an owner or admin who did not ask. */
  canApprove: boolean;
  /**
   * Whether this server can cover rooms at all (its holder kinds include `compliance`). Where it
   * cannot, compliance access may be turned on and covers nothing: no room is readable, so none says so.
   */
  available: boolean;
  /** For an auditor while it is on: the rooms it covers, newest first, metadata only. */
  covered?: ComplianceRoom[];
}
export interface ComplianceRoom {
  id: string;
  projectId: string;
  createdAt: string;
  status: string;
  endedAt: string | null;
}
/** `POST /api/orgs/:o/compliance`: the owner asks for it (`on: true`), or turns it off (`on: false`). */
export interface ComplianceInput {
  on: boolean;
}
/** `POST /api/orgs/:o/compliance/read`: an auditor reads one covered room. */
export interface ComplianceReadInput {
  room: string;
}
/** What the read answers: the room's minutes as its owner gets them. */
export interface ComplianceReadView {
  room: string;
  minutes: string;
}
/** Rooms listed to an auditor, newest first. */
export const COMPLIANCE_ROOMS_LISTED = 200;

export const COMPLIANCE_NOT_LICENSED =
  'Turning compliance access on needs a Crossroom licence that covers it. Turning it off never does.';
export const COMPLIANCE_OWNER_ONLY = 'Only an owner of this organisation can turn compliance access on or off.';
export const COMPLIANCE_SECOND_ADMIN = 'Compliance access is approved by a second owner or admin, not by whoever asked for it.';
export const COMPLIANCE_NOT_REQUESTED = 'Nobody has asked for compliance access to be turned on, so there is nothing to approve.';
export const COMPLIANCE_ALREADY_ON = 'Compliance access is already on.';
export const COMPLIANCE_AUDITORS_ONLY = "Only an auditor of this organisation reads rooms through compliance access.";
/** A room compliance access does not cover, or that does not exist: 404, the same either way. */
export const COMPLIANCE_ROOM_GONE = "No such room under this organisation's compliance access.";

/**
 * What compliance access says wherever it applies, in Crossroom's own words, never an
 * organisation's name or anything a person typed:
 * - `COMPLIANCE_NOTICE`: the room's header and a seat's page;
 * - `COMPLIANCE_BRIEFING_LINE`: every seat's briefing (one line, within `BRIEFING_LINE_MAX`, 160);
 * - `COMPLIANCE_MINUTES_ROOM`: the minutes' room line, in place of "only its owner can open it".
 */
export const COMPLIANCE_NOTICE = 'Compliance access is on: auditors of the organisation can read this room, and each read is recorded in it.';
export const COMPLIANCE_BRIEFING_LINE = "Compliance access is on in this room: the host organisation's auditors can read all of it, and each read is recorded.";
export const COMPLIANCE_MINUTES_ROOM = "private; its owner can open it, and so can its organisation's compliance access, each read recorded in the room";

/**
 * What the compliance module of `ee/` is lent to ask for and approve compliance access
 * (`EeHost.compliance`), for an owner or admin the route has already found. The host keeps the
 * rows and does what turning it on means (the holder's wraps), audited; each write asks again first
 * that the caller still is who they were, and throws when not (410).
 */
export interface ComplianceHost {
  readonly orgId: string;
  readonly licence: LicenceVerdict;
  readonly caller: { accountId: string; role: 'owner' | 'admin' | 'member' | 'auditor' };
  status(): ComplianceView;
  /** The owner asks: `requested`, audited. */
  request(): ComplianceView;
  /** A second owner or admin approves: `on`, every room it covers wrapped, audited. */
  approve(): ComplianceView;
}

export const AUDIT_SINK_KINDS: readonly AuditSinkKind[] = ['hec', 'https', 'syslog'];
export type AuditSinkFormat = typeof AUDIT_EXPORT_FORMAT | 'ocsf';
export const AUDIT_SINK_FORMATS: readonly AuditSinkFormat[] = [AUDIT_EXPORT_FORMAT, 'ocsf'];
/** Sinks one organisation may have. */
export const AUDIT_SINKS_MAX = 5;
export const AUDIT_SINK_ENDPOINT_MAX = 512;
export const AUDIT_SINK_SECRET_MAX = 512;
/** Entries one push sends at most. */
export const SIEM_BATCH_MAX = 200;
/**
 * An HTTPS sink's signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`,
 * so a receiver checks the body and refuses one replayed outside its own window.
 */
export const SIEM_SIGNATURE_HEADER = 'x-parley-signature';
/** Why a push failed, as `audit_sinks.last_error` keeps it: a code, never a sentence that could quote anything. */
export const SIEM_ERROR_CODES = ['blocked', 'dns', 'timeout', 'network', 'tls', 'http_4xx', 'http_5xx', 'bad_config'] as const;
export type SiemErrorCode = (typeof SIEM_ERROR_CODES)[number];
export const SIEM_NOT_LICENSED = 'Adding an audit sink needs a Crossroom licence that covers SIEM push. Sinks already added keep receiving.';
export const SIEM_ADMINS_ONLY = 'Only an owner or an admin of this organisation can see or change where its audit log is pushed.';
export const AUDIT_SINK_GONE = 'No such audit sink in this organisation.';
export const AUDIT_SINKS_FULL = `This organisation has ${AUDIT_SINKS_MAX} audit sinks. Remove one before adding another.`;

/**
 * A sink as an admin sees it. The endpoint is shown as its scheme, host and port only (a HEC or
 * HTTPS path can carry a token), and the secret never.
 */
export interface AuditSinkView {
  id: string;
  kind: AuditSinkKind;
  format: AuditSinkFormat;
  endpoint: string;
  state: 'active' | 'paused';
  /** The last entry delivered. */
  cursor: number;
  lastError: SiemErrorCode | null;
  pushedAt: string | null;
  createdAt: string;
}
export interface AuditSinksView {
  sinks: AuditSinkView[];
  /** Whether a sink may be added here (`licensedFor(verdict, 'siemPush')`). Pausing and removing never wait for it. */
  licensed: boolean;
}
/** `PUT /api/orgs/:o/audit/sinks`: one change. */
export type AuditSinkInput =
  | { op: 'add'; kind: AuditSinkKind; endpoint: string; secret?: string; format?: AuditSinkFormat }
  | { op: 'remove' | 'pause' | 'resume'; id: string };

/** What the SIEM module of `ee/` is lent to add a sink (`EeHost.siem`), for an owner or admin. */
export interface SiemSinkHost {
  readonly orgId: string;
  readonly licence: LicenceVerdict;
  sinks(): number;
  /** Add it, endpoint and secret sealed under the organisation's key, audited; asks again first that the caller still may (410). */
  add(sink: { kind: AuditSinkKind; endpoint: string; secret: string | null; format: AuditSinkFormat }): AuditSinkView;
}

/** A sink as the push opens it for one pass: endpoint and secret in the clear, for that pass only. */
export interface SiemSink {
  id: string;
  kind: AuditSinkKind;
  format: AuditSinkFormat;
  endpoint: string;
  secret: string | null;
}
export type SiemPushResult = { ok: true } | { ok: false; code: SiemErrorCode };

/** The SIEM module: its settings route, and the push the server's worker hands each batch to. */
export interface SiemModule extends EeRouteModule {
  /**
   * Send one batch of content-free entries, in order, through `host.fetch` (HEC, HTTPS) or
   * `host.tls` (syslog over TLS): all of it, or a failure code. Never throws.
   */
  push(sink: SiemSink, records: readonly AuditExportRecord[], host: EeHost): Promise<SiemPushResult>;
}

/** A sink's endpoint as an admin sees it: scheme, host and port, never a path, a query or credentials. */
export function sinkEndpointShown(kind: AuditSinkKind, endpoint: string): string {
  if (kind === 'syslog') return `tls://${endpoint}`;
  try {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/** What an action does, for OCSF's `activity_id`: 1 create, 2 read, 4 delete, 3 everything else. */
function ocsfActivity(action: string): 1 | 2 | 3 | 4 {
  const last = action.split('.').at(-1) ?? '';
  if (/^(create|created|set|add|added|propose|mint|minted|invite|invited|configured)$/.test(last)) return 1;
  if (/^(read|export|exported|list|listed|opened)$/.test(last)) return 2;
  if (/^(delete|deleted|remove|removed|revoke|revoked|release|released)$/.test(last)) return 4;
  return 3;
}

/**
 * One entry in OCSF 1.1's API Activity class (6003, Application Activity), the SIEM-neutral mapping
 * of `parley.audit.v1`: the same fields, nothing added that the entry does not hold. Pure.
 */
export function toOcsf(r: AuditExportRecord): Record<string, unknown> {
  const activity = ocsfActivity(r.action);
  const colon = r.target.indexOf(':');
  return {
    class_uid: 6003,
    category_uid: 6,
    activity_id: activity,
    type_uid: 600300 + activity,
    severity_id: 1,
    status_id: r.result === 'ok' ? 1 : 2,
    time: Date.parse(r.at),
    actor: { user: { uid: r.actor } },
    api: { operation: r.action },
    resources: [{ type: colon > 0 ? r.target.slice(0, colon) : 'other', uid: colon > 0 ? r.target.slice(colon + 1) : r.target }],
    metadata: { version: '1.1.0', uid: `${r.org}:${r.id}`, log_name: AUDIT_EXPORT_FORMAT, product: { name: 'Parley', vendor_name: 'Parley' } },
    unmapped: { org: r.org, chain_head: r.chain_head, sig_status: r.sig_status, policy: r.policy },
  };
}

// ---------------------------------------------------------------- federation

export const FED_PROTOCOL = 'parley-fed/1';
/** `GET /.well-known/parley-relay`: the relay and its keys, and no organisation. */
export interface RelayDiscovery {
  protocol: typeof FED_PROTOCOL;
  relay: string;
  endpoint: string;
  keys: [{ kid: string; alg: 'ed25519'; use: 'sig'; pub: string }, { kid: string; alg: 'x25519'; use: 'enc'; pub: string }];
}
/** RFC 9421 covered components of every signed request between relays, and `created`. */
export const FED_SIGNATURE_COMPONENTS = ['@method', '@target-uri', 'content-digest', 'parley-connection', 'parley-nonce'] as const;
/** `created` within this many seconds either way. */
export const FED_CREATED_SKEW_S = 300;
/** Each nonce is kept this long (`fed_nonces`), twice the window. */
export const FED_NONCE_TTL_S = 600;
export const FED_BODY_MAX = 512 * 1024;
/**
 * The prefix of a job between relays that a relay keeps (`fed_jobs.payload_sealed`):
 * HPKE-sealed to the peer's pinned encryption key (`relays.enc_public_key`), its AAD binding
 * the peer, the job's id and its kind, as `j1.` binds a runner's job (jobseal.ts). The relay that
 * keeps it cannot open it. Never under the instance key: a seat's traffic is room content.
 */
export const FED_SEAL_PREFIX = 'f1.';
/** Every refusal of a request between relays: unsigned, unknown peer, replayed, out of its window. */
export const PEER_REFUSED = 'This request between relays is not signed by a peer this relay pinned.';

// Below: what federation's module of `ee/` and the server's host of it
// (`EeHost.federation`) say to each other.

/** Where every request between relays goes: the pinned origin, then this, then the operation. */
export const FED_PATH_PREFIX = '/fed/v1/';
/**
 * The operations a peer may ask for (`POST /fed/v1/<op>`, `seat` with a seat operation after it):
 * `connect` redeems a connection code across relays once both admins pinned each other; `dispatch`
 * asks the guest relay to start its seat; `seat` is the guest's runner's call, forwarded; `stop`
 * says a seat or a room is done; `revoke` ends a connection; `keys` announces a rotation, signed by
 * the old key; `record` and `cosign` serve the seat's record and co-signatures.
 */
export const FED_OPS = ['connect', 'dispatch', 'seat', 'stop', 'revoke', 'keys', 'record', 'cosign'] as const;
export type FedOp = (typeof FED_OPS)[number];
/** The header a forwarded seat's federation link travels in, covered by the signature whenever present. */
export const FED_SEAT_HEADER = 'x-parley-seat';
/** The header naming the connection a request is about (`parley-connection`, a covered component). */
export const FED_CONNECTION_HEADER = 'parley-connection';
export const FED_NONCE_HEADER = 'parley-nonce';
/** The one label of the signature on every request and response between relays (RFC 9421). */
export const FED_SIGNATURE_LABEL = 'fed';
/** The covered components of a response: its status, its digest, and the request's nonce echoed. */
export const FED_RESPONSE_COMPONENTS = ['@status', 'content-digest', 'parley-nonce'] as const;

/** A peer relay as this relay pinned it (`relays`): only its pinned origin is ever fetched. */
export interface FedPeer {
  id: string;
  /** The origin pinned, `https://host[:port]`, no path. */
  url: string;
  kid: string;
  /** Ed25519, raw, base64url. */
  publicKey: string;
  /** X25519, raw, base64url. */
  encPublicKey: string;
}

/** This relay's own federation keys, the public halves (`fed_keys`). */
export interface FedOwnKeys {
  kid: string;
  sigPublic: string;
  encPublic: string;
}

/**
 * What two admins read to each other out of band before either pins the other's relay: one
 * fingerprint over both public keys, 32 hex digits in groups of four.
 */
export const fedFingerprint = (sigPublic: string, encPublic: string): string =>
  sha256Hex(`parley/fed/fingerprint/v1|${sigPublic}|${encPublic}`)
    .slice(0, 32)
    .replace(/(.{4})(?=.)/g, '$1-');

/**
 * What a key rotation's announcement proves (`keys`): the new signing key's signature over this,
 * the old key id and the new keys, so a peer never pins a key the relay does not hold. The request
 * carrying it is signed by the old key.
 */
export const fedRotationStatement = (oldKid: string, kid: string, publicKey: string, encPublicKey: string) =>
  `parley/fed/rotate/v1|${oldKid}|${kid}|${publicKey}|${encPublicKey}`;

/** A relay's discovery as an admin is shown it before pinning: its origin and fingerprint, nothing a peer could steer. */
export interface FedInspection {
  relay: string;
  kid: string;
  publicKey: string;
  encPublicKey: string;
  fingerprint: string;
}

/** A call from a pinned peer, its signature, window, nonce and digest checked, as `ee/` hands it to the server. */
export interface FedCall {
  peer: FedPeer;
  op: FedOp;
  /** For `seat`: the seat operation (`say`, `wait`, `status`, `view`, ...). */
  seatOp: string | null;
  connectionId: string;
  /** The JSON body, parsed; null for an empty one. */
  body: unknown;
  /** The forwarded seat's federation link (`x-parley-seat`), covered by the signature. */
  seat: string | null;
}

/** What the server answers a peer's call: signed by `ee/` on its way out. */
export interface FedAnswer {
  status: number;
  body: unknown;
}

/** A request this relay makes to a pinned peer. */
export interface FedOutgoing {
  op: FedOp;
  seatOp?: string;
  connectionId: string;
  body: unknown;
  seat?: string | null;
}

/**
 * A peer's answer, its signature and echoed nonce checked: `ok` with its status and body, or why
 * there is none. `unreachable` covers a refused connection, a timeout, a redirect (never followed)
 * and a body over the cap; `unsigned` an answer whose signature does not verify; `breaker` a peer
 * this relay stopped calling for a while after too many failures in a row.
 */
export type FedReply = { ok: true; status: number; body: unknown } | { ok: false; reason: 'unreachable' | 'unsigned' | 'breaker' | 'no-keys' };

/**
 * What a sealed job between relays is bound to (`f1.`): the peer it is for, by the key id of the
 * encryption key it was sealed to (both relays name a key alike, unlike a relay's row id), its id
 * and its kind.
 */
export interface FedSealContext {
  recipientKid: string;
  jobId: string;
  kind: string;
}

/**
 * What the server lends federation's module of `ee/` (`EeHost.federation`): never a private key.
 * It signs with this relay's key and computes the X25519 shared secret for an ephemeral key, so the
 * keys stay in the server's process, wrapped at rest.
 */
export interface FederationHost {
  /** This relay's public keys, or null before an admin first pinned a peer (nothing to discover). */
  keys(): FedOwnKeys | null;
  /** Ed25519 over `data` with this relay's current key. */
  sign(data: Uint8Array): Uint8Array;
  /** The X25519 shared secret of this relay's encryption key and `peerPublic` (raw, base64url); all-zero refused. */
  x25519(peerPublic: string): Uint8Array;
  /** A peer this relay pinned and has not revoked, by the key id it signs with. */
  peerByKid(kid: string): FedPeer | null;
  /** Records a request's nonce for `FED_NONCE_TTL_S`: false when it was seen already (a replay). */
  rememberNonce(peerId: string, nonce: string): boolean;
  /** Acts on a verified call. Its answer is signed on the way out. */
  serve(call: FedCall): Promise<FedAnswer>;
}

// ---------------------------------------------------------------- the shard router

/** How long moving an organisation drains its calls in flight before the copy. */
export const SHARD_MOVE_DRAIN_S = 120;
/** What the router answers for an organisation that is moving: 503, then its calls go to the new shard. */
export const SHARD_MOVING = 'This organisation is moving to another server for a moment. Try again shortly.';

// Below: what the shard router in `ee/` and the server's command that starts it (through
// `EeHost.shard`) say to each other.

/**
 * The shard every organisation lives on until it is moved, and where anonymous rooms, accounts,
 * runners and every id no route names go. An id the directory does not know is answered
 * by this shard's own code, so it gets exactly the 404 it always did.
 */
export const DEFAULT_SHARD = '0';

/** Why no organisation moves off the default shard yet (`ShardHost.movesOffDefault`). */
export const MOVE_OFF_DEFAULT = `An organisation stays on shard ${DEFAULT_SHARD} until the router can route its project and team calls, which name no organisation; moving it would leave two shards writing its database`;

/** A shard's id: letters, digits, `_` and `-`. */
export const SHARD_ID = /^[A-Za-z0-9_-]{1,32}$/;
/** Where the router runs: the shards it routes to, as `<id>=<url>` separated by commas. */
export const SHARDS_ENV = 'PARLEY_SHARDS';
/**
 * Where the router is the edge (nothing in front of it sets the caller's address): the header it
 * sets to the caller's socket address, overwriting whatever the caller sent. The shards read the same
 * name as `PARLEY_CLIENT_IP_HEADER`, so their per-network limits count callers apart, not the router.
 */
export const ROUTER_CLIENT_IP_ENV = 'PARLEY_ROUTER_CLIENT_IP_HEADER';
/** The key `/internal/v1` requests between shards are signed with: 32 bytes or more, base64url. */
export const SHARD_KEY_ENV = 'PARLEY_SHARD_KEY';
/** The router's answer when the shard that holds a request does not answer: 502. It names no shard and no id. */
export const SHARD_UNREACHABLE = 'This Crossroom could not reach the server that holds this just now. Try again shortly.';
/** `Retry-After` on a moving organisation's 503, in seconds. */
export const SHARD_RETRY_AFTER_S = 5;
/**
 * The private path between shards. The router answers it with the prefix's own 404 and
 * never forwards it, whatever the path's spelling, so nobody outside reaches it through the router.
 */
export const INTERNAL_PREFIX = '/internal';
export const INTERNAL_JOBS_PATH = '/internal/v1/jobs';
/** How far an internal request's time may be from the receiver's clock, either way. */
export const INTERNAL_SKEW_S = 60;
/** The headers an internal request is signed in. */
export const INTERNAL_HEADERS = { shard: 'x-parley-shard', time: 'x-parley-shard-time', nonce: 'x-parley-shard-nonce', sig: 'x-parley-shard-sig' } as const;
/** The one refusal of an internal request, the same bytes whatever was wrong (401). */
export const INTERNAL_REFUSED = 'internal request refused';

/** A shard as the router is configured with it. `url` is its address on the private network. */
export interface ShardConfig {
  id: string;
  url: string;
}

/**
 * What the server lends the shard router (`EeHost.shard`), read from the environment where the
 * router runs. Never a key of a room, an organisation or the instance: the router routes, and opens
 * nothing.
 */
export interface ShardHost {
  /**
   * The verdict `ee/` was activated under. Routing what the directory already names runs under any
   * verdict (`'in-force'`): a lapsed licence never takes an organisation's rooms away. Adding a
   * shard and moving an organisation are new, so only where `licensedFor(licence, 'shardRouter')`.
   */
  readonly licence: LicenceVerdict;
  readonly shards: readonly ShardConfig[];
  /**
   * How long a proxied call may go without a byte either way before the router gives up on it:
   * `WAIT_MAX_S + 30`, so a parked `wait` is never cut and an event stream's pings keep it open.
   */
  readonly idleTimeoutMs: number;
  /** `ROUTER_CLIENT_IP_ENV`: the header the router sets to the caller's address, or null to pass headers as they came. */
  readonly clientIpHeader: string | null;
  /** How long moving an organisation drains its calls in flight: `SHARD_MOVE_DRAIN_S` unless a test shortens it. */
  readonly drainMs?: number;
  /** How often the router looks for a move to make, in milliseconds (1 s unless a test says otherwise). */
  readonly moveTickMs?: number;
  /**
   * Whether an organisation may move off `DEFAULT_SHARD`. Never set outside tests: project and team
   * routes (`/api/projects/:p/*`, `/api/teams/:t/*`) name no organisation the router can look up,
   * so they reach the default shard wherever the organisation is, and a second process would open
   * and write its database beside the shard that holds it. Until the directory routes projects and
   * teams, every organisation stays on the default shard (SECURITY.md, known gaps).
   */
  readonly movesOffDefault?: boolean;
  /** A line for the operator. The router never puts a path, a token, a room id or a body in one. */
  readonly log: (line: string) => void;
}

/** Where an organisation is, as the directory says: its shard, and the move in progress if any. */
export interface OrgPlacement {
  orgId: string;
  shard: string;
  epoch: number;
  /** The shard it is moving to, while it moves. */
  movingTo: string | null;
}

export type MoveAnswer = { ok: true; placement: OrgPlacement } | { ok: false; reason: string };

/** An internal request as the receiver sees it. */
export interface InternalRequest {
  method: string;
  path: string;
  /** Lower-cased names. */
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
}

/** Signs and checks `/internal/v1` requests between shards (HMAC-SHA256, a nonce, a time window). */
export interface InternalChannel {
  /** The headers that sign one request from shard `from`. */
  sign(from: string, req: { method: string; path: string; body: string }): Record<string, string>;
  /** The sending shard where the request verifies and was not seen before, or null: the same refusal whatever failed. */
  verify(req: InternalRequest): { from: string } | null;
}

// ---------------------------------------------------------------- the boundary itself

/**
 * A request as an Apache route module hands it to `ee/`: no Hono context, no Core, no key. The route
 * module has already checked the caller's credential where the credential is the server's (an
 * account, an owner token); a credential `ee/` defines (a SCIM token, a peer's signature, a SAML
 * assertion) it checks itself, through what `EeHost` lends it.
 */
export interface EeRequest {
  method: string;
  /** The path as the server received it. */
  path: string;
  query: Readonly<Record<string, string>>;
  /** Lower-cased names. */
  headers: Readonly<Record<string, string>>;
  /** The body as text: a module that needs the exact bytes (a signature over them) has them. */
  body: string;
  /** The organisation the route resolved, where it names one. */
  orgId: string | null;
}

export interface EeResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

/**
 * What the server lends `ee/` for one call: for each module, the narrow capability it needs, and
 * never a Core, a database handle with more than its own tables, or a key in the clear.
 */
export interface EeHost {
  /** This relay's public URL. */
  readonly relay: string;
  readonly now: () => number;
  /**
   * The server's `safeFetch`, the only way `ee/` reaches the network over HTTP: Rekor, a TSA, a
   * peer relay, a KMS, a SIEM. The server's checks refuse in `ee/` every other fetch, every builtin
   * that would reach the network, the disk, another process or a database any other way, and every
   * package not listed.
   */
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /**
   * The server's `safeTlsConnect`, for what is not HTTP, under `safeFetch`'s
   * rules: syslog over TLS (RFC 5425) to an audit sink. Lent to the SIEM module alone.
   */
  readonly tls?: (host: string, port: number) => Promise<EeTlsStream>;
  /**
   * One organisation's SCIM directory (`ScimDirectory`), lent to the SCIM module alone and
   * only for a call whose bearer token checked out; absent, the module refuses with SCIM's one 401.
   */
  readonly scim?: ScimDirectory;
  /** One organisation's SAML rows and the one sign-in a consumed request allows. Lent to the SAML module alone. */
  readonly saml?: SamlHost;
  /**
   * A KMS's credentials, as the server reads them from its own environment for each call:
   * null where none are configured for that provider.
   * Lent to the KMS module alone, never kept by it, and never sent anywhere but the provider's own
   * address, which the server chose too (`KeyProviderConfig.endpoint`).
   */
  readonly kmsCredentials?: (provider: Exclude<KeyProviderId, 'local'>) => Promise<KmsCredentials | null>;
  /** One organisation's legal holds, to set one. Lent to the holds module alone. */
  readonly holds?: HoldsHost;
  /** One organisation's compliance access, to ask for and approve it. Lent to the compliance module alone. */
  readonly compliance?: ComplianceHost;
  /** One organisation's audit sinks, to add one. Lent to the SIEM module alone; its push is lent `tls` beside `fetch`. */
  readonly siem?: SiemSinkHost;
  /** This relay's federation keys, as operations, its pinned peers and their nonces. Lent to the federation module alone. */
  readonly federation?: FederationHost;
  /** The router's shards, its licence verdict and its timeouts. Lent to the shard router alone. */
  readonly shard?: ShardHost;
}

/** What `EeHost.tls` opens: bytes out and the end, every failure a rejected promise. */
export interface EeTlsStream {
  write(data: string | Uint8Array): Promise<void>;
  end(): Promise<void>;
}

/** A module of `ee/` that serves routes. `built` false is a stub, whose routes answer 501. */
export interface EeRouteModule {
  readonly feature: EeFeature;
  readonly built: boolean;
  handle(req: EeRequest, host: EeHost): Promise<EeResponse>;
}

/** Federation also answers discovery: null until this relay has its federation keys. */
export interface FederationModule extends EeRouteModule {
  /** `host` lends this relay's keys; without it, or before the keys exist, null. */
  discovery(relay: string, host?: EeHost): RelayDiscovery | null;
  /**
   * A relay's discovery, fetched from an origin an admin gave (a connection code's relay part, or one
   * typed), never from anything a peer said: null unless it answers in the protocol's shape for that
   * very origin. What an admin compares out of band before pinning.
   */
  inspect?(origin: string, host: EeHost): Promise<FedInspection | null>;
  /** A request signed with this relay's key to a pinned peer's origin, its answer's signature checked. */
  send?(peer: FedPeer, request: FedOutgoing, host: EeHost): Promise<FedReply>;
  /** `plain` sealed to a peer's encryption key (`f1.`), bound to `context`. */
  seal?(plain: string, peer: Pick<FedPeer, 'encPublicKey'>, context: FedSealContext): string;
  /** A value a peer sealed to this relay, opened through `host.federation`, or null. */
  open?(sealed: string, context: FedSealContext, host: EeHost): string | null;
}

/** How to reach a provider's key: its reference, and the provider's own address and region. */
export interface KeyProviderConfig {
  keyRef: string;
  endpoint?: string;
  region?: string;
}

export interface KmsModule {
  readonly feature: 'kms';
  readonly built: boolean;
  provider(id: Exclude<KeyProviderId, 'local'>, config: KeyProviderConfig, host: EeHost): KeyProvider;
}

// Below: what the server lends the KMS module (EeHost.kmsCredentials), and what an
// organisation's key-provider settings say (the server's KMS routes and the web app's settings).

/**
 * A KMS's credentials, read by the server from its environment (or its cloud's workload identity)
 * for one call. Vault takes its token as `X-Vault-Token`; AWS signs every request with SigV4 and
 * never sends the secret; GCP and Azure take an OAuth access token.
 */
export type KmsCredentials =
  | { kind: 'vault'; token: string; namespace?: string }
  | { kind: 'aws'; accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | { kind: 'bearer'; token: string };

/** Each provider's name, as an owner reads it. */
export const KEY_PROVIDER_LABELS: Readonly<Record<KeyProviderId, string>> = {
  local: "This Crossroom's own instance key",
  'vault-transit': 'HashiCorp Vault (transit)',
  'aws-kms': 'AWS KMS',
  'gcp-kms': 'Google Cloud KMS',
  'azure-kv': 'Azure Key Vault',
};

/** What a key reference looks like at each provider, as the settings page shows it. */
export const KEY_REF_HINTS: Readonly<Record<Exclude<KeyProviderId, 'local'>, string>> = {
  'vault-transit': 'a transit key name, such as parley-acme',
  'aws-kms': 'a key or alias ARN, such as arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab',
  'gcp-kms': 'a key name, such as projects/acme/locations/europe-west1/keyRings/parley/cryptoKeys/org-key',
  'azure-kv': 'a key identifier, such as https://acme-vault.vault.azure.net/keys/parley-org-key',
};

/** The longest key reference Crossroom accepts (a GCP key name with a long project id fits). */
export const KMS_KEY_REF_MAX = 512;

/** Moving an organisation's key to a provider is new, so it waits for a licence that covers KMS (EnterpriseUse). */
export const KMS_NOT_LICENSED = "Moving an organisation's key to a key provider needs a licence that covers KMS on this Crossroom.";
/** A legal hold stands on the organisation: its key stays where only this Crossroom can open it. */
export const KMS_HELD = "A legal hold covers this organisation, so its key cannot be moved to a key provider until the hold is released.";

/** One provider as the settings page offers it. */
export interface KmsProviderOffer {
  id: KeyProviderId;
  label: string;
  /** Whether this Crossroom holds credentials and an address for it (its operator's environment). */
  offered: boolean;
  /**
   * Whether this provider has been run against the real service. False for every cloud provider
   * until it has: they are tested against contract fakes of each service's API.
   */
  verified: boolean;
}

/** `GET /api/orgs/:o/kms` (an owner's): where the organisation's key is held, by reference, never key material. */
export interface KmsSettingsView {
  provider: KeyProviderId;
  /** The key's reference at the provider; null for the local provider. */
  keyRef: string | null;
  /** The organisation key's version, which every wrap is bound to. */
  keyVersion: number;
  /** When the organisation first moved its key, and when it last moved or re-wrapped it; null if never. */
  since: string | null;
  rotatedAt: string | null;
  providers: KmsProviderOffer[];
  /** Whether this Crossroom's licence lets the key move to a provider (moving back to the local one never waits for it). */
  licensed: boolean;
  /** Whether a legal hold covers the organisation, which keeps its key from moving to a provider. */
  held: boolean;
  /**
   * Where the organisation's data lives: its region, the regions this Crossroom
   * offers, and whether residency is claimed here at all (never on the hosted instance).
   */
  residency: { region: string | null; regions: string[]; claimed: boolean };
}

/** `PUT /api/orgs/:o/kms`: the provider to hold the organisation's key, and the key there. */
export type KmsMoveInput = { provider: 'local' } | { provider: Exclude<KeyProviderId, 'local'>; keyRef: string };

/** `crossroom serve --role router`. */
export interface ShardModule {
  readonly feature: 'shardRouter';
  readonly built: boolean;
  startRouter(o: { port: number; host: string; dataDir: string; relay: string }, host: EeHost): Promise<{ url: string; close(): Promise<void> }>;
  // The shard router's, below.
  /**
   * Ask the running router to move an organisation to shard `to`: new, so only where the licence
   * covers the shard router (`host.shard.licence`). It marks the move in the directory; the router
   * answers the organisation's calls 503 from then, drains them, and flips the route.
   */
  requestMove(o: { dataDir: string; orgId: string; to: string }, host: EeHost): MoveAnswer;
  /** Take back a move the router has not flipped yet. Winding down, so under any verdict. */
  cancelMove(o: { dataDir: string; orgId: string }): MoveAnswer;
  /** Where an organisation is now, or null for one the directory does not have. */
  placement(o: { dataDir: string; orgId: string }): OrgPlacement | null;
  /** Signing and checking requests between shards under `key` (`SHARD_KEY_ENV`). */
  internal(key: Uint8Array, o?: { now?: () => number }): InternalChannel;
}

/** What `activate` answers: every module, built or a stub, under the licence it was activated with. */
export interface EnterpriseModules {
  /**
   * The verdict they were activated under. `ok: false` only for an `'in-force'` use (EnterpriseUse)
   * without a licence that verifies, where every module serves only what is in force.
   */
  readonly licence: LicenceVerdict;
  readonly saml: EeRouteModule;
  readonly scim: EeRouteModule;
  readonly holds: EeRouteModule;
  readonly compliance: EeRouteModule;
  readonly siem: SiemModule;
  readonly federation: FederationModule;
  readonly kms: KmsModule;
  readonly shard: ShardModule;
}

/**
 * What `@parley/ee` exports, the one shape the server's loader reads from
 * its one dynamic import. `keyProvider` is the data path: the server calls it for a key a provider
 * of `ee/` already wrapped, whatever the licence or the flags say. `activate` takes a verdict
 * that is not `ok` for an `'in-force'` use (EnterpriseUse) alone.
 */
export interface EnterpriseEntry {
  verifyLicence(document: string, check: LicenceCheck): LicenceVerdict;
  hostedLicence(relay: string): Extract<LicenceVerdict, { ok: true }>;
  activate(licence: LicenceVerdict): EnterpriseModules;
  keyProvider(id: Exclude<KeyProviderId, 'local'>, config: KeyProviderConfig, host: EeHost): KeyProvider;
}
