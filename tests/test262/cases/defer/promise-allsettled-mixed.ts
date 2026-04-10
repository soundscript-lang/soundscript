export function main(left: number, right: number): Promise<string> {
  return Promise.allSettled([Promise.resolve(left), Promise.reject(right)]).then(
    (results) => results.map((result) => result.status).join(','),
  );
}
