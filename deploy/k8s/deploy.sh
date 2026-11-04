#!/usr/bin/env bash
# Applica i manifest. Prerequisiti: Secret creati (vedi secrets.example.yaml) e immagini pubblicate.
set -euo pipefail
cd "$(dirname "$0")"
kubectl apply -f namespace.yaml
# La configurazione del gateway è la stessa usata in sviluppo.
# Dietro l'ingress l'IP del client arriva in X-Forwarded-For: i limiti per IP lo devono leggere da lì.
TMP=$(mktemp)
sed 's/ipStrategy: { depth: 0 }/ipStrategy: { depth: 1 }/' ../../gateway/dynamic.yml > "$TMP"
kubectl -n spesa-smart create configmap gateway-config \
  --from-file=dynamic.yml="$TMP" --dry-run=client -o yaml | kubectl apply -f -
rm -f "$TMP"
kubectl apply -k .
kubectl -n spesa-smart rollout status deploy/gateway
