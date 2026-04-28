{{/*
Common labels and selectors.
*/}}
{{- define "aegis.fullname" -}}
{{- default .Release.Name (printf "%s-%s" .Release.Name .Chart.Name) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aegis.labels" -}}
app.kubernetes.io/name: aegis
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "aegis.selectorLabels" -}}
app.kubernetes.io/name: aegis
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
