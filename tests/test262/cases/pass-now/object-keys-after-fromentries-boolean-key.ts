export function main(): string {
  return Object.keys(Object.fromEntries([[true, 1], [false, 2]])).join(';');
}
