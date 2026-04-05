export function main(): string {
  return String.raw({
    raw: {
      length: 5,
      0: 'e',
      1: '',
      2: null,
      3: undefined,
      4: 123,
      5: 'overpass the length',
    },
  });
}
