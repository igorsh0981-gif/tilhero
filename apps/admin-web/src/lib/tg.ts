/**
 * A learner's Telegram username for display (review T2-3). user-admin never sends «@»: the value is either the full
 * name or its mask («ig•••81», «•••» for short names) for roles without users.sensitive.read. It is shown exactly as
 * received with «@» in front — never re-masked or rebuilt here; a stray «@» is not doubled.
 */
export const tgHandle = (u: string): string => (u.startsWith("@") ? u : `@${u}`);
