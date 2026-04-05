export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 9 };
  registry.register(target, 9, token);
  return registry.unregister(token);
}
