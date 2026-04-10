export function main(): boolean {
  const target = {};
  const registry = new FinalizationRegistry<number>(() => {});
  return registry.register(target, 0) === undefined;
}
