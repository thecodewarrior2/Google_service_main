#!/usr/bin/env python3
"""phish-tiny for the native engine: model.bin + model.json (what training produces) -> model.onnx.

The service runs the model with ONNX Runtime (src/engine/model.js). This writes the same network as an
ONNX graph: the weights stay 8-bit with one scale per row, turned back into floats by ONNX's own
DequantizeLinear exactly as before (q x scale, rounded once to float32), so the file stays about the size
of model.bin. Inputs: input_ids (int64, batch x tokens) and attention_mask (float32, 1 for a token, 0 for
padding), so several texts can run as one batch. Output: logits (batch x 2: genuine, phishing).

Run it once per new model, then the tests (test/engine.test.js holds the native engine to the answers
of a reference set):

    pip install onnx numpy
    python3 tools/export-onnx.py vendor/spruce/models/phish-tiny --reference test/fixtures/model-reference.json

It reads model.json and model.bin there and writes model.onnx next to them. With --reference FILE, it
also computes the new model's answers for FILE's made-up inputs (their token ids) on its own, in numpy
and double precision, straight from model.bin (not with ONNX), and writes them into FILE: the tests then
check that ONNX Runtime gives the same answers. --check FILE only compares (nothing written): the
largest difference from FILE's answers.
"""
import json
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

OPSET = 17   # LayerNormalization


def load(folder):
    manifest = json.load(open(os.path.join(folder, 'model.json')))
    buf = open(os.path.join(folder, 'model.bin'), 'rb').read()
    tensors = {}
    for t in manifest['tensors']:
        n = int(np.prod(t['shape']))
        if t['dtype'] == 'f32':
            tensors[t['name']] = ('f32', np.frombuffer(buf, np.float32, n, t['offset']).reshape(t['shape']).copy(), None)
        elif t['dtype'] == 'i8':
            q = np.frombuffer(buf, np.int8, n, t['offset']).reshape(t['shape']).copy()
            s = np.frombuffer(buf, np.float32, t['shape'][0], t['scales']).copy()
            tensors[t['name']] = ('i8', q, s)
        else:
            raise SystemExit(f"unknown tensor type {t['dtype']}")
    return manifest, tensors


class Graph:
    def __init__(self):
        self.nodes, self.inits, self.n = [], [], 0

    def name(self, base):
        self.n += 1
        return f'{base}_{self.n}'

    def const(self, value, base='c', dtype=np.float32):
        nm = self.name(base)
        self.inits.append(numpy_helper.from_array(np.asarray(value, dtype=dtype), nm))
        return nm

    def op(self, kind, inputs, base=None, **attrs):
        out = self.name(base or kind.lower())
        self.nodes.append(helper.make_node(kind, inputs, [out], **attrs))
        return out

    # A weight as the network uses it: float32, from 8-bit rows and their scales where it was stored so.
    # transpose: a PyTorch linear weight [out, in] becomes [in, out] for MatMul (its scales then go along
    # axis 1, one per column).
    def weight(self, tensors, key, transpose=False):
        kind, value, scales = tensors[key]
        if kind == 'f32':
            return self.const(value.T if transpose else value, key.replace('.', '_'))
        q = value.T.copy() if transpose else value
        qn = self.name(key.replace('.', '_') + '_q')
        self.inits.append(numpy_helper.from_array(q, qn))
        sn = self.const(scales, key.replace('.', '_') + '_scale')
        zn = self.const(np.zeros(scales.shape, np.int8), key.replace('.', '_') + '_zero', np.int8)
        return self.op('DequantizeLinear', [qn, sn, zn], key.replace('.', '_'), axis=1 if transpose else 0)


def build(manifest, tensors):
    c = manifest['config']
    H, heads, layers, eps = c['hidden'], c['heads'], c['layers'], float(c['eps'])
    dh = H // heads
    g = Graph()
    P = 'bert.'
    # Embeddings: word + position + token type 0, then LayerNorm.
    we = g.weight(tensors, P + 'embeddings.word_embeddings.weight')
    pe = g.weight(tensors, P + 'embeddings.position_embeddings.weight')
    te = g.weight(tensors, P + 'embeddings.token_type_embeddings.weight')
    words = g.op('Gather', [we, 'input_ids'], 'words', axis=0)                       # B x T x H
    shape = g.op('Shape', ['input_ids'], 'shape')
    T = g.op('Gather', [shape, g.const(1, 'one', np.int64)], 'T', axis=0)
    positions = g.op('Range', [g.const(0, 'zero', np.int64), T, g.const(1, 'step', np.int64)], 'positions')
    pos = g.op('Gather', [pe, positions], 'pos', axis=0)                              # T x H
    tt = g.op('Gather', [te, g.const(0, 'type0', np.int64)], 'tt', axis=0)            # H
    x = g.op('Add', [g.op('Add', [words, pos]), tt], 'emb')
    x = g.op('LayerNormalization', [x, g.weight(tensors, P + 'embeddings.LayerNorm.weight'), g.weight(tensors, P + 'embeddings.LayerNorm.bias')], 'emb_ln', axis=-1, epsilon=eps)
    # Padding is never attended to: (1 - mask) x -1e9 on its scores (B x 1 x 1 x T).
    masked = g.op('Mul', [g.op('Sub', [g.const(1.0, 'one_f'), 'attention_mask']), g.const(-1e9, 'neg')], 'masked')
    masked = g.op('Unsqueeze', [masked, g.const([1, 2], 'axes', np.int64)], 'mask4')
    split = g.const([0, 0, heads, dh], 'split', np.int64)
    merge = g.const([0, 0, H], 'merge', np.int64)
    scale = g.const(1.0 / np.sqrt(dh), 'scale')

    def linear(inp, key):
        return g.op('Add', [g.op('MatMul', [inp, g.weight(tensors, key + '.weight', transpose=True)]), g.weight(tensors, key + '.bias')])

    for layer in range(layers):
        L = f'{P}encoder.layer.{layer}.'
        q = g.op('Transpose', [g.op('Reshape', [linear(x, L + 'attention.self.query'), split])], perm=[0, 2, 1, 3])   # B h T d
        k = g.op('Transpose', [g.op('Reshape', [linear(x, L + 'attention.self.key'), split])], perm=[0, 2, 3, 1])     # B h d T
        v = g.op('Transpose', [g.op('Reshape', [linear(x, L + 'attention.self.value'), split])], perm=[0, 2, 1, 3])   # B h T d
        scores = g.op('Add', [g.op('Mul', [g.op('MatMul', [q, k]), scale]), masked])
        probs = g.op('Softmax', [scores], axis=-1)
        ctx = g.op('Reshape', [g.op('Transpose', [g.op('MatMul', [probs, v])], perm=[0, 2, 1, 3]), merge])
        att = g.op('Add', [linear(ctx, L + 'attention.output.dense'), x])
        att = g.op('LayerNormalization', [att, g.weight(tensors, L + 'attention.output.LayerNorm.weight'), g.weight(tensors, L + 'attention.output.LayerNorm.bias')], axis=-1, epsilon=eps)
        mid = linear(att, L + 'intermediate.dense')
        # GELU with the exact erf: x/2 (1 + erf(x/sqrt 2)).
        mid = g.op('Mul', [g.op('Mul', [mid, g.op('Add', [g.op('Erf', [g.op('Div', [mid, g.const(np.sqrt(2.0), 'sqrt2')])]), g.const(1.0, 'one_g')])]), g.const(0.5, 'half')])
        out = g.op('Add', [linear(mid, L + 'output.dense'), att])
        x = g.op('LayerNormalization', [out, g.weight(tensors, L + 'output.LayerNorm.weight'), g.weight(tensors, L + 'output.LayerNorm.bias')], axis=-1, epsilon=eps)
    first = g.op('Gather', [x, g.const(0, 'cls', np.int64)], 'cls_token', axis=1)    # B x H
    pooled = g.op('Tanh', [linear(first, P + 'pooler.dense')], 'pooled')
    logits = linear(pooled, 'classifier')
    g.nodes.append(helper.make_node('Identity', [logits], ['logits']))
    graph = helper.make_graph(g.nodes, manifest.get('name', 'phish-tiny'),
                              [helper.make_tensor_value_info('input_ids', TensorProto.INT64, ['batch', 'tokens']),
                               helper.make_tensor_value_info('attention_mask', TensorProto.FLOAT, ['batch', 'tokens'])],
                              [helper.make_tensor_value_info('logits', TensorProto.FLOAT, ['batch', 2])], g.inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', OPSET)], producer_name='spruce-mail-protection tools/export-onnx.py')
    model.ir_version = 8
    meta = model.metadata_props.add(); meta.key = 'version'; meta.value = str(manifest.get('version', ''))
    onnx.checker.check_model(model)
    return model


# The same network in numpy, double precision, from the same weights (8-bit rows times their scale,
# rounded once to float32, as DequantizeLinear does): an answer that doesn't come from ONNX, for the tests.
def erf(x):
    # From the complementary error function (Numerical Recipes' erfc; relative error below 1.2e-7), for
    # whole arrays at once.
    z = np.abs(x)
    t = 1.0 / (1.0 + 0.5 * z)
    r = t * np.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))))
    return np.where(x >= 0, 1.0 - r, r - 1.0)


def dense(tensors, key):
    kind, value, scales = tensors[key]
    if kind == 'f32':
        return value.astype(np.float64)
    w = (value.astype(np.float32) * scales.reshape((-1,) + (1,) * (value.ndim - 1))).astype(np.float32)
    return w.astype(np.float64)


def margin_numpy(manifest, tensors, ids):
    c = manifest['config']
    H, heads, layers, eps = c['hidden'], c['heads'], c['layers'], float(c['eps'])
    dh = H // heads
    P = 'bert.'
    W = lambda k: dense(tensors, k)
    def ln(x, k):
        m = x.mean(-1, keepdims=True); v = ((x - m) ** 2).mean(-1, keepdims=True)
        return (x - m) / np.sqrt(v + eps) * W(k + '.weight') + W(k + '.bias')
    lin = lambda x, k: x @ W(k + '.weight').T + W(k + '.bias')
    T = len(ids)
    x = W(P + 'embeddings.word_embeddings.weight')[ids] + W(P + 'embeddings.position_embeddings.weight')[:T] + W(P + 'embeddings.token_type_embeddings.weight')[0]
    x = ln(x, P + 'embeddings.LayerNorm')
    for layer in range(layers):
        L = f'{P}encoder.layer.{layer}.'
        split = lambda y: y.reshape(T, heads, dh).transpose(1, 0, 2)
        q, k, v = (split(lin(x, L + 'attention.self.' + n)) for n in ('query', 'key', 'value'))
        s = q @ k.transpose(0, 2, 1) / np.sqrt(dh)
        s = np.exp(s - s.max(-1, keepdims=True)); s /= s.sum(-1, keepdims=True)
        ctx = (s @ v).transpose(1, 0, 2).reshape(T, H)
        att = ln(lin(ctx, L + 'attention.output.dense') + x, L + 'attention.output.LayerNorm')
        mid = lin(att, L + 'intermediate.dense')
        mid = mid * 0.5 * (1.0 + erf(mid / np.sqrt(2.0)))
        x = ln(lin(mid, L + 'output.dense') + att, L + 'output.LayerNorm')
    pooled = np.tanh(lin(x[0], P + 'pooler.dense'))
    logits = lin(pooled, 'classifier')
    return float(logits[1] - logits[0])


def main():
    args = sys.argv[1:]
    opt = lambda name: args[args.index(name) + 1] if name in args else None
    ref_out, ref_check = opt('--reference'), opt('--check')
    rest = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or args[i - 1] not in ('--reference', '--check'))]
    folder = rest[0] if rest else 'vendor/spruce/models/phish-tiny'
    manifest, tensors = load(folder)
    if ref_check:
        ref = json.load(open(ref_check))
        worst = max(abs(margin_numpy(manifest, tensors, c['ids']) - c['margin']) for c in ref['cases'])
        print(f"{ref_check}: {len(ref['cases'])} cases, largest difference {worst:.2e} (model {ref.get('model')}; this one {manifest.get('version')})")
        return
    model = build(manifest, tensors)
    out = os.path.join(folder, 'model.onnx')
    onnx.save(model, out)
    print(f"{out}: {manifest.get('name')} {manifest.get('version')}, {os.path.getsize(out) / 1e6:.1f} MB")
    if ref_out:
        ref = json.load(open(ref_out))
        for c in ref['cases']:
            c['margin'] = margin_numpy(manifest, tensors, c['ids'])
        ref['model'] = str(manifest.get('version', ''))
        ref['note'] = (f"Made-up inputs (maple-schools.example), their token ids, and the margins (phishing logit minus genuine logit) of "
                       f"phish-tiny {ref['model']} as tools/export-onnx.py computed them from model.bin (numpy, double precision). The native "
                       f"engine must match them to rounding. For a new model: python3 tools/export-onnx.py <model folder> --reference {ref_out}.")
        with open(ref_out, 'w') as f:
            f.write(json.dumps(ref, separators=(',', ':')) + '\n')
        print(f"{ref_out}: the answers of {len(ref['cases'])} made-up inputs, for model {ref['model']}")


if __name__ == '__main__':
    main()
