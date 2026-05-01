import { WorkOrderPushQueue, PushedWorkOrder } from '../work-order-push-queue';

const mkPush = (id: string, overrides: Partial<PushedWorkOrder> = {}): Omit<PushedWorkOrder, 'receivedAt'> => ({
  id,
  title: `wo ${id}`,
  status: 'PENDING',
  rewardAmount: '1',
  requiredCapabilities: [],
  creatorAddress: 'creator',
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('WorkOrderPushQueue', () => {
  it('returns pushed entries on drain in insertion order', () => {
    const q = new WorkOrderPushQueue();
    q.push(mkPush('a'));
    q.push(mkPush('b'));
    expect(q.size()).toBe(2);

    const drained = q.drain();
    expect(drained.map((d) => d.id)).toEqual(['a', 'b']);
    expect(q.size()).toBe(0);
  });

  it('idempotent on duplicate id — second push wins', () => {
    const q = new WorkOrderPushQueue();
    q.push(mkPush('a', { title: 'old' }));
    q.push(mkPush('a', { title: 'new' }));
    expect(q.size()).toBe(1);
    expect(q.drain()[0].title).toBe('new');
  });

  it('expires entries older than the configured TTL', () => {
    const q = new WorkOrderPushQueue(50);
    q.push(mkPush('a'));
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const drained = q.drain();
        expect(drained).toHaveLength(0);
        expect(q.size()).toBe(0);
        resolve();
      }, 80);
    });
  });

  it('invokes wake callback on push and survives callback exceptions', () => {
    const q = new WorkOrderPushQueue();
    let wakes = 0;
    q.setWakeCallback(() => {
      wakes++;
      throw new Error('callback should not bubble');
    });
    q.push(mkPush('a'));
    q.push(mkPush('b'));
    expect(wakes).toBe(2);
    expect(q.size()).toBe(2);
  });

  it('clear() empties the queue', () => {
    const q = new WorkOrderPushQueue();
    q.push(mkPush('a'));
    q.push(mkPush('b'));
    q.clear();
    expect(q.size()).toBe(0);
    expect(q.drain()).toEqual([]);
  });
});
