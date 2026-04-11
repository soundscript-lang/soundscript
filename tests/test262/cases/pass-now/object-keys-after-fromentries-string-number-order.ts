export function main(): string {
  return Object.keys(Object.fromEntries([['b', 2], ['1', 1]])).join(';');
}
