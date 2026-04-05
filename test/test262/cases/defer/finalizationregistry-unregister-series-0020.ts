export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 20 };
  registry.register(target, 20, token);
  return registry.unregister(token);
}
