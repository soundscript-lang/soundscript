export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 39 };
  registry.register(target, 39, token);
  return registry.unregister(token);
}
