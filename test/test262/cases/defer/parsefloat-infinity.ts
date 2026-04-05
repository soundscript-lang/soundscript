export function main(): string[] {
  return [
    String(parseFloat('Infinity')),
    String(parseFloat('+Infinity')),
    String(parseFloat('-Infinity')),
  ];
}
