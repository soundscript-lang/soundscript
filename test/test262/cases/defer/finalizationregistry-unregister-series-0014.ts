export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 14 };
  registry.register(target, 14, token);
  return registry.unregister(token);
}
