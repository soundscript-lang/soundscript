export function main(): boolean {
  const first = {};
  const second = {};
  const token = {};
  const registry = new FinalizationRegistry<number>(() => {});
  registry.register(first, 1, token);
  registry.register(second, 2, token);
  registry.unregister(token);
  return registry.unregister(token);
}
