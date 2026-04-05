export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 15 };
  registry.register(target, 15, token);
  return registry.unregister(token);
}
