export function main(): boolean {
  const first = {};
  const second = {};
  const third = {};
  const token = {};
  const registry = new FinalizationRegistry<{ value: number }>(() => {});
  registry.register(first, { value: 1 }, token);
  registry.register(second, { value: 2 }, token);
  registry.register(third, { value: 3 }, token);
  return registry.unregister(token);
}
