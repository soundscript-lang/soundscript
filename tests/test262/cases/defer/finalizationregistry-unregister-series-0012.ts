export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 12 };
  registry.register(target, 12, token);
  return registry.unregister(token);
}
