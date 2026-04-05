export function main(): string {
  const target = { left: 1, right: 2 };
  Object.assign(target, { left: 3 });
  return Object.keys(target).join(',');
}
