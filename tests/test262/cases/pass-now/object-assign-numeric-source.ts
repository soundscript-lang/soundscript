export function main(): number {
  const target = Object.assign({}, [7, 8]);
  return Object.values(target).length;
}
