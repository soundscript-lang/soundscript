export function main(): number[] {
  return [
    parseFloat('0x'),
    parseFloat('11x'),
    parseFloat('11s1'),
    parseFloat('11.s1'),
    parseFloat('.0s1'),
    parseFloat('1.s1'),
    parseFloat('1..1'),
    parseFloat('0.1.1'),
    parseFloat('0. 1'),
  ];
}
