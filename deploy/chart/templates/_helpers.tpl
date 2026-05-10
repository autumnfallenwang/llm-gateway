{{/*
Chart name. With `name = llmgw` in Chart.yaml, this is just "llmgw".
*/}}
{{- define "llmgw.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{/*
Fully qualified resource name. Intentionally set to the chart name (not
`<release>-<chart>`) so resources land as `llmgw` regardless of release name —
ArgoCD will use `llmgw` as the release name anyway, and predictable names make
kubectl access painless.
*/}}
{{- define "llmgw.fullname" -}}
{{- .Chart.Name -}}
{{- end -}}

{{/*
Standard kubernetes recommended labels.
*/}}
{{- define "llmgw.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/name: {{ include "llmgw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels (subset of labels). Must remain stable across Chart.Version
bumps — used to match the Deployment's pod selector.
*/}}
{{- define "llmgw.selectorLabels" -}}
app.kubernetes.io/name: {{ include "llmgw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
