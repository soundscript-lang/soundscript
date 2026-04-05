export function main(): number[] {
  return [
    parseFloat('\u00091.1'),
    parseFloat('\u0009\u0009-1.1'),
    parseFloat('\t1.1'),
    parseFloat('\t\t\t1.1'),
    parseFloat('\t\t\t\u0009\t\t\t\u0009-1.1'),
    Number.isNaN(parseFloat('\u0009')) ? 1 : 0,
  ];
}
