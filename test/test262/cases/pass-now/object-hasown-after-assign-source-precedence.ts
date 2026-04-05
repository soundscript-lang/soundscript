export function main(): boolean {
  const target = { left: 1 };
  Object.assign(target, { left: 2 }, { left: 3 });
  return Object.hasOwn(target, 'left') && target.left === 3;
}
