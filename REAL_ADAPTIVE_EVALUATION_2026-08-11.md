# Real Adaptive Facilitator evaluation — 2026-08-11

## Scope

The evaluation used the configured `MiniMax-Text-01` endpoint and synthetic
public discussion only. No real participant or private-profile data was sent.
Each scenario executed the production-shaped path:

`LLM detector → EvidenceChecker → rule classification → PolicyCompiler →
Generator → schema/deterministic checks → LLM Validator`.

This is a functional and mechanism test. It is not evidence that the system
causes real groups to use more information; that claim requires the planned
controlled participant study and behavioural outcome data.

## Final scenario results

| Scenario | Expected | Selected | All checks | Actual intervention |
|---|---|---|---|---|
| Narrow discussion / missing information | Expander | Expander | Pass | “Has the group considered how Eldoron's large rail station might affect accessibility or local community support?” |
| Unsupported convergence | Challenger | Challenger | Pass | “Before we decide on Eldoron, what evidence or reasoning supports this preference?” |
| Fragmented, uncompared evidence | Synthesiser | Synthesiser | Pass | “How do Eldoron and Myloria compare on transport capacity and total cost?” |

Final result: **3/3 role matches and 3/3 complete pipeline passes**. All three
messages were short, neutral, answerable, grounded in public discussion,
non-recommending, and aligned with the selected reasoning act. They directly
instantiate the intended information-use mechanisms: broaden coverage, request
justification, and compare shared evidence.

## Problems exposed by real calls and corrected

1. The old E2E script did not provide production dynamic context to the
   Generator and failed its Static schema check. A new production-shaped real
   evaluation runner was added as `server/real-adaptive-evaluation.mjs`.
2. Near-equal detector scores allowed Expander to displace a strongly supported
   Challenger. Near-ties now use the frozen priority: Scrutiny (Challenger),
   then Integration (Synthesiser), then Expansion (Expander).
3. The Generator could not see the plan's grounding allow-list and cited valid
   public messages outside the hidden list. The allow-list is now explicit in
   its dynamic context. Synthesiser plans include validated attributed but
   uncompared evidence relations so a comparison can cite both sides.
4. MiniMax returned a valid fenced Validator JSON object followed by an
   explanation. A Validator-only envelope parser now accepts the first fenced
   object and still applies the exact JSON schema. Generator parsing remains
   strict.
5. Validator fields used positive names even though `true` meant a violation.
   `requiredReasoningActFidelity` and `answerability` were renamed to
   `requiredReasoningActMissing` and `unanswerable`, making every boolean follow
   the same `true = problem detected` contract.
6. The detector initially varied on the integration scenario. Calibration
   guidance now distinguishes missing breadth from already-broad but
   unintegrated evidence.

## Remaining limitations and risks

- End-to-end latency was approximately **45–62 seconds per checkpoint** for
  three sequential LLM calls. Functionality is correct, but this may be too
  slow for a live ten-minute discussion and can make an intervention stale.
- One transient `fetch failed` occurred during repeated testing. Production
  currently fails closed, so the checkpoint would be silent rather than unsafe,
  but availability should be measured during pilot rehearsal.
- Detector scores are stochastic. Before claiming classification reliability,
  run repeated trials per scenario and report role agreement, score dispersion,
  abstention rate, and false-positive/false-negative cases on held-out human-
  coded transcripts.
- The detector still sometimes marks multiple related deficiencies present.
  Evidence checking and priority rules prevent some bad routing, but detector
  discriminant validity remains an empirical question.
- The Validator uses the same model family as the detector/Generator and is not
  an independent human quality judgement.
- The final messages have the intended mechanism to promote information use;
  actual uptake, information pooling, cross-option comparison, decision quality,
  and participant experience must be evaluated with real groups.

## Reproduction

From `server/`, with the approved synthetic-data/API arrangement:

```bash
node real-adaptive-evaluation.mjs
```

To run one scenario:

```bash
SCENARIO_ID=unsupported_consensus_challenger node real-adaptive-evaluation.mjs
```

## Follow-up: factually sparse discussion

Expander coverage was subsequently clarified so that `breadth_deficiency` also
includes a public discussion with too little concrete factual information to
evaluate or compare the named options. This remains an LLM-scored semantic
factor; no hand-engineered feature was added.

A targeted live-LLM scenario in which participants explicitly described their
discussion as general impressions without concrete facts passed end to end:

- checked `breadth_deficiency`: present, strength 0.9;
- selected role: Expander (the only eligible specialist);
- generated intervention: “What additional task-relevant facts could the group
  share about the cities, such as transport capacity, cost, weather reliability,
  accessibility, or local community support?”;
- schema, deterministic grounding checks, role match, and semantic Validator:
  all passed;
- elapsed time: 43.2 seconds.

The detector prompt explicitly prohibits treating message count or discussion
length alone as evidence of factual insufficiency. The transcript must support
a substantive coverage gap.
