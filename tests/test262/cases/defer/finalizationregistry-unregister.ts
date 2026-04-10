export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const token = {};
  return registry.unregister(token);
}
