export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 2 };
  registry.register(target, 2, token);
  return registry.unregister(token);
}
