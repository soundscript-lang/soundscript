export function main(): string {
  const map = new Map<string | number, string | boolean>([
    ['foo', 'valid foo'],
    ['bar', false],
    ['baz', 'valid baz'],
  ]);
  map.set(0, false);
  map.set(1, false);
  map.set(2, 'valid 2');
  map.delete(1);
  map.delete('bar');
  map.set(0, 'valid 0');

  const results: string[] = [];
  map.forEach((value) => {
    results.push(String(value));
  });
  return results.join(';');
}
