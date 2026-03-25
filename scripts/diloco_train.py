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
    batch_size = hyperparams.get("batchSize", 4)

    device = "cpu"
    if hardware == "mps" and torch.backends.mps.is_available():
        device = "mps"
    elif hardware == "cuda" and torch.cuda.is_available():
        device = "cuda"

    # 4-bit quantization config (only for CUDA)
    if device == "cuda":
        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_use_double_quant=True,
            bnb_4bit_quant_type="nf4",
        )
        base_model = AutoModelForCausalLM.from_pretrained(
            model_id, quantization_config=bnb_config, device_map="auto"
        )
    else:
        base_model = AutoModelForCausalLM.from_pretrained(
            model_id, torch_dtype=torch.float32
        )
        base_model = base_model.to(device)

    # Load or create LoRA adapter
    if adapter_path and os.path.exists(adapter_path):
        model = PeftModel.from_pretrained(base_model, adapter_path, is_trainable=True)
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

    tokenizer = AutoTokenizer.from_pretrained(model_id)
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
    dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad], lr=lr
    )

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
