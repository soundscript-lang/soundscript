export function main(): boolean {
  const first = {};
  const second = {};
  const third = {};
  const fourth = {};
  const registry = new FinalizationRegistry<{ value: number }>(() => {});
  return registry.register(first, { value: 1 }) === undefined &&
    registry.register(second, { value: 2 }) === undefined &&
    registry.register(third, { value: 3 }) === undefined &&
    registry.register(fourth, { value: 4 }) === undefined;
}
