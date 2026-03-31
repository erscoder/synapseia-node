import { jest } from "@jest/globals";
// Mock for @libp2p/ping
export const ping = jest.fn(() => ({
  name: 'libp2p:ping',
  start: jest.fn(),
  stop: jest.fn(),
  ping: (jest.fn() as any).mockResolvedValue(100),
}));

export default { ping };
