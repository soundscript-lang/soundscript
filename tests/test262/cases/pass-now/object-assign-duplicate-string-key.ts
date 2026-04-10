export function main(): string {
  const target = { left: 1 };
  Object.assign(target, { left: 2 }, { left: 3 });
  return Object.keys(target).join(',');
}
