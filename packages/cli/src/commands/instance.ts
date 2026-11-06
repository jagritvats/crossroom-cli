/**
 * The Crossroom a command means when it names none: the hosted instance's app host. Rooms (`new`,
 * `ask`, `panel open`), account commands (`login`, `work`...) and the runner all default to it;
 * `--instance`, `--relay` or `CROSSROOM_URL` names another (`chosenInstance`, relay-call.ts). Its own
 * module, importing nothing, so any command reads it without registering another.
 */
export const DEFAULT_INSTANCE = 'https://app.crossroom.dev';

/** The same address under the name the runner and the account commands have always used. */
export const DEFAULT_RELAY = DEFAULT_INSTANCE;
