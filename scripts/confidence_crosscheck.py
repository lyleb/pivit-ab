#!/usr/bin/env python3
"""Compare pivitlab's sample size with Spotify Confidence.

Not part of npm test. Spotify's SampleSize.binomial uses the baseline
variance for both arms and an absolute difference, so its visitor count is
a little smaller. Within about 10% is the expected gap.

    pip install spotify-confidence
    python scripts/confidence_crosscheck.py
"""

import math
import sys

CASES = [
    # baseline, relative, variants, pivitlab visitors per variant
    (0.10, 0.50, 2, 686),
    (0.10, 0.50, 3, 831),
    (0.03, 0.10, 2, 53211),
    (0.03, 0.10, 3, 64439),
]


def pivit_n(baseline, relative, alpha):
    p1 = baseline
    p2 = p1 * (1 + relative)
    delta = p2 - p1
    p_bar = (p1 + p2) / 2
    z_alpha = inverse_normal(1 - alpha / 2)
    z_beta = inverse_normal(0.8)
    term = z_alpha * math.sqrt(2 * p_bar * (1 - p_bar)) + z_beta * math.sqrt(
        p1 * (1 - p1) + p2 * (1 - p2)
    )
    return math.ceil((term / delta) ** 2)


def inverse_normal(p):
    # Acklam's approximation, same coefficients as src/plan.js.
    a = [
        -3.969683028665376e01,
        2.209460984245205e02,
        -2.759285104469687e02,
        1.383577518672690e02,
        -3.066479806614716e01,
        2.506628277459239e00,
    ]
    b = [
        -5.447609879822406e01,
        1.615858368580409e02,
        -1.556989798598866e02,
        6.680131188771972e01,
        -1.328068155288572e01,
    ]
    c = [
        -7.784894002430293e-03,
        -3.223964580411365e-01,
        -2.400758277161838e00,
        -2.549732539343734e00,
        4.374664141464968e00,
        2.938163982698783e00,
    ]
    d = [
        7.784695709041462e-03,
        3.224671290700398e-01,
        2.445134137142996e00,
        3.754408661907416e00,
    ]
    plow = 0.02425
    phigh = 1 - plow
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (
            (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
        )
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(
            (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
        )
    q = p - 0.5
    r = q * q
    return (
        (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5])
        * q
        / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    )


def spotify_n(baseline, relative, variants):
    from spotify_confidence import SampleSize

    absolute = baseline * relative
    frame = SampleSize.binomial(
        absolute_percentage_mde=absolute,
        baseline_proportion=baseline,
        alpha=0.05,
        power=0.8,
        treatments=variants,
        bonferroni_correction=variants > 2,
    )
    # The frame has a total and a per-group column. Prefer a per-arm figure.
    columns = {str(name).lower(): name for name in frame.columns}
    for key in ("sample size per group", "n_per_group", "sample_size_per_group"):
        if key in columns:
            return int(round(float(frame[columns[key]].iloc[0])))
    numeric = [frame[name].iloc[0] for name in frame.columns if _is_number(frame[name].iloc[0])]
    if len(numeric) >= 2:
        return int(round(float(min(numeric))))
    if len(numeric) == 1:
        return int(round(float(numeric[0]) / variants))
    raise SystemExit("Could not read a sample size from:\n%s" % frame)


def _is_number(value):
    try:
        float(value)
    except (TypeError, ValueError):
        return False
    return True


def main():
    try:
        import spotify_confidence  # noqa: F401
    except ImportError:
        print("spotify-confidence is not installed. pip install spotify-confidence")
        print("pivitlab visitors per variant, for reference:")
        for baseline, relative, variants, expected in CASES:
            alpha = 0.05 / (variants - 1)
            print(
                "  baseline %.0f%%, relative %.0f%%, %d variants: %d"
                % (baseline * 100, relative * 100, variants, pivit_n(baseline, relative, alpha))
            )
        return 0

    print("baseline  relative  variants  pivitlab  spotify  gap")
    worst = 0
    for baseline, relative, variants, expected in CASES:
        alpha = 0.05 / (variants - 1)
        ours = pivit_n(baseline, relative, alpha)
        if ours != expected:
            print("pivitlab formula drifted: expected %d, got %d" % (expected, ours))
            return 1
        theirs = spotify_n(baseline, relative, variants)
        gap = abs(ours - theirs) / ours
        worst = max(worst, gap)
        print(
            "%7.0f%%  %7.0f%%  %8d  %8d  %7d  %5.1f%%"
            % (baseline * 100, relative * 100, variants, ours, theirs, gap * 100)
        )
    if worst > 0.15:
        print("Gap above 15%. The methods should still be within about 10% for these rates.")
        return 1
    print("Within 15%. Spotify is expected to be a little smaller.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
