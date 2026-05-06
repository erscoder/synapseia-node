/**
 * Bug H1 — coordinator-side helpers added in Step 3.
 *
 * Covers:
 *   - getWorkOrder returns the parsed WO body on 2xx;
 *   - getWorkOrder returns null on 404 / network failure;
 *   - completeWorkOrder reclassifies a 400 from the POST as `dropped`
 *     (info-level, returns true so the agent loop closes the WO).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { WorkOrderCoordinatorHelper } from '../work-order.coordinator';
import logger from '../../../../utils/logger';

describe('WorkOrderCoordinatorHelper — stale-WO handling (Bug H1)', () => {
  let helper: WorkOrderCoordinatorHelper;
  let fetchSpy: jest.SpiedFunction<typeof globalThis.fetch>;
  let infoSpy: jest.SpiedFunction<typeof logger.info>;
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;

  beforeEach(() => {
    helper = new WorkOrderCoordinatorHelper();
    fetchSpy = jest.spyOn(globalThis, 'fetch') as any;
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('getWorkOrder returns the WO on 200', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'wo-1', status: 'ACCEPTED' }),
    } as any);

    const wo = await helper.getWorkOrder('http://coord', 'wo-1');
    expect(wo).toEqual({ id: 'wo-1', status: 'ACCEPTED' });
  });

  it('getWorkOrder returns null on 404', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' } as any);
    const wo = await helper.getWorkOrder('http://coord', 'wo-missing');
    expect(wo).toBeNull();
  });

  it('getWorkOrder returns null on network error', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const wo = await helper.getWorkOrder('http://coord', 'wo-1');
    expect(wo).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[GetWO] Network error:', 'ECONNREFUSED');
  });

  it('completeWorkOrder reclassifies 400 as dropped (info-level, returns true)', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: 'WORK_ORDER_NOT_ACCEPTABLE', message: 'expired' }),
    } as any);

    const completedIds = new Set<string>();
    const added: string[] = [];
    const ok = await helper.completeWorkOrder(
      'http://coord',
      'wo-1',
      'peer-1',
      'wallet-1',
      'result',
      true,
      completedIds,
      (id) => added.push(id),
      () => {},
      (s) => BigInt(Math.floor(parseFloat(s) * 1e9)),
    );

    expect(ok).toBe(true);
    expect(added).toContain('wo-1');
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping stale submission for WO wo-1 (WORK_ORDER_NOT_ACCEPTABLE)'),
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('completeWorkOrder still warns + returns false on non-400 errors', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'INTERNAL', message: 'boom' }),
    } as any);

    const ok = await helper.completeWorkOrder(
      'http://coord',
      'wo-1',
      'peer-1',
      'wallet-1',
      'result',
      true,
      new Set<string>(),
      () => {},
      () => {},
      (s) => BigInt(Math.floor(parseFloat(s) * 1e9)),
    );

    expect(ok).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
