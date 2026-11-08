# ⑯: list run ids in each runexec test store (read-only) and dump `runexec run view` for each. Args: tmpdir bin outfile
import sqlite3, subprocess, sys, os, json
d, binp, out = sys.argv[1:4]
n = 0
with open(out, 'w') as f:
    for name in sorted(os.listdir(d)):
        if not name.endswith('.sqlite'): continue
        p = os.path.join(d, name)
        try:
            con = sqlite3.connect(f'file:{p}?mode=ro', uri=True)
            ids = [r[0] for r in con.execute('SELECT run_id FROM runs')]
            con.close()
        except Exception as e:
            continue
        for i in ids:
            r = subprocess.run([binp, 'run', 'view', '--db', p, '--run', i], capture_output=True, text=True, timeout=30)
            line = (r.stdout.strip().splitlines() or [''])[-1]
            try: v = json.loads(line)
            except Exception: continue
            f.write(json.dumps({'store': name, 'run_id': i, 'view': v}) + '\n'); n += 1
print(n)
