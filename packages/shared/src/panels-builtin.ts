/**
 * The panels Crossroom ships, as /api/templates and `crossroom panel` offer them. Data only, so the
 * server and the `crossroom` command read the same list.
 */
import type { PanelInput } from './panels.js';

/** What every seat of a built-in panel is told about evidence: its own, with where it came from. */
const EVIDENCE =
  'Bring evidence from your own repository, tools or notes, and give its source (a file and its lines, a command, a document) with each piece you share. Say so when you only think something rather than know it.';

/** A built-in panel, as `/api/templates` and `crossroom panel` offer it. */
export interface BuiltInPanel {
  id: string;
  tagline: string;
  panel: PanelInput;
}

/**
 * The panels Crossroom ships: attached seats only, so every instance can open them, each with one
 * lead and a role per seat, a private brief that asks for sourced evidence, and a shared brief that
 * says what the room ends with in `finish`'s own terms (decisions, actions, open questions). Their
 * gate is null: they make no claim that evidence changes a mind, only that the room ends with a record.
 */
export const BUILT_IN_PANELS: readonly BuiltInPanel[] = [
  {
    id: 'panel-design-review',
    tagline: 'Four agents review one design from where each stands: the design, its security, running it, and calling it.',
    panel: {
      version: 1,
      name: 'Design review',
      mode: 'review',
      sharedBrief: [
        'Design: [the design, and where it is written down]',
        'The Architect presents the design and chairs the review. Security, Operations and the API consumer each review it from their own role and their own evidence, and address the Architect, or each other, with @ and the seat name when a point is for one of them.',
        'End with the decisions taken, the actions (who changes what before it ships) and the questions still open.',
      ].join('\n\n'),
      seats: [
        {
          name: 'Architect',
          role: 'Owns the design: presents it, answers for its choices and chairs the review',
          lead: true,
          kind: 'attached',
          privateBrief: `You wrote or own this design. Present it briefly: what it does, the choices it makes and what it leaves out. Take each concern seriously and say what you would change. ${EVIDENCE}`,
        },
        {
          name: 'Security',
          role: 'Looks for auth gaps, data exposure and abuse of the design',
          kind: 'attached',
          privateBrief: `Review the design for who can do what: authentication, authorisation, data that crosses a boundary it should not, secrets, and how it can be abused. ${EVIDENCE}`,
        },
        {
          name: 'Operations',
          role: 'Runs it: rollout, monitoring, failure modes and rollback',
          kind: 'attached',
          privateBrief: `Review the design as the people who will run it: how it is deployed and rolled back, what it needs to be watched by, how it fails and what it costs. ${EVIDENCE}`,
        },
        {
          name: 'API consumer',
          role: 'Calls it: the interface, its errors and what a change would break',
          kind: 'attached',
          privateBrief: `Review the design as a caller: is the interface clear, are errors and limits stated, and what in your own code would break or need to change. ${EVIDENCE}`,
        },
      ],
    },
  },
  {
    id: 'panel-cross-repo',
    tagline: 'One change across two repositories: a lead and one agent per repository settle who changes what, in what order.',
    panel: {
      version: 1,
      name: 'Cross-repo coordination',
      mode: 'reconcile',
      sharedBrief: [
        'Change: [the change, and why it is needed]',
        'Service A and Service B each work in their own repository. Each says what the change means for its repository, what it depends on from the other, and what would break. The Lead keeps the plan.',
        'End with the decisions, the actions (who changes what, and in what order they ship), and the questions still open.',
      ].join('\n\n'),
      seats: [
        {
          name: 'Lead',
          role: 'Coordinates the change and keeps the plan: who changes what, and in what order',
          lead: true,
          kind: 'attached',
          privateBrief: `You coordinate. Ask each service what the change needs from its side and what it depends on, find the order that never breaks either one, and write it down as actions. ${EVIDENCE}`,
        },
        {
          name: 'Service A',
          role: 'Speaks for the first repository',
          kind: 'attached',
          privateBrief: `You work in the first repository. Say what the change needs here, what in this code depends on the other service, and what would break if the other side shipped first. ${EVIDENCE}`,
        },
        {
          name: 'Service B',
          role: 'Speaks for the second repository',
          kind: 'attached',
          privateBrief: `You work in the second repository. Say what the change needs here, what in this code depends on the other service, and what would break if the other side shipped first. ${EVIDENCE}`,
        },
      ],
    },
  },
  {
    id: 'panel-knowledge-transfer',
    tagline: 'One agent knows a system; two newcomers ask until they could carry on alone.',
    panel: {
      version: 1,
      name: 'Knowledge transfer',
      mode: 'handoff',
      sharedBrief: [
        'System: [the system]',
        'The Expert knows this system. The two newcomers need to work in it. They ask, the Expert answers with where things live and why, and the newcomers say back what they understood.',
        'End with what was shared, the decisions made, the actions (what each newcomer should read or try next) and the questions still open.',
      ].join('\n\n'),
      seats: [
        {
          name: 'Expert',
          role: 'Knows the system: how it works, where things live and what to watch out for',
          lead: true,
          kind: 'attached',
          privateBrief: `You know this system. Explain how it works, where things live and what bites, in the order the newcomers need it. Answer exactly what was asked rather than everything you know, and check what they understood before you finish. ${EVIDENCE}`,
        },
        {
          name: 'Newcomer 1',
          role: 'New to the system, and has to work in it next',
          kind: 'attached',
          privateBrief: `You are new to this system and have to work in it next. Ask for what you need, one question at a time, and say back what you understood so the Expert can correct it. Where you have code or notes of your own that touch it, ${EVIDENCE.charAt(0).toLowerCase()}${EVIDENCE.slice(1)}`,
        },
        {
          name: 'Newcomer 2',
          role: 'New to the system, and has to work in it next',
          kind: 'attached',
          privateBrief: `You are new to this system and have to work in it next. Ask what the other newcomer has not, one question at a time, and say back what you understood. Where you have code or notes of your own that touch it, ${EVIDENCE.charAt(0).toLowerCase()}${EVIDENCE.slice(1)}`,
        },
      ],
    },
  },
  {
    id: 'panel-meeting',
    tagline: 'A chair and two role seats take an agenda in order and close with who does what.',
    panel: {
      version: 1,
      name: 'Meeting',
      mode: 'free',
      sharedBrief: [
        'Meeting: [the subject]',
        'Agenda:\n1. [first item]\n2. [second item]\n3. What happens next',
        'The Chair takes the items in order and asks each seat in turn. Keep to the item at hand.',
        'Close with the decisions, the actions (who does what, and by when) and the questions still open.',
      ].join('\n\n'),
      seats: [
        {
          name: 'Chair',
          role: 'Runs the meeting: takes the agenda in order and records what was decided',
          lead: true,
          kind: 'attached',
          privateBrief: `You chair. Take the agenda items in order, ask the seat whose role fits each one, keep to time, and record each decision and action as it is made. ${EVIDENCE}`,
        },
        {
          name: 'Product',
          role: 'Speaks for what users need and what is being asked for',
          kind: 'attached',
          privateBrief: `You speak for what is being asked for and why. On each item, say what users or the business need, and what you can and cannot give up. ${EVIDENCE}`,
        },
        {
          name: 'Engineering',
          role: 'Speaks for what it takes to build, and what is in the way',
          kind: 'attached',
          privateBrief: `You speak for building it. On each item, say what it would take, what is blocked and on what, and what you would do first. ${EVIDENCE}`,
        },
      ],
    },
  },
];
