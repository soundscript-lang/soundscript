export function main(): boolean {
  const first = {};
  const second = {};
  const registry = new FinalizationRegistry<number>(() => {});
  return registry.register(first, 1) === undefined && registry.register(second, 2) === undefined;
}
