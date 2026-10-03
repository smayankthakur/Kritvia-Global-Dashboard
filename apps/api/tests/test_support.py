from kritvia_api.config import get_settings
from kritvia_api.services.mailer import get_mailer


async def test_contact_form_stores_and_emails(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "support_inbox", "help@sitelytc.example")
    r = await client.post("/public/support", json={"name": "Ravi", "email": "ravi@example.com", "topic": "billing",
                                                    "message": "How do I get a GST invoice?"})
    assert r.status_code == 202 and len(r.json()["reference"]) == 8
    mail = [m for m in get_mailer().outbox if m["To"] == "help@sitelytc.example"][-1]
    assert "[Kritvia billing] Ravi" == mail["Subject"] and "GST invoice" in mail.get_content()
    trap = await client.post("/public/support", json={"name": "Bot", "email": "b@example.com", "message": "hello world",
                                                       "website": "http://spam"})
    assert trap.status_code == 202 and "reference" not in trap.json()
    assert (await client.post("/public/support", json={"name": "x", "email": "bad", "message": "hello"})).status_code == 422
