export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 7 };
  registry.register(target, 7, token);
  return registry.unregister(token);
}
