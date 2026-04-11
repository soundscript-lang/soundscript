export function main(): boolean {
  return Object.hasOwn({ present: 1 }, 'missing');
}
