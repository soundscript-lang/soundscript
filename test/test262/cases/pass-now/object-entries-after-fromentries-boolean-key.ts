export function main(): string {
  return Object.entries(Object.fromEntries([[true, 1], [false, 2]])).map(([key, value]) =>
    `${key}:${value}`
  ).join(';');
}
