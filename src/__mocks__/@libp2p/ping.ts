// Mock for @libp2p/ping
export const ping = jest.fn(() => ({
  name: 'libp2p:ping',
  start: jest.fn(),
  stop: jest.fn(),
  ping: jest.fn().mockResolvedValue(100),
}));

export default { ping };
