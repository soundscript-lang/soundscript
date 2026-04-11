export function main(): number {
  const key = Symbol('token');
  const record = Object.fromEntries([[key, 5]]);
  return record[key];
}
