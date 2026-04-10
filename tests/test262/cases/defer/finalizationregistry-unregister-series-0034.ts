export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 34 };
  registry.register(target, 34, token);
  return registry.unregister(token);
}
