export function main(): string {
  const key = Symbol('token');
  const record = Object.fromEntries([[key, 3], ['plain', 4]]);
  return `${record.plain}:${record[key]}`;
}
