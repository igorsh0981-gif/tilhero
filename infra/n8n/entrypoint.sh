#!/bin/sh
# TilHero n8n: импорт workflow из /workflows (upsert по фиксированным id — повторный старт не создаёт дублей),
# включение ИМЕННО этих workflow (остальные, созданные в UI, не трогаются), затем запуск n8n.
# Workflow включается, только если задана переменная адреса из его HTTP-узла ($env.<X>_URL): адрес может появиться позже:
# n8n, обновлённый раньше сервисов, стартует и не дёргает несуществующие
# адреса (импорт выключает workflow; без адреса он остаётся выключенным до следующего старта с переменной).
set -eu

WORKFLOWS_DIR="${TILHERO_WORKFLOWS_DIR:-/workflows}"
export N8N_USER_FOLDER="${N8N_USER_FOLDER:-/home/node}"

if [ -z "${SCHEDULER_TOKEN:-}" ]; then
  # n8n стартует (UI доступен), но вызовы по расписанию получат 401 — видно в логах деплоя
  echo "tilhero-n8n: WARNING: не задана переменная SCHEDULER_TOKEN (вызовы сервисов будут отклонены)" >&2
fi

# "<id> <переменная адреса>" на каждый workflow (переменная — из url HTTP-узла: ={{ $env.X_URL }}/...)
plan="$(node -e '
const fs = require("fs"), path = require("path");
const dir = process.argv[1];
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
  const wf = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  if (!/^[A-Za-z0-9]{16}$/.test(wf.id || "")) { console.error(`${f}: нет фиксированного id`); process.exit(1); }
  const urls = (wf.nodes || []).filter((n) => n.type === "n8n-nodes-base.httpRequest").map((n) => String(n.parameters.url || ""));
  const vars = [...new Set(urls.map((u) => (u.match(/\$env\.([A-Z][A-Z0-9_]*_URL)\b/) || [])[1]).filter(Boolean))];
  if (vars.length !== 1) { console.error(`${f}: ожидается один адрес $env.<X>_URL`); process.exit(1); }
  console.log(`${wf.id} ${vars[0]}`);
}' "$WORKFLOWS_DIR")"

echo "tilhero-n8n: импорт workflow из $WORKFLOWS_DIR"
n8n import:workflow --separate --input="$WORKFLOWS_DIR"
echo "$plan" | while read -r id var; do
  [ -n "$id" ] || continue
  eval "url=\${$var:-}"
  if [ -z "$url" ]; then
    echo "tilhero-n8n: WARNING: не задана $var — workflow $id не включён (добавьте переменную и сделайте Redeploy)" >&2
    continue
  fi
  echo "tilhero-n8n: активация workflow $id"
  n8n update:workflow --id="$id" --active=true
done

echo "tilhero-n8n: запуск n8n"
exec n8n start
