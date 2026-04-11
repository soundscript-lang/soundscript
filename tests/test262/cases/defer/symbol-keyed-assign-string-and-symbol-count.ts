export function main(): string {
  const key = Symbol('token');
  const record = Object.assign({ plain: 'x' }, { other: 'z', [key]: 'y' });
  return `${Object.keys(record).length}:${record[key]}`;
}
