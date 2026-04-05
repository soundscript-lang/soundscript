export function main(): number {
  return globalThis.JSON.parse('{"value":33}').value;
}
