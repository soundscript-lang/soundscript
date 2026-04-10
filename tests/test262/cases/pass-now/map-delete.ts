export function main(): boolean {
  const map = new Map<string, number>();
  map.set('answer', 42);
  return map.delete('missing');
}
