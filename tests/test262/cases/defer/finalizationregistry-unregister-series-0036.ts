export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 36 };
  registry.register(target, 36, token);
  return registry.unregister(token);
}
