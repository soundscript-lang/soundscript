export function main(): boolean {
  const first = {};
  const second = {};
  const registry = new FinalizationRegistry<{ value: number }>(() => {});
  return registry.register(first, { value: 1 }) === undefined &&
    registry.register(second, { value: 2 }) === undefined;
}
