# ⑯: one mutation per output directory copy of ④'s chain-flow outputs. Reads JSON only; writes the copies.
import json, sys, shutil, os
src, dst = sys.argv[1], sys.argv[2]
OTHER_TAG = 1973050754706772818
def load(d, f): return json.load(open(os.path.join(d, f)))
def save(d, f, j): json.dump(j, open(os.path.join(d, f), 'w'), indent=1)
muts = {
  'M1-a-tag+1':        ('a-join.json',    lambda j: j.__setitem__('citizen_tag', OTHER_TAG)),
  'M2-b-other-citizen':('b-caravan.json', lambda j: j.__setitem__('citizen_tag', OTHER_TAG)),
  'M3-c-fact-tag':     ('c-memory.json',  lambda j: j['facts'][0]['data'].__setitem__('tag', '1b61af352e1d1352')),
  'M4-d-ship-tag':     ('d-outcome.json', lambda j: j['proposed_mapping']['events'][0].__setitem__('ship', j['proposed_mapping']['events'][0]['ship'].replace('1973050754706772817', str(OTHER_TAG)))),
  'M5-e-other-citizen':('e-prize-run.json', lambda j: j.__setitem__('nft_citizen', '6TUvpsqCubL6tRZoVuVW1sB9xUJgc8ypQDnU52uDhbgj')),
  'M6-a-no-transfer':  ('a-join.json',    lambda j: j.__setitem__('generation', 0)),
  'M7-e-claim-paid':   ('e-prize-run.json', lambda j: j.__setitem__('claim_A_with_pass_citizen', 'Ok')),
}
for name, (f, fn) in muts.items():
    d = os.path.join(dst, name)
    shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(src, d, ignore=shutil.ignore_patterns('*.sqlite*'))
    j = load(d, f); fn(j); save(d, f, j)
    print(name, f)
