export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 19 };
  registry.register(target, 19, token);
  return registry.unregister(token);
}
