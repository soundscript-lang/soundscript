export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 22 };
  registry.register(target, 22, token);
  return registry.unregister(token);
}
