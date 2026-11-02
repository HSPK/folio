import {
  decodedDraft,
  type DraftIdentity,
  type DraftKeys,
  type DraftSnapshot,
  type EncryptedDraft,
  type LocalDraft,
} from "../models/drafts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function draftNonce() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deriveDraftKeys(identity: DraftIdentity): Promise<DraftKeys> {
  if (!crypto.subtle) throw new Error("Encrypted local recovery requires HTTPS or localhost.");
  const raw = Uint8Array.from({ length: identity.secret.length / 2 }, (_, index) =>
    parseInt(identity.secret.slice(index * 2, index * 2 + 2), 16),
  );
  const master = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const derive = (purpose: string, algorithm: AesDerivedKeyParams | HmacImportParams, usages: KeyUsage[]) =>
    crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode(identity.scope),
        info: encoder.encode(purpose),
      },
      master,
      algorithm,
      false,
      usages,
    );
  const encryption = await derive("folio-draft-content", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
  const naming = await derive("folio-draft-identifiers", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]);
  const identify = async (value: string) =>
    [...new Uint8Array(await crypto.subtle.sign("HMAC", naming, encoder.encode(value)))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  return { encryption, identify, owner: await identify("owner") };
}

export async function encryptDraft(keys: DraftKeys, snapshot: DraftSnapshot, key: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = encoder.encode(JSON.stringify(snapshot));
  const compressed = typeof CompressionStream !== "undefined";
  const input = compressed
    ? await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer()
    : bytes;
  const payload = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(key) },
    keys.encryption,
    input,
  );
  return { iv, compressed, payload };
}

export async function decryptDraft(keys: DraftKeys, record: EncryptedDraft): Promise<LocalDraft> {
  if (record.owner !== keys.owner) throw new Error("This recovery copy belongs to a different account.");
  const payload = record.payload instanceof Blob ? await record.payload.arrayBuffer() : record.payload;
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: record.iv, additionalData: encoder.encode(record.key) },
    keys.encryption,
    payload,
  );
  if (record.compressed && typeof DecompressionStream === "undefined")
    throw new Error("This browser cannot decompress the local recovery copy.");
  const bytes = record.compressed
    ? await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer()
    : plain;
  const value: unknown = JSON.parse(decoder.decode(bytes));
  return Object.freeze({
    ...decodedDraft(value),
    key: record.key,
    generation: record.generation,
    updated: record.updated,
  });
}
