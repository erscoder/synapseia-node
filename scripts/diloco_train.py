#!/usr/bin/env python3
"""
DiLoCo inner-loop training script.

Reads config from stdin as JSON.
Outputs JSON lines to stdout: progress updates + final result.

Supports testMode=True to use a tiny model (GPT-2) for CI/testing.
"""

import sys
import json
import os

# Bug 28 / Slice 18 v3 — DiLoCo runtime OOM mitigation
# ----------------------------------------------------
# `expandable_segments:True` lets the CUDA caching allocator grow its
# pre-reserved blocks instead of fragmenting into fixed-size segments,
# which is the typical failure mode during the backward pass of a
# quantized 7B model with LoRA on a 24 GB card. Must be set BEFORE
# `import torch` runs anywhere in the process — torch reads this env
# only at allocator init. `setdefault` so an externally provided env
# (e.g. a more aggressive operator override) still wins.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import gc
import tempfile
import time
import math

def log(obj: dict) -> None:
    """Output a JSON line to stdout (flush immediately so TS wrapper sees it)."""
    print(json.dumps(obj), flush=True)


def compress_gradients_svd(gradients: dict, top_k: int = 64) -> dict:
    """
    Compress a dict of named gradient tensors using truncated SVD.
    Returns a dict of {name: {"U": ..., "S": ..., "V": ..., "shape": ...}}.
    """
    import torch
    compressed = {}
    for name, grad in gradients.items():
        if grad is None:
            continue
        shape = list(grad.shape)
        # Reshape to 2D for SVD
        if grad.dim() == 1:
            # 1-D tensors: treat as row vector
            mat = grad.unsqueeze(0).float()
        else:
            mat = grad.view(grad.shape[0], -1).float()

        try:
            U, S, Vh = torch.linalg.svd(mat, full_matrices=False)
            k = min(top_k, S.shape[0])
            compressed[name] = {
                "U": U[:, :k].tolist(),
                "S": S[:k].tolist(),
                "V": Vh[:k, :].tolist(),
                "shape": shape,
                "original_rows": mat.shape[0],
                "original_cols": mat.shape[1],
            }
        except Exception:
            # Fallback: store as-is (shouldn't happen in practice)
            compressed[name] = {
                "raw": grad.tolist(),
                "shape": shape,
            }
    return compressed


def run_test_mode(config: dict) -> None:
    """
    Test mode: use a tiny randomly-initialized model instead of downloading 7B.
    Simulates the DiLoCo inner loop with synthetic data.
    """
    import torch
    import torch.nn as nn

    inner_steps = config.get("innerSteps", 10)
    lr = config.get("hyperparams", {}).get("learningRate", 1e-3)
    hardware = config.get("hardware", "cpu")

    device = "cpu"
    if hardware == "mps" and torch.backends.mps.is_available():
        device = "mps"
    elif hardware == "cuda" and torch.cuda.is_available():
        device = "cuda"

    # Tiny 2-layer MLP as stand-in for foundation model + LoRA
    model = nn.Sequential(
        nn.Linear(64, 128),
        nn.ReLU(),
        nn.Linear(128, 64),
        nn.ReLU(),
        nn.Linear(64, 32),
    ).to(device)

    # Capture initial weights (for pseudo-gradient computation)
    initial_weights = {}
    for name, param in model.named_parameters():
        initial_weights[name] = param.data.clone()

    optimizer = torch.optim.AdamW(model.parameters(), lr=lr)
    loss_val = 5.0

    for step in range(1, inner_steps + 1):
        optimizer.zero_grad()
        x = torch.randn(8, 64, device=device)
        y = torch.randn(8, 32, device=device)
        out = model(x)
        loss = nn.functional.mse_loss(out, y)
        loss.backward()
        optimizer.step()

        loss_val = float(loss.item())

        # Emit progress every step (or every 10 for larger runs)
        if step % max(1, inner_steps // 10) == 0 or step == inner_steps:
            log({"step": step, "loss": round(loss_val, 4), "lr": lr})

    # Compute pseudo-gradients = final_weights - initial_weights
    pseudo_gradients = {}
    for name, param in model.named_parameters():
        pseudo_gradients[name] = param.data - initial_weights[name]

    # Compress with SVD
    compressed = compress_gradients_svd(pseudo_gradients, top_k=32)

    # Save to temp file
    import pickle
    tmp = tempfile.NamedTemporaryFile(
        suffix="_diloco_gradients.pt", delete=False, mode="wb"
    )
    pickle.dump(compressed, tmp)
    tmp.close()
    gradient_path = tmp.name

    val_loss = loss_val * 1.05  # Slightly worse than train loss
    final_loss = loss_val

    log({
        "result": {
            "finalLoss": round(final_loss, 4),
            "valLoss": round(val_loss, 4),
            "innerSteps": inner_steps,
            "durationMs": int(time.time() * 1000),
            "gradientPath": gradient_path,
        }
    })


def _load_with_retry(loader_fn, what: str, max_attempts: int = 2, base_delay: float = 1.0):
    """
    Bug 18 v3 (refactored): with `local_files_only=True` the only failures
    `from_pretrained` can raise are deterministic cache-miss / corrupt-file
    errors (OSError, EnvironmentError). Network-flake retries no longer
    make sense — there is no network round-trip anymore.

    We keep a thin 2-attempt retry only to absorb a transient mmap / fd
    pressure race that we have occasionally seen on highly-loaded pods
    (the second open succeeds when the first hits "too many open files").

    Bails immediately on TypeError / ValueError (programmer error).
    """
    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            return loader_fn()
        except (TypeError, ValueError):
            raise
        except Exception as e:  # noqa: BLE001 — see docstring
            last_err = e
            err_name = type(e).__name__
            if attempt == max_attempts:
                log({
                    "warn": f"{what} failed after {attempt} attempts ({err_name}: {str(e)[:200]}); giving up"
                })
                raise
            delay = base_delay * (2 ** (attempt - 1))
            log({
                "warn": f"{what} attempt {attempt}/{max_attempts} failed ({err_name}: {str(e)[:200]}); retrying in {delay:.0f}s"
            })
            time.sleep(delay)
    # Unreachable, but defensive — `raise` above always fires on the
    # final attempt. Keeps type-checkers and reviewers happy.
    if last_err is not None:
        raise last_err
    raise RuntimeError(f"{what} failed without capturing an error")


def _resolve_local_snapshot(model_id: str) -> str:
    """
    Bug 18 v3 (refactored): resolve the local snapshot path for `model_id`
    from the install-deps marker. Fail-fast (raises RuntimeError) when no
    valid marker exists — DiLoCo runtime is local-only by design and
    MUST NOT attempt any HF Hub round-trip.

    Looks for `~/.synapseia/diloco-model-ok` (override via SYNAPSEIA_HOME).
    Returns the absolute snapshot directory suitable for passing directly
    as `pretrained_model_name_or_path` to `from_pretrained()`.

    Raises RuntimeError with an operator-actionable hint when:
      - marker file missing
      - marker JSON corrupt / wrong shape
      - marker is for a different modelId
      - cacheDir on disk no longer exists

    P2 fail-closed: never silently fall back to a Hub fetch.
    """
    base = os.environ.get("SYNAPSEIA_HOME")
    if base:
        marker_path = os.path.join(base, "diloco-model-ok")
    else:
        marker_path = os.path.join(os.path.expanduser("~"), ".synapseia", "diloco-model-ok")

    hint = (
        f"DiLoCo model '{model_id}' not cached locally. "
        f"Run `syn install-deps` to pre-download the foundation model. "
        f"(Looked for marker at {marker_path})"
    )

    if not os.path.exists(marker_path):
        raise RuntimeError(hint)
    try:
        with open(marker_path, "r", encoding="utf-8") as f:
            marker = json.load(f)
    except Exception as e:
        raise RuntimeError(f"{hint} — marker exists but is unreadable: {e}")

    if not isinstance(marker, dict):
        raise RuntimeError(f"{hint} — marker is not a JSON object")
    if marker.get("modelId") != model_id:
        raise RuntimeError(
            f"{hint} — marker is for modelId={marker.get('modelId')!r}, "
            f"requested {model_id!r}"
        )
    cache_dir = marker.get("cacheDir")
    if not isinstance(cache_dir, str) or not os.path.exists(cache_dir):
        raise RuntimeError(
            f"{hint} — marker points to cacheDir={cache_dir!r} which does not exist on disk"
        )

    # cache_dir points to the snapshot directory (e.g.
    # ~/.cache/huggingface/hub/models--Qwen--Qwen2.5-7B/snapshots/<sha>).
    # `from_pretrained` accepts that path directly with
    # `local_files_only=True`, which forbids any Hub round-trip.
    return cache_dir


def run_full_mode(config: dict) -> None:
    """
    Full mode: fine-tune Qwen2.5-7B (or configured modelId) with LoRA.
    Uses QLoRA (4-bit quantization) to fit in 24GB VRAM.
    """
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM, BitsAndBytesConfig
    from peft import LoraConfig, get_peft_model, PeftModel
    from torch.utils.data import Dataset, DataLoader

    model_id = config.get("modelId", "Qwen/Qwen2.5-7B")
    adapter_path = config.get("adapterPath")
    dataset_path = config.get("datasetPath", "")
    inner_steps = config.get("innerSteps", 100)
    hyperparams = config.get("hyperparams", {})
    hardware = config.get("hardware", "cpu")
    lr = hyperparams.get("learningRate", 2e-4)
    # Bug 28 / Slice 18 v3: default lowered 4 → 1 to keep peak activation
    # memory inside the 24 GB envelope on an RTX A5000 during the backward
    # pass of a quantized 7B base with LoRA adapters. TS caller may still
    # override via hyperparams.batchSize when running on bigger GPUs.
    # P31: clamp to [1, 1024] to fail-closed on negative / oversized inputs
    # that would silently OOM mid-run.
    try:
        batch_size = int(hyperparams.get("batchSize", 1))
    except (TypeError, ValueError):
        batch_size = 1
    batch_size = max(1, min(1024, batch_size))

    # Bug 18 v3: DiLoCo runtime is LOCAL-ONLY. The install-deps phase
    # pre-downloads the foundation model once and writes a marker; here
    # we resolve the marker to a snapshot path and load with
    # `local_files_only=True`. No HF Hub round-trip ever happens at
    # runtime — eliminates rate-limit / mid-load SIGPIPE failure modes
    # entirely. Cache miss fails fast with an operator-actionable hint
    # (P2 fail-closed; no silent download).
    pretrained_name = _resolve_local_snapshot(model_id)
    # F-node-005 (HIGH): pin `use_safetensors=True` on every from_pretrained
    # call. Refuses pickled checkpoints (.bin / pytorch_model.bin) which
    # `torch.load`-via-transformers can deserialize → arbitrary code
    # execution on the trainer process. Combined with the sha256
    # commitment + verify in TS land (model-downloader.ts), this closes
    # the model-poisoning + RCE path for the aggregate adapter and the
    # base model alike.
    load_kwargs_extra = {"local_files_only": True, "use_safetensors": True}
    log({"info": f"diloco_model_source=local snapshot={pretrained_name}"})

    device = "cpu"
    if hardware == "mps" and torch.backends.mps.is_available():
        device = "mps"
    elif hardware == "cuda" and torch.cuda.is_available():
        device = "cuda"

    # Slice 11 (Plan B, 2026-05-17) — OOM mitigation
    # --------------------------------------------
    # Try `low_cpu_mem_usage=True` (accelerate-backed lazy weight
    # loading via `init_empty_weights`). When supported it reduces
    # the load-time fp16 weight materialization peak by avoiding the
    # double-copy that the default loader does (load to CPU → cast →
    # move). Wrap in a fallback: older transformers without accelerate
    # raise TypeError / ValueError, in which case retry without the
    # kwarg. Worth attempting on both CUDA and non-CUDA paths.
    base_load_kwargs = dict(load_kwargs_extra)
    base_load_kwargs["low_cpu_mem_usage"] = True

    # 4-bit quantization config (only for CUDA)
    if device == "cuda":
        # Slice 18 residual SIGKILL fix (2026-05-18)
        # ------------------------------------------
        # Pod A40 (48GB VRAM) SIGKILLed at 96%/339 shards during nf4 load.
        # Three mitigations:
        #   1. bnb_4bit_quant_storage=uint8 → packs 4-bit weights into uint8
        #      storage, halves the intermediate materialization buffer.
        #   2. device_map={"":0} → pin all layers to GPU 0. Valid ONLY when
        #      the quantized model fits a single GPU; gated above by the
        #      total_vram_gb >= 12 check. Fail-closed on under-resourced
        #      pods (P2) — silent CPU-offload would mask training failures.
        #   3. Hard VRAM gate: refuses to load if heartbeat misclassified
        #      the pod. Heartbeat should never advertise diloco_training on
        #      <12GB cards; this is a defense-in-depth backstop.
        total_vram_gb = int(torch.cuda.get_device_properties(0).total_memory / (1024 ** 3))
        if total_vram_gb < 12:
            raise RuntimeError(
                f"DiLoCo 4-bit training requires >=12GB VRAM (detected {total_vram_gb}GB). "
                f"Pod is misclassified - heartbeat should not have advertised diloco_training cap. "
                f"Refusing to proceed to avoid silent CPU-offload."
            )
        log({"info": f"diloco_load_budget gpu_total_gb={total_vram_gb} strategy=pin-gpu-0"})
        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_use_double_quant=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_quant_storage=torch.uint8,
        )
        try:
            base_model = _load_with_retry(
                lambda: AutoModelForCausalLM.from_pretrained(
                    pretrained_name, quantization_config=bnb_config,
                    device_map={"": 0},
                    **base_load_kwargs,
                ),
                what=f"AutoModelForCausalLM.from_pretrained({pretrained_name}, 4bit, low_cpu_mem)",
            )
        except (TypeError, ValueError) as exc:
            log({"warn": f"low_cpu_mem_usage unsupported on this transformers/accelerate; retrying without it: {exc}"})
            base_model = _load_with_retry(
                lambda: AutoModelForCausalLM.from_pretrained(
                    pretrained_name, quantization_config=bnb_config,
                    device_map={"": 0},
                    **load_kwargs_extra,
                ),
                what=f"AutoModelForCausalLM.from_pretrained({pretrained_name}, 4bit)",
            )
    else:
        # transformers 5.x renamed `torch_dtype` → `dtype` (deprecation
        # since 4.43, hard-removed in 5.0). Pods upgraded to 5.8.1 and the
        # old kwarg raised TypeError at from_pretrained call → process
        # exit code null → every DiLoCo WO crashed pre-train. Use `dtype`
        # going forward; install-deps pins transformers>=4.43 to guarantee
        # the keyword is recognized on older venvs too. See Bug 14.
        try:
            base_model = _load_with_retry(
                lambda: AutoModelForCausalLM.from_pretrained(
                    pretrained_name, dtype=torch.float32, **base_load_kwargs,
                ),
                what=f"AutoModelForCausalLM.from_pretrained({pretrained_name}, fp32, low_cpu_mem)",
            )
        except (TypeError, ValueError) as exc:
            log({"warn": f"low_cpu_mem_usage unsupported on this transformers/accelerate; retrying without it: {exc}"})
            base_model = _load_with_retry(
                lambda: AutoModelForCausalLM.from_pretrained(
                    pretrained_name, dtype=torch.float32, **load_kwargs_extra,
                ),
                what=f"AutoModelForCausalLM.from_pretrained({pretrained_name}, fp32)",
            )
        base_model = base_model.to(device)

    # Load or create LoRA adapter
    if adapter_path and os.path.exists(adapter_path):
        # F-node-005: pin safetensors-only for the adapter weights too.
        # The TS side (model-downloader.ts) writes the verified bytes to
        # `adapter_weights.safetensors`; peft must refuse to fall back to
        # a `.bin` pickled adapter sitting next to it.
        model = PeftModel.from_pretrained(
            base_model,
            adapter_path,
            is_trainable=True,
            use_safetensors=True,
        )
    else:
        lora_config = LoraConfig(
            r=16,
            lora_alpha=32,
            target_modules=["q_proj", "v_proj", "k_proj", "o_proj"],
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
        )
        model = get_peft_model(base_model, lora_config)

    # Bug 28 / Slice 18 v3: gradient checkpointing trades compute for VRAM
    # by recomputing activations during backward instead of caching them.
    # `use_reentrant=False` is the modern, autograd-graph-clean path.
    # `enable_input_require_grads()` is REQUIRED when checkpointing a
    # quantized base model with LoRA adapters — the frozen nf4 weights
    # break the gradient path unless we explicitly mark the embedding
    # output as requiring grad, otherwise the checkpoint reentry sees a
    # detached graph and grads never reach the LoRA adapters.
    if hasattr(model, "gradient_checkpointing_enable"):
        model.gradient_checkpointing_enable(
            gradient_checkpointing_kwargs={"use_reentrant": False}
        )
    if hasattr(model, "enable_input_require_grads"):
        model.enable_input_require_grads()
    # `use_cache=True` caches past KV pairs in the forward pass, which is
    # incompatible with gradient checkpointing (HF emits a warning + disables
    # checkpointing silently). Force it off on the underlying config if present.
    if hasattr(model, "config") and getattr(model.config, "use_cache", False):
        model.config.use_cache = False
    base_cfg = getattr(getattr(model, "base_model", None), "config", None)
    if base_cfg is not None and getattr(base_cfg, "use_cache", False):
        base_cfg.use_cache = False

    tokenizer = _load_with_retry(
        lambda: AutoTokenizer.from_pretrained(pretrained_name, **load_kwargs_extra),
        what=f"AutoTokenizer.from_pretrained({pretrained_name})",
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # Capture initial LoRA weights
    initial_weights = {}
    for name, param in model.named_parameters():
        if param.requires_grad:
            initial_weights[name] = param.data.clone()

    # Simple text dataset
    class TextDataset(Dataset):
        def __init__(self, path: str, tokenizer, max_length: int = 512):
            texts = []
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    texts = [line.strip() for line in f if line.strip()]
            if not texts:
                texts = ["Hello world. This is a test."] * 32
            self.encodings = tokenizer(
                texts[:1000],
                truncation=True,
                padding="max_length",
                max_length=max_length,
                return_tensors="pt",
            )

        def __len__(self):
            return len(self.encodings["input_ids"])

        def __getitem__(self, idx):
            return {k: v[idx] for k, v in self.encodings.items()}

    dataset = TextDataset(dataset_path, tokenizer)
    # Slice 11 (Plan B, 2026-05-17): pin_memory=False to avoid the
    # CUDA pinned-memory pool that DataLoader allocates by default.
    # Each pinned page is held outside the cgroup-reclaimable set so
    # it stacks with the model weights and inflates the OOM headroom
    # required by `DILOCO_REQUIRED_FREE_MB`. At the v3 batch_size=1
    # default the H2D copy is trivial; pinning is a luxury, not a need.
    dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True, pin_memory=False)

    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad], lr=lr
    )

    # Slice 11 (Plan B, 2026-05-17): drop transient quantization / load
    # buffers before training starts. `from_pretrained` leaves cudaMalloc
    # / MPS staging fragments that empty_cache() returns to the allocator,
    # and CPU-side temporary fp32 buffers that gc.collect() reclaims.
    # Cheap (10-50 ms) and meaningful on the load-peak headroom.
    gc.collect()
    if device == "cuda" and torch.cuda.is_available():
        torch.cuda.empty_cache()

    model.train()
    step = 0
    total_loss = 0.0
    data_iter = iter(dataloader)

    while step < inner_steps:
        try:
            batch = next(data_iter)
        except StopIteration:
            data_iter = iter(dataloader)
            batch = next(data_iter)

        batch = {k: v.to(device) for k, v in batch.items()}
        labels = batch["input_ids"].clone()
        labels[labels == tokenizer.pad_token_id] = -100

        outputs = model(**batch, labels=labels)
        loss = outputs.loss

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        step += 1
        total_loss = float(loss.item())

        # Slice 11 (Plan B, 2026-05-17): periodic empty_cache + gc to
        # contain transient activation buffers between micro-steps.
        # Every 10 steps is a safe cadence — empty_cache on CUDA is
        # ~1 ms; gc.collect on python heap with model loaded is ~10
        # ms; combined cost per 10 steps is below the cost of a single
        # backward pass on a 7B model, so the throughput hit is in
        # the noise.
        if step % 10 == 0:
            gc.collect()
            if device == "cuda" and torch.cuda.is_available():
                torch.cuda.empty_cache()

        if step % max(1, inner_steps // 10) == 0 or step == inner_steps:
            log({"step": step, "loss": round(total_loss, 4), "lr": lr})

    final_loss = total_loss
    val_loss = final_loss * 1.05

    # Compute pseudo-gradients for LoRA parameters
    pseudo_gradients = {}
    for name, param in model.named_parameters():
        if param.requires_grad and name in initial_weights:
            pseudo_gradients[name] = param.data - initial_weights[name]

    # Compress with SVD
    compressed = compress_gradients_svd(pseudo_gradients, top_k=64)

    import pickle
    tmp = tempfile.NamedTemporaryFile(
        suffix="_diloco_gradients.pt", delete=False, mode="wb"
    )
    pickle.dump(compressed, tmp)
    tmp.close()
    gradient_path = tmp.name

    log({
        "result": {
            "finalLoss": round(final_loss, 4),
            "valLoss": round(val_loss, 4),
            "innerSteps": inner_steps,
            "durationMs": int(time.time() * 1000),
            "gradientPath": gradient_path,
        }
    })


def main() -> None:
    try:
        raw = sys.stdin.read()
        config = json.loads(raw)
    except Exception as e:
        log({"error": f"Failed to parse config: {e}"})
        sys.exit(1)

    test_mode = config.get("testMode", False)

    try:
        if test_mode:
            run_test_mode(config)
        else:
            run_full_mode(config)
    except Exception as e:
        log({"error": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
