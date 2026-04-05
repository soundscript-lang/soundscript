export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  return registry.register(target, 1) === undefined;
}
