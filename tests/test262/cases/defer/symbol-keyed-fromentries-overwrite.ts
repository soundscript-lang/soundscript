export function main(): number {
  const key = Symbol('token');
  const record = Object.fromEntries([[key, 1], [key, 2]]);
  return record[key];
}
