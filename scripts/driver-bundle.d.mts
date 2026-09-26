export const DRIVER_FILE: string;
export const DRIVER_SHA256: string;
export const PASSKEY_FILE: string;
export const SCRYPT: { N: number; r: number; p: number; keyLength: number };
export function scryptMaxmem(N: number, r: number): number;
