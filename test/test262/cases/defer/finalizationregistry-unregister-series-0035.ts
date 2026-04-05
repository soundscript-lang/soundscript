export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 35 };
  registry.register(target, 35, token);
  return registry.unregister(token);
}
