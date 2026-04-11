export function main(): string {
  return Object.values(Object.fromEntries([[true, 1], [false, 2]])).join(';');
}
