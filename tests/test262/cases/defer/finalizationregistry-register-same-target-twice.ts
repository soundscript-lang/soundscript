export function main(): boolean {
  const target = {};
  const registry = new FinalizationRegistry<number>(() => {});
  return registry.register(target, 1) === undefined && registry.register(target, 2) === undefined;
}
