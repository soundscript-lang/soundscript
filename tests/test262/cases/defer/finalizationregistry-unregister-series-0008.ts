export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 8 };
  registry.register(target, 8, token);
  return registry.unregister(token);
}
