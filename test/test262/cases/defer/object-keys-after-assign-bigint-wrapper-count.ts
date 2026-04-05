export function main(): number {
  return Object.keys(Object.assign({}, Object(2n))).length;
}
