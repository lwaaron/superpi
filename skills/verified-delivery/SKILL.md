---
name: verified-delivery
description: Use when about to claim any task is done, fixed, passing or complete; when about to end a turn or ask whether to continue; when a command times out, a process is busy, a tool crashed or a step failed and you are tempted to report it as blocked; before running npm test; before committing; when a gate is green but you have not seen it fail; when you just wrote or adopted a checker, tool, script or assertion and are about to trust its output; before deleting, replacing or archiving anything; and before condensing a long-lived rules/prompt/checklist file. Covers the pre-claim gate, test-first with a watched red, whether a suite has teeth (mutation kill rate, teeth tool, vacuity audit), verify-the-verifier (fixture with a known answer, then confirm it can fail), prove-before-delete (unused + duties transferred + full gate green + cross-project carriers), never-stall (retry silently with a bounded budget and a changed variable; only credentials, exclusive goals or irreversible wide impact justify asking), lossless condensing (anchor check, and which losses are correct), and the stop condition (goal objectively true, with a delivery ledger where unverified counts as red).
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

A test can pass without testing anything: an assertion inside a callback that
never runs, a selector that matches nothing, `assert(true)`, a condition guarded
by an `if` that always takes the early exit, a regex that no longer matches the
source it scans (`includes()` on a renamed string quietly returns `false`, and
`assert(!x)` still passes).

**Cheapest way to audit: mutate the code and watch the suite stay green.**

Do this by hand for one guard you care about:

1. Pick the guard you believe in ("`renderBlock` must start with the override line").
2. Change the production code to violate it — delete that line, flip the
   comparison, widen the limit by one.
3. Run the test. **Green means the guard is decorative.**
4. Restore the code, verify the restored file is byte-identical (`git diff` must
   be empty before you move on).

### Do the whole suite at once: `teeth`

Manual mutation does not scale past one or two guards, so it gets skipped —
which is how suites end up decorative. There is a tool for this that works on
**any repo, any language**, because it needs only one thing: the command that
runs the tests.

```bash
T=~/.agents/toolkit/bin/teeth.mjs
node $T --cmd "npm test"                      # JS / Node
node $T --cmd "pytest -q"     --ext .py       # Python
node $T --cmd "go test ./..." --ext .go       # Go
node $T --cmd "cargo test"    --ext .rs       # Rust
node $T --list --ext .js --max 30             # dry run: list mutation sites
```

It flips comparisons (`<` ↔ `<=`), booleans and numeric literals in your
**source** (not in strings, not in comments), runs the suite after each single
change, restores byte-for-byte, and reports:

```
有效变异体 5 · 被杀 2 · 存活 3
杀伤率 = 40.0%
```

Every survivor is printed as `file:line` with its source line. **A survivor is
proof that no test constrains that line** — that is the finding, not the percentage.

Verify the tool tells the truth on a fixture before trusting it on your repo:
two functions, one tested and one not → kill rate should equal exactly the tested
fraction. If a fully-tested module does not come back at 100%, the tool is
misreading your project (wrong `--include`, wrong `--ext`, or a suite command that
exits 0 even when assertions fail).

## Verify the verifier

The vacuity audit says: a green gate proves nothing until you have seen it fail.
This section is one level up: **the thing you used to prove that also needs proving.**

The loop it breaks: you write a checker, the checker says PASS, you trust it. If
the checker is wrong it reports PASS anyway, and nothing warns you.

### The three ways my own checkers lied (one session, all real)

| Checker | What it reported | Reality |
| --- | --- | --- |
| mutation runtime | "kill rate 100%, PASS" | 2 of 6 mutants had stale patterns and were silently skipped — the denominator shrank 6→4 |
| `teeth.mjs` (written that day) | ran fine, printed a number | on Windows `path.join` emits backslashes, so `--include "src/"` matched nothing; the tool silently degraded to scanning the whole repo |
| `check-memory.mjs` (written that day) | "FAIL: index lists name.md but the file is missing" | it had parsed the *example* line inside the docs as a real entry — the checker itself misfired |

All three produced a signal that did not match reality and **would not have
raised any alarm on its own**.

### Fixture-first, three steps

Before pointing a checker at real data:

1. **Build an input whose answer you already know.**
   Two functions, one tested and one not → kill rate must equal exactly the
   tested fraction. One bad entry in an index → report *that* entry and nothing else.
2. **Confirm it returns the known answer.** Not "it ran" — the number matches.
   40% must read 40%. A duck must read duck.
   If it does not match, **the checker is wrong**, not the subject.
3. **Feed it an input that must fail** and confirm it goes red.
   A checker you have only seen pass is the same species as a guard that never fails.

Skip any of the three and the checker has no standing to judge real data.

### The three checker classes that get skipped

- **Tools** — scripts, frame grabbers, OCR, proxy assertions. They take
  parameters, depend on the platform, and degrade *silently* when a parameter
  stops matching.
- **Methods** — sampling strategy, coordinate transforms, mask thresholds,
  sample density. A 25×25 grid stepped straight over the wheel spokes and
  reported "the image is not animating". The method was wrong, the conclusion was
  wrong, and it looked like a defect in the subject.
- **My own assertions** — an assertion that has never been red is not "passing",
  it is "unverified".

### Self-check

- What is this checker's input? Have I run it on one with a known answer?
- When it fails silently (parameter ignored, platform mismatch, pattern no longer
  matches), does it return a *plausible wrong answer*? If yes, a fixture must
  stand between it and real data.
- Is the number I am reporting computed by the checker, or is it what I *expect*
  the checker would compute?

## Before deleting anything, prove it first

Deletion is the cheapest irreversible action and the most expensive to get
wrong: it does not error, it frees space, and it looks like tidiness.

**Prove three things first:**

1. **Unused** — grep the whole repo, including `.json`, `.md`, CI config and
   scripts. Zero references before you continue. Remember `grep` cannot see a
   path built by string concatenation or an external caller.
2. **Responsibility transferred** — list each duty of the old thing and point at
   where the replacement covers *that duty*. A duty you cannot place is a reason
   not to delete.
3. **The full gate is still green after the removal** — the full one, not the
   relevant subset.

**A green suite is not proof.** Green only says the paths your tests cover still
work. If the thing you are deleting had no tests, green carries no information
about it at all.

**Prefer archiving to deleting.** `_archive/` costs a few KB and keeps the
history reviewable. Delete only what is regenerable, and keep the archive
directory gitignored so archived artefacts do not enter the repo.

**Cross-project carriers need their own check.** Deleting a file from a repo
turns something red. Deleting a memory note, a skill, or a global config entry
turns *nothing* red — no project depends on it, so no gate notices. That is how
a carrier gets removed by "whoever last cleaned up".

- `~/.agents/skills/` — user-level skills
- `~/.pi/agent/memory/` — cross-project memory notes
- `~/.agents/toolkit/bin/` — the scripts those notes refer to

Run `node tools/check-carriers.mjs` at the start of a session and inside CI. It
verifies each carrier exists, matches its source, and is actually **loaded by the
runtime** — presence on disk is not the same as being loaded.

**When a carrier disappears and the cause will not reproduce, automate recovery and stop investigating.**

Observed: two user-level skills vanished 4 times in one day, always near a commit or
sync. Five hypotheses were tested and excluded with evidence — the loader does not
delete, sync only removes `.git` locks, the post-commit hook only pushes in the
background, 60s of idle does not trigger it, and 100s of `fs.watch` across a commit
caught zero events. It does not reproduce on demand.

The lesson is not "find it eventually". Twenty rounds of forensics bought nothing while
the work sat degraded (skills not loaded), and every round spent looking is a round the
delivered thing stood still. The correct shape:

- keep the alarm **honest** — the gate stays red when a carrier is missing, because a
  gate that silently repairs itself is a green light wired to nothing;
- make recovery **one command** (`npm run check:carriers:fix`), idempotent, sourced from
  the repo (the single truth), never from a hand-made copy;
- record which hypotheses were excluded, so the next session does not re-run them.

**Edit the source, never the installed copy.** Installers overwrite the installed
copy from the repo source. Edits made directly to `~/.agents/skills/**` are lost
on the next `--install` without a warning. In one session the same file was lost
this way twice, and the second loss was only caught because the carrier check
compared bytes against the source.

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

## Condensing text without losing judgment

Long-lived text (rules, AGENTS.md, prompts, checklists) accretes redundancy: the
same intent restated, drift in wording, paragraphs that grow while the reader's
attention is paid per token. Cutting it is easy. **Proving nothing was lost is
the hard part.**

The three ways manual condensing fails:

1. It deletes the criterion and keeps the conclusion — reads better, executes worse.
2. It keeps the meaning but changes the wording — a human understands it, a
   machine check no longer matches, so future verification silently breaks.
3. "I checked, it's all there" — that is inference, not evidence.

Use the tool instead of judging by feel:

```bash
node ~/.agents/toolkit/bin/condense.mjs verify --src old.txt --new new.txt
```

It extracts **anchors** in six classes — ban verbs, ban targets, quantities,
terms, judgment phrases, numbered labels — and reports which ones the new text no
longer expresses. Exit 1 means a criterion is missing.

### What counts as a correct loss

The tool reports candidates; you decide. Three categories are correct compression:

| Report | Verdict |
| --- | --- |
| an example or counter-example disappeared (`running` → `done` as a sample value) | correct — an example is not a criterion |
| a descriptive sub-heading was merged or dropped | correct — that is the yield |
| the same criterion now uses a synonym (`3 个地方` → `3 处`) | correct — extend the synonym table |

Anything outside those three is a real loss: put it back.

### The rule this enforces

Compression is only finished when the anchor check has run **last**, after the
final edit. A compression you "already verified" before the last tweak is
unverified.

## Never stall — but retry with a budget

Two opposite failures wear the same face, and both look like caution:

- **Stalling**: reporting "blocked / failed / waiting" for something you could
  wait out or retry. This pushes your own retry cost onto the user.
- **Spinning**: retrying the same thing unchanged. This is stalling with extra steps.

### Retry silently (do not report as failure)

| Situation | Do |
| --- | --- |
| resource busy / lock held ("another sync is running") | sleep, retry until acquired or budget spent |
| timed out but the work is finite | raise the timeout, split the task, or take a faster equivalent path, then re-run |
| transient fault (network, 5xx, file locked, port not yet freed) | back off with jitter (1s → 2s → 4s) and count attempts |
| process or tool crashed | restart, restore to a known state, continue |

None of these belong in a status report. Reporting them is asking the user to do
your waiting for you.

### Stop and ask (exactly three classes)

1. something only the user holds — credentials, account, private assets, a file
   they never provided;
2. goals that are physically exclusive — two requirements that cannot both hold;
3. irreversible action whose blast radius exceeds this task — production data,
   live config, anything published.

When you stop, say **what is missing, why you cannot obtain it, and what you
propose**. Do not present a menu of trade-offs.

### The budget is part of the rule

Unbounded retrying is not persistence, it is the same failure as stalling.

- **After 3 attempts at the same operation, stop retrying and change the layer or
  the method.** This is the same rule as "the third failed fix means your model of
  the system is wrong".
- **Every retry must change a variable**: timeout, path, parameters, environment,
  approach. An identical retry is a prayer, not an experiment.
- **State the budget up front**: at most N attempts / at most T minutes. Past it,
  either escalate to a human need or switch approach.

### Interruption is the expensive case

The costly form of "process interrupted" is not a failed command, it is work that
stops half-done with no way to resume.

- After each independently verifiable step, write the state into the repo — what
  is done, what is next, what the acceptance check is.
- Leave no ambiguous state: either roll back to the last known-good point or
  label the spot "in progress, do not trust".
- The next person (or the next you) should be able to continue from the files
  alone, without asking anyone anything.

## Reporting

Every completion report names, in this order:

1. the command run and what it printed (counts, exit code)
2. anything the run revealed that was not part of the task, by name
3. what is **not** verified, stated as plainly as what is
4. for behaviour claims, whether tests were seen red before green

Never upgrade an inference to an observation. "I did not run it" is a valid,
honest line; "it works" without a run is not.
