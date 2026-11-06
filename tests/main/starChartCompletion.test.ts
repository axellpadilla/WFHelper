import { describe, expect, it } from "vitest";

import * as masteryHelper from "../../services/masteryHelper";

// The in-game profile and Teshin's Steel Path check count 238 Origin System
// nodes plus 13 Junctions. Zero-mastery nodes (Void, Lua, Kuva Fortress,
// Deimos, Dark Sectors) still count.
const STAR_CHART_NODES = 238;
const JUNCTIONS = 13;

function completion(missions: Array<Record<string, unknown>>) {
  return masteryHelper.computeMasteryProgress({ Missions: missions }).stats.completion.starChart;
}

describe("star chart completion", () => {
  it("counts the Steel Path unlock set, not only nodes that grant mastery", () => {
    const chart = completion([]);
    expect(chart.normal.total).toBe(STAR_CHART_NODES);
    expect(chart.steelPath.total).toBe(STAR_CHART_NODES);
    expect(chart.junctions.total).toBe(JUNCTIONS);
    expect(chart.steelPathJunctions.total).toBe(JUNCTIONS);
  });

  it("counts zero-mastery and quest-locked nodes Teshin requires", () => {
    const chart = completion([
      { Tag: "SolNode400", Completes: 1 }, // Teshub, Void
      { Tag: "SolNode300", Completes: 1 }, // Plato, Lua
      { Tag: "SolNode741", Completes: 1 }, // Koro, Kuva Fortress
      { Tag: "SolNode229", Completes: 1 }, // Cambion Drift, Deimos
      { Tag: "ClanNode1", Completes: 1 }, // Malva, Venus dark sector
      { Tag: "SolNode451", Completes: 1 }, // Saya's Visions, Earth
      { Tag: "SolNode450", Completes: 1 }, // Tyana Pass, Mars
      { Tag: "SolNode239", Completes: 1 }, // Vesper Relay (Follie's Hunt), Venus
      { Tag: "SolNode740", Completes: 1, Tier: 1 }, // The Ropalolyst, Steel Path too
    ]);
    expect(chart.normal.done).toBe(9);
    expect(chart.steelPath.done).toBe(1);
  });

  it("leaves out nodes outside the Steel Path unlock", () => {
    const chart = completion([
      { Tag: "SolNode701", Completes: 1 }, // Jordas Golem Assassinate
      { Tag: "SolNode705", Completes: 1 }, // Mutalist Alad V Assassinate
      { Tag: "SolNode723", Completes: 1 }, // Brutus, hidden
      { Tag: "SolNode715", Completes: 1 }, // Effervo, Albrecht's Laboratories
      { Tag: "NokkoColony", Completes: 1 }, // Deepmines
      { Tag: "SolNode230", Completes: 1 }, // Everview Arc, Zariman
      { Tag: "SolNode236", Completes: 1 }, // The Duviri Experience
      { Tag: "SolNode850", Completes: 1 }, // Legacyte Harvest, Hollvania
      { Tag: "SolNode250", Completes: 1 }, // Recall: Hunhullus, Dark Refractory
      { Tag: "CrewBattleNode502", Completes: 1 }, // Sover Strait, Railjack
      { Tag: "SolNode801", Completes: 1 }, // Sanctuary Onslaught
      { Tag: "MercuryHUB", Completes: 1 }, // Larunda Relay
    ]);
    expect(chart.normal.done).toBe(0);
    expect(chart.junctions.done).toBe(0);
  });

  it("counts junctions separately from nodes", () => {
    const chart = completion([
      { Tag: "EarthToVenusJunction", Completes: 1, Tier: 1 },
      { Tag: "VenusToMercuryJunction", Completes: 1 },
    ]);
    expect(chart.junctions.done).toBe(2);
    expect(chart.steelPathJunctions.done).toBe(1);
    expect(chart.normal.done).toBe(0);
  });
});
