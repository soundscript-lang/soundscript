export async function main(): Promise<string> {
  let result = '';
  for await (
    const [key, value] of new Map([
      ['left', Promise.resolve(1)],
      ['right', Promise.resolve(2)],
    ]).entries()
  ) {
    result += `${key}:${value}`;
    break;
  }
  return result;
}
