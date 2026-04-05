export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 33 };
  registry.register(target, 33, token);
  return registry.unregister(token);
}
