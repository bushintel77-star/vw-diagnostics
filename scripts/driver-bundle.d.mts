export interface DriverMeta {
  version: 1;
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  sha256: string;
  size: number;
}
export const DRIVER_FILE: string;
export const DRIVER_SHA256: string;
export const ENCRYPTED_FILE: string;
export const META_FILE: string;
export const MIN_PASSKEY_LENGTH: number;
export const SCRYPT: { N: number; r: number; p: number };
export function scryptMaxmem(N: number, r: number): number;
export function sha256(data: Buffer | Uint8Array): string;
export function encryptDriver(
  plain: Buffer,
  passkey: string,
  kdf?: { N: number; r: number; p: number }
): { meta: DriverMeta; ciphertext: Buffer };
export function isValidMeta(meta: unknown): meta is DriverMeta;
export function decryptDriver(ciphertext: Buffer, meta: unknown, passkey: unknown): Promise<Buffer | null>;
