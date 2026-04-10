export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 1 };
  registry.register(target, 1, token);
  return registry.unregister(token);
}
