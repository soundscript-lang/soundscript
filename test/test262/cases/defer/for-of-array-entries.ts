export function main(): string {
  let result = '';
  for (const [index, value] of ['a', 'b'].entries()) {
    result += `${index}:${value};`;
  }
  return result;
}
