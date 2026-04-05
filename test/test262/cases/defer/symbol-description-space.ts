export function main(): string {
  return Symbol('foo').description ?? 'missing';
}
