# A/B pilot reader: ai-pilot-A1

Local test chain only. Read from the run's public files, the herald's immutable province files and (operator side, labelled) the mind's private records. The seat's ballot is scripted (origin 2).

Nation 0 council files: 4; with options: 4; with an AI motion: 4; adopted: 1; opened: 4. Seat ballots: [{"period":2,"option":1,"ok":true,"bell":52}]; periods the seat could not vote in (NotEligible): [].

## Period 2 (C0 48, strike bell 60): option 1 at (1,1)

- options: [{"option":1,"kind":"camp","p":1,"q":1,"ratio":"favourable"},{"option":2,"kind":"camp","p":1,"q":2,"ratio":"favourable"},{"option":3,"kind":"camp","p":2,"q":-1,"ratio":"favourable"}]; options_hash 1a830cba8e224194fad2c0ecaeece2811e86818a292bd3311faf43c5a8b8802f; AI motions [{"name":"Sael Aridge","option":1}]; ballots by origin {"ai":2,"human":0,"scripted":1}; pivot condition (>= 1 AI ballot for the winning option): true
- invited hosts: 4; ready at C0 + 6: **4**; ready at some bell of the window: 4; invited hosts that departed in the window for the strike bell: **0**; nation 0 departures arriving at S (any host): 0; nation 0 hosts revealed at the target at S: 0
  - host 354047039111168 (ai): b53 ready, b54 ready, b55 ready, b56 ready, b57 ready, b58 ready, b59 ready
  - host 363942643761152 (ai): b53 ready, b54 ready, b55 ready, b56 ready, b57 ready, b58 ready, b59 ready
  - host 354047039111169 (ai): b53 ready, b54 ready, b55 ready, b56 ready, b57 ready, b58 ready, b59 ready
  - host 363942643761154 (ai): b53 ready, b54 ready, b55 ready, b56 ready, b57 ready, b58 ready, b59 ready
- council file result: {"present":0,"bounced":0,"clash":null,"present_hosts":[]}
- nation-0 AI records in the follow window (operator side):
  - bell 54 AI 2811df1c autopilot/autopilot: Strike Order candidate offered no (request body not stored); chosen false; ids c1
  - bell 54 AI a02ad0c4 autopilot/autopilot: Strike Order candidate offered no (request body not stored); chosen false; ids c1
  - bell 55 AI 2811df1c session/model: Strike Order candidate offered no; chosen false; ids c2
  - bell 55 AI a02ad0c4 session/model: Strike Order candidate offered no; chosen false; ids c2
  - bell 56 AI 2811df1c autopilot/autopilot: Strike Order candidate offered no (request body not stored); chosen false; ids c1
  - bell 56 AI a02ad0c4 reaction/model: Strike Order candidate offered no; chosen false; ids 
  - bell 57 AI 2811df1c session/model: Strike Order candidate offered no; chosen false; ids c1
  - bell 57 AI a02ad0c4 autopilot/autopilot: Strike Order candidate offered no (request body not stored); chosen false; ids c1
  - bell 58 AI 2811df1c autopilot/autopilot: Strike Order candidate offered no (request body not stored); chosen false; ids c1
  - bell 58 AI a02ad0c4 autopilot/autopilot: Strike Order candidate offered no (request body not stored); chosen false; ids c1
  - bell 59 AI 2811df1c autopilot/autopilot: Strike Order candidate offered no (request body not stored); chosen false; ids c1
  - bell 59 AI a02ad0c4 autopilot/autopilot: Strike Order candidate offered no (request body not stored); chosen false; ids c1

T (contract 9.3) from the first opened Strike Order: 3 (ready invited hosts at C0 + 6: 4).

## Brain follow counters

AI fleet: null

script bots: null

## Limits

- readiness comes from the province files (roster state, mustered, ready bell, stamina); a pending order and a host in transit are not in that view, so "ready" can over-count by those; a host that is not in the files near the target counts as away
- host owners come from the public owners index; "script" means a citizen of nation 0 that is neither an AI nor the seat
- the AI follow-window rows are operator-side (the mind's private records and stored request bodies) and are not part of the public audit
- one pilot run: it sets T and says what happened, it is not a rate
