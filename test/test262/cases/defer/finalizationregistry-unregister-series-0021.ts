export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 21 };
  registry.register(target, 21, token);
  return registry.unregister(token);
}
