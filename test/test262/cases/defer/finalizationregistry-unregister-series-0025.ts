export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 25 };
  registry.register(target, 25, token);
  return registry.unregister(token);
}
