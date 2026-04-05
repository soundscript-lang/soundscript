export function main(): string {
  const target = Object.assign({ a: 'left' }, { a: 'middle' }, {});
  return target.a;
}
