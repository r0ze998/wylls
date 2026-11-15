#!/usr/bin/env python3 -I
"""play2-land ops v2 (2026-11-16): the outer guard and watchdog, fail-closed. Started only by play2-start.sh BEFORE it
execs the launcher (the launcher keeps the starter's pid and start time across exec), so no world Start is possible
unless both are armed. Nothing here starts a launcher or a world.

  guard    — every --interval s: free disk (checked whether or not a world exists) and the TOTAL size of everything under
             --data (all worlds) plus every --count file (launcher log, these logs). Free < floor or total >= limit →
             SIGINT the target. Also SIGINT when the watchdog (its peer) is gone.
  watchdog — at --deadline SIGINT the target; at deadline + 300 s SIGTERM the target and the guard if still there.
             Also SIGINT when the guard (its peer) is gone.

Limits can only be tightened, never relaxed: floor = max(21 GiB, --free-floor-bytes); limit = min(110 MiB,
--limit-bytes); deadline = min(--deadline, t0 + 8700) so that everything ends by t0 + 150 min.

Every signal is sent only after re-checking, right before it, that the pid is still the same process: same start time
(ps lstart) as recorded at arming, and a command line that is exactly the play2 launcher (`local-play-launcher.mjs`
with `--root <root>` and `--data <data>`) or the play2 starter before its exec. A peer is checked the same way
(pid + start time + its own role on the command line). Nothing else is ever signalled; nothing is deleted.
"""
import argparse, json, os, shutil, signal, subprocess, sys, time

GIB, MIB = 1024 ** 3, 1024 ** 2
FLOOR_MIN = 21 * GIB
LIMIT_MAX = 110 * MIB
WINDOW = 150 * 60          # everything ends by t0 + WINDOW
SIGINT_AT = WINDOW - 300   # the watchdog's SIGINT, 5 min before the window ends
GRACE = 300


def proc(pid):
    """(lstart, command) of a live pid, or None."""
    r = subprocess.run(['ps', '-o', 'lstart=', '-o', 'command=', '-p', str(pid)], capture_output=True, text=True)
    line = r.stdout.strip()
    if r.returncode != 0 or not line:
        return None
    # lstart is a fixed 24-char field: "Mon Nov 16 08:09:18 2026"
    return ' '.join(line[:24].split()), line[24:].strip()


def lstart_of(pid):
    p = proc(pid)
    return p[0] if p else None


def is_target(pid, lstart, root, data):
    p = proc(pid)
    if not p or p[0] != ' '.join(lstart.split()):
        return False
    tok = p[1].split()
    if any(t.endswith('/play2-start.sh') or t == 'play2-start.sh' or t == './play2-start.sh' for t in tok):
        return True  # the starter itself, before its exec
    def after(flag):
        return [tok[i + 1] for i, t in enumerate(tok[:-1]) if t == flag]
    return any(t.endswith('local-play-launcher.mjs') for t in tok) and after('--root') == [root] and after('--data') == [data]


def is_peer(pid, lstart, role):
    p = proc(pid)
    if not p or p[0] != ' '.join(lstart.split()):
        return False
    tok = p[1].split()
    return any(t.endswith('play2_ops.py') for t in tok) and role in tok


def total_bytes(data, counted):
    n = 0
    if os.path.isdir(data):
        for dp, _, fs in os.walk(data):
            for f in fs:
                try:
                    n += os.lstat(os.path.join(dp, f)).st_size
                except FileNotFoundError:
                    pass
    for f in counted:
        try:
            n += os.lstat(f).st_size
        except FileNotFoundError:
            pass
    return n


def free_bytes(data):
    d = data
    while not os.path.isdir(d):
        d = os.path.dirname(d) or '/'
    return shutil.disk_usage(d).free


class Run:
    def __init__(self, a):
        self.a = a
        self.floor = max(FLOOR_MIN, a.free_floor_bytes or 0)
        self.limit = min(LIMIT_MAX, a.limit_bytes or LIMIT_MAX)
        self.end = a.t0 + WINDOW
        self.log = open(a.log, 'a')

    def say(self, **row):
        row = {'t': time.strftime('%H:%M:%S'), 'role': self.a.role, **row}
        self.log.write(json.dumps(row) + '\n')
        self.log.flush()

    def signal_target(self, sig, why):
        a = self.a
        if is_target(a.target_pid, a.target_start, a.root, a.data):
            try:
                os.kill(a.target_pid, sig)
                self.say(signal=int(sig), pid=a.target_pid, why=why)
                return True
            except ProcessLookupError:
                pass
        self.say(not_signalled=a.target_pid, why=why, reason='identity changed or gone')
        return False

    def peer_ok(self):
        f = os.path.join(self.a.state, ('watchdog' if self.a.role == 'guard' else 'guard') + '.armed')
        try:
            p = json.load(open(f))
        except (FileNotFoundError, ValueError):
            return False
        return is_peer(p['pid'], p['lstart'], p['role'])

    def arm(self):
        a = self.a
        if not is_target(a.target_pid, a.target_start, a.root, a.data):
            self.say(refused='target is not the play2 starter/launcher with this pid, start time, root and data')
            sys.exit(5)
        me = {'role': a.role, 'pid': os.getpid(), 'lstart': lstart_of(os.getpid()), 'floor': self.floor,
              'limit': self.limit, 'end': self.end}
        if a.role == 'watchdog':
            me['deadline'] = min(a.deadline, a.t0 + SIGINT_AT)
        tmp = os.path.join(a.state, a.role + '.armed.tmp')
        json.dump(me, open(tmp, 'w'))
        os.replace(tmp, os.path.join(a.state, a.role + '.armed'))
        self.say(armed=me)
        return me


def guard(run):
    a = run.a
    run.arm()
    peer_seen_at = time.time()
    stopped = False
    while time.time() < run.end:
        if not proc(a.target_pid):
            run.say(exit='target gone')
            return
        free, total = free_bytes(a.data), total_bytes(a.data, a.count)
        run.say(free=free, total=total)
        why = 'total output >= limit' if total >= run.limit else 'free < floor' if free < run.floor else None
        if not run.peer_ok():
            # the peer gets a few seconds to arm at the start; after that its absence stops the run
            if time.time() - peer_seen_at > a.peer_grace:
                why = why or 'watchdog gone'
        else:
            peer_seen_at = time.time()
        if why and not stopped:
            stopped = run.signal_target(signal.SIGINT, why) or True
        time.sleep(a.interval)
    run.say(exit='window over')


def watchdog(run):
    a = run.a
    me = run.arm()
    deadline = me['deadline']
    peer_seen_at = time.time()
    while time.time() < deadline:
        if not proc(a.target_pid):
            run.say(exit='target gone')
            return
        if not run.peer_ok():
            if time.time() - peer_seen_at > a.peer_grace:
                run.signal_target(signal.SIGINT, 'guard gone')
                break
        else:
            peer_seen_at = time.time()
        time.sleep(a.interval)
    else:
        run.signal_target(signal.SIGINT, 'deadline')
    final = min(deadline + GRACE, run.end)
    while time.time() < final and proc(a.target_pid):
        time.sleep(a.interval)
    if proc(a.target_pid):
        run.signal_target(signal.SIGTERM, 'final')
    try:
        g = json.load(open(os.path.join(a.state, 'guard.armed')))
        if is_peer(g['pid'], g['lstart'], 'guard'):
            os.kill(g['pid'], signal.SIGTERM)
            run.say(signal=int(signal.SIGTERM), pid=g['pid'], why='final: guard')
    except (FileNotFoundError, ValueError, ProcessLookupError):
        pass
    run.say(exit='done')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('role', choices=['guard', 'watchdog'])
    p.add_argument('--state', required=True)
    p.add_argument('--log', required=True)
    p.add_argument('--target-pid', type=int, required=True)
    p.add_argument('--target-start', required=True)
    p.add_argument('--root', required=True)
    p.add_argument('--data', required=True)
    p.add_argument('--t0', type=int, required=True)
    p.add_argument('--deadline', type=int, default=0)
    p.add_argument('--count', action='append', default=[])
    p.add_argument('--interval', type=float, default=15.0)
    p.add_argument('--peer-grace', type=float, default=30.0)
    p.add_argument('--free-floor-bytes', type=int, default=0)
    p.add_argument('--limit-bytes', type=int, default=0)
    a = p.parse_args()
    a.interval = min(max(a.interval, 0.2), 15.0)
    if a.role == 'watchdog' and a.deadline <= 0:
        p.error('watchdog needs --deadline')
    signal.signal(signal.SIGHUP, signal.SIG_IGN)  # outlive a closed terminal, so the launcher is still supervised
    run = Run(a)
    (guard if a.role == 'guard' else watchdog)(run)


if __name__ == '__main__':
    main()
