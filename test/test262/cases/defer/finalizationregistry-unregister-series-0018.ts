export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 18 };
  registry.register(target, 18, token);
  return registry.unregister(token);
}
