/**
 * D-P2P Slice 2 (2026-05-28) — node-side `fetchAvailableWorkOrders`
 * must encode the `since` cursor as a `?since=<seq>` query string AND
 * sign the resulting URL (the path + search are part of the signed
 * canonical path; see `signedFetch`).
 */

import { WorkOrderCoordinatorHelper } from '../work-order.coordinator';

describe('WorkOrderCoordinatorHelper.fetchAvailableWorkOrders — D-P2P Slice 2 ?since=', () => {
  const ORIG_FETCH = global.fetch;
  let capturedUrl: string | undefined;

  beforeEach(() => {
    capturedUrl = undefined;
    (global as any).fetch = jest.fn(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => [],
      };
    });
  });

  afterEach(() => {
    (global as any).fetch = ORIG_FETCH;
  });

  it('omits ?since= when the cursor is undefined (legacy/cold-boot)', async () => {
    const helper = new WorkOrderCoordinatorHelper();
    await helper.fetchAvailableWorkOrders(
      'http://coord.local',
      'peer-1',
      ['llm'],
      undefined,
    );
    expect(capturedUrl).toBe('http://coord.local/work-orders/available');
  });

  it('appends ?since=<seq> when the cursor is a positive integer', async () => {
    const helper = new WorkOrderCoordinatorHelper();
    await helper.fetchAvailableWorkOrders(
      'http://coord.local',
      'peer-1',
      ['llm'],
      42,
    );
    expect(capturedUrl).toBe('http://coord.local/work-orders/available?since=42');
  });

  it('floors a fractional cursor (BIGSERIAL is integer)', async () => {
    const helper = new WorkOrderCoordinatorHelper();
    await helper.fetchAvailableWorkOrders(
      'http://coord.local',
      'peer-1',
      ['llm'],
      42.9,
    );
    expect(capturedUrl).toBe('http://coord.local/work-orders/available?since=42');
  });

  it('drops ?since=0 (BIGSERIAL starts at 1; 0 would 400)', async () => {
    const helper = new WorkOrderCoordinatorHelper();
    await helper.fetchAvailableWorkOrders(
      'http://coord.local',
      'peer-1',
      ['llm'],
      0,
    );
    expect(capturedUrl).toBe('http://coord.local/work-orders/available');
  });

  it('drops a negative cursor', async () => {
    const helper = new WorkOrderCoordinatorHelper();
    await helper.fetchAvailableWorkOrders(
      'http://coord.local',
      'peer-1',
      ['llm'],
      -5,
    );
    expect(capturedUrl).toBe('http://coord.local/work-orders/available');
  });

  it('drops NaN cursors', async () => {
    const helper = new WorkOrderCoordinatorHelper();
    await helper.fetchAvailableWorkOrders(
      'http://coord.local',
      'peer-1',
      ['llm'],
      Number.NaN,
    );
    expect(capturedUrl).toBe('http://coord.local/work-orders/available');
  });
});
