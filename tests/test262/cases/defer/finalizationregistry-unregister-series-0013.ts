export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 13 };
  registry.register(target, 13, token);
  return registry.unregister(token);
}
