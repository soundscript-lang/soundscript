export function main(): number {
  const target = { left: 1 };
  Object.assign(target, {});
  return Object.keys(target).length;
}
