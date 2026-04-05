export function main(): boolean {
  const first = {};
  const second = {};
  const left = {};
  const right = {};
  const registry = new FinalizationRegistry<number>(() => {});
  registry.register(first, 1, left);
  registry.register(second, 2, right);
  return registry.unregister(right);
}
