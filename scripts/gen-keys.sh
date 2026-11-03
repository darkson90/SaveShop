#!/usr/bin/env sh
# Genera la coppia di chiavi RS256 per i JWT (solo sviluppo: in produzione usare un KMS).
set -e
cd "$(dirname "$0")/.."
mkdir -p keys
if [ ! -f keys/jwt-private.pem ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out keys/jwt-private.pem
  openssl rsa -in keys/jwt-private.pem -pubout -out keys/jwt-public.pem
  chmod 644 keys/jwt-private.pem keys/jwt-public.pem
  echo "Chiavi create in keys/"
else
  echo "Chiavi già presenti in keys/"
fi
