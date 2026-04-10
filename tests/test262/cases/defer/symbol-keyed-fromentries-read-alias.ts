export function main(): number {
  const key = Symbol('token');
  const alias = key;
  const record = Object.fromEntries([[key, 3]]);
  return record[alias];
}
