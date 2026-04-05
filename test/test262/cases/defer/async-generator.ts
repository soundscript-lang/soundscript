export function main(): number {
  void (async function* () {
    yield 1;
  })();

  return 1;
}
