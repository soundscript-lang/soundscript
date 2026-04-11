export function main(): number {
  const key = Symbol('token');
  const record = Object.fromEntries([[key, 1], ['plain', 2]]);
  return Object.values(record).length;
}
