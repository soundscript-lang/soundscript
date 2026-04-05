export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 26 };
  registry.register(target, 26, token);
  return registry.unregister(token);
}
