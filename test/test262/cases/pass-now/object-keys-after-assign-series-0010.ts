export function main(): number {
  return Object.keys(Object.assign({}, { left10: 10 }, { right10: 11 })).length;
}
