export function main(): Promise<number> {
  return Promise.resolve(7).finally(() => undefined).finally(() => undefined);
}
