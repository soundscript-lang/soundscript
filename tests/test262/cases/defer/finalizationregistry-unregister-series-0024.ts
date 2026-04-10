export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 24 };
  registry.register(target, 24, token);
  return registry.unregister(token);
}
