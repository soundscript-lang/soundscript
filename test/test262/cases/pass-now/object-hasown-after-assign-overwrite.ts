export function main(): boolean {
  const target = { left: 1, right: 2 };
  Object.assign(target, { left: 3 });
  return Object.hasOwn(target, 'left') && target.left === 3;
}
