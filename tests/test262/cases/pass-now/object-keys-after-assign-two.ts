export function main(): number {
  const target = Object.assign({}, { a: 1 }, { b: 2 });
  return Object.keys(target).length;
}
