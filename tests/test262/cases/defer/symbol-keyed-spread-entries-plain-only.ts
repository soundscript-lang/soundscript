export function main(): string {
  const key = Symbol('token');
  const record = { plain: 'x', ...{ [key]: 'y' } };
  return Object.entries(record).map(([name, value]) => `${name}:${value}`).join(';');
}
