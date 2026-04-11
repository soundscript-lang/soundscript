export function main(): string {
  return Object.values(Object.assign({}, { '-1': 1, a: 2 })).join(';');
}
