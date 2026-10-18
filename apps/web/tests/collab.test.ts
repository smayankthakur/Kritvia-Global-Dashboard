import { collaborators, colourFor, initials, membersOf, NO_TEAM, reasons, TEAM_COLOR, topPairs, type Collab, type CollabLink } from "@/lib/collab";

const link = (source: string, target: string, kind: CollabLink["kind"], over: Partial<CollabLink> = {}): CollabLink => ({
  source,
  target,
  kind,
  strength: 1,
  shared_tasks: 0,
  handoffs: 0,
  meetings: 0,
  emails: 0,
  other_docs: 0,
  mentions: 0,
  same_team: false,
  is_lead: false,
  teams: [],
  projects: [],
  evidence: [],
  ...over,
});

const g: Collab = {
  days: 90,
  truncated: false,
  boards: [{ id: "b1", name: "Acme rollout", color: "blue" }],
  teams: [
    { id: "t:t2", team_id: "t2", name: "Sales", color: "yellow", members: 1 },
    { id: "t:t1", team_id: "t1", name: "Platform", color: "green", members: 2 },
  ],
  projects: [{ id: "p:b1", board_id: "b1", name: "Acme rollout", team_id: "t1", people: 2, open_tasks: 3 }],
  people: [],
  links: [
    link("a", "b", "works_with", { strength: 5, shared_tasks: 2, handoffs: 1, meetings: 1, same_team: true }),
    link("a", "c", "works_with", { strength: 2, emails: 2 }),
    link("b", "c", "works_with", { strength: 9, other_docs: 1 }),
    link("a", "p:b1", "on_project"),
    link("b", "p:b1", "on_project"),
    link("a", "t:t1", "in_team"),
  ],
};

describe("who works with whom", () => {
  it("explains each link in plain words", () => {
    expect(reasons(g.links[0]!)).toEqual(["2 shared tasks", "1 task handed over", "1 meeting", "same team"]);
    expect(reasons(g.links[1]!)).toEqual(["2 emails"]);
    expect(reasons(g.links[2]!)).toEqual(["1 document"]);
  });

  it("ranks a person's collaborators and the closest pairs", () => {
    expect(collaborators(g, "a").map((l) => l.target)).toEqual(["b", "c"]);
    expect(topPairs(g, undefined, 2).map((l) => `${l.source}-${l.target}`)).toEqual(["b-c", "a-b"]);
    expect(topPairs(g, membersOf(g, "p:b1")).map((l) => `${l.source}-${l.target}`)).toEqual(["a-b"]);
    expect([...membersOf(g, "t:t1")]).toEqual(["a"]);
  });

  it("colours by the first team by name, else neutral", () => {
    const teams = g.teams.map((t) => ({ id: t.team_id, name: t.name, color: t.color }));
    expect(colourFor(["t2", "t1"], teams)).toBe(TEAM_COLOR.green);
    expect(colourFor([], teams)).toBe(NO_TEAM);
  });

  it("makes initials from any script", () => {
    expect(initials("Priya Sharma")).toBe("PS");
    expect(initials("rohit")).toBe("R");
    expect(initials("आरव मेहता")).toBe("आम");
    expect(initials("  ")).toBe("?");
  });
});
