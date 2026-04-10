export function main(): boolean {
  const first = {};
  const second = {};
  const token = {};
  const registry = new FinalizationRegistry<number>(() => {});
  registry.register(first, 1);
  registry.register(second, 2, token);
  return registry.unregister(token);
}
