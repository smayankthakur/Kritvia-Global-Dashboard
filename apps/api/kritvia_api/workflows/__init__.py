"""Importing this package registers every workflow with the engine registry."""
from kritvia_api.workflows import (  # noqa: F401
    assistant, collections, inbox, kitchen, lead_triage, loan_verification, meeting, prospector, whatsapp_followup)
