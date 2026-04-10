export function main(): string {
  const first = { left: 1, middle: 2 };
  const second = { left: 3 };
  const target = { ...first, ...second };
  return Object.entries(target)
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
}
