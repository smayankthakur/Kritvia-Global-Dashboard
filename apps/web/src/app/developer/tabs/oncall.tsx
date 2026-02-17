"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  HolidayCalendar,
  HolidayEntry,
  OnCallMember,
  OnCallOverride,
  OnCallSchedule,
  createHolidayCalendar,
  createHolidayEntry,
  createOnCallMember,
  createOnCallOverride,
  createOnCallSchedule,
  deleteHolidayEntry,
  deleteOnCallSchedule,
  linkOnCallScheduleCalendar,
  listHolidayCalendars,
  listHolidayEntries,
  deleteOnCallMember,
  deleteOnCallOverride,
  unlinkOnCallScheduleCalendar,
  getOnCallNow,
  listManagedUsers,
  listOnCallMembers,
  listOnCallOverrides,
  listOnCallSchedules,
  updateOnCallMember,
  updateOnCallSchedule
} from "../../../lib/api";

interface OnCallTabProps {
  token: string;
}

export function OnCallTab({ token }: OnCallTabProps) {
  const [schedules, setSchedules] = useState<OnCallSchedule[]>([]);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string>("");
  const [members, setMembers] = useState<OnCallMember[]>([]);
  const [overrides, setOverrides] = useState<OnCallOverride[]>([]);
  const [calendars, setCalendars] = useState<HolidayCalendar[]>([]);
  const [calendarEntries, setCalendarEntries] = useState<HolidayEntry[]>([]);
  const [selectedCalendarId, setSelectedCalendarId] = useState<string>("");
  const [users, setUsers] = useState<Array<{ id: string; name: string; email: string; role: string }>>([]);
  const [nowState, setNowState] = useState<{
    scheduleId: string | null;
    activeScheduleId?: string | null;
    inCoverageWindow?: boolean;
    isHoliday?: boolean;
    primary: { id: string; name: string; email: string; role: string } | null;
    secondary: { id: string; name: string; email: string; role: string } | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [newScheduleName, setNewScheduleName] = useState("Primary Rotation");
  const [newScheduleTz, setNewScheduleTz] = useState("UTC");
  const [newScheduleInterval, setNewScheduleInterval] = useState<"DAILY" | "WEEKLY">("WEEKLY");
  const [newScheduleHour, setNewScheduleHour] = useState(10);
  const [newScheduleCoverageEnabled, setNewScheduleCoverageEnabled] = useState(false);
  const [newScheduleCoverageStart, setNewScheduleCoverageStart] = useState("10:00");
  const [newScheduleCoverageEnd, setNewScheduleCoverageEnd] = useState("19:00");
  const [newScheduleCoverageDays] = useState<string[]>([
    "MON",
    "TUE",
    "WED",
    "THU",
    "FRI"
  ]);

  const [memberUserId, setMemberUserId] = useState("");
  const [memberTier, setMemberTier] = useState<"PRIMARY" | "SECONDARY">("PRIMARY");
  const [memberOrder, setMemberOrder] = useState(1);

  const [overrideTier, setOverrideTier] = useState<"PRIMARY" | "SECONDARY">("PRIMARY");
  const [overrideToUserId, setOverrideToUserId] = useState("");
  const [overrideStartAt, setOverrideStartAt] = useState("");
  const [overrideEndAt, setOverrideEndAt] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [newCalendarName, setNewCalendarName] = useState("Default Holidays");
  const [newCalendarTimezone, setNewCalendarTimezone] = useState("UTC");
  const [newHolidayStartDate, setNewHolidayStartDate] = useState("");
  const [newHolidayEndDate, setNewHolidayEndDate] = useState("");
  const [newHolidayTitle, setNewHolidayTitle] = useState("");
  const [linkCalendarId, setLinkCalendarId] = useState("");

  const selectedSchedule = useMemo(
    () => schedules.find((entry) => entry.id === selectedScheduleId) ?? null,
    [selectedScheduleId, schedules]
  );

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [scheduleRows, managedUsers, now, holidayCalendars] = await Promise.all([
        listOnCallSchedules(token),
        listManagedUsers(token, { active: "active", page: 1, pageSize: 100 }),
        getOnCallNow(token),
        listHolidayCalendars(token)
      ]);
      setSchedules(scheduleRows);
      setNowState(now);
      setCalendars(holidayCalendars);
      const nextCalendar = holidayCalendars[0]?.id ?? "";
      setSelectedCalendarId((current) => current || nextCalendar);
      setUsers(
        managedUsers.items.map((entry) => ({
          id: entry.id,
          name: entry.name,
          email: entry.email ?? "",
          role: entry.role
        }))
      );
      const nextSelected = scheduleRows[0]?.id ?? "";
      setSelectedScheduleId((current) => current || nextSelected);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setError("Upgrade required for on-call management.");
      } else {
        setError(requestFailure instanceof Error ? requestFailure.message : "Failed to load on-call data");
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  const loadScheduleDetails = useCallback(async () => {
    if (!selectedScheduleId) {
      setMembers([]);
      setOverrides([]);
      return;
    }
    try {
      const [memberRows, overrideRows] = await Promise.all([
        listOnCallMembers(token, selectedScheduleId),
        listOnCallOverrides(token, selectedScheduleId)
      ]);
      setMembers(memberRows);
      setOverrides(overrideRows);
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to load schedule details");
    }
  }, [selectedScheduleId, token]);

  const loadCalendarEntries = useCallback(async () => {
    if (!selectedCalendarId) {
      setCalendarEntries([]);
      return;
    }
    try {
      const rows = await listHolidayEntries(token, selectedCalendarId);
      setCalendarEntries(rows);
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to load holiday entries");
    }
  }, [selectedCalendarId, token]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    void loadScheduleDetails();
  }, [loadScheduleDetails]);

  useEffect(() => {
    void loadCalendarEntries();
  }, [loadCalendarEntries]);

  async function refreshNowState(): Promise<void> {
    const now = await getOnCallNow(token);
    setNowState(now);
  }

  async function onCreateSchedule(): Promise<void> {
    try {
      await createOnCallSchedule(token, {
        name: newScheduleName,
        timezone: newScheduleTz,
        handoffInterval: newScheduleInterval,
        handoffHour: newScheduleHour,
        coverageEnabled: newScheduleCoverageEnabled,
        coverageDays: newScheduleCoverageDays,
        coverageStart: newScheduleCoverageEnabled ? newScheduleCoverageStart : undefined,
        coverageEnd: newScheduleCoverageEnabled ? newScheduleCoverageEnd : undefined
      });
      await loadAll();
      setToast("Schedule created.");
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to create schedule");
    }
  }

  async function onSaveSchedule(): Promise<void> {
    if (!selectedSchedule) {
      return;
    }
    try {
      await updateOnCallSchedule(token, selectedSchedule.id, {
        name: selectedSchedule.name,
        timezone: selectedSchedule.timezone,
        handoffInterval: selectedSchedule.handoffInterval,
        handoffHour: selectedSchedule.handoffHour,
        isEnabled: selectedSchedule.isEnabled,
        coverageEnabled: selectedSchedule.coverageEnabled ?? false,
        coverageDays: selectedSchedule.coverageDays ?? undefined,
        coverageStart:
          selectedSchedule.coverageEnabled && selectedSchedule.coverageStart
            ? selectedSchedule.coverageStart
            : undefined,
        coverageEnd:
          selectedSchedule.coverageEnabled && selectedSchedule.coverageEnd
            ? selectedSchedule.coverageEnd
            : undefined,
        fallbackScheduleId: selectedSchedule.fallbackScheduleId ?? null
      });
      await Promise.all([loadAll(), loadScheduleDetails()]);
      setToast("Schedule updated.");
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to update schedule");
    }
  }

  async function onDisableSchedule(): Promise<void> {
    if (!selectedSchedule) {
      return;
    }
    try {
      await deleteOnCallSchedule(token, selectedSchedule.id);
      await loadAll();
      setToast("Schedule disabled.");
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to disable schedule");
    }
  }

  async function onCreateMember(): Promise<void> {
    if (!selectedScheduleId || !memberUserId) {
      return;
    }
    try {
      await createOnCallMember(token, selectedScheduleId, {
        userId: memberUserId,
        tier: memberTier,
        order: memberOrder
      });
      await Promise.all([loadScheduleDetails(), refreshNowState()]);
      setToast("Member added.");
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to add member");
    }
  }

  async function onMoveMember(member: OnCallMember, delta: number): Promise<void> {
    try {
      const nextOrder = Math.max(1, member.order + delta);
      await updateOnCallMember(token, member.id, { order: nextOrder });
      await loadScheduleDetails();
      setToast("Member order updated.");
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to update member");
    }
  }

  async function onRemoveMember(memberId: string): Promise<void> {
    try {
      await deleteOnCallMember(token, memberId);
      await Promise.all([loadScheduleDetails(), refreshNowState()]);
      setToast("Member removed.");
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to remove member");
    }
  }

  async function onCreateOverride(): Promise<void> {
    if (!selectedScheduleId || !overrideToUserId || !overrideStartAt || !overrideEndAt) {
      return;
    }
    try {
      await createOnCallOverride(token, {
        scheduleId: selectedScheduleId,
        tier: overrideTier,
        toUserId: overrideToUserId,
        startAt: new Date(overrideStartAt).toISOString(),
        endAt: new Date(overrideEndAt).toISOString(),
        reason: overrideReason || undefined
      });
      await Promise.all([loadScheduleDetails(), refreshNowState()]);
      setToast("Override created.");
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to create override");
    }
  }

  async function onDeleteOverride(overrideId: string): Promise<void> {
    try {
      await deleteOnCallOverride(token, overrideId);
      await Promise.all([loadScheduleDetails(), refreshNowState()]);
      setToast("Override removed.");
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to remove override");
    }
  }

  async function onCreateCalendar(): Promise<void> {
    try {
      await createHolidayCalendar(token, { name: newCalendarName, timezone: newCalendarTimezone });
      await loadAll();
      setToast("Holiday calendar created.");
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to create holiday calendar");
    }
  }

  async function onCreateHolidayEntry(): Promise<void> {
    if (!selectedCalendarId || !newHolidayStartDate) {
      return;
    }
    try {
      await createHolidayEntry(token, selectedCalendarId, {
        startDate: newHolidayStartDate,
        endDate: newHolidayEndDate || undefined,
        title: newHolidayTitle || undefined
      });
      await loadCalendarEntries();
      setToast("Holiday added.");
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to add holiday");
    }
  }

  async function onDeleteHolidayEntry(entryId: string): Promise<void> {
    try {
      await deleteHolidayEntry(token, entryId);
      await loadCalendarEntries();
      setToast("Holiday removed.");
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to remove holiday");
    }
  }

  async function onLinkCalendarToSchedule(): Promise<void> {
    if (!selectedScheduleId || !linkCalendarId) {
      return;
    }
    try {
      await linkOnCallScheduleCalendar(token, selectedScheduleId, linkCalendarId);
      await Promise.all([loadAll(), loadScheduleDetails()]);
      setToast("Calendar linked.");
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to link calendar");
    }
  }

  async function onUnlinkCalendarFromSchedule(calendarId: string): Promise<void> {
    if (!selectedScheduleId) {
      return;
    }
    try {
      await unlinkOnCallScheduleCalendar(token, selectedScheduleId, calendarId);
      await Promise.all([loadAll(), loadScheduleDetails()]);
      setToast("Calendar unlinked.");
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to unlink calendar");
    }
  }

  function toggleCoverageDay(day: string): void {
    setSchedules((current) =>
      current.map((entry) => {
        if (entry.id !== selectedScheduleId) {
          return entry;
        }
        const existing = new Set(entry.coverageDays ?? []);
        if (existing.has(day)) {
          existing.delete(day);
        } else {
          existing.add(day);
        }
        return { ...entry, coverageDays: Array.from(existing) };
      })
    );
  }

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <section className="kv-stack" aria-live="polite">
      {error ? <p className="kv-error">{error}</p> : null}
      {toast ? <p style={{ color: "var(--warning-color)", margin: 0 }}>{toast}</p> : null}

      <div className="kv-card">
        <h2 className="kv-section-title" style={{ marginTop: 0 }}>
          Who&apos;s on-call now
        </h2>
        {loading ? (
          <p>Loading...</p>
        ) : (
          <div className="kv-row" style={{ gap: "20px", flexWrap: "wrap" }}>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>Active schedule</p>
              <p style={{ margin: 0 }}>{nowState?.activeScheduleId ?? nowState?.scheduleId ?? "-"}</p>
            </div>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>In coverage window</p>
              <p style={{ margin: 0 }}>{nowState?.inCoverageWindow ? "Yes" : "No"}</p>
            </div>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>Holiday</p>
              <p style={{ margin: 0 }}>{nowState?.isHoliday ? "Yes" : "No"}</p>
            </div>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>Primary</p>
              <p style={{ margin: 0 }}>
                {nowState?.primary ? `${nowState.primary.name} (${nowState.primary.email})` : "-"}
              </p>
            </div>
            <div>
              <p style={{ margin: 0, fontWeight: 600 }}>Secondary</p>
              <p style={{ margin: 0 }}>
                {nowState?.secondary ? `${nowState.secondary.name} (${nowState.secondary.email})` : "-"}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="kv-card">
        <h2 className="kv-section-title" style={{ marginTop: 0 }}>
          Schedules
        </h2>
        <div className="kv-row" style={{ flexWrap: "wrap", gap: "10px" }}>
          <input value={newScheduleName} onChange={(event) => setNewScheduleName(event.target.value)} placeholder="Schedule name" />
          <input value={newScheduleTz} onChange={(event) => setNewScheduleTz(event.target.value)} placeholder="Timezone" />
          <select value={newScheduleInterval} onChange={(event) => setNewScheduleInterval(event.target.value as "DAILY" | "WEEKLY")}>
            <option value="DAILY">DAILY</option>
            <option value="WEEKLY">WEEKLY</option>
          </select>
          <input type="number" min={0} max={23} value={newScheduleHour} onChange={(event) => setNewScheduleHour(Number(event.target.value))} />
          <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <input
              type="checkbox"
              checked={newScheduleCoverageEnabled}
              onChange={(event) => setNewScheduleCoverageEnabled(event.target.checked)}
            />
            Coverage
          </label>
          <input
            value={newScheduleCoverageStart}
            onChange={(event) => setNewScheduleCoverageStart(event.target.value)}
            placeholder="10:00"
          />
          <input
            value={newScheduleCoverageEnd}
            onChange={(event) => setNewScheduleCoverageEnd(event.target.value)}
            placeholder="19:00"
          />
          <button type="button" onClick={() => void onCreateSchedule()}>
            Create
          </button>
        </div>

        <div className="kv-table-wrap" style={{ marginTop: "12px" }}>
          <table>
            <thead>
              <tr>
                <th align="left">Name</th>
                <th align="left">Timezone</th>
                <th align="left">Interval</th>
                <th align="left">Handoff Hour</th>
                <th align="left">Enabled</th>
                <th align="left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.length === 0 ? (
                <tr>
                  <td colSpan={6}>No on-call schedules yet.</td>
                </tr>
              ) : (
                schedules.map((schedule) => (
                  <tr key={schedule.id}>
                    <td>{schedule.name}</td>
                    <td>{schedule.timezone}</td>
                    <td>{schedule.handoffInterval}</td>
                    <td>{schedule.handoffHour}</td>
                    <td>{schedule.isEnabled ? "Yes" : "No"}</td>
                    <td style={{ display: "flex", gap: "8px" }}>
                      <button type="button" onClick={() => setSelectedScheduleId(schedule.id)}>
                        Select
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedSchedule ? (
        <>
          <div className="kv-card">
            <h2 className="kv-section-title" style={{ marginTop: 0 }}>
              Schedule settings
            </h2>
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "10px" }}>
              <input
                value={selectedSchedule.name}
                onChange={(event) =>
                  setSchedules((current) =>
                    current.map((entry) =>
                      entry.id === selectedSchedule.id ? { ...entry, name: event.target.value } : entry
                    )
                  )
                }
              />
              <input
                value={selectedSchedule.timezone}
                onChange={(event) =>
                  setSchedules((current) =>
                    current.map((entry) =>
                      entry.id === selectedSchedule.id ? { ...entry, timezone: event.target.value } : entry
                    )
                  )
                }
              />
              <select
                value={selectedSchedule.handoffInterval}
                onChange={(event) =>
                  setSchedules((current) =>
                    current.map((entry) =>
                      entry.id === selectedSchedule.id
                        ? { ...entry, handoffInterval: event.target.value as "DAILY" | "WEEKLY" }
                        : entry
                    )
                  )
                }
              >
                <option value="DAILY">DAILY</option>
                <option value="WEEKLY">WEEKLY</option>
              </select>
              <input
                type="number"
                min={0}
                max={23}
                value={selectedSchedule.handoffHour}
                onChange={(event) =>
                  setSchedules((current) =>
                    current.map((entry) =>
                      entry.id === selectedSchedule.id ? { ...entry, handoffHour: Number(event.target.value) } : entry
                    )
                  )
                }
              />
              <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <input
                  type="checkbox"
                  checked={selectedSchedule.isEnabled}
                  onChange={(event) =>
                    setSchedules((current) =>
                      current.map((entry) =>
                        entry.id === selectedSchedule.id ? { ...entry, isEnabled: event.target.checked } : entry
                      )
                    )
                  }
                />
                Enabled
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <input
                  type="checkbox"
                  checked={selectedSchedule.coverageEnabled ?? false}
                  onChange={(event) =>
                    setSchedules((current) =>
                      current.map((entry) =>
                        entry.id === selectedSchedule.id
                          ? { ...entry, coverageEnabled: event.target.checked }
                          : entry
                      )
                    )
                  }
                />
                Coverage enabled
              </label>
              <input
                value={selectedSchedule.coverageStart ?? ""}
                onChange={(event) =>
                  setSchedules((current) =>
                    current.map((entry) =>
                      entry.id === selectedSchedule.id ? { ...entry, coverageStart: event.target.value } : entry
                    )
                  )
                }
                placeholder="10:00"
              />
              <input
                value={selectedSchedule.coverageEnd ?? ""}
                onChange={(event) =>
                  setSchedules((current) =>
                    current.map((entry) =>
                      entry.id === selectedSchedule.id ? { ...entry, coverageEnd: event.target.value } : entry
                    )
                  )
                }
                placeholder="19:00"
              />
              <select
                value={selectedSchedule.fallbackScheduleId ?? ""}
                onChange={(event) =>
                  setSchedules((current) =>
                    current.map((entry) =>
                      entry.id === selectedSchedule.id
                        ? { ...entry, fallbackScheduleId: event.target.value || null }
                        : entry
                    )
                  )
                }
              >
                <option value="">No fallback</option>
                {schedules
                  .filter((entry) => entry.id !== selectedSchedule.id)
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "8px" }}>
              {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((day) => (
                <button
                  key={day}
                  type="button"
                  className={(selectedSchedule.coverageDays ?? []).includes(day) ? "kv-dev-tab is-active" : "kv-dev-tab"}
                  onClick={() => toggleCoverageDay(day)}
                >
                  {day}
                </button>
              ))}
            </div>
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "10px" }}>
              <select value={linkCalendarId} onChange={(event) => setLinkCalendarId(event.target.value)}>
                <option value="">Select calendar to attach</option>
                {calendars.map((calendar) => (
                  <option key={calendar.id} value={calendar.id}>
                    {calendar.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void onLinkCalendarToSchedule()}>
                Attach calendar
              </button>
            </div>
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "8px" }}>
              {(selectedSchedule.calendars ?? []).map((link) => (
                <button
                  key={link.calendar.id}
                  type="button"
                  onClick={() => void onUnlinkCalendarFromSchedule(link.calendar.id)}
                >
                  {link.calendar.name} x
                </button>
              ))}
            </div>
            <div className="kv-row" style={{ marginTop: "10px" }}>
              <button type="button" onClick={() => void onSaveSchedule()}>
                Save schedule
              </button>
              <button type="button" onClick={() => void onDisableSchedule()}>
                Disable
              </button>
            </div>
          </div>

          <div className="kv-card">
            <h2 className="kv-section-title" style={{ marginTop: 0 }}>
              Rotation members
            </h2>
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "10px" }}>
              <select value={memberUserId} onChange={(event) => setMemberUserId(event.target.value)}>
                <option value="">Select user</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name} ({user.role})
                  </option>
                ))}
              </select>
              <select value={memberTier} onChange={(event) => setMemberTier(event.target.value as "PRIMARY" | "SECONDARY")}>
                <option value="PRIMARY">PRIMARY</option>
                <option value="SECONDARY">SECONDARY</option>
              </select>
              <input type="number" min={1} value={memberOrder} onChange={(event) => setMemberOrder(Number(event.target.value))} />
              <button type="button" onClick={() => void onCreateMember()}>
                Add member
              </button>
            </div>

            <div className="kv-table-wrap" style={{ marginTop: "12px" }}>
              <table>
                <thead>
                  <tr>
                    <th align="left">Tier</th>
                    <th align="left">Order</th>
                    <th align="left">User</th>
                    <th align="left">Status</th>
                    <th align="left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {members.length === 0 ? (
                    <tr>
                      <td colSpan={5}>No members configured.</td>
                    </tr>
                  ) : (
                    members.map((member) => (
                      <tr key={member.id}>
                        <td>{member.tier}</td>
                        <td>{member.order}</td>
                        <td>{member.user ? `${member.user.name} (${member.user.email})` : member.userId}</td>
                        <td>{member.isActive ? "Active" : "Inactive"}</td>
                        <td style={{ display: "flex", gap: "8px" }}>
                          <button type="button" onClick={() => void onMoveMember(member, -1)}>
                            Up
                          </button>
                          <button type="button" onClick={() => void onMoveMember(member, 1)}>
                            Down
                          </button>
                          <button type="button" onClick={() => void onRemoveMember(member.id)}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="kv-card">
            <h2 className="kv-section-title" style={{ marginTop: 0 }}>
              Overrides
            </h2>
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "10px" }}>
              <select value={overrideTier} onChange={(event) => setOverrideTier(event.target.value as "PRIMARY" | "SECONDARY")}>
                <option value="PRIMARY">PRIMARY</option>
                <option value="SECONDARY">SECONDARY</option>
              </select>
              <select value={overrideToUserId} onChange={(event) => setOverrideToUserId(event.target.value)}>
                <option value="">Select user</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name} ({user.role})
                  </option>
                ))}
              </select>
              <input type="datetime-local" value={overrideStartAt} onChange={(event) => setOverrideStartAt(event.target.value)} />
              <input type="datetime-local" value={overrideEndAt} onChange={(event) => setOverrideEndAt(event.target.value)} />
              <input placeholder="Reason" value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} />
              <button type="button" onClick={() => void onCreateOverride()}>
                Add override
              </button>
            </div>

            <div className="kv-table-wrap" style={{ marginTop: "12px" }}>
              <table>
                <thead>
                  <tr>
                    <th align="left">Tier</th>
                    <th align="left">User</th>
                    <th align="left">Start</th>
                    <th align="left">End</th>
                    <th align="left">Reason</th>
                    <th align="left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {overrides.length === 0 ? (
                    <tr>
                      <td colSpan={6}>No overrides configured.</td>
                    </tr>
                  ) : (
                    overrides.map((override) => (
                      <tr key={override.id}>
                        <td>{override.tier}</td>
                        <td>{override.toUser ? `${override.toUser.name} (${override.toUser.email})` : override.toUserId}</td>
                        <td>{new Date(override.startAt).toLocaleString()}</td>
                        <td>{new Date(override.endAt).toLocaleString()}</td>
                        <td>{override.reason ?? "-"}</td>
                        <td>
                          <button type="button" onClick={() => void onDeleteOverride(override.id)}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="kv-card">
            <h2 className="kv-section-title" style={{ marginTop: 0 }}>
              Holiday calendars
            </h2>
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "10px" }}>
              <input
                value={newCalendarName}
                onChange={(event) => setNewCalendarName(event.target.value)}
                placeholder="Calendar name"
              />
              <input
                value={newCalendarTimezone}
                onChange={(event) => setNewCalendarTimezone(event.target.value)}
                placeholder="Timezone"
              />
              <button type="button" onClick={() => void onCreateCalendar()}>
                Create calendar
              </button>
            </div>
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "10px", marginTop: "10px" }}>
              <select value={selectedCalendarId} onChange={(event) => setSelectedCalendarId(event.target.value)}>
                <option value="">Select calendar</option>
                {calendars.map((calendar) => (
                  <option key={calendar.id} value={calendar.id}>
                    {calendar.name} ({calendar.timezone})
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={newHolidayStartDate}
                onChange={(event) => setNewHolidayStartDate(event.target.value)}
              />
              <input
                type="date"
                value={newHolidayEndDate}
                onChange={(event) => setNewHolidayEndDate(event.target.value)}
              />
              <input
                value={newHolidayTitle}
                onChange={(event) => setNewHolidayTitle(event.target.value)}
                placeholder="Holiday title"
              />
              <button type="button" onClick={() => void onCreateHolidayEntry()}>
                Add holiday
              </button>
            </div>
            <div className="kv-table-wrap" style={{ marginTop: "12px" }}>
              <table>
                <thead>
                  <tr>
                    <th align="left">Start</th>
                    <th align="left">End</th>
                    <th align="left">Title</th>
                    <th align="left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {calendarEntries.length === 0 ? (
                    <tr>
                      <td colSpan={4}>No holiday entries.</td>
                    </tr>
                  ) : (
                    calendarEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{new Date(entry.startDate).toLocaleDateString()}</td>
                        <td>{entry.endDate ? new Date(entry.endDate).toLocaleDateString() : "-"}</td>
                        <td>{entry.title ?? "-"}</td>
                        <td>
                          <button type="button" onClick={() => void onDeleteHolidayEntry(entry.id)}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
