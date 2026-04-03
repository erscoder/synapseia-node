import { Injectable } from '@nestjs/common';
import logger from '../../../utils/logger';

@Injectable()
export class IpifyService {
  private cachedIp: string | null = null;
  private cachedAt = 0;
  private readonly TTL_MS = 30 * 60 * 1000; // 30 min

  async resolvePublicIp(): Promise<string | null> {
    if (this.cachedIp && Date.now() - this.cachedAt < this.TTL_MS) {
      return this.cachedIp;
    }
    try {
      const res = await fetch('https://api.ipify.org?format=json', {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { ip: string };
      this.cachedIp = data.ip;
      this.cachedAt = Date.now();
      logger.log(`Public IP: ${data.ip}`);
      return data.ip;
    } catch {
      return null; // graceful fallback
    }
  }
}
