# ADR-0001: DiLoCo torch/numpy pin policy and bump procedure

- Status: Accepted
- Date: 2026-05-29
- Context: audit item WS3 (validate + document the DiLoCo torch/numpy pins)

## Context

The node runs DiLoCo distributed training and node-side aggregation in an
isolated Python venv (`/opt/training-venv`, built by the runtime stage of the
Dockerfile). The dependencies are hard-pinned in
`packages/node/requirements-training.txt`:

```
torch==2.5.1
numpy==2.1.3
```

The aggregation scripts live in `packages/node/scripts/diloco_*.py`. The
executor (`diloco_aggregate_executor.py`) is CPU-pinned and upcasts to float64
for accumulation; it never constructs a CUDA tensor.

A prior framing in the requirements file said a torch bump must "re-validate
DiLoCo aggregation determinism (sha256 of accumulated gradients)". That is
misleading and this ADR corrects it.

## Decision

### 1. Gradients travel as an opaque blob; the coordinator does not deserialize

Each training node uploads its gradient/adapter as a serialized bundle. The
coordinator verifies that submission blob by its sha256 plus an Ed25519
signature, for INTEGRITY and AUTH only. The coordinator never deserializes the
blob or touches a torch tensor. Therefore the coordinator needs NO torch pin,
and the adapter sha256 is purely a transport-integrity check, not a consensus
value.

### 2. The consensus key is the scalar invariants, not the adapter bytes

Consensus is computed over the scalar invariants the executor emits:

- `avgGradientNorm`
- `velocityNorm`
- the accepted / rejected peer sets (and per-peer cosine)

These scalars are bit-stable given pinned inputs, and the coordinator reaches
consensus on them with a tolerance (tight, ~1e-5 because the executor is
CPU-pinned + float64). The adapter serialized bytes / adapter sha256 are
NON-deterministic across runs — torch tensor serialization embeds storage
metadata — and design section 4.2 treats them as informational only. So adapter
sha256 is NOT a re-validation target on a torch bump; scalar-invariant
STABILITY is.

### 3. The `==` pin enforces node uniformity

All training and aggregating NODES must share the exact `==` pin so the scalar
invariants are computed identically across the swarm. If two nodes ran
different torch builds, their invariants could drift past the coordinator's
tolerance and split consensus. The pin (not a range) is what guarantees
uniformity, and as a bonus keeps the image build reproducible and removes the
supply-chain risk of silently pulling a newer release on every rebuild.

## Bump procedure (torch and/or numpy)

1. Edit `requirements-training.txt` to the candidate versions.
2. Rebuild `/opt/training-venv` with the candidate pins.
3. Run `pnpm --filter @synapseia-network/node test:diloco-compat`
   AUTHORITATIVELY inside that pinned venv. It runs:
   - `scripts/diloco_compat_smoke.py` — aggregates byte-identical seeded
     inputs twice and asserts the consensus-key invariants are bit-equal
     across runs (exits non-zero on any drift); and
   - the existing `scripts/__tests__/diloco_aggregate_executor_test.py`
     (invariant stability + the real SVD compress/decompress round-trip).
4. Confirm the invariants are stable AND that a held-out eval on the new
   torch produces equivalent training quality (no silent numerical
   regression in the training path).
5. Only then ship. A green compat run on an unpinned developer torch is
   smoke-only evidence, never the release gate.

## Consequences

- Coordinator stays torch-free and cannot be broken by a node-side torch bump.
- A torch bump is a swarm-wide change: all nodes must move together, gated by
  the compat harness in the pinned venv.
- The documentation now states the correct re-validation target
  (scalar-invariant stability), removing the misleading adapter-sha256 framing.
