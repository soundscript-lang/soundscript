export function main(): number {
  return globalThis.JSON.parse('{"value":24}').value;
}
