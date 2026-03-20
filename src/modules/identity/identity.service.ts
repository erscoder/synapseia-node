import { Injectable } from '@nestjs/common';
import {
  generateIdentity,
  loadIdentity,
  getOrCreateIdentity,
  updateIdentity,
  getAgentProfile,
  sign,
  verifySignature,
  canonicalPayload,
  type Identity,
} from '../../identity.js';

@Injectable()
export class IdentityService {
  generate(dir?: string): Identity {
    return generateIdentity(dir);
  }

  load(dir?: string): Identity {
    return loadIdentity(dir);
  }

  getOrCreate(dir?: string): Identity {
    return getOrCreateIdentity(dir);
  }

  update(
    updates: Partial<Pick<Identity, 'tier' | 'mode' | 'status'>>,
    dir?: string,
  ): Identity {
    return updateIdentity(updates, dir);
  }

  getProfile(identity: Identity) {
    return getAgentProfile(identity);
  }

  sign(message: string, privateKeyHex: string): Promise<string> {
    return sign(message, privateKeyHex);
  }

  verify(message: string, signatureHex: string, publicKeyHex: string): Promise<boolean> {
    return verifySignature(message, signatureHex, publicKeyHex);
  }

  canonicalPayload(data: Record<string, unknown>): string {
    return canonicalPayload(data);
  }
}
