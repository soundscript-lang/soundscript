export function main(): string {
  return Object.entries(Object.assign({}, { '-1': 1, a: 2 })).map(([key, value]) =>
    `${key}:${value}`
  ).join(';');
}
