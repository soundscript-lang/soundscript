export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 3 };
  registry.register(target, 3, token);
  return registry.unregister(token);
}
