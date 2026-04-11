export function main(): number[] {
  return [
    Math.abs(-42),
    Math.abs(42),
    Math.abs(-0.000001),
    Math.abs(0.000001),
    Math.abs(-1e-17),
    Math.abs(1e-17),
    Math.abs(-9007199254740991),
    Math.abs(9007199254740991),
  ];
}
