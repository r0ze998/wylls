Fixtures for the "world creation postponed / no world yet" tests in ../../health.test.mjs.
Shapes copied from the operator's Mac on 2026-11-24 after the owner postponed the world creation
(driver stopped 12:08 JST); paths shortened, no key, token or secret in them.

- `season-driver-log.txt`     devnet-season-driver.log (named .txt: *.log is git-ignored) as it stood: started, then stopped by hand, CreateSeason never run
- `devnet-create-postponed`   the marker file (its first line is shown as the reason)
- `ps-driver-stopped.txt`     `ps -axo pid=,etime=,command=`: driver gone; gateway starter and join check still waiting
- `ps-waiters-stopped.txt`    the same with the gateway starter and the join check stopped too
- `ps-driver-running.txt`     the driver still (or again) running
