export function main(): string {
  return Object.keys(Object.assign({}, new String('ab'))).join(';');
}
