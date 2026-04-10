export function main(): boolean {
  const first = {};
  const second = {};
  const third = {};
  const token = {};
  const registry = new FinalizationRegistry<number>(() => {});
  return registry.register(first, 1, token) === undefined &&
    registry.register(second, 2, token) === undefined &&
    registry.register(third, 3, token) === undefined;
}
