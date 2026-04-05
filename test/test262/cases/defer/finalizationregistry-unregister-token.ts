export function main(): boolean {
  const target = {};
  const token = {};
  const registry = new FinalizationRegistry<number>(() => {});
  registry.register(target, 1, token);
  return registry.unregister(token);
}
