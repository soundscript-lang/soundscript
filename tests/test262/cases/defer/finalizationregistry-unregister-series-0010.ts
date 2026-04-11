export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 10 };
  registry.register(target, 10, token);
  return registry.unregister(token);
}
