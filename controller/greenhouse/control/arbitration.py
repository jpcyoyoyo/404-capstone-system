"""Multi-parameter arbitration (§3.5) — the element that makes this one controller rather than six.

Precedence, strongest first:
  1 safety interlocks     2 resource contention (incl. operator commands)
  3 cross-parameter coupling   4 fertigation gating   5 ordinary threshold requests
Within a rule, `rank` breaks ties (temperature > humidity > CO₂).
Every request that loses to a contrary one is returned as Suppressed so the
decision can be shown from the event log rather than asserted.
"""
from __future__ import annotations

from .types import Request, Suppressed, RULE_NAMES


def arbitrate(requests: list[Request]) -> tuple[dict[str, Request], list[Suppressed]]:
    by_act: dict[str, list[Request]] = {}
    for r in requests:
        by_act.setdefault(r.actuator, []).append(r)
    decisions: dict[str, Request] = {}
    suppressed: list[Suppressed] = []
    for act, reqs in by_act.items():
        ordered = sorted(reqs, key=lambda r: (r.rule, r.rank))
        winner = ordered[0]
        decisions[act] = winner
        for loser in ordered[1:]:
            if loser.on != winner.on:
                suppressed.append(Suppressed(
                    actuator=act, wanted_on=loser.on, source=loser.source, rule=loser.rule,
                    by_source=winner.source, by_rule=winner.rule,
                    reason=(f"{loser.source} wanted {act} {'ON' if loser.on else 'OFF'} ({loser.reason}); "
                            f"overruled by {winner.source} [{RULE_NAMES[winner.rule]}]: {winner.reason}"),
                ))
    return decisions, suppressed
