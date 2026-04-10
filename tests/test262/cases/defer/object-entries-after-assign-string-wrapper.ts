export function main(): string {
  return Object.entries(Object.assign({}, new String('ab'))).map(([key, value]) =>
    `${key}:${value}`
  ).join(';');
}
