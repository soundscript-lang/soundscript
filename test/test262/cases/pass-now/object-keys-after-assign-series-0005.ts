export function main(): number {
  return Object.keys(Object.assign({}, { left5: 5 }, { right5: 6 })).length;
}
