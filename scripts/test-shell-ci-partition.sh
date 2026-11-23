#!/usr/bin/env bash
set -Eeuo pipefail

parte="${1:-}"
if [[ "$parte" != 1 && "$parte" != 2 ]]; then
  echo "Uso: pnpm test:shell:ci 1|2" >&2
  exit 2
fi

mapfile -d '' -t comandos < <(
  node -e 'process.stdout.write(require("./package.json").scripts["test:shell"].split(" && ").join("\0"))'
)

total="${#comandos[@]}"
meio=$(((total + 1) / 2))
if [[ "$parte" == 1 ]]; then
  inicio=0
  fim="$meio"
else
  inicio="$meio"
  fim="$total"
fi

for ((i = inicio; i < fim; i++)); do
  printf '==> kit bash %s/2 (%s/%s): %s\n' "$parte" "$((i + 1))" "$total" "${comandos[$i]}"
  bash -euo pipefail -c "${comandos[$i]}"
done
