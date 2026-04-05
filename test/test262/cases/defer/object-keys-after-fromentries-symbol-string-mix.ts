export function main(): boolean {
  const key = Symbol('token');
  const record = Object.fromEntries([[key, 1], ['plain', 2]]);
  return Object.keys(record).join(',') === 'plain';
}
