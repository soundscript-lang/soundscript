export function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function log<T>(value: T): T {
  console.log(value);
  return value;
}
