"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, PublicOpenApiDocument, getPublicOpenApi } from "../../../lib/api";

interface DocsTabProps {
  token: string;
}

interface EndpointDocItem {
  path: string;
  summary: string;
  requiredScope: string;
}

function getPublicApiBaseUrl(): string {
  const configuredBase = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!configuredBase) {
    return "http://localhost:4000/api/v1";
  }
  return `${configuredBase.replace(/\/+$/, "")}/api/v1`;
}

function toEndpointDocs(openApi: PublicOpenApiDocument | null): EndpointDocItem[] {
  if (!openApi?.paths) {
    return [];
  }
  return Object.entries(openApi.paths)
    .filter(([, operations]) => Boolean(operations?.get))
    .map(([path, operations]) => ({
      path,
      summary: operations?.get?.summary ?? "Public API endpoint",
      requiredScope: operations?.get?.["x-kritviya-required-scope"] ?? "-"
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function buildCurlSample(baseUrl: string, endpointPath: string): string {
  return [
    "curl -X GET \\",
    `  -H "Authorization: Bearer ktv_live_your_token_here" \\`,
    `  -H "Accept: application/json" \\`,
    `  "${baseUrl}${endpointPath.replace("/api/v1", "")}"`
  ].join("\n");
}

function buildNodeFetchSample(baseUrl: string, endpointPath: string): string {
  return [
    "const token = \"ktv_live_your_token_here\";",
    "",
    `const response = await fetch("${baseUrl}${endpointPath.replace("/api/v1", "")}", {`,
    "  method: \"GET\",",
    "  headers: {",
    "    \"Authorization\": `Bearer ${token}`,",
    "    \"Accept\": \"application/json\"",
    "  }",
    "});",
    "",
    "if (!response.ok) {",
    "  throw new Error(`Request failed: ${response.status}`);",
    "}",
    "",
    "const data = await response.json();",
    "console.log(data);"
  ].join("\n");
}

export function DocsTab({ token }: DocsTabProps) {
  const [openApi, setOpenApi] = useState<PublicOpenApiDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>("/api/v1/users");

  const baseUrl = useMemo(() => getPublicApiBaseUrl(), []);
  const endpoints = useMemo(() => toEndpointDocs(openApi), [openApi]);
  const selectedEndpoint = endpoints.find((endpoint) => endpoint.path === selectedPath) ?? endpoints[0];
  const curlSample = selectedEndpoint ? buildCurlSample(baseUrl, selectedEndpoint.path) : "";
  const nodeFetchSample = selectedEndpoint ? buildNodeFetchSample(baseUrl, selectedEndpoint.path) : "";

  const loadDocs = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      setRequestError(null);
      const response = await getPublicOpenApi(token);
      setOpenApi(response);
      const derivedEndpoints = toEndpointDocs(response);
      if (derivedEndpoints.length > 0) {
        setSelectedPath((currentPath) =>
          derivedEndpoints.some((endpoint) => endpoint.path === currentPath)
            ? currentPath
            : derivedEndpoints[0].path
        );
      }
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setRequestError("Upgrade required to access developer docs.");
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to fetch API docs"
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadDocs();
  }, [loadDocs]);

  return (
    <section className="kv-stack">
      <div className="kv-card">
        <h2 className="kv-section-title" style={{ marginTop: 0 }}>
          Public API Docs
        </h2>
        <p className="kv-subtitle" style={{ marginBottom: "6px" }}>
          Base URL
        </p>
        <pre className="kv-dev-pre">{baseUrl}</pre>
        <p className="kv-subtitle" style={{ marginTop: "12px", marginBottom: "6px" }}>
          Authentication
        </p>
        <p style={{ margin: 0 }}>
          Use an API token in the `Authorization: Bearer &lt;token&gt;` header.
        </p>
      </div>

      {requestError ? <p className="kv-error">{requestError}</p> : null}

      <div className="kv-card">
        <h3 className="kv-section-title" style={{ marginTop: 0 }}>
          Endpoints
        </h3>
        {loading ? <p>Loading endpoints...</p> : null}
        {!loading && endpoints.length === 0 ? <p>No public endpoints found.</p> : null}
        {!loading && endpoints.length > 0 ? (
          <div className="kv-grid-2">
            {endpoints.map((endpoint) => {
              const active = selectedEndpoint?.path === endpoint.path;
              return (
                <button
                  type="button"
                  key={endpoint.path}
                  onClick={() => setSelectedPath(endpoint.path)}
                  style={{
                    textAlign: "left",
                    background: active ? "var(--hover-bg)" : "var(--bg-card)",
                    borderColor: active ? "var(--accent-color)" : "var(--border-color)"
                  }}
                >
                  <p style={{ margin: "0 0 6px", fontWeight: 700 }}>{endpoint.path}</p>
                  <p className="kv-subtitle" style={{ marginBottom: "4px" }}>
                    {endpoint.summary}
                  </p>
                  <p className="kv-subtitle" style={{ margin: 0 }}>
                    Scope: {endpoint.requiredScope}
                  </p>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="kv-card">
        <h3 className="kv-section-title" style={{ marginTop: 0 }}>
          Code samples
        </h3>
        <p className="kv-subtitle">curl</p>
        <pre className="kv-dev-pre">{curlSample}</pre>
        <p className="kv-subtitle" style={{ marginTop: "12px" }}>
          Node fetch
        </p>
        <pre className="kv-dev-pre">{nodeFetchSample}</pre>
      </div>
    </section>
  );
}
