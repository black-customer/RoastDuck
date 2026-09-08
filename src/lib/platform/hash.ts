import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** Preserve UTF-8 bytes and each caller's existing encoding; never normalize IDs implicitly. */
export const sha256Text = (text:string) => bytesToHex(sha256(new TextEncoder().encode(text)));
export const hashParts = (...parts:Array<string|number>) => sha256Text(JSON.stringify(parts));
