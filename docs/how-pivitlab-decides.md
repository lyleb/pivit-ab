# How pivitlab decides

A test is read once, when the plan is reached. Until then the owner sees a health check, progress, and the traffic split. Conversion rates, uplift, a winner, and probability best stay hidden. That is what keeps a false win near the 5% the plan was built for.

Probability best with a flat prior, watched continuously, is a different question. Spotify’s Confidence library found that setup calls a winner about 30% of the time when nothing has changed. A 7 October 2026 fake-traffic run on pivitlab showed 86% “best” on 17 conversions. The verdict below is not that live score.

## The plan, without a calculator

The planner asks how big a change you are looking for:

- Small change, about 5% relative
- Medium, about 10% relative
- Big, about 20% relative

The exact percentage sits under Advanced, with the baseline conversion rate, the visitors you expect in a week, and the minimum runtime. The page answers in one sentence, for example: “You'll need about 53,211 visitors per variant, roughly 22 weeks at your current traffic.” That example is a 3% baseline, a 10% relative change, and 5,000 visitors a week, with Control and one challenger.

The baseline is filled from this test when it already has at least 100 visitors and some conversions, otherwise from past results on the same page, otherwise from an estimate of 3%. The label says which, and you can edit it. Weekly traffic is filled from visitors to this test, or to a matching page, over the last 28 days when there are at least 30 of them. Otherwise it uses snippet page loads on the site domain (`host_hits`). If neither exists, the field is left for you.

Leaving the suggestion is enough. Finishing the wizard, or starting a draft that has no plan, stores that suggestion as an automatic plan (medium change, the estimated baseline, 80% power, 14-day minimum). The plan is marked automatic. Blind mode and the verdict still run. A test that is already running with no plan is not given one on its own. It keeps showing its numbers, with a prompt to use the suggestion. Adopting that prompt then hides the score until the plan is reached.

## The sum, in plain terms

Each variant needs the same number of visitors. The sum is the usual two-proportion sample size:

- 80% power: if the change is really there, the verdict calls it about four times in five
- 5% two-sided: if there is no change, a false win or a false loss happens about one time in twenty
- The null standard error uses the pooled rate. The alternative uses each arm’s own variance. That is the sample size that actually lands near 80% power

With three variants there are two challengers against Control. Each comparison uses a 2.5% bar instead of 5% (Bonferroni), so a false call across both stays near 5%. The sample size grows to match. The interval shown on the verdict is still the 95% range. The win or loss itself uses the stricter bar when there is more than one challenger.

The minimum runtime is two whole weeks by default, and never under one week. One week can miss a weekday pattern. Two weeks is the usual minimum. The test needs both the visitors and the minimum runtime. Whichever finishes last is the moment the verdict is read.

## What you see

While a planned test is still short of that moment:

- Health (only while it is running), progress against the visitor target, days against the minimum, and the traffic split
- No conversion rate, no uplift, no winner, no trend, and no probability best
- The client portal and the CSV follow the same rule. The CSV in that period is progress only

Reveal early is an owner-only hatch. It warns that looking early raises the chance of a false win, writes a row to the test-traffic audit (`action` `reveal`), and marks the result peeked. The mark stays. The numbers are then a look, not a verdict. The client portal shows the same numbers and the peeked note. It does not offer the hatch.

When the plan is reached, each challenger against Control is one of:

- Win
- Loss
- Inconclusive

with the posterior uplift, the 95% range, and a line for what that range rules out. An example is “An uplift bigger than +4% is unlikely.” Probability best is a secondary detail under that verdict, not the decision.

If the traffic split is broken (the health sample-ratio check), the verdict says Data problem. It does not call a win, a loss, or inconclusive, and it does not lead with probability best.

A test with no stored plan keeps its numbers. The prompt to set a plan is a nudge. Nothing already stored in `events` is rewritten by saving a plan, revealing early, or reading a verdict.

## Simulations

Seed `20261008`. Each run draws the planned visitors from an exact binomial, then reads the verdict with 4,000 posterior draws. A false positive is any win or any loss when the variants are identical. Power is a win for the challenger that truly has the planned uplift.

Two variants, baseline 10%, relative change 50%, 686 visitors per variant:

- No true difference: 4 false calls out of 200 (2%). The flat prior interval is slightly cautious, so this sits under the 5% line rather than on it
- Known uplift: 162 wins out of 200 (81%), against the planned 80%

Three variants, same baseline and change, Bonferroni, 831 visitors per variant:

- No true difference: 6 false calls out of 120 (5%)

`npm test` runs this subset (`scripts/stats-sim.test.js`). It takes a few seconds.

## Cross-check with Spotify Confidence

Spotify’s open-source `spotify-confidence` package is optional and is not part of `npm test`.

```bash
pip install spotify-confidence
python scripts/confidence_crosscheck.py
```

`SampleSize.binomial` takes an absolute difference (baseline times the relative change), `power=0.8`, `alpha=0.05`, and `bonferroni_correction` when there is more than one challenger. Pass `power=0.8`. The library’s own default is 0.85.

That calculator uses the baseline variance for both arms, so its visitor count is a little smaller than pivitlab’s. Agreement within about 10% is the expected gap, not a mismatch to force. The script prints both numbers. `BetaBinomial` in the same library is a separate posterior check if you want one.
