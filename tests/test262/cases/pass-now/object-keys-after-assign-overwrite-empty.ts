export function main(): number {
  const target = { left: 1 };
  Object.assign(target, {}, { left: 2 });
  return Object.keys(target).length;
}
