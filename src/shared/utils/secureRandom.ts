const UINT32_RANGE = 0x1_0000_0000;
const FLOAT_RESOLUTION = 0x1_000000;
const BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ALPHANUMERIC_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function getCrypto(): Crypto {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.getRandomValues) {
    throw new Error("Web Crypto getRandomValues is required for secure randomness");
  }
  return cryptoObject;
}

export function randomBytes(byteLength: number): Uint8Array {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RangeError("byteLength must be a non-negative safe integer");
  }
  const bytes = new Uint8Array(byteLength);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

export function randomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > UINT32_RANGE) {
    throw new RangeError("maxExclusive must be a safe integer in the range 1..2^32");
  }

  const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
  const values = new Uint32Array(1);
  let value = UINT32_RANGE;
  while (value >= limit) {
    getCrypto().getRandomValues(values);
    value = values[0];
  }
  return value % maxExclusive;
}

export function randomFloat(): number {
  return randomInt(FLOAT_RESOLUTION) / FLOAT_RESOLUTION;
}

export function randomString(length: number, alphabet = ALPHANUMERIC_ALPHABET): string {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("length must be a non-negative safe integer");
  }
  if (alphabet.length === 0) {
    throw new RangeError("alphabet must not be empty");
  }

  let result = "";
  for (let i = 0; i < length; i++) {
    result += alphabet[randomInt(alphabet.length)];
  }
  return result;
}

export function randomBase36(length: number): string {
  return randomString(length, BASE36_ALPHABET);
}

export function randomAlphaNumeric(length: number): string {
  return randomString(length, ALPHANUMERIC_ALPHABET);
}

export function randomHex(byteLength: number): string {
  return Array.from(randomBytes(byteLength), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
