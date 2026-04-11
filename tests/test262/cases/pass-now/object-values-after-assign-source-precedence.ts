export function main(): string {
  const target = { left: 1 };
  Object.assign(target, { left: 2, middle: 3 }, { left: 4 });
  return Object.values(target).join(',');
}
