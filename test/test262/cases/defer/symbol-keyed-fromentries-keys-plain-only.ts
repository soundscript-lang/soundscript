export function main(): string {
  const key = Symbol('token');
  const record = Object.fromEntries([[key, 'y'], ['plain', 'x']]);
  return Object.keys(record).join(';');
}
