export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 38 };
  registry.register(target, 38, token);
  return registry.unregister(token);
}
