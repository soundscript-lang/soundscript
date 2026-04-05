export function main(): boolean {
  const first = {};
  const second = {};
  const third = {};
  const token = {};
  const registry = new FinalizationRegistry<number>(() => {});
  registry.register(first, 1, token);
  registry.register(second, 2, token);
  registry.register(third, 3, token);
  return registry.unregister(token);
}
