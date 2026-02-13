"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  DealTimelineResponse,
  getDealTimeline
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";
import {
  ExecutionTimeline,
  ExecutionTimelineError,
  ExecutionTimelineSkeleton
} from "../../../components/execution-timeline";

export default function DealDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user, token, loading, error } = useAuthUser();
  const [timeline, setTimeline] = useState<DealTimelineResponse | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const loadTimeline = useCallback(async () => {
    if (!token || !id) {
      return;
    }

    try {
      setTimelineLoading(true);
      setRequestError(null);
      const payload = await getDealTimeline(token, id);
      setTimeline(payload);
      setForbidden(false);
      setNotFound(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError) {
        if (requestFailure.status === 403) {
          setForbidden(true);
          return;
        }
        if (requestFailure.status === 404) {
          setNotFound(true);
          return;
        }
      }
      setRequestError(
        requestFailure instanceof Error
          ? requestFailure.message
          : "Failed to load execution timeline"
      );
    } finally {
      setTimelineLoading(false);
    }
  }, [id, token]);

  useEffect(() => {
    void loadTimeline();
  }, [loadTimeline]);

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">{error}</main>;
  }

  if (forbidden) {
    return (
      <AppShell user={user} title="Deal Detail">
        <p>403: Forbidden</p>
      </AppShell>
    );
  }

  if (notFound) {
    return (
      <AppShell user={user} title="Deal Detail">
        <p>404: Deal not found.</p>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Deal Detail">
      <section className="kv-card" style={{ marginBottom: "1rem" }}>
        <h2 className="kv-section-title" style={{ marginTop: 0 }}>
          Deal Header
        </h2>
        <p className="kv-subtitle" style={{ marginBottom: 0 }}>
          Deal ID: {id}
        </p>
      </section>

      {timelineLoading ? <ExecutionTimelineSkeleton /> : null}

      {!timelineLoading && requestError ? (
        <ExecutionTimelineError message={requestError} onRetry={() => void loadTimeline()} />
      ) : null}

      {!timelineLoading && !requestError && timeline ? (
        <ExecutionTimeline
          milestones={timeline.milestones}
          totalCycleHours={timeline.totalCycleHours}
        />
      ) : null}
    </AppShell>
  );
}
