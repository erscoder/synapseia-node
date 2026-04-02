#!/usr/bin/env python3
"""
Micro-transformer training script for SynapseIA
Trains a tiny transformer (120K params) with configurable hyperparameters

Input: JSON via stdin with hyperparameters and dataset path
Output: JSON lines to stdout (progress updates + final result)
"""

import json
import sys
import time
import math
import random
from pathlib import Path
from typing import List, Dict, Any, Tuple

import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader


class CharTokenizer:
    """Simple character-level tokenizer"""
    
    def __init__(self, text: str):
        self.chars = sorted(list(set(text)))
        self.vocab_size = len(self.chars)
        self.char_to_idx = {ch: i for i, ch in enumerate(self.chars)}
        self.idx_to_char = {i: ch for i, ch in enumerate(self.chars)}
    
    def encode(self, text: str) -> List[int]:
        return [self.char_to_idx.get(ch, 0) for ch in text]
    
    def decode(self, indices: List[int]) -> str:
        return ''.join([self.idx_to_char.get(i, '') for i in indices])


class TextDataset(Dataset):
    """Dataset for language modeling"""
    
    def __init__(self, data: str, tokenizer: CharTokenizer, seq_length: int = 128):
        self.data = tokenizer.encode(data)
        self.seq_length = seq_length
    
    def __len__(self) -> int:
        return max(0, len(self.data) - self.seq_length - 1)
    
    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        x = torch.tensor(self.data[idx:idx + self.seq_length], dtype=torch.long)
        y = torch.tensor(self.data[idx + 1:idx + self.seq_length + 1], dtype=torch.long)
        return x, y


class RMSNorm(nn.Module):
    """Root Mean Square Layer Normalization"""
    
    def __init__(self, dim: int, eps: float = 1e-6):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))
    
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        norm = x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps)
        return norm * self.weight


class Head(nn.Module):
    """Single attention head"""
    
    def __init__(self, head_size: int, n_embd: int, dropout: float = 0.1):
        super().__init__()
        self.key = nn.Linear(n_embd, head_size, bias=False)
        self.query = nn.Linear(n_embd, head_size, bias=False)
        self.value = nn.Linear(n_embd, head_size, bias=False)
        self.dropout = nn.Dropout(dropout)
    
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C = x.shape
        k = self.key(x)   # (B, T, head_size)
        q = self.query(x) # (B, T, head_size)
        
        # Attention scores
        wei = q @ k.transpose(-2, -1) * (k.shape[-1] ** -0.5)  # (B, T, T)
        wei = torch.tril(wei)
        wei = wei.masked_fill(wei == 0, float('-inf'))
        wei = torch.softmax(wei, dim=-1)
        wei = self.dropout(wei)
        
        v = self.value(x)  # (B, T, head_size)
        out = wei @ v  # (B, T, head_size)
        return out


class MultiHeadAttention(nn.Module):
    """Multiple attention heads in parallel"""
    
    def __init__(self, num_heads: int, head_size: int, n_embd: int, dropout: float = 0.1):
        super().__init__()
        self.heads = nn.ModuleList([Head(head_size, n_embd, dropout) for _ in range(num_heads)])
        self.proj = nn.Linear(n_embd, n_embd)
        self.dropout = nn.Dropout(dropout)
    
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = torch.cat([h(x) for h in self.heads], dim=-1)
        out = self.proj(out)
        out = self.dropout(out)
        return out


class FeedForward(nn.Module):
    """Feed-forward layer"""
    
    def __init__(self, n_embd: int, dropout: float = 0.1):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(n_embd, 4 * n_embd),
            nn.GELU(),
            nn.Linear(4 * n_embd, n_embd),
            nn.Dropout(dropout),
        )
    
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class Block(nn.Module):
    """Transformer block"""
    
    def __init__(self, n_embd: int, num_heads: int, dropout: float = 0.1, normalization: str = 'layernorm'):
        super().__init__()
        head_size = n_embd // num_heads
        self.sa = MultiHeadAttention(num_heads, head_size, n_embd, dropout)
        self.ffwd = FeedForward(n_embd, dropout)
        
        if normalization == 'rmsnorm':
            self.ln1 = RMSNorm(n_embd)
            self.ln2 = RMSNorm(n_embd)
        else:
            self.ln1 = nn.LayerNorm(n_embd)
            self.ln2 = nn.LayerNorm(n_embd)
    
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.sa(self.ln1(x))
        x = x + self.ffwd(self.ln2(x))
        return x


class MicroTransformer(nn.Module):
    """Micro transformer for language modeling (~120K params)"""
    
    def __init__(
        self,
        vocab_size: int,
        n_embd: int = 128,
        num_layers: int = 4,
        num_heads: int = 4,
        dropout: float = 0.1,
        normalization: str = 'layernorm',
        init_scheme: str = 'xavier',
    ):
        super().__init__()
        self.token_embedding = nn.Embedding(vocab_size, n_embd)
        self.position_embedding = nn.Embedding(512, n_embd)  # Max 512 positions
        self.blocks = nn.Sequential(*[
            Block(n_embd, num_heads, dropout, normalization)
            for _ in range(num_layers)
        ])
        self.ln_f = RMSNorm(n_embd) if normalization == 'rmsnorm' else nn.LayerNorm(n_embd)
        self.lm_head = nn.Linear(n_embd, vocab_size)
        self.dropout = nn.Dropout(dropout)
        
        # Apply initialization scheme
        self._apply_init(init_scheme)
    
    def _apply_init(self, scheme: str):
        """Apply weight initialization scheme"""
        for name, p in self.named_parameters():
            if 'weight' in name and p.dim() >= 2:
                if scheme == 'xavier':
                    nn.init.xavier_uniform_(p)
                elif scheme == 'kaiming':
                    nn.init.kaiming_uniform_(p, nonlinearity='relu')
                elif scheme == 'normal':
                    nn.init.normal_(p, mean=0, std=0.02)
            elif 'bias' in name:
                nn.init.zeros_(p)
    
    def forward(self, idx: torch.Tensor) -> torch.Tensor:
        B, T = idx.shape
        
        tok_emb = self.token_embedding(idx)  # (B, T, n_embd)
        pos_emb = self.position_embedding(torch.arange(T, device=idx.device))  # (T, n_embd)
        x = self.dropout(tok_emb + pos_emb)  # (B, T, n_embd)
        x = self.blocks(x)  # (B, T, n_embd)
        x = self.ln_f(x)  # (B, T, n_embd)
        logits = self.lm_head(x)  # (B, T, vocab_size)
        
        return logits
    
    def count_parameters(self) -> int:
        return sum(p.numel() for p in self.parameters())


def load_data(data_path: str) -> str:
    """Load text data from file"""
    path = Path(data_path)
    if not path.exists():
        # Create sample data if file doesn't exist
        sample_text = """Astrophysics is the branch of astronomy that employs the principles of physics and chemistry to explain the nature of celestial objects. Stars, galaxies, planets, and other objects in the universe emit radiation across the electromagnetic spectrum. Astronomers use telescopes to detect and analyze this radiation, learning about the composition, structure, and evolution of cosmic objects.

The study of stars involves understanding their life cycles, from formation in nebulae through main sequence evolution to their final states as white dwarfs, neutron stars, or black holes. Stellar nucleosynthesis creates the chemical elements that make up planets and life.

Galaxies are vast collections of stars, gas, dust, and dark matter bound together by gravity. The Milky Way is a barred spiral galaxy containing billions of stars. At the centers of most large galaxies lie supermassive black holes millions to billions of times the mass of our Sun.

Cosmology studies the origin and evolution of the universe as a whole. The Big Bang theory describes the universe expanding from an extremely hot, dense state approximately 13.8 billion years ago. Dark matter and dark energy remain mysterious components that dominate the mass-energy content of the universe.

Observational astrophysics spans the entire electromagnetic spectrum from radio waves to gamma rays. Space telescopes like Hubble and James Webb observe infrared, visible, and ultraviolet light above Earth's atmosphere. Radio telescopes detect cold gas and energetic processes in galaxies.

Computational astrophysics uses numerical simulations to model complex systems like galaxy formation, stellar interiors, and accretion disks around black holes. Machine learning increasingly helps analyze vast datasets from sky surveys."""
        return sample_text
    
    return path.read_text(encoding='utf-8')


def split_data(text: str, train_ratio: float = 0.9) -> Tuple[str, str]:
    """Split text into train and validation sets"""
    n = len(text)
    train_size = int(n * train_ratio)
    return text[:train_size], text[train_size:]


def get_activation(name: str):
    """Get activation function by name"""
    activations = {
        'gelu': nn.GELU(),
        'relu': nn.ReLU(),
        'silu': nn.SiLU(),
    }
    return activations.get(name, nn.GELU())


def train_step(model: nn.Module, batch: Tuple[torch.Tensor, torch.Tensor], optimizer: torch.optim.Optimizer, device: str) -> float:
    """Single training step"""
    model.train()
    x, y = batch
    x, y = x.to(device), y.to(device)
    
    logits = model(x)
    B, T, C = logits.shape
    loss = nn.functional.cross_entropy(logits.view(B * T, C), y.view(B * T))
    
    optimizer.zero_grad()
    loss.backward()
    optimizer.step()
    
    return loss.item()


def evaluate(model: nn.Module, dataloader: DataLoader, device: str) -> float:
    """Evaluate model on validation set"""
    model.eval()
    total_loss = 0
    count = 0
    
    with torch.no_grad():
        for batch in dataloader:
            x, y = batch
            x, y = x.to(device), y.to(device)
            
            logits = model(x)
            B, T, C = logits.shape
            loss = nn.functional.cross_entropy(logits.view(B * T, C), y.view(B * T))
            
            total_loss += loss.item()
            count += 1
    
    return total_loss / max(count, 1)


def main():
    """Main training function"""
    # Read hyperparameters from stdin
    try:
        input_data = sys.stdin.read()
        config = json.loads(input_data)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {str(e)}"}), file=sys.stderr)
        sys.exit(1)
    
    # Extract hyperparameters with defaults
    learning_rate = config.get('learningRate', 0.001)
    batch_size = config.get('batchSize', 32)
    hidden_dim = config.get('hiddenDim', 128)
    num_layers = config.get('numLayers', 4)
    num_heads = config.get('numHeads', 4)
    activation_name = config.get('activation', 'gelu')
    normalization = config.get('normalization', 'layernorm')
    init_scheme = config.get('initScheme', 'xavier')
    warmup_steps = config.get('warmupSteps', 100)
    weight_decay = config.get('weightDecay', 0.01)
    max_train_seconds = config.get('maxTrainSeconds', 120)
    data_path = config.get('dataPath', './data/astro-sample.txt')
    hardware = config.get('hardware', 'cpu')
    
    # Set device
    device = 'cuda' if hardware == 'gpu' and torch.cuda.is_available() else 'cpu'
    
    # Load and prepare data
    text = load_data(data_path)
    train_text, val_text = split_data(text)
    
    # Create tokenizer
    tokenizer = CharTokenizer(text)
    vocab_size = tokenizer.vocab_size
    
    # Create datasets
    seq_length = 128
    train_dataset = TextDataset(train_text, tokenizer, seq_length)
    val_dataset = TextDataset(val_text, tokenizer, seq_length)

    # Guard: dataset must have enough samples to train
    MIN_SAMPLES = 2
    if len(train_dataset) < MIN_SAMPLES:
        # Corpus too short — fall back to built-in astrophysics sample
        print(json.dumps({
            "warning": f"Corpus too short ({len(text)} chars, need >={seq_length + 1} chars). Using built-in sample data."
        }), flush=True)
        from pathlib import Path as _Path
        try:
            _Path(data_path).unlink(missing_ok=True)  # remove the bad file so next call re-downloads
        except Exception:
            pass
        fallback_text = load_data('/nonexistent')  # triggers the built-in sample
        train_text_fb, val_text_fb = split_data(fallback_text)
        tokenizer = CharTokenizer(fallback_text)
        vocab_size = tokenizer.vocab_size
        train_dataset = TextDataset(train_text_fb, tokenizer, seq_length)
        val_dataset = TextDataset(val_text_fb, tokenizer, seq_length)

    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False)
    
    # Create model
    model = MicroTransformer(
        vocab_size=vocab_size,
        n_embd=hidden_dim,
        num_layers=num_layers,
        num_heads=num_heads,
        dropout=0.1,
        normalization=normalization,
        init_scheme=init_scheme,
    ).to(device)
    
    param_count = model.count_parameters()
    
    # Setup optimizer with weight decay
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=weight_decay)
    
    # Training loop with time limit
    start_time = time.time()
    step = 0
    best_val_loss = float('inf')
    
    try:
        while time.time() - start_time < max_train_seconds:
            for batch in train_loader:
                # Check time limit
                elapsed = time.time() - start_time
                if elapsed >= max_train_seconds:
                    break
                
                # Learning rate warmup
                if step < warmup_steps:
                    lr = learning_rate * (step + 1) / warmup_steps
                    for param_group in optimizer.param_groups:
                        param_group['lr'] = lr
                
                # Training step
                loss = train_step(model, batch, optimizer, device)
                step += 1
                
                # Log progress every 10 steps
                if step % 10 == 0:
                    current_lr = optimizer.param_groups[0]['lr']
                    progress = {
                        "step": step,
                        "loss": round(loss, 4),
                        "lr": round(current_lr, 6),
                    }
                    print(json.dumps(progress), flush=True)
            
            # Validation at end of each epoch
            val_loss = evaluate(model, val_loader, device)
            best_val_loss = min(best_val_loss, val_loss)
            
            # Check early stopping condition
            if time.time() - start_time >= max_train_seconds:
                break
                
    except KeyboardInterrupt:
        pass
    
    # Final evaluation
    final_train_loss = evaluate(model, train_loader, device)
    final_val_loss = evaluate(model, val_loader, device)
    duration_ms = int((time.time() - start_time) * 1000)
    
    # Output final result
    result = {
        "result": {
            "finalLoss": round(final_train_loss, 4),
            "valLoss": round(final_val_loss, 4),
            "steps": step,
            "durationMs": duration_ms,
            "params": param_count,
            "vocabSize": vocab_size,
        }
    }
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
