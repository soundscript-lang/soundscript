export function main(): boolean {
  const key = Symbol('left');
  const record = Object.fromEntries([
    [key, 1],
    ['right', 2],
  ]);
  return record[key] === 1 && Object.keys(record).join(',') === 'right';
}
