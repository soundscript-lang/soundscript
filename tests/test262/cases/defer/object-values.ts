export function main(left: number, right: number): string {
  const record = Object.assign({ first: left }, { second: right });
  return Object.values(record).join(':');
}
