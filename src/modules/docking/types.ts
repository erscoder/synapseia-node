/**
 * Node-side mirror of the coordinator's docking domain types.
 *
 * Kept here as a local copy to avoid a cross-package import. The shapes
 * MUST stay in sync with `packages/coordinator/src/domain/docking/types.ts`
 * — the submission this node returns to the coordinator is validated
 * against `DockingSubmissionPayload` over the wire.
 */

export interface AtomCoord {
  readonly serial: number;
  readonly element: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface DockingPose {
  readonly rank: number;
  /** kcal/mol — most negative wins. */
  readonly affinity: number;
  readonly rmsdLb: number;
  readonly rmsdUb: number;
  readonly atoms: readonly AtomCoord[];
}

/** Coordinator-issued WO payload (sent in workOrder.description). */
export interface DockingWorkOrderPayload {
  readonly pairId: string;
  readonly missionId: string;
  readonly receptorPdbId: string;
  readonly ligandSmiles: string;
  readonly bindingSite: {
    readonly x: number; readonly y: number; readonly z: number;
    readonly sizeX: number; readonly sizeY: number; readonly sizeZ: number;
  };
  readonly vinaSeed: string;
  readonly vinaVersion: '1.2.5';
  readonly vinaParams: {
    readonly exhaustiveness: number;
    readonly num_modes: number;
    readonly energy_range: number;
  };
  readonly slot: 'A' | 'B' | 'TIEBREAK';
}

/** Submission shape returned to the coordinator. */
export interface DockingSubmissionPayload {
  readonly workOrderId: string;
  readonly peerId: string;
  readonly bestAffinity: number;
  readonly poses: readonly DockingPose[];
  readonly durationMs: number;
  readonly vinaVersion: string;
  readonly hardwareUsed: { cpu: string; ramMb: number };
  readonly resultHash: string;
}
