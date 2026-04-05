export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 6 };
  registry.register(target, 6, token);
  return registry.unregister(token);
}
