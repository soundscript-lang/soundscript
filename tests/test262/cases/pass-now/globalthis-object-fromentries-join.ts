export function main(): string {
  return globalThis.Object.keys(globalThis.Object.fromEntries([['left', 1], ['right', 2]])).join(
    ';',
  );
}
