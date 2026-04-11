export function main(): string {
  return Symbol('test').description ?? 'missing';
}
