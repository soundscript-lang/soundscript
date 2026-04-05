export function main(): number {
  const target = {};
  Object.assign(target, [1, 2]);
  return Object.keys(target).length;
}
