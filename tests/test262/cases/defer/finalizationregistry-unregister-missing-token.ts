export function main(): boolean {
  const token = {};
  const registry = new FinalizationRegistry<number>(() => {});
  return registry.unregister(token);
}
