export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 27 };
  registry.register(target, 27, token);
  return registry.unregister(token);
}
