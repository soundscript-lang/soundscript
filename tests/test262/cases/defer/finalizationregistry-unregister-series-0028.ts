export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 28 };
  registry.register(target, 28, token);
  return registry.unregister(token);
}
