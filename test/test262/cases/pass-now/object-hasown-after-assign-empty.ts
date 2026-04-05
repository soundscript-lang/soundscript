export function main(): boolean {
  const record = Object.assign({ a: 1 }, {});
  return Object.hasOwn(record, 'a');
}
