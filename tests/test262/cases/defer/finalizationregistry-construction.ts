export function main(): boolean {
  const registry = new FinalizationRegistry<string>(() => {});
  return registry instanceof FinalizationRegistry;
}
