export function main(): string {
  return Object.keys(Object.assign({}, { '-1': 1, a: 2 })).join(';');
}
