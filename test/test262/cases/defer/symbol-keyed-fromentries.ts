export function main(): string {
  const key = Symbol('token');
  const record = Object.fromEntries([[key, 'value']]) as Record<PropertyKey, string>;
  return record[key];
}
