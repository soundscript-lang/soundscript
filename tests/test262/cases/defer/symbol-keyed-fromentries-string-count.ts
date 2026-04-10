export function main(): string {
  const key = Symbol('token');
  const record = Object.fromEntries([[key, 'y'], ['plain', 'x'], ['other', 'z']]);
  return `${Object.keys(record).length}:${record[key]}`;
}
