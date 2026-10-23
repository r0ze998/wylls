# Sound for ① (9 s), synthesised here, no samples. Follows the picture:
# 0–2.5 s  in the clash: spear-on-shield knocks and iron ticks, a crowd roar, low drum hits on the pushes
# 2.5–6.5 s the crane: the clash recedes and darkens, a wind swell rises with the camera, a low pad enters
# 6.5–9 s  the valley: a distant horn from the keep, open wind, the pad resolving; a short tail
# Usage: python3 sound_v01.py out.wav
import numpy as np, wave, sys
SR = 48000; DUR = 9.0; N = int(SR * DUR)
rng = np.random.default_rng(5)
t = np.arange(N) / SR
out = np.zeros((N, 2))

def onepole(x, a):
    """One-pole low-pass, vectorised through a short IIR by blocks (fast enough for a few seconds of audio)."""
    y = np.empty_like(x); acc = 0.0
    for i in range(0, len(x), 4096):
        blk = x[i:i + 4096]; out_b = np.empty_like(blk)
        for j, v in enumerate(blk): acc += a * (v - acc); out_b[j] = acc
        y[i:i + 4096] = out_b
    return y
def env(n, atk, dec):
    tt = np.arange(n) / SR
    return np.minimum(1, tt / max(atk, 1e-4)) * np.exp(-tt * dec)
def put(sig, at, pan=0.5, gain=1.0):
    i0 = int(at * SR); n = min(len(sig), N - i0)
    if n <= 0 or i0 < 0: return
    out[i0:i0 + n, 0] += sig[:n] * np.sqrt(1 - pan) * gain; out[i0:i0 + n, 1] += sig[:n] * np.sqrt(pan) * gain
def knock(p=1.0):        # wood and leather: a spear shaft on a shield
    n = int(0.16 * SR); tt = np.arange(n) / SR
    body = np.sin(2 * np.pi * 120 * p * tt) * env(n, 0.001, 38) + np.sin(2 * np.pi * 310 * p * tt) * env(n, 0.001, 70) * 0.5
    return (body + onepole(rng.normal(0, 1, n), 0.35) * env(n, 0.0005, 140) * 0.8) * 0.6
def tick(p=1.0):         # iron on iron: the spearheads
    n = int(0.12 * SR); tt = np.arange(n) / SR
    return sum(np.sin(2 * np.pi * f * p * tt + rng.uniform(0, 6)) for f in (1870, 2930, 4410, 6020)) / 4 * env(n, 0.0005, 45) * 0.3
def drum(p=1.0):         # a low thud for the shove of the line
    n = int(0.5 * SR); tt = np.arange(n) / SR
    f = 55 * p * (1 + 0.6 * np.exp(-tt * 30))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.002, 7) * 0.9

near = lambda x: float(np.interp(x, [0, 2.3, 4.5, 6.5, 9], [1.0, 1.0, 0.32, 0.12, 0.08]))
# the clash: many small hits, denser near the camera
for k in range(int(DUR * 9)):
    at = rng.uniform(0, DUR); g = near(at)
    put(knock(rng.uniform(0.8, 1.25)), at, rng.uniform(0.2, 0.8), 0.55 * g)
    if rng.random() < 0.55: put(tick(rng.uniform(0.9, 1.12)), at + rng.uniform(0, 0.03), rng.uniform(0.2, 0.8), 0.6 * g)
for k in range(int(DUR / 1.1)):           # the line shoves together roughly every 1.1 s (the thrust cycle)
    at = 0.25 + k * 1.1 + rng.uniform(-0.05, 0.05)
    put(drum(rng.uniform(0.95, 1.05)), at, 0.5, 0.8 * near(at))
# crowd roar: band-limited noise with a slow swell, formant-ish by mixing two filtered layers
roar = onepole(rng.normal(0, 1, N), 0.08) - onepole(rng.normal(0, 1, N), 0.012)
roar *= 1 + 0.35 * np.sin(2 * np.pi * 0.7 * t) * np.sin(2 * np.pi * 0.23 * t + 1)
cg = np.interp(t, [0, 0.4, 2.3, 5.0, 9], [0.0, 0.5, 0.55, 0.12, 0.05])
out += (roar * cg * 1.6)[:, None] * np.array([0.95, 1.0])
# wind swell with the crane, then the open valley wind (stereo decorrelated)
for ch in (0, 1):
    w = onepole(rng.normal(0, 1, N), 0.006) * 6
    gust = 1 + 0.4 * np.sin(2 * np.pi * 0.15 * t + ch * 1.7)
    out[:, ch] += w * gust * np.interp(t, [0, 2.4, 5.2, 6.8, 9], [0.03, 0.05, 0.22, 0.13, 0.11])
# a low pad: D and A, an F entering at the reveal (strings-like: detuned saws, low-passed)
def saw(f, ph=0.0): return 2 * ((t * f + ph) % 1.0) - 1
pad = np.zeros(N)
for f, a0, a1 in ((73.42, 2.4, 9), (110.0, 3.2, 9), (174.61, 6.4, 9), (146.83, 6.6, 9)):
    v = sum(saw(f * d, rng.random()) for d in (0.997, 1.0, 1.004)) / 3
    pad += v * np.clip((t - a0) / 1.6, 0, 1) * np.clip((a1 - t) / 0.6, 0, 1)
pad = onepole(onepole(pad, 0.03), 0.03)
out += (pad * 0.2)[:, None]
# the horn from the keep at 6.6 s: a brass-like tone with a slight scoop and vibrato, far away (low-passed, reverb-ish)
n = int(2.2 * SR); tt = np.arange(n) / SR
fh = 146.83 * (1 - 0.03 * np.exp(-tt * 8)) * (1 + 0.006 * np.sin(2 * np.pi * 5.2 * tt))
ph = np.cumsum(fh) / SR
horn = sum(np.sin(2 * np.pi * k * ph) / k ** 1.1 for k in range(1, 9)) * np.minimum(1, tt / 0.25) * np.clip((2.2 - tt) / 0.9, 0, 1)
horn = onepole(horn, 0.08)
echo = np.zeros(n + int(0.35 * SR)); echo[:n] += horn; echo[int(0.35 * SR):] += horn * 0.35
put(echo, 6.6, 0.62, 0.4)
# master: gentle fades, soft clip, normalise
out *= (np.clip(t / 0.12, 0, 1) * np.clip((DUR - t) / 0.5, 0, 1))[:, None]
out = np.tanh(out / max(1e-6, np.abs(out).max()) * 1.4) / np.tanh(1.4) * 0.89
with wave.open(sys.argv[1], 'wb') as f:
    f.setnchannels(2); f.setsampwidth(2); f.setframerate(SR); f.writeframes((out * 32767).astype(np.int16).tobytes())
print('ok', sys.argv[1])
