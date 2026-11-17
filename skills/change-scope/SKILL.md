---
name: change-scope
description: Use before writing implementation code for any non-trivial request — when a request could be read more than one way, when the change might touch files beyond the one asked about, or when you are about to "improve" neighbouring code. Covers naming assumptions before coding, the smallest diff that satisfies the request, and the line-trace test for every changed line.
---

# Change Scope

**Core principle:** every changed line must trace to the request. Anything
else is a second, unreviewed change ridden in on the first.

The failure this prevents is not sloppiness — it is a *reasonable* impulse.
While editing file X you see something wrong in X. Fixing it feels free.
It is not: it widens the blast radius, mixes two intents in one diff, makes
the fix un-revertible on its own, and hides the actual change from review.

## Before the first line: state what you assumed

A request is a compressed description. Multiple implementations satisfy it.
Picking one silently is the single most expensive mistake available, because
everything after it is wasted rather than wrong.

Write down, before coding:

- **what it must do** — the observable behavior, in one or two sentences
- **what it must not change** — the existing behaviors you are implicitly
  promising to preserve
- **what you assumed** — each assumption that, if wrong, changes the shape
  of the work
- **what is ambiguous and could go two ways** — with which reading you picked
  and why

If an assumption is cheap to check in the codebase, **check it instead of
writing it down**. Never ask what the repo already answers — read the file,
run the command, grep for the symbol. Only ask the human partner when the
answer is genuinely absent from the repo *and* changes what gets built.

Ask one question, not five. If several things are open, pick the one whose
answer moves the design most, and say what each option trades.

### Simplicity is a constraint, not a taste

Write the smallest thing that satisfies the stated behavior:

- no options, flags or configurability that was not asked for
- no abstraction for a single call site
- no error handling for a state the code cannot reach
- no "while I'm here" cleanup
- if a 200-line version can be 50, the 50-line version is the deliverable

The test that catches over-building: **explain each piece of the diff to
someone who only read the request.** The piece with no sentence is the
over-build.

Depth over breadth on the same principle: when a file you are editing is
already unwieldy, note it — do not restructure it as part of an unrelated
change. Structure changes deserve their own step with the human partner's
knowledge.

## The line-trace test

Before reporting, walk the diff:

```
for each changed line:
    which sentence of the request does this line implement?
```

A line with no answer is one of three things, and each has a different
correct action:

| Line | Action |
| --- | --- |
| made unused by **your** change (import, variable, helper) | remove it — cleaning your own orphan is part of the change |
| pre-existing dead code you noticed | mention it; leave it unless asked |
| "improvement" you felt like making (comment wording, formatting, an adjacent refactor) | revert it; propose it separately |

### Rationalizations, and what they actually are

| The thought | What it actually is |
| --- | --- |
| "It's only cosmetic, it doesn't count" | Cosmetic lines still enter the diff and still need review. Revert. |
| "I'm here anyway, it's wasteful not to" | Second intent, first review. Split it into its own change. |
| "Leaving it would be worse than fixing it" | Maybe. Neither is this request's business. Report it, do not do it. |
| "The user will want it" | Prediction, not a requirement. Ask or omit. |
| "Being careful means fixing everything I see" | Care is scope discipline. Breadth without a request is the risk. |
| "The extra option future-proofs it" | Speculative capability is surface area with nobody's use case behind it. YAGNI. |
| "The request was vague, so any reasonable reading is fine" | Then state the reading. Silence is the failure, not the breadth. |
| "Asking a question slows the work down" | One wrong assumption costs the whole implementation. Check the repo first, then ask the one question that matters. |
| "The refactor is needed to do this task" | Then say so up front and get agreement, instead of bundling it in silently. |

`git diff --stat` is the fast version of this audit: the file you were asked
about should dominate. A second file with a large count is a question you
must answer before committing.

Measure it, do not eyeball it:

```bash
git diff --stat          # scope of the change
git diff --numstat       # per-file lines added/removed
git diff                 # the line-trace test itself, walked top to bottom
```

## Behavior changes need a watched red

A behavior change without a test that failed before is a claim about the
future, not evidence. If the change is testable at all:

1. write the assertion of the new behavior
2. run it — it must fail, for the reason you intend
3. make the change
4. run it — pass, and everything else still passes
5. run the project's whole suite command, not one file

Fixing a bug is the same cycle with the symptom as the assertion: reproduce
in a test first, then fix. A bug fixed without a reproducing test will come
back, silently.

Forbidden framing: "I already verified it manually." Manual checking has no
record of what was covered and cannot be re-run; it is not evidence that the
test layer would have caught the regression.

## Reporting scope honestly

Three lines earn the report's credibility:

1. **what changed** — files, one clause each on why
2. **what did not change** even though it was nearby — named, so the reader
   knows the omission was a decision
3. **what is not verified** — stated as plainly as the successes
