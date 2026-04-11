export function main(): string {
  return Symbol.for({toString() { return 'test262'; }}).description ?? 'missing';
}
