export function main(): string {
  const key = Symbol('token');
  const record = { plain: 'x', ...{ [key]: 'y' } };
  return `${record.plain}:${record[key]}`;
}
