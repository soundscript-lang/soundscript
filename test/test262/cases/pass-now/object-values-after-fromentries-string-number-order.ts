export function main(): string {
  return Object.values(Object.fromEntries([['b', 2], ['1', 1]])).join(';');
}
