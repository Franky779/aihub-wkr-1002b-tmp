#!/usr/bin/env bash
# deploy.sh — 云服务器一键更新 hub-worker（IP报告款式卡片支持）
# 用法（OrcaTerm 执行）: curl -fsSL <RAW_URL>/deploy.sh | bash
set -euo pipefail

DIR=/opt/ai-hub-workers
RAW=https://raw.githubusercontent.com/Franky779/aihub-wkr-1002b-tmp/main

cd "$DIR"
TS=$(date +%Y%m%d%H%M%S)
echo "== 1/4 备份当前脚本（*.bak-style-$TS） =="
cp -f hub-worker.cjs "hub-worker.cjs.bak-style-$TS"
cp -f report-worker.cjs "report-worker.cjs.bak-style-$TS"
ls -la "hub-worker.cjs.bak-style-$TS" "report-worker.cjs.bak-style-$TS"

echo "== 2/4 下载新版 hub-worker.cjs / report-worker.cjs 与 IP 提示词包 =="
curl -fsSL "$RAW/hub-worker.cjs" -o hub-worker.cjs
curl -fsSL "$RAW/report-worker.cjs" -o report-worker.cjs
curl -fsSL "$RAW/_bp_prompts_ip.json" -o _bp_prompts_ip.json

echo "== 3/4 语法校验 =="
node --check hub-worker.cjs
node --check report-worker.cjs
node -e "require('$DIR/_bp_prompts_ip.json');console.log('IP 提示词包可解析')"

echo "== 4/4 重启服务 =="
systemctl restart ai-hub-worker.service
sleep 5
systemctl is-active ai-hub-worker.service
journalctl -u ai-hub-worker.service -n 20 --no-pager

echo
echo "✅ 部署完成。如需回滚：cd $DIR && cp -f hub-worker.cjs.bak-style-$TS hub-worker.cjs && cp -f report-worker.cjs.bak-style-$TS report-worker.cjs && systemctl restart ai-hub-worker.service"
