export async function main(): Promise<string> {
  let result = '';
  for await (const key of new Map([
    ['left', Promise.resolve(1)],
    ['right', Promise.resolve(2)],
    ['third', Promise.resolve(3)],
  ]).keys()) {
    if (key === 'right') {
      continue;
    }
    result += key;
  }
  return result;
}
