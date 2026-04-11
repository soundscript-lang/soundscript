export function main(): number {
  const source = { 0: 'a', 2: 'b', length: 3 };
  const target = Object.assign({}, source);
  return Object.keys(target).length;
}
