"""Mind map: the graph endpoint returns entities and the links between them, scoped by venture."""
from __future__ import annotations


def script(fake):
    fake.on("You build a company knowledge graph", {
        "entities": [{"name": "Orbit Clinics", "type": "company"}, {"name": "Neha Rao", "type": "person"},
                     {"name": "Clinic Website", "type": "project"}, {"name": "Lone Vendor", "type": "vendor"}],
        "edges": [{"src": "Neha Rao", "dst": "Orbit Clinics", "type": "works at", "source": 0},
                  {"src": "Orbit Clinics", "dst": "Clinic Website", "type": "commissioned", "source": 0}],
        "facts": [{"statement": "Neha Rao runs operations at Orbit Clinics", "kind": "fact",
                   "subject": "Neha Rao", "source": 0}]})


async def test_graph_overview_focus_and_isolation(world, fake_llm):
    alice, v = world["alice"], world["site"]
    script(fake_llm)
    r = await alice.post(f"/ventures/{v}/notes", json={
        "title": "Orbit kickoff", "text": "Neha Rao from Orbit Clinics commissioned a clinic website.", "kind": "note"})
    assert r.status_code == 201, r.text

    g = (await alice.get(f"/ventures/{v}/graph")).json()
    names = {n["name"]: n for n in g["nodes"]}
    assert {"Orbit Clinics", "Neha Rao", "Clinic Website"} <= set(names)
    assert names["Orbit Clinics"]["degree"] >= 2 and names["Neha Rao"]["facts"] >= 1
    ids = {n["id"] for n in g["nodes"]}
    assert all(l["source"] in ids and l["target"] in ids for l in g["links"])
    assert {l["type"] for l in g["links"]} >= {"WORKS_AT", "COMMISSIONED"}

    # focus: the person, their company, and the company's project (2 hops); not the unlinked vendor
    focus = names["Neha Rao"]["id"]
    f = (await alice.get(f"/ventures/{v}/graph?focus={focus}")).json()
    fn = [n["name"] for n in f["nodes"]]
    assert fn[0] == "Neha Rao" and {"Orbit Clinics", "Clinic Website"} <= set(fn) and "Lone Vendor" not in fn

    # search
    s = (await alice.get(f"/ventures/{v}/graph?q=orbit")).json()
    assert [n["name"] for n in s["nodes"]] == ["Orbit Clinics"]

    # another venture's member sees nothing
    assert (await world["bob"].get(f"/ventures/{v}/graph")).status_code == 404
