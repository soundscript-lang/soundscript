// #[effects(add: [fails.throws])]
export function assert(condition: unknown, message?: string): asserts condition;
// #[effects(add: [host.ffi])]
export function log<T>(value: T): T;
