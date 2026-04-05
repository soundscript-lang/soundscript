export const getRandomValues = crypto.getRandomValues.bind(crypto);

const cryptoGlobal = crypto;

export { cryptoGlobal as crypto };
