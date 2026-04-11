export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 5 };
  registry.register(target, 5, token);
  return registry.unregister(token);
}
