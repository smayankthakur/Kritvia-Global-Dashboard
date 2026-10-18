"""Who works with whom: the mind map's "People & projects" view.

Built from what the viewer can already see (row-level security does the hiding):

  shared project tasks  two people both have cards on the same project board in the period
                        (the main "Tasks" board doesn't count: everyone's work lands there);
  handoffs              one person made a card and gave it to another (any board);
  meetings & emails     both are named in the same meeting, email or document (from the knowledge
                        graph: the people a document's facts and links are about, and task owners);
  same team             both are in one of the organisation's teams.

Person mentions in documents are matched to the organisation's people by full name, by email, or by
a first name that only one person has; anyone else named is an outside contact. Project mentions are
matched to boards by name. The strength of a pair is a simple, explained sum (no ranking of people):
shared tasks + 2 × handoffs + 2 × meetings/emails + 1 for a shared team.
"""
from __future__ import annotations

import itertools
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from kritvia_api.services.memory import canonical

MAX_PEOPLE_PER_DOC = 15     # a company-wide all-hands isn't evidence that everyone works together
MAX_DOCS_PER_LINK = 5
MAX_CONTACTS = 40
MAX_PEOPLE = 150
MEETING_KINDS = {"meeting", "transcript"}


@dataclass
class Person:
    id: str
    kind: str                     # member | contact
    name: str
    email: str | None = None
    teams: set[str] = field(default_factory=set)
    open_tasks: int = 0
    done_tasks: int = 0
    docs: set[str] = field(default_factory=set)
    outside: bool = False         # team view: not in the team


@dataclass
class Pair:
    shared_tasks: int = 0
    handoffs: int = 0
    projects: set[str] = field(default_factory=set)
    teams: set[str] = field(default_factory=set)
    docs: dict[str, dict[str, Any]] = field(default_factory=dict)

    def counts(self) -> dict[str, int]:
        c = {"meetings": 0, "emails": 0, "other_docs": 0}
        for d in self.docs.values():
            c["meetings" if d["kind"] in MEETING_KINDS else "emails" if d["kind"] == "email" else "other_docs"] += 1
        return c

    @property
    def strength(self) -> float:
        return self.shared_tasks + 2 * self.handoffs + 2 * len(self.docs) + (1 if self.teams else 0)


def _link(source: str, target: str, kind: str, strength: float, **kw: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"source": source, "target": target, "kind": kind, "strength": float(strength),
                           "shared_tasks": 0, "handoffs": 0, "meetings": 0, "emails": 0, "other_docs": 0,
                           "mentions": 0, "same_team": False, "is_lead": False, "teams": [], "projects": [],
                           "evidence": []}
    out.update(kw)
    return out


def _first(name: str) -> str:
    c = canonical(name)
    return c.split(" ")[0] if c else ""


def match_people(people: dict[str, dict[str, Any]]):
    """A function mapping a mentioned name/email to a member id (or None)."""
    by_full: dict[str, str] = {}
    by_email: dict[str, str] = {}
    firsts: dict[str, list[str]] = defaultdict(list)
    for uid, p in people.items():
        if p.get("full_name"):
            by_full.setdefault(canonical(p["full_name"]), uid)
            firsts[_first(p["full_name"])].append(uid)
        if p.get("email"):
            by_email[p["email"].lower()] = uid
            by_full.setdefault(canonical(p["email"].split("@")[0].replace(".", " ")), uid)

    def match(name: str | None, email: str | None = None) -> str | None:
        if email and email.lower() in by_email:
            return by_email[email.lower()]
        if not name:
            return None
        c = canonical(name)
        if c in by_full:
            return by_full[c]
        if " " not in c and len(firsts.get(c, [])) == 1:
            return firsts[c][0]
        return None

    return match


def build(*, people: dict[str, dict[str, Any]], teams: list[dict[str, Any]], members: list[dict[str, Any]],
          boards: list[dict[str, Any]], cards: list[dict[str, Any]], mentions: list[dict[str, Any]],
          project: str | None = None, team: str | None = None, use_tasks: bool = True, use_docs: bool = True,
          use_teams: bool = True, contacts: bool = True) -> dict[str, Any]:
    """people: {user_id: {full_name, email}} (the business's people)
    teams: [{id, name, color}]; members: [{team_id, user_id, is_lead}]
    boards: [{id, name, is_default, team_id}]
    cards: [{board_id, assignee_id, created_by, open, done}] (counts per board/assignee/creator)
    mentions: [{document_id, title, kind, created_at, entity_id, type, name, email}] (type person|project)
    """
    match = match_people(people)
    board_by_id = {str(b["id"]): b for b in boards}
    board_by_name = {canonical(b["name"]): str(b["id"]) for b in boards if not b["is_default"]}
    team_by_id = {str(t["id"]): t for t in teams}
    team_members: dict[str, set[str]] = defaultdict(set)
    leads: dict[str, set[str]] = defaultdict(set)
    for m in members:
        uid = str(m["user_id"])
        if uid in people and str(m["team_id"]) in team_by_id:
            team_members[str(m["team_id"])].add(uid)
            if m.get("is_lead"):
                leads[str(m["team_id"])].add(uid)

    # The filter: which boards, teams and documents count.
    focus_board = str(project) if project else None
    focus_team = str(team) if team else None
    if focus_board and focus_board not in board_by_id:
        focus_board = None
    if focus_team and focus_team not in team_by_id:
        focus_team = None
    if focus_board:
        counted_boards = {focus_board}
    elif focus_team:
        counted_boards = {bid for bid, b in board_by_id.items() if str(b.get("team_id") or "") == focus_team}
    else:
        counted_boards = set(board_by_id)
    if focus_board:
        bt = board_by_id[focus_board].get("team_id")
        counted_teams = {str(bt)} & set(team_by_id) if bt else set()
    else:
        counted_teams = {focus_team} if focus_team else set(team_by_id)

    nodes: dict[str, Person] = {}

    def member(uid: str) -> Person:
        if uid not in nodes:
            p = people[uid]
            nodes[uid] = Person(id=uid, kind="member", name=p.get("full_name") or p.get("email") or "Someone",
                                email=p.get("email"))
        return nodes[uid]

    pairs: dict[tuple[str, str], Pair] = defaultdict(Pair)
    on_project: dict[tuple[str, str], dict[str, int]] = defaultdict(lambda: {"tasks": 0, "docs": 0})

    def pair(a: str, b: str) -> Pair:
        return pairs[(a, b) if a < b else (b, a)]

    # Tasks.
    if use_tasks:
        per_board: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        for c in cards:
            bid = str(c["board_id"])
            if bid not in counted_boards:
                continue
            a = str(c["assignee_id"]) if c.get("assignee_id") else None
            by = str(c["created_by"]) if c.get("created_by") else None
            n = int(c.get("open", 0)) + int(c.get("done", 0))
            if a and a in people:
                pp = member(a)
                pp.open_tasks += int(c.get("open", 0))
                pp.done_tasks += int(c.get("done", 0))
                if not board_by_id[bid]["is_default"]:
                    per_board[bid][a] += n
                    on_project[(a, bid)]["tasks"] += n
            if a and by and a != by and a in people and by in people:
                member(by)
                pr = pair(a, by)
                pr.handoffs += n
                if not board_by_id[bid]["is_default"]:
                    pr.projects.add(bid)
        for bid, who in per_board.items():
            for a, b in itertools.combinations(sorted(who), 2):
                pr = pair(a, b)
                pr.shared_tasks += min(who[a], who[b])
                pr.projects.add(bid)

    # Meetings, emails and documents.
    if use_docs:
        docs: dict[str, dict[str, Any]] = {}
        in_doc: dict[str, set[str]] = defaultdict(set)
        projects_in_doc: dict[str, set[str]] = defaultdict(set)
        contact_names: dict[str, str] = {}
        for m in mentions:
            did = str(m["document_id"])
            docs.setdefault(did, {"id": did, "title": m["title"], "kind": m["kind"],
                                  "date": m["created_at"].isoformat() if isinstance(m["created_at"], datetime) else m["created_at"]})
            if m["type"] == "project":
                bid = board_by_name.get(canonical(m["name"] or ""))
                if bid:
                    projects_in_doc[did].add(bid)
                continue
            uid = match(m.get("name"), m.get("email"))
            if uid:
                in_doc[did].add(uid)
            elif contacts and m.get("name"):
                key = "c:" + canonical(m["name"])
                if len(key) > 2:
                    contact_names.setdefault(key, m["name"])
                    in_doc[did].add(key)
        for did, who in in_doc.items():
            if focus_board and focus_board not in projects_in_doc[did]:
                continue
            if focus_team and not (who & team_members[focus_team]) and not (projects_in_doc[did] & counted_boards):
                continue
            if not any(not w.startswith("c:") for w in who):
                continue        # only outside contacts: not about the team's work
            for w in who:
                if w.startswith("c:"):
                    if w not in nodes:
                        nodes[w] = Person(id=w, kind="contact", name=contact_names[w])
                else:
                    member(w)
                nodes[w].docs.add(did)
                for bid in projects_in_doc[did] & counted_boards:
                    on_project[(w, bid)]["docs"] += 1
            if len(who) > MAX_PEOPLE_PER_DOC:
                continue
            for a, b in itertools.combinations(sorted(who), 2):
                pr = pair(a, b)
                pr.docs[did] = docs[did]
                pr.projects |= projects_in_doc[did] & counted_boards

    # Teams.
    if use_teams:
        for tid in counted_teams:
            for uid in team_members.get(tid, ()):
                member(uid).teams.add(tid)
            for a, b in itertools.combinations(sorted(team_members.get(tid, ())), 2):
                pair(a, b).teams.add(tid)
    for tid, uids in team_members.items():      # chips: every team a shown person is in
        for uid in uids:
            if uid in nodes:
                nodes[uid].teams.add(tid)

    # Narrow to the filter.
    if focus_board:
        team_of_board = str(board_by_id[focus_board].get("team_id") or "")
        keep = {p for (p, b) in on_project if b == focus_board}
        keep |= team_members.get(team_of_board, set()) if use_teams else set()
        keep |= {w for (a, b), pr in pairs.items() if focus_board in pr.projects for w in (a, b)}
    elif focus_team:
        core = team_members.get(focus_team, set())
        keep = set(core) | {p for (p, b) in on_project if b in counted_boards}
        keep |= {w for (a, b), pr in pairs.items() if (a in core or b in core) for w in (a, b)}
        for p in keep - core:
            if p in nodes:
                nodes[p].outside = True
    else:
        keep = set(nodes)
    keep &= set(nodes)

    # Contacts only when they connect to someone shown; cap the size.
    contact_ids = sorted((k for k in keep if k.startswith("c:")), key=lambda k: -len(nodes[k].docs))[:MAX_CONTACTS]
    keep = {k for k in keep if not k.startswith("c:")} | set(contact_ids)
    strength: dict[str, float] = defaultdict(float)
    for (a, b), pr in pairs.items():
        if a in keep and b in keep:
            strength[a] += pr.strength
            strength[b] += pr.strength
    truncated = False
    if len(keep) > MAX_PEOPLE:
        truncated = True
        keep = set(sorted(keep, key=lambda k: (-strength[k], nodes[k].name))[:MAX_PEOPLE])

    core = team_members.get(focus_team, set()) if focus_team else set()
    links: list[dict[str, Any]] = []
    for (a, b), pr in sorted(pairs.items(), key=lambda kv: -kv[1].strength):
        if a not in keep or b not in keep or pr.strength <= 0:
            continue
        if focus_team and a not in core and b not in core and not (pr.projects & counted_boards):
            continue        # two outsiders working together on something else isn't the team's story
        docs_sorted = sorted(pr.docs.values(), key=lambda d: d["date"] or "", reverse=True)
        links.append(_link(a, b, "works_with", pr.strength, shared_tasks=pr.shared_tasks, handoffs=pr.handoffs,
                           **pr.counts(), same_team=bool(pr.teams), teams=sorted(pr.teams),
                           projects=sorted(pr.projects), evidence=docs_sorted[:MAX_DOCS_PER_LINK]))
    shown_projects: set[str] = set()
    for (p, bid), w in on_project.items():
        if p in keep and bid in counted_boards and (w["tasks"] or w["docs"]):
            shown_projects.add(bid)
            links.append(_link(p, "p:" + bid, "on_project", w["tasks"] + 2 * w["docs"], shared_tasks=w["tasks"],
                               mentions=w["docs"], projects=[bid]))
    if focus_board:
        shown_projects.add(focus_board)
    shown_teams: set[str] = set()
    if use_teams:
        for tid in counted_teams:
            ms = [u for u in team_members.get(tid, ()) if u in keep]
            if ms or tid == focus_team:
                shown_teams.add(tid)
            for u in ms:
                links.append(_link(u, "t:" + tid, "in_team", 1, same_team=True, teams=[tid], is_lead=u in leads[tid]))
        for bid in shown_projects:
            tid = str(board_by_id[bid].get("team_id") or "")
            if tid in shown_teams:
                links.append(_link("p:" + bid, "t:" + tid, "project_team", 1, teams=[tid], projects=[bid]))

    people_out = []
    for k in sorted(keep, key=lambda k: (nodes[k].kind != "member", nodes[k].name.lower())):
        n = nodes[k]
        people_out.append({"id": n.id, "kind": n.kind, "name": n.name, "email": n.email, "teams": sorted(n.teams),
                           "open_tasks": n.open_tasks, "done_tasks": n.done_tasks, "documents": len(n.docs),
                           "outside": n.outside, "strength": strength[k],
                           "leads": sorted(t for t in n.teams if k in leads[t])})
    project_people: dict[str, int] = defaultdict(int)
    project_open: dict[str, int] = defaultdict(int)
    for (p, bid), w in on_project.items():
        if p in keep:
            project_people[bid] += 1
    for c in cards:
        if str(c["board_id"]) in shown_projects:
            project_open[str(c["board_id"])] += int(c.get("open", 0))
    projects_out = [{"id": "p:" + bid, "board_id": bid, "name": board_by_id[bid]["name"],
                     "team_id": str(board_by_id[bid]["team_id"]) if board_by_id[bid].get("team_id") else None,
                     "people": project_people[bid], "open_tasks": project_open[bid]}
                    for bid in sorted(shown_projects, key=lambda b: board_by_id[b]["name"].lower())]
    teams_out = [{"id": "t:" + tid, "team_id": tid, "name": team_by_id[tid]["name"], "color": team_by_id[tid]["color"],
                  "members": len(team_members.get(tid, ()))}
                 for tid in sorted(shown_teams, key=lambda t: team_by_id[t]["name"].lower())]
    return {"people": people_out, "projects": projects_out, "teams": teams_out, "links": links, "truncated": truncated}

