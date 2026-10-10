import { keccak256, toUtf8Bytes } from "ethers";
import { Api, session } from "./api";

/** Same canonical form as backend/src/routes/documents.js -> hashes match. */
export const documentHash = ({ kind, title, body }) =>
  keccak256(toUtf8Bytes(JSON.stringify({ kind, title: title || "", body })));

/**
 * Stores a document off-chain (if signed in to the API) and returns the hash to
 * anchor on-chain. Without a session the hash is computed locally, so the
 * on-chain flow still works; the text just isn't retrievable later.
 */
export async function anchorDocument(kind, title, body) {
  const doc = { kind, title: title?.trim() || null, body: body.trim() };
  if (session.get()) {
    const saved = await Api.createDocument(doc);
    return { hash: saved.hash, stored: true };
  }
  return { hash: documentHash(doc), stored: false };
}
