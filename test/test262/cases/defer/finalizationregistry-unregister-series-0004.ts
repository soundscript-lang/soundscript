export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 4 };
  registry.register(target, 4, token);
  return registry.unregister(token);
}
