export function main(): string {
  const target = { left: 1, right: 2 };
  Object.assign(target, { left: 3 });
  return Object.entries(target)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
}
