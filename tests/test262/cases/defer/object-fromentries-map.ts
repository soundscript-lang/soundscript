export function main(): string {
  const object = Object.fromEntries(new Map([
    ['z', 1],
    ['y', 2],
    ['x', 3],
    ['y', 4],
  ]));
  return Object.getOwnPropertyNames(object).join(',');
}
