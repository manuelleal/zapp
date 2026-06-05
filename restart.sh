#!/bin/bash
# Restart the Zajuna API server
# Usage: bash /c/zajuna/restart.sh

BASH_PID=$(ps aux | grep "node.*server.js" | grep -v grep | awk '{print $1}')
if [ -n "$BASH_PID" ]; then
  echo "Matando proceso node (PID: $BASH_PID)..."
  kill -9 $BASH_PID
  sleep 2
fi

node /c/zajuna/api/src/server.js > /c/zajuna/server.log 2>&1 &
echo "Server restarted, PID: $!"
