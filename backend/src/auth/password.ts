import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Promise wrapper around crypto.scrypt. promisify() resolves to the option-less
// overload, so we wrap the callback form directly to pass scrypt options.
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err !== null) {
        reject(err);
        return;
      }
      resolve(derivedKey);
    });
  });
}

// scrypt parameters. N (cost) must be a power of two; r and p tune memory and
// parallelism. These are the OWASP-recommended interactive-login defaults.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const ALGORITHM = "scrypt";

// scrypt's internal memory use is roughly 128 * N * r bytes. Node's default
// maxmem (32 MiB) is too low for N=16384, r=8, so raise it explicitly.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

async function deriveKey(plain: string, salt: Buffer): Promise<Buffer> {
  const derived = (await scrypt(plain, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })) as Buffer;
  return derived;
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(plain, salt);
  return `${ALGORITHM}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

// Always run one scrypt of comparable cost even when the stored value is absent
// or malformed, so a non-existent or password-less user is indistinguishable
// from a wrong password by response timing.
async function dummyVerify(plain: string): Promise<void> {
  const salt = randomBytes(SALT_LENGTH);
  await deriveKey(plain, salt);
}

export async function verifyPassword(
  plain: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (stored === null || stored === undefined || stored === "") {
    await dummyVerify(plain);
    return false;
  }

  const parts = stored.split("$");
  if (parts.length !== 6) {
    await dummyVerify(plain);
    return false;
  }

  const [algorithm, nRaw, rRaw, pRaw, saltHex, keyHex] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (
    algorithm !== ALGORITHM ||
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n <= 0 ||
    r <= 0 ||
    p <= 0 ||
    !/^[0-9a-f]+$/.test(saltHex) ||
    !/^[0-9a-f]+$/.test(keyHex)
  ) {
    await dummyVerify(plain);
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");

  let derived: Buffer;
  try {
    derived = (await scrypt(plain, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    })) as Buffer;
  } catch {
    // A stored value whose parameters are structurally valid but rejected by
    // scrypt (e.g. non-power-of-two N) is treated as a failed verification, not
    // an exception the caller must handle.
    return false;
  }

  // timingSafeEqual requires equal-length buffers; guard before comparing.
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

const MIN_PASSWORD_LENGTH = 10;

export function assertPasswordPolicy(plain: string): void {
  if (typeof plain !== "string" || plain.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password does not meet policy: must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
}
