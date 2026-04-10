export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 16 };
  registry.register(target, 16, token);
  return registry.unregister(token);
}
