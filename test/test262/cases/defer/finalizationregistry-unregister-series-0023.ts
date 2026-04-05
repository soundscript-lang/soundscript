export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 23 };
  registry.register(target, 23, token);
  return registry.unregister(token);
}
