export function main(): string {
  return Object.entries(Object.assign({}, 'ab'))
    .map(([key, value]) => `${key}:${value}`)
    .join(';');
}
