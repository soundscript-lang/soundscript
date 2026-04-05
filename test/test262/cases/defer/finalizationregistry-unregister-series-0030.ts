export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 30 };
  registry.register(target, 30, token);
  return registry.unregister(token);
}
