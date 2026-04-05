export function main(): boolean {
  const first = {};
  const second = {};
  const left = {};
  const right = {};
  const registry = new FinalizationRegistry<number>(() => {});
  return registry.register(first, 1, left) === undefined &&
    registry.register(second, 2, right) === undefined;
}
