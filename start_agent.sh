#!/usr/bin/env bash
# ============================================================
#  Agent Launcher for Linux / macOS
# ============================================================
#  Copy this file to ANY folder you want as the sandbox root.
#  Run with:    bash start_agent.sh
#  Or chmod +x start_agent.sh and double-click.
#  Sandbox root is auto-locked to this script's folder.
# ============================================================

# ===== EDIT THIS: path to your agent repo =====
AGENT_HOME="${AGENT_HOME:-$HOME/agent}"

# Resolve this script's directory (handles symlinks)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$SCRIPT_DIR"

echo
echo "============================================================"
echo "  Agent Launcher"
echo "============================================================"
echo "  Code home : $AGENT_HOME"
echo "  Sandbox   : $WORKSPACE"
echo "============================================================"
echo

if [ ! -f "$AGENT_HOME/local_terminal_server.py" ]; then
    echo "[ERROR] Cannot find $AGENT_HOME/local_terminal_server.py"
    echo "        Edit AGENT_HOME at top of this script, or run:"
    echo "        AGENT_HOME=/path/to/agent bash start_agent.sh"
    exit 1
fi

# Prefer python3, fall back to python
PYTHON_BIN="$(command -v python3 || command -v python)"
if [ -z "$PYTHON_BIN" ]; then
    echo "[ERROR] python / python3 not found in PATH"
    exit 1
fi

"$PYTHON_BIN" "$AGENT_HOME/local_terminal_server.py" --workspace "$WORKSPACE" "$@"
