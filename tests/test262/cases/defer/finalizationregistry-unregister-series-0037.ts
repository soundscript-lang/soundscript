export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 37 };
  registry.register(target, 37, token);
  return registry.unregister(token);
}
