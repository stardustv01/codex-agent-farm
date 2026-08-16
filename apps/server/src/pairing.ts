import { randomBytes, randomUUID } from "node:crypto";

import type {
  BridgePort,
  PairingChallenge,
  PairingChallengeInput,
  PairingSignatureInput,
} from "./contracts.js";
import { HttpError, canonicalJson } from "./security.js";

export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
export const MAX_PAIRING_TTL_MS = 10 * 60 * 1000;

/**
 * Challenge storage is intentionally separate from an implementation bridge.
 * A production bridge may persist/revoke it, while tests can use this small
 * deterministic in-memory ledger.  The nonce is never logged or derived from
 * a user-controlled value.
 */
export class PairingLedger {
  private readonly challenges = new Map<string, PairingChallenge & { used: boolean }>();

  create(input: PairingChallengeInput, ttlMs = DEFAULT_PAIRING_TTL_MS): PairingChallenge {
    const ttl = Math.min(Math.max(1_000, ttlMs), MAX_PAIRING_TTL_MS);
    const challenge: PairingChallenge = {
      ...input,
      pairingId: randomUUID(),
      nonce: randomBytes(32).toString("base64url"),
      expiresAt: new Date(Date.now() + ttl).toISOString(),
    };
    this.challenges.set(challenge.pairingId, { ...challenge, used: false });
    return challenge;
  }

  get(pairingId: string): (PairingChallenge & { used: boolean }) | undefined {
    const challenge = this.challenges.get(pairingId);
    if (!challenge) return undefined;
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      this.challenges.delete(pairingId);
      return undefined;
    }
    return challenge;
  }

  consume(pairingId: string): PairingChallenge & { used: boolean } {
    const challenge = this.get(pairingId);
    if (!challenge || challenge.used) {
      throw new HttpError(403, "PAIRING_REPLAY", "Pairing challenge is invalid or already used");
    }
    challenge.used = true;
    return challenge;
  }

  invalidateForBinding(input: Pick<PairingChallengeInput, "ownerId" | "tenantId" | "agentSessionId" | "installationId">): void {
    for (const [pairingId, challenge] of this.challenges) {
      if (
        challenge.ownerId === input.ownerId &&
        challenge.tenantId === input.tenantId &&
        challenge.agentSessionId === input.agentSessionId &&
        challenge.installationId === input.installationId
      ) {
        this.challenges.delete(pairingId);
      }
    }
  }
}

export function pairingMessage(challenge: PairingChallenge): string {
  return `agent-farm-pairing-v1:${canonicalJson({
    agentSessionId: challenge.agentSessionId,
    expiresAt: challenge.expiresAt,
    installationId: challenge.installationId,
    nonce: challenge.nonce,
    ownerId: challenge.ownerId,
    pairingId: challenge.pairingId,
    requestedScopes: [...challenge.requestedScopes].sort(),
    sourceRootId: challenge.sourceRootId,
    sourceRootAttestationDigest: challenge.sourceRootAttestationDigest,
    sourceRootAttestationExpiresAt: challenge.sourceRootAttestationExpiresAt,
    sourceSessionId: challenge.sourceSessionId,
    tenantId: challenge.tenantId,
  })}`;
}

export async function verifyPairing(
  bridge: BridgePort,
  challenge: PairingChallenge,
  signature: string,
): Promise<boolean> {
  if (signature.length === 0 || signature.length > 8_192) return false;
  const input: PairingSignatureInput = {
    ...challenge,
    signature,
    message: pairingMessage(challenge),
  };
  try {
    return await bridge.verifyPairingSignature(input);
  } catch {
    // Signature implementation failures are intentionally indistinguishable
    // from a bad signature to the caller.
    return false;
  }
}
