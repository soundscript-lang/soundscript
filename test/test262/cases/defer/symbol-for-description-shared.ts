export function main(): string {
  return Symbol.for(({ toString() { return 'test262'; } } as unknown as string)).description ?? 'missing';
}
