export function main(): string {
  return globalThis.Object.entries({ left: 1, right: 2 }).map(([key, value]) => `${key}:${value}`).join(';');
}
