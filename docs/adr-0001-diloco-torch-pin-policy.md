# ADR-0001: DiLoCo torch/numpy pin policy and bump procedure

- Status: Accepted
- Date: 2026-05-29 (re-pinned 2026-05-30 — see "Pin bump 2026-05-30")
- Context: audit item WS3 (validate + document the DiLoCo torch/numpy pins)

## Context

The node runs DiLoCo distributed training and node-side aggregation in an
isolated Python venv (`/opt/training-venv`, built by the runtime stage of the
Dockerfile). The dependencies are hard-pinned in
`packages/node/requirements-training.txt`. The current pin is:

```
torch==2.9.1
numpy==2.3.2
```

> The pin was originally `torch==2.5.1 / numpy==2.1.3`. Both aged out of
> PyPI and lacked cp314 wheels; see "Pin bump 2026-05-30" below for the
> full history and the live re-validation result.

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

## Pin bump 2026-05-30 — torch 2.6.0 → 2.9.1 (PyPI drift + Python 3.14 / cp314)

### Why

The earlier `torch==2.6.0` (the version the runtime installer
`src/utils/install-deps.ts` resolved for cp310-cp313, with `==2.5.1` still in
this requirements file) **aged out of PyPI**:

- The default PyPI index now serves only torch `{2.9.0, 2.9.1, 2.10.0, 2.11.0,
  2.12.0}` — both `2.5.1` and `2.6.0` are gone.
- The `cu124` NVIDIA index stops at `2.6.0` and **never carried a cp314 wheel**.
- Neither `2.5.1` nor `2.6.0` ever shipped a **cp314** wheel anywhere.

A node whose venv is **Python 3.14 (cp314)** — confirmed live on node-kike
(venv Python 3.14.5) — therefore could not install the pinned torch and booted
**without torch**, losing its pytorch/DiLoCo training caps:

```
ERROR: Could not find a version that satisfies the requirement torch==2.6.0
(from versions: 2.9.0, 2.9.1, 2.10.0, 2.11.0, 2.12.0)
```

### Decision

Pin `torch==2.9.1` and move the NVIDIA wheel index `cu124 → cu128`:

- `2.9.1` is the **oldest stable still served** by the default PyPI index
  (least bleeding-edge in the available set).
- It ships a **real cp314 wheel** on BOTH the default/cpu index (macOS arm64 +
  CPU) AND the `cu128` NVIDIA index (manylinux_2_28 x86_64 + aarch64,
  win_amd64) — so Python 3.14 is **no longer best-effort** in
  `selectTorchSpec`; `bestEffort` is retained only for Python ≥ 3.15.
- `cu128` (CUDA 12.8, driver ≥ ~570) is the modern default; the prod RunPod
  A5000/A40 pods already run driver 570 / CUDA 12.8, so no GPU capability is
  lost. `cu124` could not be kept because it has neither `2.9.1` nor any cp314
  wheel.
- `numpy==2.1.3` likewise had no cp314 wheel (numpy cp314 wheels start at
  `2.3.2`); bumped to `numpy==2.3.2` (lowest cp314-capable) so the pinned venv
  is installable on Python 3.14.

`requirements-training.txt` and `selectTorchSpec` in
`src/utils/install-deps.ts` now resolve to the **same exact `torch==2.9.1`
pin** across every supported (OS, Python) combo, as this ADR's section 3
requires.

### Re-validation (ADR mandate, isolated cp314 venv)

Performed in a throwaway `python3.14 -m venv /tmp/torch-reval` (node-kike's
live `~/.synapseia/venv` was NOT touched; node-kike pid 46896 stayed running):

1. **Install proof (headline fix):** `pip install torch==2.9.1 numpy==2.3.2`
   exited 0 on Python 3.14.5 — installed `torch-2.9.1` + `numpy-2.3.2` cleanly.
2. **`scripts/diloco_compat_smoke.py`** → `PASS`: consensus-key scalar
   invariants bit-stable across identical runs on torch 2.9.1.
   - `avgGradientNorm = 8.215838362577491`
   - `velocityNorm = 8.215838362577491`
   - `accepted = ['a', 'b']`, `rejected = ['bad']`
3. **`scripts/__tests__/diloco_aggregate_executor_test.py`** → `19 passed`
   (invariant stability + the real SVD compress/decompress round-trip).

The smoke run is version-robustness evidence on this developer torch; the
authoritative release gate remains a green `test:diloco-compat` inside the
pinned `/opt/training-venv` in CI (now built with `torch==2.9.1`), per the bump
procedure above. The temp venv was removed after the run.
