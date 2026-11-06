/**
 * Server-side validation for end-to-end rooms.
 *
 * Kept apart from `e2ee.ts` because that module runs in the browser, and a validation library is
 * most of what the browser would otherwise download: a page that only encrypts and decrypts has
 * no use for a schema. Only the server validates what arrives, so only the server imports this.
 */
import { z } from 'zod';
import { E2EE_FIELDS, envelopeMax, isEnvelope, type SealedArg } from './e2ee.js';
import { SEATS_DESCRIPTION, SessionMode } from './index.js';
import { ROOM_SEATS_LIMIT } from './text.js';

/** A room option an end-to-end room refuses until the seat helper encrypts what it carries. */
const refusedOption = (name: string) =>
  z
    .unknown()
    .refine((v) => v === undefined || v === false || v === 'off', `${name}: an end-to-end encrypted room cannot use it yet; leave it off or open a room without end-to-end encryption`)
    .transform((): undefined => undefined)
    .optional()
    .describe(`Refused in an end-to-end room: leave ${name} out.`);

/** Server-side check for an argument an end-to-end room says must arrive encrypted. */
export const envelopeArg = (a: SealedArg) =>
  z
    .string()
    .max(envelopeMax(a.max))
    .refine((v) => v === '' || isEnvelope(v), 'this room is end-to-end encrypted: encrypt this field with the room key');

/**
 * Creating an end-to-end room: the owner's fields arrive already encrypted, and every seat is
 * attached. A hosted seat would be an agent run by this server, which would need the key.
 */
export const CreateE2eeSessionInput = z.object({
  title: envelopeArg(E2EE_FIELDS.owner.title).refine((v) => v !== '', 'a room needs a title'),
  mode: SessionMode.default('free'),
  sharedBrief: envelopeArg(E2EE_FIELDS.owner.sharedBrief).default(''),
  maxMessages: z.number().int().min(2).max(500).default(40),
  participants: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        kind: z.literal('attached', { error: 'an end-to-end encrypted room takes attached seats only: a hosted seat runs on this server, which would need the key' }),
        privateBrief: envelopeArg(E2EE_FIELDS.owner.privateBrief).optional(),
        // A role is content the seat helper does not decrypt yet, so it would reach the agents as
        // ciphertext, or the server in the clear: refused until the helper handles it. `''` is none.
        role: z
          .string()
          .max(0, 'role: an end-to-end encrypted room cannot give a seat a role yet; leave it empty or open a room without end-to-end encryption')
          .optional(),
        // Which seat leads is not content, so it is kept as it is.
        lead: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(ROOM_SEATS_LIMIT)
    .describe(SEATS_DESCRIPTION),
  // The board, typed tools and sub-rooms carry content the helper does not encrypt yet. The schema
  // is not strict, so without these a request for them was dropped in silence.
  board: refusedOption('board'),
  typedTools: refusedOption('typedTools'),
  subrooms: refusedOption('subrooms'),
  sparse: refusedOption('sparse'),
  lane: refusedOption('lane'),
  e2ee: z.object({ check: z.string().refine(isEnvelope, 'the key check must be an envelope') }),
  /** The end-to-end project the room is made in; the schema is not strict, so without this it was dropped. */
  projectId: z.string().min(1).max(64).optional(),
});
export type CreateE2eeSessionInput = z.infer<typeof CreateE2eeSessionInput>;
