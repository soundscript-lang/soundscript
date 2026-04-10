export function main(): string {
  const key = Symbol('token');
  const record = { plain: 'x', [key]: 'y' };
  return `${Object.keys(record).length}:${record[key]}`;
}
