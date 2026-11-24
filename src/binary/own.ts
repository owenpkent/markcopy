// Looking a name read from a file up in a table of known names.
//
// The tables are object literals, so `table[name]` and `name in table` also
// find what every object inherits. A file that names `constructor` or
// `__proto__` got `function Object() { [native code] }` or `[object Object]`
// on its page instead of its own text (found 2026-11-23; see
// docs/FUZZING-STRATEGY.md). Only a table's own keys are answers.

/** `table[key]` when `key` is one of the table's own keys, else undefined. */
export function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
