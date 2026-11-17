---
name: verified-delivery
description: Use when about to claim any task is done, fixed, passing or complete — before running npm test, before committing, and when a gate is green but you have not seen it fail. Covers the pre-claim gate (identify the exact command that would prove the claim and run it), test-first with a watched red, and measuring whether the suite actually has teeth (mutation kill rate, vacuity audit) instead of trusting a green run.
---

# Verified Delivery

**Core principle:** a green suite is a claim, not evidence. Evidence is a
command you ran in this message, whose output you read, that **could have
failed**.

This skill exists because "tests pass" and "the tests can catch this bug" are
different statements, and only the second one predicts anything about
production.

## The Gate Function

Run this before **any** statement of success — "done", "fixed", "passes",
"works", "应该没问题", "改好了", or a cheerful summary that implies any of them.

1. **IDENTIFY** — which exact command proves this specific claim? Not "the
   tests", the command line.
2. **RUN** — that command, full, right now. Not a previous run, not "it
   should still pass", not a subset because it is slow.
3. **READ** — the whole output and the exit code. Count failures yourself.
   Do not read the last line and assume.
4. **COMPARE** — does the output actually confirm the claim? If the run
   shows any failure, including one you believe is unrelated, that failure
   belongs in the report **by name**. A red line you watched scroll past
   and did not mention is a report falsified by omission.
5. **ONLY THEN** — make the claim, and quote the evidence (command →
   observed output).

Skip a step and you are not verifying, you are asserting.

| Claim | Proves it | Does **not** prove it |
| --- | --- | --- |
| tests pass | the test command's output, 0 failures | a previous run, "unchanged logic" |
| bug fixed | the original symptom's test now passes | the diff looks right |
| feature works | a test of the new behavior that failed before | the code reads correctly |
| regression test exists | red → green cycle, watched both times | the test passes once |
| build ok | the build command, exit 0 | linter passing |
| requirements met | line-by-line checklist against the request | tests passing |

### Red flags that mean stop

- "should", "probably", "seems to", "应该", "看起来没问题"
- satisfaction expressed **before** the run ("太好了，完成了！")
- about to commit / push / report while the last run predates the final edit
- trusting a report — including your own earlier one — instead of re-running
- "just this once", "it's a one-line change", "the logic is obviously right"
- paraphrasing the requirement into something the tests happen to check

### Rationalizations, and what they actually are

The rule does not hold because it is written down; it holds when each exit is
named. Every line below is a real justification shape observed in coding-agent
transcripts (including this repo's own session logs). Answer in the right column.

| The thought | What it actually is |
| --- | --- |
| "The change is too small to need a run" | Small changes are exactly where the unrun case hides. One line, one run. |
| "I ran it a moment ago, the last edit cannot matter" | Then re-run it; it costs seconds. "Cannot matter" is the hypothesis under test. |
| "Tests passed before my edit" | Evidence about the old code, not the new one. |
| "Other files fail, not mine" | An unmentioned red line is a falsified report. Name it or fix it. |
| "I verified it by hand" | Manual checking has no record and cannot be re-run. Not evidence. |
| "The test is obviously correct" | "Obvious" is what test-after produces. Watch it fail or it is unproven. |
| "Green suite, so the behavior is protected" | Only if the test can fail. Mutate the guard and look. |
| "Mutation testing is overkill for this" | 0.3 s per mutant on this repo. Cheaper than a false green. |
| "I will add the test in the follow-up" | The follow-up is where believed-covered bugs live. |
| "It is about the spirit, not the letter" | The letter is what the green/red outcome measures. Spirit-over-letter is the loophole, not the escape. |
| "Exhaustion / time pressure" | Pressure is precisely when the shortcut looks reasonable; the run is the cheap part. |
| "I am confident" | Confidence is the thing being verified, not a substitute for verifying. |

## Test-first, and what "watched" means

The only thing that makes a test evidence is that you saw it **fail for the
expected reason** first.

```
1. write the assertion of the desired behavior
2. run it            → must FAIL, and the failure text must match your intent
3. if it passed      → your test asserts existing behavior; it proves nothing new
4. if it errored     → fix the harness, re-run, until it fails on the assertion
5. implement minimally
6. run it            → PASS, and the rest of the suite still PASSES
7. run the project's full suite command, not just your file
```

Two failure modes this catches, both invisible afterwards:

- **test-after**: written against code you just wrote, it verifies the cases
  you happened to think of, and passes on the first run. You never learned
  whether it can fail.
- **vacuity**: the test passes because it asserts nothing meaningful (see
  below). A green run of a vacuous test is worse than no test, because it
  buys false confidence.

## Vacuity audit — a green suite may be vacuous

A test can pass without testing anything: assertion inside a callback that
never runs, a selector that matches nothing, `assert(true)`, an expectation
computed from the same value it checks, a condition guarded by `if (x ===
undefined) return` hitting that early exit forever, a regex that no longer
matches the source it scans (`includes()` on a renamed string quietly returns
`false` and `assert(!x)` still passes).

**Cheapest way to audit: mutate what the test claims to guard, and watch it
fail.**

3. Pick the guard you believe in ("`renderBlock` must start with the override
   line", "empty input must render nothing").
4. Change the production code to violate it — delete that line, flip the
   comparison, widen the limit by one.
5. Run the test. **Green means the guard is decorative.**
6. Restore the code, verify the restored file is byte-identical (`git diff`
   must be empty before you move on).

### Metric: mutation kill rate

```
kill rate = killed mutants / valid mutants
```

- **valid mutant** = the source actually changed (assert the replacement
  happened; a silent no-op makes the measurement a lie)
- **killed** = the suite went red
- **survived** = the suite stayed green → that behavior is unguarded

Reference measurement on this repo's `test/rules.mjs` (2026-11-18, 12 mutants
across the model layer / pi extension / HTTP layer):

```
valid mutants      = 10 / 12 attempted   (2 patterns did not match — reported, not skipped)
killed             = 9
survived           = 1
kill rate          = 90.0 %
```

The survivor was **real**: `store.write()` rejected the over-long input so
`test/rules.mjs` never reached the command handler's own length pre-check.
The notice-only assertion (`some(item => item.level === 'error')`) was
satisfied by the *other* guard. Fixing it means asserting the specific
message and length, not "some error happened". Report the survivor exactly
like this: what was believed covered, what actually covered it, what the
test must assert instead.

Do not report a kill rate you did not compute. If you did not mutate
anything, say "no mutation run" — never estimate it.

## Keep throwaway verification out of the repo

Probes, mutation drivers, fixture generators and one-off scanners are
**verification**, not deliverables. They belong in a temp directory or a
gitignored folder; they must not be committed, not be in `files` for the
package, and not be referenced by other code.

Why it matters: this repo's `research/` holds 141 tracked files with **13
`.mjs` probe scripts whose external reference count is 0** — committed
exploration that now reads as if it were part of the product. A
first-principles check at commit time ("does every tracked file have a
consumer, an owner, or a documented status?") is the cheap version of the
cleanup.

Two legitimate exceptions, both must be **declared**:

- test-only exports (referenced only by the gate) — say so in a comment, so a
  later reader does not delete them
- `test/fixtures/**` — protocol doubles that cannot be synthesized at test
  time; they ship with a header explaining what they fake and why

## When you are stuck, name the layer before touching it

Being stuck has a shape, and the shape tells you where the fault is. Retrying
a failed action is the one response that never works — because if the action
were going to succeed, it would have on the second try.

### The stuck triage

Classify **first**, then act. Each class has a different escape; using the
wrong one wastes the attempts you need.

| Symptom | What is actually wrong | The escape |
| --- | --- | --- |
| Same command, same error, twice | You are re-running, not diagnosing. Stop. | Read the error text **in full** before the third run. The answer is usually in it and you skipped it. |
| "The file I just wrote does not exist" | **Two different directories with one name.** On Windows `/tmp` resolves to `%LOCALAPPDATA%\Temp` in bash and `D:\tmp` in node/python (measured 2026-11-18). Any tool-to-tool path handoff is suspect. | Print the absolute path from **each** tool (`pwd -W`, `path.resolve`, `os.path.abspath`) and compare. Then keep the work inside the repo (`_scratch/`, gitignored) so every tool agrees. |
| A file works, then a one-line edit breaks the syntax | **The edit tool ate your escaping.** Heredocs, `sed -i` and python triple-quotes strip one level of backslash: `^---\n` arrives as a real newline, `[\s\S]` arrives as `[sS]`. bash reports success. | Never write backslash-bearing content through a shell string. Write it with the file-writing tool, or build it from `String.fromCharCode(92)`. Then `node --check <file>` — one second, every time. |
| "It compiles but the test says the symbol is undefined" | **Scope.** You added assertions in a block whose bindings are local elsewhere. The editor's syntax check cannot see this; only running can. | Run the gate, not the parser. `node --check` proves syntax, never scope. |
| You fixed the same thing 3+ times | **Your model of the system is wrong**, not your patch. | Stop patching. Add one instrumentation point at the boundary where reality diverges from your belief, read it once, then change the structure or ask. |
| An action "succeeded" but the state is unchanged | You are verifying the **action** (exit code) instead of the **effect** (read it back). | Assert on the effect: read the file, re-query the endpoint, count the rows. |

### The two-minute rule

Before a third attempt at anything, spend two minutes on one of these, in order:

1. **Reproduce it in isolation** — smallest possible command, outside the
   surrounding machinery. If it does not reproduce there, the fault is in the
   machinery, not the thing.
2. **Print the actual values** at the layer you believe is fine. Belief is what
   is stuck; printed values are not.
3. **Check the assumption you have not checked** — the one that feels too
   obvious to test. That feeling is the marker.

### What "optimizing yourself" means mechanically

A lesson that lives only in a memory of a bad afternoon is lost by the next
session. Convert each one into a **constraint the tools enforce**:

| Lesson | Weak form (lost) | Strong form (kept) |
| --- | --- | --- |
| path confusion across tools | "remember /tmp is weird" | a gitignored `_scratch/` dir plus the rule to keep work in-repo |
| shell escaping broke a file | "be careful with heredocs" | the file write it with the file tool, then `node --check` |
| assertion outside its scope | "test more carefully" | the gate is the only proof; the parser is not |
| a repeated wrong fix | "think harder next time" | the 3-attempts counter names architecture, not effort |

Write the strong form into the repo's own rule file (`AGENTS.md`) and the skill
that will be loaded at the moment of need — not into a note that nothing reads.
A constraint that a future run cannot violate is worth more than a resolution
that it can.

## When the same fix fails three times, stop fixing

Counting attempts is the diagnostic. One failure is bad luck, two is a wrong
hypothesis, **three means the model of the system is wrong** — not the
next patch.

At three:

1. state what you now believe the system actually does
2. find the layer where the belief diverges (add instrumentation at the
   boundary, once, and read it — do not guess twice)
3. change the structure, or ask the human partner
4. do not add fix #4 on top of #1–#3

A concrete instance from this repo: the editor's appearance changed in 0.9.4
and silently did nothing for four versions. Each "fix" was a patch to the
thing being rendered; the actual cause was one layer up — pi's
`getEditorTheme()` has no `fg`, the call threw, and the render fallback
returned unstyled rows. The gate also missed it because its fake theme had
an `fg`. Patch #4 would have been the fourth wrong fix in the same place;
replacing the lookup chain (and rebuilding the fake from pi's real shape)
ended the class of bug.

## Reporting

Every completion report names, in this order:

1. the command run and what it printed (counts, exit code)
2. anything the run revealed that was not part of the task, by name
3. what is **not** verified, stated as plainly as what is
4. for behavior claims, whether tests were seen red before green

Never upgrade an inference to an observation. "I did not run it" is a valid,
honest line; "it works" without a run is not.
