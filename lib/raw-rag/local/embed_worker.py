#!/usr/bin/env python3
"""Local embedding worker. Protocol v2: metadata first, lazy model load.

No downloads or remote providers. stdout contains NDJSON protocol only.
"""
import argparse
import importlib.metadata
import json
import sys
from pathlib import Path


def bge_vectors(args):
    from fastembed import TextEmbedding
    model = TextEmbedding(model_name="BAAI/bge-small-zh-v1.5", threads=args.threads,
                          cache_dir=args.cache_dir or None, local_files_only=True,
                          specific_model_path=args.bge_dir, providers=["CPUExecutionProvider"])

    def embed(texts, kind):
        values = model.query_embed(texts) if kind == "query" else model.embed(texts)
        return [list(map(float, vector)) for vector in values]
    return embed


def qwen_vectors(args):
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer
    tokenizer = Tokenizer.from_file(args.onnx_tokenizer)
    tokenizer.no_truncation()
    tokenizer.no_padding()
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(args.onnx_model, sess_options=options, providers=["CPUExecutionProvider"])
    input_names = {item.name for item in session.get_inputs()}
    output_names = [item.name for item in session.get_outputs()]

    def encode_one(text):
        ids = tokenizer.encode(text).ids
        if not ids:
            ids = [tokenizer.token_to_id("<|endoftext|>") or 0]
        if len(ids) > args.max_tokens:
            raise RuntimeError("embedding input exceeds configured token limit")
        length = len(ids)
        feeds = {}
        for name in input_names:
            if name == "input_ids":
                feeds[name] = np.asarray([ids], dtype=np.int64)
            elif name == "attention_mask":
                feeds[name] = np.ones((1, length), dtype=np.int64)
            elif name == "position_ids":
                feeds[name] = np.arange(length, dtype=np.int64).reshape(1, length)
            elif name == "token_type_ids":
                feeds[name] = np.zeros((1, length), dtype=np.int64)
            elif "past_key_values" in name:
                feeds[name] = np.zeros((1, 8, 0, 128), dtype=np.float32)
            else:
                raise RuntimeError("unsupported ONNX input: " + name)
        hidden = session.run(output_names, feeds)[0]
        if hidden.ndim == 3:
            vector = np.asarray(hidden[0, length - 1, :], dtype=np.float32)
        elif hidden.ndim == 2 and hidden.shape[0] == 1:
            vector = np.asarray(hidden[0], dtype=np.float32)
        else:
            raise RuntimeError("unsupported ONNX embedding output shape")
        if vector.shape != (1024,) or not np.isfinite(vector).all():
            raise RuntimeError("invalid Qwen 0.6B embedding dimensions or values")
        norm = float(np.linalg.norm(vector))
        if norm == 0.0:
            raise RuntimeError("zero embedding")
        return (vector / norm).tolist()

    def embed(texts, kind):
        # The host formats query/document inputs once for every transport.
        return [encode_one(text) for text in texts]
    return embed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["fastembed", "onnx"], required=True)
    parser.add_argument("--cache-dir", default="")
    parser.add_argument("--bge-dir", default="")
    parser.add_argument("--onnx-model", default="")
    parser.add_argument("--onnx-tokenizer", default="")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--max-tokens", type=int, default=2048)
    args = parser.parse_args()
    try:
        packages = ["onnxruntime", "numpy", "tokenizers"]
        if args.engine == "fastembed":
            packages.append("fastembed")
        versions = {package: importlib.metadata.version(package) for package in packages}
        print(json.dumps({"event": "ready", "protocol": 2,
                          "runtime": {"python": sys.version.split()[0], "packages": versions}}), flush=True)
    except Exception:
        print(json.dumps({"event": "fatal", "error": "required embedding dependencies are unavailable"}), flush=True)
        return
    embed = None
    counter = None
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                request = {}
                raise RuntimeError("invalid embedding request")
            texts, kind = request.get("texts"), request.get("kind")
            if kind not in ("query", "document") or not isinstance(texts, list) or not all(isinstance(text, str) for text in texts):
                raise RuntimeError("invalid embedding request")
            if counter is None:
                from tokenizers import Tokenizer
                tokenizer_file = str(Path(args.bge_dir) / "tokenizer.json") if args.engine == "fastembed" else args.onnx_tokenizer
                counter = Tokenizer.from_file(tokenizer_file)
                counter.no_truncation()
                counter.no_padding()
            counts = [len(counter.encode(text).ids) for text in texts]
            if request.get("operation") == "tokenize":
                print(json.dumps({"id": request.get("id"), "counts": counts}), flush=True)
                continue
            if request.get("operation", "embed") != "embed":
                raise RuntimeError("invalid embedding operation")
            if any(count > args.max_tokens for count in counts):
                raise RuntimeError("embedding input exceeds configured token limit")
            if embed is None:
                embed = bge_vectors(args) if args.engine == "fastembed" else qwen_vectors(args)
            vectors = embed(texts, kind)
            print(json.dumps({"id": request.get("id"), "vectors": vectors}, allow_nan=False), flush=True)
        except Exception as error:
            print(json.dumps({"id": request.get("id"), "error": type(error).__name__ + ": embedding failed"}), flush=True)


if __name__ == "__main__":
    main()
