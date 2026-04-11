export function main(): string {
  const target = { left: 1 };
  Object.assign(target, { middle: 2 }, { right: 3 });
  return Object.keys(target).join(',');
}
