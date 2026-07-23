export type TelemetryAttributes = Readonly<Record<string, string>>

interface IngestTelemetryEnvelope {
    readonly environment: string
    readonly service_version: string
    readonly timestamp: string
    readonly source: string
    readonly attributes: TelemetryAttributes
}

interface LogPayload {
    readonly log_id: string
    readonly service_name: string
    readonly source_type: string
    readonly severity_text: string
    readonly severity_number: number
    readonly message: string
    readonly trace_id: string
    readonly span_id: string
    readonly request_id: string
    readonly user_id: string
    readonly logger_name: string
    readonly file_ref: string
    readonly instance_id: string
    readonly pod_name: string
    readonly namespace: string
    readonly node_name: string
    readonly resource_attributes: TelemetryAttributes
    readonly log_attributes: TelemetryAttributes
}

interface SpanPayload {
    readonly trace_id: string
    readonly span_id: string
    readonly parent_span_id: string
    readonly end_time: string
    readonly duration_us: number
    readonly service_name: string
    readonly operation_name: string
    readonly span_kind: string
    readonly span_category: string
    readonly status_code: string
    readonly status_message: string
    readonly has_error: boolean
    readonly http_method: string
    readonly http_route: string
    readonly http_status_code: number
    readonly db_system: string
    readonly messaging_system: string
    readonly peer_service: string
    readonly resource_attributes: TelemetryAttributes
    readonly span_attributes: TelemetryAttributes
}

interface MetricGaugePayload {
    readonly metric_kind: 'gauge'
    readonly service_name: string
    readonly metric_name: string
    readonly unit: string
    readonly value: number
    readonly resource_attributes: TelemetryAttributes
    readonly metric_attributes: TelemetryAttributes
}

interface MetricSumPayload {
    readonly metric_kind: 'sum'
    readonly service_name: string
    readonly metric_name: string
    readonly unit: string
    readonly value: number
    readonly is_monotonic: boolean
    readonly temporality: 'delta' | 'cumulative'
    readonly resource_attributes: TelemetryAttributes
    readonly metric_attributes: TelemetryAttributes
}

interface MetricHistogramPayload {
    readonly metric_kind: 'histogram'
    readonly service_name: string
    readonly metric_name: string
    readonly unit: string
    readonly buckets: ReadonlyArray<{
        readonly le: number
        readonly count: number
    }>
    readonly count: number
    readonly sum: number
    readonly min: number
    readonly max: number
    readonly resource_attributes: TelemetryAttributes
    readonly metric_attributes: TelemetryAttributes
}

interface EventPayload {
    readonly event_id: string
    readonly event_name: string
    readonly event_category: string
    readonly service_name: string
    readonly source_type: string
    readonly user_id: string
    readonly session_id: string
    readonly trace_id: string
    readonly span_id: string
    readonly event_attributes: TelemetryAttributes
}

interface K8sEventPayload {
    readonly event_id: string
    readonly cluster_name: string
    readonly namespace: string
    readonly resource_kind: string
    readonly resource_name: string
    readonly reason: string
    readonly event_type: string
    readonly message: string
    readonly count: number
    readonly first_seen: string
    readonly last_seen: string
    readonly attributes: TelemetryAttributes
}

interface DeploymentEventPayload {
    readonly deployment_id: string
    readonly service_name: string
    readonly version: string
    readonly commit_sha: string
    readonly repository: string
    readonly branch: string
    readonly actor: string
    readonly status: string
    readonly attributes: TelemetryAttributes
}

interface RumEventPayload {
    readonly event_id: string
    readonly application_name: string
    readonly session_id: string
    readonly user_id: string
    readonly page_url: string
    readonly route: string
    readonly event_name: string
    readonly browser_name: string
    readonly browser_version: string
    readonly os_name: string
    readonly device_type: string
    readonly country: string
    readonly trace_id: string
    readonly attributes: TelemetryAttributes
    readonly numeric_attributes: Readonly<Record<string, number>>
}

interface RequestResponseCapturePayload {
    readonly capture_id: string
    readonly trace_id: string
    readonly span_id: string
    readonly service_name: string
    readonly http_method: string
    readonly http_route: string
    readonly http_status_code: number
    readonly request_headers: TelemetryAttributes
    readonly request_query: TelemetryAttributes
    readonly request_body: string
    readonly response_headers: TelemetryAttributes
    readonly response_body: string
}

type IngestTelemetrySignalWithPayload<TSignalType extends string, TPayload> = IngestTelemetryEnvelope & {
    readonly signal_type: TSignalType
    readonly payload: TPayload
}

export type IngestTelemetrySignal =
    | IngestTelemetrySignalWithPayload<'log', LogPayload>
    | IngestTelemetrySignalWithPayload<'span', SpanPayload>
    | IngestTelemetrySignalWithPayload<'metric', MetricGaugePayload | MetricSumPayload | MetricHistogramPayload>
    | IngestTelemetrySignalWithPayload<'event', EventPayload>
    | IngestTelemetrySignalWithPayload<'k8s_event', K8sEventPayload>
    | IngestTelemetrySignalWithPayload<'deployment_event', DeploymentEventPayload>
    | IngestTelemetrySignalWithPayload<'rum_event', RumEventPayload>
    | IngestTelemetrySignalWithPayload<'request_response_capture', RequestResponseCapturePayload>

export interface IngestTelemetryRequest {
    readonly signals: ReadonlyArray<IngestTelemetrySignal>
}

export interface IngestTelemetryResponse {
    readonly accepted: number
    readonly organisation_id: string
    readonly application_id: string
}
