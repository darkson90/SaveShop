#!/usr/bin/env bash
# Applica i manifest. Prerequisiti: Secret creati (vedi secrets.example.yaml) e immagini pubblicate.
set -euo pipefail
cd "$(dirname "$0")"
kubectl apply -f namespace.yaml
# La configurazione del gateway è la stessa usata in sviluppo.
kubectl -n spesa-smart create configmap gateway-config \
  --from-file=dynamic.yml=../../gateway/dynamic.yml --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -k .
kubectl -n spesa-smart rollout status deploy/gateway
