export async function main(): Promise<string> {
  let result = '';
  for await (const key of new Map([
    ['left', Promise.resolve(1)],
    ['right', Promise.resolve(2)],
  ]).keys()) {
    result += key;
    break;
  }
  return result;
}
