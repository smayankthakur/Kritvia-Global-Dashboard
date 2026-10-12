"""Demo API for recording the how-to videos: the real app with a fake AI model and fake Telegram, Meta,
Slack and MCP servers, so nothing leaves the machine. Needs the test database (run the API tests once)
and the same environment the tests use (DATABASE_URL, MASTER_KEK_B64, JWT_SECRET, …).

    cd apps/api && python ../../scripts/video/serve_demo.py      # then the web app on :3000
"""
import os, sys
os.environ["DISPATCH_MODE"] = "inline"
os.environ["PUBLIC_API_URL"] = "https://api.example.test"
os.environ["INBOUND_EMAIL_DOMAIN"] = "in.sitelytc.com"
os.environ["INBOUND_EMAIL_SECRET"] = "x" * 40
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../apps/api/tests"))
import httpx, uvicorn
from fakes import FakeLiteLLM
import test_telegram as TG
import test_whatsapp_templates as T
from kritvia_api.config import get_settings
from kritvia_api.engine.bootstrap import build_services
from kritvia_api.engine.context import set_services
from kritvia_api.services.model_router import ModelRouter, TierConfig
from kritvia_api.services.sandbox import LocalSandbox
from kritvia_api.services.telegram import TelegramClient
from kritvia_api.services.whatsapp import WhatsAppClient
from kritvia_api.main import app

F = FakeLiteLLM()
def classify(messages):
    return {"category": "enquiry", "summary": "The customer asks about sofa cleaning.", "needs_reply": True,
            "language": "en", "urgency": "medium", "wants_person": False}
def draft(messages):
    u = messages[-1]["content"]
    if "sofa" in u.lower() or "photo" in u.lower():
        return {"subject": "", "body": "Thanks Ravi! That stain should come out with a shampoo clean: ₹899 for a 3-seater. Shall we book Saturday?", "used_sources": [], "unsure": False}
    return {"subject": "", "body": "Hello Neha! Welcome to Clean Co. We do kitchen and sofa deep cleaning across Delhi. What can we help with?", "used_sources": [], "unsure": False}
F.on("You sort the business's incoming messages", classify)
F.on("You answer the business's", draft)
router = ModelRouter(TierConfig.load(get_settings().tiers_config_path), "http://litellm", "k", transport=httpx.MockTransport(F))
svc = build_services(dispatch_mode="inline", router=router, sandbox=LocalSandbox("ui"))
fake = TG.FakeTelegram()
svc.telegram = svc.messaging.telegram = TelegramClient(transport=httpx.MockTransport(fake))
svc.whatsapp = svc.messaging.whatsapp = WhatsAppClient("app-secret-123", "verify-me", transport=httpx.MockTransport(T.FakeGraph()))
from kritvia_api.services.slack import SlackClient
svc.slack = SlackClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, text="ok")))
from kritvia_api.services import mcp as _mcp
import test_assistant as TA
_mcp.transport = httpx.MockTransport(TA.FakeMcp(sse=True, token="demo-token"))
async def _public(host):
    return ["93.184.216.34"]
_mcp.resolve = _public
set_services(svc)

@app.get("/__tg_secret", include_in_schema=False)
async def tg_secret():
    return {"secret": (fake.webhook or {}).get("secret_token"), "token": TG.TOKEN}

uvicorn.run(app, port=8000, log_level="warning")
