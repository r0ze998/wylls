/**
 * The entry a gateway route (③/⑤'s, not yet written) calls to run an
 * adopted 06 plan, and the read-only status it may show. A technical
 * connection only: it adds no authority, no signature scheme and no
 * economic promise. See docs/12-intake-contract.ja.md.
 *
 *   intake({ dispatch, route, adoption, binding, request })
 *     route    "run" (④ run accept/view) or "act" (③ MCP send)
 *     adoption (planHash) -> null | problem   06's adoption record (AdoptionBook.problem)
 *     binding  (plan, requester) -> null | problem
 *              who may run this plan for this requester. NOT DECIDED (docs/12 §3, D1):
 *              there is no default; without one every run request is refused.
 *     request  the plan's content, its hash, the pinned definition, the request's nonce,
 *              and for the run route the requester the gateway authenticated
 *              (passed to ④ as it is) plus ④'s places, owner tag, deadline and budget.
 *   status(dispatch, key)  reads the journal only: no outside call, nothing sent.
 *
 * Kept from the delivered contracts and never loosened here: the requester
 * comes from the gateway's credential layer and 06 never writes it; run ids
 * and requestIds are fixed from the plan; PlanUsed and a requestId reused on
 * another connection are held; a result-unknown send is never sent again;
 * `landed` is never completion.
 */

export function intake({ dispatch, route, adoption, binding, request }) {
  if (typeof binding !== "function") {
    return { ok: false, findings: [{ code: "BINDING_UNDECIDED", detail: "who may run a plan for an authenticated requester is not decided (docs/12 §3 D1); nothing is planned" }] };
  }
  if (typeof adoption !== "function") return { ok: false, findings: [{ code: "SHAPE", detail: "adoption(planHash) is required" }] };
  const a = adoption(request.planHash);
  if (a) return { ok: false, findings: [{ code: a, detail: "the plan is not an active adoption" }] };
  if (route === "run") {
    const b = binding(request.plan, request.requester);
    if (b) return { ok: false, findings: [{ code: "NOT_BOUND", detail: String(b) }] };
  } else if (route !== "act") {
    return { ok: false, findings: [{ code: "SHAPE", detail: "route: run | act" }] };
  }
  return dispatch.plan({ route, ...request });
}

/** The state of a run request from the journal: nothing is read from ③ or ④, nothing is sent. */
export function status(dispatch, key) {
  return dispatch.status(key);
}
