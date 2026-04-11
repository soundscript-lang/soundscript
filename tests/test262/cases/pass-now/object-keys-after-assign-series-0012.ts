export function main(): number {
  return Object.keys(Object.assign({}, { left12: 12 }, { right12: 13 })).length;
}
