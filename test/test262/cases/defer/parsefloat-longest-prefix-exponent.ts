export function main(): number[] {
  return [
    parseFloat('1ex'),
    parseFloat('1e-x'),
    parseFloat('1e1x'),
    parseFloat('1e-1x'),
    parseFloat('0.1e-1x'),
  ];
}
