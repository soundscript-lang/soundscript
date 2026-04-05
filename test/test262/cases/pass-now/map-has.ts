export function main(): boolean {
  const map = new Map<string, number>();
  map.set('present', 1);
  return map.has('present');
}
