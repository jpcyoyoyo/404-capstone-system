"""Liquid fertigation arithmetic (decided 4 Oct 2026).

Doses are set in grams of FERTILIZER. The fertilizer is dissolved into a stock solution that sits
in a bottle on the load cell; the dosing pump moves solution into the reservoir until the bottle
has lost the matching weight of SOLUTION. The stock strength is given by weight, so the conversion
is exact whatever the fertilizer's density: 100 g of fertilizer + 900 g of water = 1000 g of stock
at 100 g/kg, and a 20 g dose is 200 g of solution.
"""
from __future__ import annotations

from typing import Any

DEFAULT_G_PER_KG = 100.0
DEFAULT_RESERVE_G = 100.0


def stock_g_per_kg(fert: dict[str, Any]) -> float:
    v = float(fert.get("stock_g_per_kg", DEFAULT_G_PER_KG))
    if not 0 < v <= 1000:
        raise ValueError(f"fertigation.stock_g_per_kg must be between 0 and 1000 (got {v})")
    return v


def reserve_g(fert: dict[str, Any]) -> float:
    return float(fert.get("stock_reserve_g", DEFAULT_RESERVE_G))


def to_solution(fertilizer_g: float, g_per_kg: float) -> float:
    """Grams of stock solution that carry fertilizer_g of fertilizer."""
    return fertilizer_g * 1000.0 / g_per_kg


def to_fertilizer(solution_g: float, g_per_kg: float) -> float:
    return solution_g * g_per_kg / 1000.0


def available_fertilizer_g(stock_solution_g: float, fert: dict[str, Any]) -> float:
    """Fertilizer that can still be dosed from the bottle, keeping the reserve the pump cannot reach."""
    return max(0.0, to_fertilizer(stock_solution_g - reserve_g(fert), stock_g_per_kg(fert)))


def fertigation_meta(fert: dict[str, Any]) -> dict[str, float]:
    """What the app needs to show doses and the bottle in grams of fertilizer (GET /greenhouse)."""
    return {"stock_g_per_kg": stock_g_per_kg(fert), "stock_reserve_g": reserve_g(fert),
            "dose_g": float(fert.get("dose_g", 20)), "tolerance_g": float(fert.get("tolerance_g", 0.5))}


# Why a dose ended early, in plain words (alerts, the activity log and `ghctl hw dose`).
# The app has the same wording in app/src/contract/codes.ts (DOSE_STOP).
STOP_TEXT = {
    "LOAD_CELL_FAULT": "the load cell under the stock bottle gave no reading (check the HX711 wires: DT, SCK, VCC, GND)",
    "NO_FLOW": "the pump ran but the bottle did not get lighter (empty bottle, kinked tube or air in the line)",
    "TIMEOUT": "it took longer than the time limit",
    "INTERLOCK": "a safety lock came on (low reservoir, float switch or emergency stop)",
    "STOPPED": "Stop dose was pressed",
    "NO_DOSER": "the dosing pump is not set up on this controller",
    "PUMP_ERROR": "the controller could not drive the pump (see the controller log)",
}


def stop_text(reason: str | None) -> str:
    if not reason:
        return "it was stopped"
    return STOP_TEXT.get(reason, reason.replace("_", " ").lower())


def outcome_text(target_g: float, delivered_g: float, status: str, reason: str | None) -> str:
    """One sentence on how a dose ended, in grams of fertilizer."""
    if status == "complete":
        return f"Dose of {target_g:g} g complete: {delivered_g:g} g delivered."
    got = "with nothing delivered" if delivered_g <= 0 else f"after {delivered_g:g} of {target_g:g} g"
    return f"Dose of {target_g:g} g stopped {got}: {stop_text(reason)}."
