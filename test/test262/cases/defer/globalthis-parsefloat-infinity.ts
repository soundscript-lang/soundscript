export function main(): string[] {
  return [
    String(globalThis.parseFloat('Infinity')),
    String(globalThis.parseFloat('+Infinity')),
    String(globalThis.parseFloat('-Infinity')),
  ];
}
