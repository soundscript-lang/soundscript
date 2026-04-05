export function main(): string {
  return globalThis.Array.from(new Map([
    ['left', 1],
    ['right', 2],
  ])).map(([key, value]) => `${key}:${value}`).join(';');
}
