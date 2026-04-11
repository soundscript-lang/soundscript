export function main(): string {
  const map = new Map<string, number | string>();
  map.set('foo', 42);
  map.set('bar', 'baz');

  const results: string[] = [];
  map.forEach((value, key, self) => {
    results.push(`${String(value)}:${key}:${self === map ? 1 : 0}`);
  });

  return results.join(';');
}
