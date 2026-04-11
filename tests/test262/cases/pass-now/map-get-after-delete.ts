export function main(): number {
  const map = new Map<string, number>();
  map.set('left', 1);
  map.delete('left');
  return map.get('left') ?? 0;
}
