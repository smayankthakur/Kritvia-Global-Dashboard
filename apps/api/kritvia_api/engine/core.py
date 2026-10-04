"""Workflow definitions: a workflow is a named graph of async steps.

    wf = Workflow("lead_triage", title="Inbound lead triage", start="extract")

    @wf.step("extract", agent="extraction")
    async def extract(ctx: RunContext, state: dict) -> StepResult:
        ...
        return Goto("score", update={"requirements": reqs})

A step returns exactly one of:

  Goto(step)        continue with another step (state is checkpointed first)
  Interrupt(req)    pause for a human decision on a draft action; the run is
                    checkpointed as 'waiting' and resumes at `resume` when an
                    authorised user approves/edits, or at `on_reject`
  Finish()          end the run

State is a JSON-serialisable dict, encrypted at rest with the venture DEK and
checkpointed after every step, so a run survives restarts and can wait for an
approval for days. Steps must be safe to re-run: if the worker dies mid-step
the step is executed again. Side effects that must not repeat (sending an
email) go through ToolRegistry, which enforces at-most-once per approval.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
import uuid
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from kritvia_api.engine.context import RunContext

VentureKind = Literal["general", "software", "finance", "kitchen"]


@dataclass
class ApprovalRequest:
    agent: str
    action: str                      # registered tool name, e.g. "gmail.send"
    title: str
    payload: dict[str, Any]
    summary: str = ""
    key: str = "decision"            # state key the decision is written to
    required_roles: tuple[str, ...] = ("approver", "venture_admin")
    sensitive: bool = False
    expires_in_hours: int | None = 72
    # True: a person must look at this one even if the agent has earned autonomy for the action
    # (for example a reply that quotes internal documents to an outside sender).
    always_review: bool = False


@dataclass
class Goto:
    step: str
    update: dict[str, Any] = field(default_factory=dict)
    note: str | None = None


@dataclass
class Interrupt:
    request: ApprovalRequest
    resume: str
    on_reject: str | None = None     # None -> the run finishes with outcome 'rejected'
    update: dict[str, Any] = field(default_factory=dict)
    note: str | None = None


@dataclass
class Finish:
    outcome: str = "completed"
    update: dict[str, Any] = field(default_factory=dict)
    note: str | None = None


StepResult = Goto | Interrupt | Finish
StepFn = Callable[["RunContext", dict[str, Any]], Awaitable[StepResult]]


@dataclass
class StepSpec:
    name: str
    fn: StepFn
    agent: str


@dataclass(frozen=True)
class Option:
    """A setting a business can change from the Agents page without touching JSON.
    `key` is the settings key; `default` is what the workflow uses when unset."""
    key: str
    label: str
    type: Literal["boolean", "number", "text"]
    default: Any
    help: str = ""
    min: float | None = None
    max: float | None = None


class WorkflowDefinitionError(Exception):
    pass


class Workflow:
    def __init__(
        self,
        name: str,
        *,
        title: str,
        start: str,
        description: str = "",
        venture_kinds: tuple[VentureKind, ...] = ("general", "software", "finance", "kitchen"),
        version: int = 1,
        max_steps: int = 60,
        authorize_input: Callable[[Any, uuid.UUID, dict[str, Any]], Awaitable[None]] | None = None,
        options: tuple[Option, ...] = (),
        trigger: str = "manual",
    ) -> None:
        """authorize_input(conn, venture_id, input) runs in the STARTING USER's RLS
        transaction and must raise LookupError if the input references records that
        user cannot see — agents run with wider access, so a human must not be able
        to point them at data the human couldn't read themselves."""
        self.authorize_input = authorize_input
        self.name, self.title, self.start, self.description = name, title, start, description
        self.venture_kinds, self.version, self.max_steps = venture_kinds, version, max_steps
        self.options, self.trigger = options, trigger   # trigger: what starts it, for the Agents page
        self.steps: dict[str, StepSpec] = {}

    def defaults(self) -> dict[str, Any]:
        return {o.key: o.default for o in self.options}

    def step(self, name: str, *, agent: str = "orchestrator") -> Callable[[StepFn], StepFn]:
        def register(fn: StepFn) -> StepFn:
            if name in self.steps:
                raise WorkflowDefinitionError(f"{self.name}: duplicate step {name!r}")
            self.steps[name] = StepSpec(name, fn, agent)
            return fn
        return register

    def validate(self) -> None:
        if self.start not in self.steps:
            raise WorkflowDefinitionError(f"{self.name}: start step {self.start!r} is not defined")


class WorkflowRegistry:
    def __init__(self) -> None:
        self._wfs: dict[str, Workflow] = {}

    def register(self, wf: Workflow) -> Workflow:
        """Register at import time; steps are attached afterwards by decorators,
        so validation happens in validate_all() (called at bootstrap and in tests)."""
        if wf.name in self._wfs:
            raise WorkflowDefinitionError(f"workflow {wf.name!r} registered twice")
        self._wfs[wf.name] = wf
        return wf

    def get(self, name: str) -> Workflow:
        try:
            return self._wfs[name]
        except KeyError:
            raise WorkflowDefinitionError(f"unknown workflow {name!r}") from None

    def validate_all(self) -> None:
        for wf in self._wfs.values():
            wf.validate()

    def __contains__(self, name: str) -> bool:
        return name in self._wfs

    def all(self) -> list[Workflow]:
        return sorted(self._wfs.values(), key=lambda w: w.name)


registry = WorkflowRegistry()
