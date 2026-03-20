import { Injectable } from '@nestjs/common';
import {
  IdentityHelper,
  type Identity,
} from './helpers/identity.js';

@Injectable()
export class IdentityService {
  constructor(private readonly identityHelper: IdentityHelper) {}

  generate(dir?: string): Identity {
    return this.identityHelper.generateIdentity(dir);
  }

  load(dir?: string): Identity {
    return this.identityHelper.loadIdentity(dir);
  }

  getOrCreate(dir?: string): Identity {
    return this.identityHelper.getOrCreateIdentity(dir);
  }

  update(
    updates: Partial<Pick<Identity, 'tier' | 'mode' | 'status'>>,
    dir?: string,
  ): Identity {
    return this.identityHelper.updateIdentity(updates, dir);
  }

  getProfile(identity: Identity) {
    return this.identityHelper.getAgentProfile(identity);
  }

  sign(message: string, privateKeyHex: string): Promise<string> {
    return this.identityHelper.sign(message, privateKeyHex);
  }

  verify(message: string, signatureHex: string, publicKeyHex: string): Promise<boolean> {
    return this.identityHelper.verifySignature(message, signatureHex, publicKeyHex);
  }

  canonicalPayload(data: Record<string, unknown>): string {
    return this.identityHelper.canonicalPayload(data);
  }
}
