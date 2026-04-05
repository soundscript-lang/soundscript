export function main(): string {
  return Object.values(Object.assign({}, new String('ab'))).join(';');
}
