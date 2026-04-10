export function main(): string {
  const key = Symbol('token');
  const record = { ...{ [key]: 1 }, visible: 2 };
  return `${Object.keys(record).length}:${record[key]}`;
}
