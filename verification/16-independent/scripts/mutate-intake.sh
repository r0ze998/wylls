#!/bin/sh
# ⑯: code mutations of ④'s run intake (cf517b55) in the isolated worktree; each is reverted after its run.
S=/tmp/claude-0/-home-user-wylls/47a54b0f-427a-5cca-bc82-feb7c5056956/scratchpad
W=$S/v23/workstreams/04-execution; L=$S/logs-v23; mkdir -p $L; cd $W
run(){ name=$1; file=$2; from=$3; to=$4
  grep -qF -- "$from" $file || { echo "$name: pattern not found" >> $L/intake-mutations.log; return; }
  python3 -I -c 'import sys; p,a,b=sys.argv[1:4]; s=open(p).read(); assert s.count(a)==1, s.count(a); open(p,"w").write(s.replace(a,b))' $file "$from" "$to"
  cargo test --offline --no-fail-fast --test v16_intake_regressions --test intake > $L/mut-$name.log 2>&1
  echo "$name exit=$? $(grep -E '^test result' $L/mut-$name.log | tr '\n' ' ') FAILED: $(grep -E '^test .* FAILED$' $L/mut-$name.log | sed 's/^test //; s/ ... FAILED//' | tr '\n' ' ')" >> $L/intake-mutations.log
  git checkout -q -- $file; }
: > $L/intake-mutations.log
run I1-generation-from-pass src/intake.rs '.authority(&req.actor, req.generation, pass.now, true)' '.authority(&req.actor, h.generation, pass.now, true)'
run I2-no-citizen-tag-check src/intake.rs 'if permutation_rules::frontier::addr::citizen_tag(&req.citizen) != spec.owner {' 'if false {'
run I3-no-program-owner-check src/intake.rs 'if pass.link.owner != pass.program || pass.policy.owner != pass.program {' 'if false {'
run I4-accept-as-unchecked src/executor.rs 'crate::intake::accept_checked(&self.store, spec, req, passes, now)' '{ let _ = (req, passes); self.store.accept(spec, now) }'
git status --short >> $L/intake-mutations.log
