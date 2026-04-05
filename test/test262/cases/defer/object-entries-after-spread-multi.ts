export function main(): string {
  const first = { left: 1 };
  const second = { middle: 2 };
  const target = { ...first, ...second, right: 3 };
  return Object.entries(target)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
}
