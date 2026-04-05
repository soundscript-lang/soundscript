export function main(): boolean {
  const key = Symbol.for('token');
  const record = Object.fromEntries([[key, 'value']]) as Record<PropertyKey, string>;
  return record[Symbol.for('token')] === 'value';
}
