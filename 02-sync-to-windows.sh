#!/usr/bin/env bash
# 02-sync-to-windows.sh — 将本地 metabot 代码同步到 Windows 217 主机
#
# 用法: ./02-sync-to-windows.sh [文件/目录相对路径]
#   无参数: 同步整个项目（排除 .git 和 node_modules）
#   有参数: 仅同步指定文件/目录（相对于项目根目录）

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_ROOT="$SCRIPT_DIR"
REMOTE_USER="master"
REMOTE_HOST="192.168.3.217"
REMOTE_PATH="D:/metabot_root"
SSH_KEY="/home/master/f/home/metabot_root/private/REMOTE.pem"
SSH_OPTS="-o ConnectTimeout=5 -o StrictHostKeyChecking=no -i ${SSH_KEY}"

if [ -n "${1:-}" ]; then
    # 同步单个文件或目录
    TARGET="${LOCAL_ROOT}/$1"
    if [ ! -e "$TARGET" ]; then
        echo "错误: $TARGET 不存在"
        exit 1
    fi
    REL_PATH="$1"
    echo "同步: $REL_PATH → ${REMOTE_HOST}:${REMOTE_PATH}/${REL_PATH}"
    scp $SSH_OPTS -r "$TARGET" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/${REL_PATH}"
else
    # 同步整个目录内容（用 * 展开，避免多一层目录）
    echo "同步 metabot_root/ 内容 → ${REMOTE_HOST}:${REMOTE_PATH}/"
    # 先同步文件和目录（排除 .git）
    cd "$LOCAL_ROOT"
    # 使用 scp 逐项发送，排除 .git 和 node_modules
    for item in *; do
        if [ "$item" = ".git" ] || [ "$item" = "node_modules" ]; then
            continue
        fi
        if [ -e "$item" ]; then
            echo "  发送: $item"
            scp $SSH_OPTS -r "$item" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/"
        fi
    done
    # 同步隐藏文件（排除 .git）
    for item in .??*; do
        if [ "$item" = ".git" ] || [ "$item" = ".." ] || [ "$item" = "." ]; then
            continue
        fi
        if [ -e "$item" ]; then
            echo "  发送: $item"
            scp $SSH_OPTS -r "$item" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/"
        fi
    done
fi

echo "同步完成"
